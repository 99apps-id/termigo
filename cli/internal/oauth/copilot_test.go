package oauth

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestFetchCopilotToken(t *testing.T) {
	var gotAuth, gotVersion, gotEditor, gotPlugin, gotAgent string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotVersion = r.Header.Get("x-github-api-version")
		gotEditor = r.Header.Get("Editor-Version")
		gotPlugin = r.Header.Get("Editor-Plugin-Version")
		gotAgent = r.Header.Get("User-Agent")

		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"token":"copilot-session-token-xyz","expires_at":1900000000}`)
	}))
	defer server.Close()

	clock := Clock{}
	token, err := FetchCopilotToken(context.Background(), server.URL, "ghu_dummy_access_token", clock)
	if err != nil {
		t.Fatalf("FetchCopilotToken failed: %v", err)
	}

	if gotAuth != "token ghu_dummy_access_token" {
		t.Errorf("Authorization = %q, want token ghu_dummy_access_token", gotAuth)
	}
	if gotVersion != "2025-04-01" {
		t.Errorf("x-github-api-version = %q, want 2025-04-01", gotVersion)
	}
	if gotEditor != "vscode/1.110.0" || gotPlugin != "copilot-chat/0.38.0" {
		t.Errorf("editor headers: editor=%q plugin=%q", gotEditor, gotPlugin)
	}
	if gotAgent != "GitHubCopilotChat/0.38.0" {
		t.Errorf("User-Agent = %q", gotAgent)
	}

	if token.Access != "copilot-session-token-xyz" {
		t.Errorf("token.Access = %q", token.Access)
	}
	if token.Refresh != "ghu_dummy_access_token" {
		t.Errorf("token.Refresh = %q", token.Refresh)
	}
	if token.Expires.Unix() != 1900000000 {
		t.Errorf("token.Expires = %v", token.Expires)
	}
}

func TestPreserveAccountIDOnRefresh(t *testing.T) {
	store := testStore(t)
	server := fakeTokenServer(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		// Refresh response without id_token and without account_id in access token
		fmt.Fprint(writer, `{"access_token":"refreshed-access","expires_in":3600}`)
	})
	useTestSpec(t, Spec{
		Provider: "test-preserve-account",
		Kind:     "pkce",
		ClientID: "cid",
		TokenURL: server.URL,
	})

	if err := store.Save("test-preserve-account", Token{
		Access:    "stale-access",
		Refresh:   "good-refresh",
		AccountID: "my-chatgpt-account-id",
		Expires:   time.Now().Add(-time.Hour),
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	token := AccessToken(context.Background(), store, "test-preserve-account")
	if token != "refreshed-access" {
		t.Fatalf("AccessToken = %q, want refreshed-access", token)
	}

	saved, ok := store.Load("test-preserve-account")
	if !ok {
		t.Fatal("token not in store")
	}
	if saved.AccountID != "my-chatgpt-account-id" {
		t.Errorf("saved.AccountID = %q, want my-chatgpt-account-id", saved.AccountID)
	}
}
