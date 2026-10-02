package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/99apps-id/termigo/cli/internal/config"
	"github.com/99apps-id/termigo/cli/internal/secrets"
)

// testStore builds a token store over an isolated secret file.
func testStore(t *testing.T) *Store {
	t.Helper()
	t.Setenv(config.EnvHome, t.TempDir())
	secretsStore, err := secrets.Load()
	if err != nil {
		t.Fatalf("secrets.Load: %v", err)
	}
	return NewStore(secretsStore)
}

// fakeTokenServer answers device refreshes with a fresh token and counts how
// many token requests actually arrived.
func fakeTokenServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server
}

func useTestSpec(t *testing.T, spec Spec) {
	t.Helper()
	name := spec.Provider
	previous, existed := specs[name]
	specs[name] = spec
	t.Cleanup(func() {
		if existed {
			specs[name] = previous
		} else {
			delete(specs, name)
		}
	})
}

func TestStatusErrorClassifiesADeadGrant(t *testing.T) {
	for _, body := range []string{
		`{"error":"invalid_grant","error_description":"token has been revoked"}`,
		`{"error":"refresh_token_reused"}`,
		`{"error":{"code":"refresh_token_expired"}}`,
		`invalid_grant: bad refresh token`,
	} {
		err := statusError("https://example.invalid/token", http.StatusBadRequest, []byte(body))
		var grant *GrantError
		if !errors.As(err, &grant) {
			t.Fatalf("statusError(%s) = %v, want a *GrantError", body, err)
		}
	}
	err := statusError("https://example.invalid/token", http.StatusTooManyRequests, []byte(`{"error":"temporarily_unavailable"}`))
	var grant *GrantError
	if errors.As(err, &grant) {
		t.Fatalf("a transient error must not classify as a dead grant: %v", err)
	}
}

func TestAccessTokenDropsADeadLogin(t *testing.T) {
	store := testStore(t)
	server := fakeTokenServer(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(writer, `{"error":"invalid_grant","error_description":"refresh token expired"}`)
	})
	useTestSpec(t, Spec{Provider: "dead-login", Kind: "device", ClientID: "cid", TokenURL: server.URL})

	if err := store.Save("dead-login", Token{
		Access:  "stale-access",
		Refresh: "dead-refresh",
		Expires: time.Now().Add(-time.Hour),
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if got := AccessToken(context.Background(), store, "dead-login"); got != "" {
		t.Fatalf("a revoked login must yield no token, got %q", got)
	}
	if _, ok := store.Load("dead-login"); ok {
		t.Fatal("a revoked login must be dropped from the store")
	}
}

func TestAccessTokenKeepsAWorkingTokenThroughATemporaryOutage(t *testing.T) {
	store := testStore(t)
	server := fakeTokenServer(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(writer, `{"error":"server_error"}`)
	})
	useTestSpec(t, Spec{Provider: "blip-login", Kind: "device", ClientID: "cid", TokenURL: server.URL})

	if err := store.Save("blip-login", Token{
		Access: "current-access", Refresh: "r", Expires: time.Now().Add(-time.Minute),
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if got := AccessToken(context.Background(), store, "blip-login"); got != "current-access" {
		t.Fatalf("a failed refresh must hand back the stored token, got %q", got)
	}
	if _, ok := store.Load("blip-login"); !ok {
		t.Fatal("a transient outage must not drop the login")
	}
}

// TestAccessTokenRefreshesOnceUnderConcurrency guards the rotation hazard:
// Codex and Anthropic invalidate a refresh token the moment it is used, so a
// second, racing replay of the old token can revoke the whole session.
func TestAccessTokenRefreshesOnceUnderConcurrency(t *testing.T) {
	store := testStore(t)
	var hits atomic.Int64
	server := fakeTokenServer(t, func(writer http.ResponseWriter, request *http.Request) {
		hit := hits.Add(1)
		writer.Header().Set("Content-Type", "application/json")
		body, _ := json.Marshal(map[string]any{
			"access_token":  fmt.Sprintf("access-%d", hit),
			"refresh_token": fmt.Sprintf("refresh-%d", hit),
			"expires_in":    3600,
		})
		writer.Write(body)
	})
	useTestSpec(t, Spec{Provider: "race-login", Kind: "device", ClientID: "cid", TokenURL: server.URL})

	if err := store.Save("race-login", Token{
		Access: "old-access", Refresh: "old-refresh", Expires: time.Now().Add(-time.Minute),
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	const racers = 12
	start := make(chan struct{})
	var wait sync.WaitGroup
	tokens := make([]string, racers)
	for i := 0; i < racers; i++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			<-start
			tokens[index] = AccessToken(context.Background(), store, "race-login")
		}(i)
	}
	close(start)
	wait.Wait()

	if got := hits.Load(); got != 1 {
		t.Fatalf("concurrent refreshes made %d token requests, want 1", got)
	}
	for _, token := range tokens {
		if token != "access-1" {
			t.Fatalf("a racer got %q instead of the single refreshed token", token)
		}
	}
}

func TestAccessTokenRefreshesAStaleGrantEarly(t *testing.T) {
	store := testStore(t)
	var hits atomic.Int64
	server := fakeTokenServer(t, func(writer http.ResponseWriter, request *http.Request) {
		hits.Add(1)
		writer.Header().Set("Content-Type", "application/json")
		fmt.Fprint(writer, `{"access_token":"fresh-access","refresh_token":"fresh-refresh","expires_in":3600}`)
	})
	// The 9router codex preset: a grant older than eight days must rotate even
	// while its access token is still hours from expiry.
	useTestSpec(t, Spec{
		Provider: "stale-login", Kind: "device", ClientID: "cid",
		TokenURL: server.URL, MaxRefreshAge: 8 * 24 * time.Hour,
	})

	if err := store.Save("stale-login", Token{
		Access: "old-access", Refresh: "old-refresh",
		Expires:     time.Now().Add(23 * time.Hour),
		LastRefresh: time.Now().Add(-9 * 24 * time.Hour),
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if got := AccessToken(context.Background(), store, "stale-login"); got != "fresh-access" {
		t.Fatalf("stale credential returned %q, want the refreshed token", got)
	}
	if hits.Load() != 1 {
		t.Fatalf("the stale credential was refreshed %d times, want 1", hits.Load())
	}
	saved, ok := store.Load("stale-login")
	if !ok || saved.LastRefresh.IsZero() {
		t.Fatal("a refresh must stamp LastRefresh on the saved token")
	}
}

// TestPKCERefreshSendsTheConfiguredScope covers the OpenAI refresh grant, which
// expects the original scope back; providers that do not set one send none.
func TestPKCERefreshSendsTheConfiguredScope(t *testing.T) {
	store := testStore(t)
	var gotScope string
	server := fakeTokenServer(t, func(writer http.ResponseWriter, request *http.Request) {
		_ = request.ParseForm()
		gotScope = request.PostForm.Get("scope")
		writer.Header().Set("Content-Type", "application/json")
		fmt.Fprint(writer, `{"access_token":"fresh","expires_in":3600}`)
	})
	useTestSpec(t, Spec{
		Provider: "codex-scope", Kind: "pkce", ClientID: "cid",
		TokenURL: server.URL, RefreshScope: "openid profile email offline_access",
	})
	if err := store.Save("codex-scope", Token{Access: "old", Refresh: "rt", Expires: time.Now().Add(-time.Hour)}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if got := AccessToken(context.Background(), store, "codex-scope"); got != "fresh" {
		t.Fatalf("AccessToken = %q, want fresh", got)
	}
	if gotScope != "openid profile email offline_access" {
		t.Errorf("refresh scope = %q", gotScope)
	}
}

func TestValidSkipsTheLeadWindow(t *testing.T) {
	// Claude's preset rotates four hours early (9router refreshLeadMs).
	token := Token{Access: "a", Expires: time.Now().Add(3 * time.Hour)}
	if token.Valid(time.Now(), 4*time.Hour) {
		t.Fatal("a token inside the lead window must count as needing a refresh")
	}
	if !token.Valid(time.Now(), time.Hour) {
		t.Fatal("a token outside the lead window must stay valid")
	}
}

func TestStaleOnlyAppliesWhenTheProviderAgesGrants(t *testing.T) {
	token := Token{Access: "a", Expires: time.Now().Add(time.Hour)}
	if token.Stale(time.Now(), 0) {
		t.Fatal("a provider with no MaxRefreshAge never ages out")
	}
	if !token.Stale(time.Now(), time.Minute) {
		t.Fatal("a token with no recorded refresh age is stale")
	}
}
