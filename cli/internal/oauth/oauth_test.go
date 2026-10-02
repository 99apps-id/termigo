package oauth

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/99apps-id/termigo/cli/internal/config"
	"github.com/99apps-id/termigo/cli/internal/secrets"
)

func noWaitClock() Clock {
	fixed := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	return Clock{
		Now:   func() time.Time { return fixed },
		Sleep: func(context.Context, time.Duration) error { return nil },
	}
}

func TestDeviceFlow(t *testing.T) {
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/device":
			fmt.Fprint(writer, `{"device_code":"dc","user_code":"WXYZ","verification_uri":"https://verify","interval":"1","expires_in":"60"}`)
		case "/token":
			polls++
			if polls == 1 {
				writer.WriteHeader(http.StatusBadRequest)
				fmt.Fprint(writer, `{"error":"authorization_pending"}`)
				return
			}
			fmt.Fprint(writer, `{"access_token":"access-1","refresh_token":"refresh-1","expires_in":3600}`)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	flow := DeviceFlow{ClientID: "cid", Scope: "s", DeviceURL: server.URL + "/device", TokenURL: server.URL + "/token"}
	code, err := StartDevice(context.Background(), flow)
	if err != nil {
		t.Fatalf("StartDevice: %v", err)
	}
	if code.UserCode != "WXYZ" || code.VerificationURIComplete != "https://verify" {
		t.Fatalf("code = %+v", code)
	}
	token, err := WaitDevice(context.Background(), flow, code, noWaitClock())
	if err != nil {
		t.Fatalf("WaitDevice: %v", err)
	}
	if token.Access != "access-1" || token.Refresh != "refresh-1" || token.Expires.IsZero() {
		t.Fatalf("token = %+v", token)
	}
}

func TestRefreshDevice(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_ = request.ParseForm()
		if request.Form.Get("grant_type") != "refresh_token" || request.Form.Get("refresh_token") != "old" {
			t.Errorf("refresh form = %v", request.Form)
		}
		writer.Header().Set("Content-Type", "application/json")
		fmt.Fprint(writer, `{"access_token":"new-access","expires_in":1800}`)
	}))
	defer server.Close()

	token, err := RefreshDevice(context.Background(), DeviceFlow{ClientID: "cid", TokenURL: server.URL}, "old", noWaitClock())
	if err != nil {
		t.Fatalf("RefreshDevice: %v", err)
	}
	if token.Access != "new-access" || token.Refresh != "old" {
		t.Fatalf("token = %+v", token)
	}
}

func TestCodexDeviceFlow(t *testing.T) {
	polls := 0
	access := testJWT(`{"https://api.openai.com/auth":{"chatgpt_account_id":"acct_123"}}`)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/accounts/deviceauth/usercode":
			fmt.Fprint(writer, `{"user_code":"CODE","device_auth_id":"DA","interval":"1"}`)
		case "/api/accounts/deviceauth/token":
			polls++
			if polls == 1 {
				writer.WriteHeader(http.StatusForbidden)
				fmt.Fprint(writer, `{}`)
				return
			}
			fmt.Fprint(writer, `{"authorization_code":"ac","code_verifier":"cv"}`)
		case "/oauth/token":
			fmt.Fprintf(writer, `{"access_token":%q,"refresh_token":"rt","id_token":"","expires_in":3600}`, access)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	flow := CodexFlow{ClientID: "app_test", Issuer: server.URL}
	device, err := StartCodexDevice(context.Background(), flow)
	if err != nil {
		t.Fatalf("StartCodexDevice: %v", err)
	}
	if device.UserCode != "CODE" || device.DeviceAuthID != "DA" {
		t.Fatalf("device = %+v", device)
	}
	token, err := WaitCodexToken(context.Background(), flow, device, noWaitClock())
	if err != nil {
		t.Fatalf("WaitCodexToken: %v", err)
	}
	if token.Access != access || token.AccountID != "acct_123" {
		t.Fatalf("token = %+v", token)
	}
}

func TestAccountIDFromJWT(t *testing.T) {
	token := testJWT(`{"https://api.openai.com/auth":{"chatgpt_account_id":"abc"}}`)
	if got := AccountIDFromJWT(token); got != "abc" {
		t.Errorf("AccountIDFromJWT = %q, want abc", got)
	}
	if got := AccountIDFromJWT("not-a-jwt"); got != "" {
		t.Errorf("a malformed token should yield nothing, got %q", got)
	}
}

func TestTokenStore(t *testing.T) {
	t.Setenv(config.EnvHome, t.TempDir())
	store, err := secrets.Load()
	if err != nil {
		t.Fatalf("secrets.Load: %v", err)
	}
	tokens := NewStore(store)
	if _, ok := tokens.Load("xai-oauth"); ok {
		t.Fatalf("a fresh store should have no token")
	}
	if err := tokens.Save("xai-oauth", Token{Access: "a", Refresh: "r", Expires: time.Now().Add(time.Hour)}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	loaded, ok := tokens.Load("xai-oauth")
	if !ok || loaded.Access != "a" || loaded.Refresh != "r" {
		t.Fatalf("Load = %+v ok=%v", loaded, ok)
	}
	if err := tokens.Delete("xai-oauth"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, ok := tokens.Load("xai-oauth"); ok {
		t.Errorf("a deleted token should not load")
	}
}

// TestClientCredentialStore keeps the vendor client pair in the secret file,
// out of the repository, so a provider can refresh without environment keys.
func TestClientCredentialStore(t *testing.T) {
	t.Setenv(config.EnvHome, t.TempDir())
	store, err := secrets.Load()
	if err != nil {
		t.Fatalf("secrets.Load: %v", err)
	}
	tokens := NewStore(store)
	if id, secret := tokens.LoadClient("antigravity"); id != "" || secret != "" {
		t.Fatalf("a fresh store should have no client credentials, got %q %q", id, secret)
	}
	if err := tokens.SaveClient("antigravity", "the-id", "the-secret"); err != nil {
		t.Fatalf("SaveClient: %v", err)
	}
	if id, secret := tokens.LoadClient("antigravity"); id != "the-id" || secret != "the-secret" {
		t.Errorf("LoadClient = %q %q, want the-id the-secret", id, secret)
	}
}

// TestOpenAICodexUsesTheLoopbackPKCEFlow pins the flow the Codex CLI uses. The
// old device session answered client_id_not_found_in_session, so login must be
// an authorization code on the fixed loopback port with the CLI's extra params.
func TestOpenAICodexUsesTheLoopbackPKCEFlow(t *testing.T) {
	spec, ok := SpecFor("openai-codex")
	if !ok {
		t.Fatal("no openai-codex spec")
	}
	if spec.Kind != "pkce" {
		t.Fatalf("kind = %q, want pkce", spec.Kind)
	}
	if spec.RedirectPort != 1455 || spec.RedirectPath != "/auth/callback" {
		t.Errorf("redirect = %d %q, want 1455 /auth/callback", spec.RedirectPort, spec.RedirectPath)
	}
	if spec.AuthorizeURL != "https://auth.openai.com/oauth/authorize" {
		t.Errorf("authorize = %q", spec.AuthorizeURL)
	}
	if spec.ExtraAuth["codex_cli_simplified_flow"] != "true" || spec.ExtraAuth["originator"] != "codex_cli_rs" {
		t.Errorf("extra auth = %#v", spec.ExtraAuth)
	}
	if strings.TrimSpace(spec.RefreshScope) == "" {
		t.Errorf("the OpenAI refresh grant needs the original scope")
	}
}

// TestTokenFromReadsTheChatGPTAccountID proves the PKCE exchange captures the
// account id the Codex client sends as ChatGPT-Account-ID.
func TestTokenFromReadsTheChatGPTAccountID(t *testing.T) {
	access := testJWT(`{"https://api.openai.com/auth":{"chatgpt_account_id":"acct_42"}}`)
	token := tokenFrom(tokenResponse{AccessToken: access, RefreshToken: "r", ExpiresIn: 3600}, time.Now())
	if token.AccountID != "acct_42" {
		t.Errorf("AccountID = %q, want acct_42", token.AccountID)
	}
}

// TestPromptClientCredentialsAsksOnlyForTheMissingSecret covers the Antigravity
// 400 "client_secret is missing": the id was known, so the login must ask for
// the secret alone and not re-ask the id.
func TestPromptClientCredentialsAsksOnlyForTheMissingSecret(t *testing.T) {
	var out strings.Builder
	id, secret, err := promptClientCredentials(strings.NewReader("the-secret\n"), &out, "antigravity", "known-id", "")
	if err != nil {
		t.Fatalf("promptClientCredentials: %v", err)
	}
	if id != "known-id" || secret != "the-secret" {
		t.Errorf("got id=%q secret=%q, want known-id the-secret", id, secret)
	}
	if strings.Contains(out.String(), "Client id:") {
		t.Errorf("a resolved id must not be asked again: %q", out.String())
	}
	if !strings.Contains(out.String(), "Client secret:") {
		t.Errorf("the missing secret must be asked for: %q", out.String())
	}
}

// TestPKCEResolvesStoredClientCredentials proves a provider with a client
// secret can exchange a code after only the secret was stored.
func TestPKCEResolvesStoredClientCredentials(t *testing.T) {
	t.Setenv(config.EnvHome, t.TempDir())
	store, err := secrets.Load()
	if err != nil {
		t.Fatalf("secrets.Load: %v", err)
	}
	tokens := NewStore(store)
	if err := tokens.SaveClient("antigravity", "cid", "csecret"); err != nil {
		t.Fatalf("SaveClient: %v", err)
	}
	spec, ok := SpecFor("antigravity")
	if !ok {
		t.Fatal("no antigravity spec")
	}
	flow := pkceFlowFromSpec(spec, tokens)
	if flow.ClientID != "cid" || flow.ClientSecret != "csecret" {
		t.Errorf("flow = %+v, want cid/csecret from the store", flow)
	}
}

// TestSpecForCarriesStampedAntigravityCredentials proves a release binary that
// had the public client pair injected at link time needs no environment and no
// prompt: the spec already holds both values.
func TestSpecForCarriesStampedAntigravityCredentials(t *testing.T) {
	oldID, oldSecret := AntigravityClientID, AntigravityClientSecret
	t.Cleanup(func() { AntigravityClientID, AntigravityClientSecret = oldID, oldSecret })
	AntigravityClientID, AntigravityClientSecret = "stamped-id", "stamped-secret"

	spec, ok := SpecFor("antigravity")
	if !ok {
		t.Fatal("no antigravity spec")
	}
	if spec.ClientID != "stamped-id" || spec.ClientSecret != "stamped-secret" {
		t.Errorf("spec = %+v, want the stamped pair", spec)
	}
}

// TestPersistClientCredentialsStoresTheResolvedPair keeps a refresh working
// after the first login even from a build without the credentials stamp.
func TestPersistClientCredentialsStoresTheResolvedPair(t *testing.T) {
	t.Setenv(config.EnvHome, t.TempDir())
	store, err := secrets.Load()
	if err != nil {
		t.Fatalf("secrets.Load: %v", err)
	}
	tokens := NewStore(store)
	persistClientCredentials(tokens, "antigravity", PKCEFlow{ClientID: "cid", ClientSecret: "csecret"})
	if id, secret := tokens.LoadClient("antigravity"); id != "cid" || secret != "csecret" {
		t.Errorf("stored = %q %q, want cid csecret", id, secret)
	}
	// A second call must not overwrite the pair already stored.
	persistClientCredentials(tokens, "antigravity", PKCEFlow{ClientID: "other", ClientSecret: "other"})
	if id, _ := tokens.LoadClient("antigravity"); id != "cid" {
		t.Errorf("id = %q, want the original cid", id)
	}
}

// TestPKCEFlow drives the loopback authorization-code flow end to end against
// a fake token endpoint: start, visit the redirect with a code, exchange.
func TestPKCEFlow(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/token" {
			http.NotFound(writer, request)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		fmt.Fprint(writer, `{"access_token":"pkce-access","refresh_token":"pkce-refresh","expires_in":3600}`)
	}))
	defer server.Close()

	flow := PKCEFlow{ClientID: "cid", AuthorizeURL: server.URL + "/authorize", TokenURL: server.URL + "/token", RedirectPath: "/callback"}
	session, authURL, err := StartPKCE(flow)
	if err != nil {
		t.Fatalf("StartPKCE: %v", err)
	}
	parsed, err := url.Parse(authURL)
	if err != nil {
		t.Fatalf("parse authorize url: %v", err)
	}
	if parsed.Query().Get("code_challenge") == "" || parsed.Query().Get("code_challenge_method") != "S256" {
		t.Errorf("the authorize url must carry a PKCE challenge: %s", authURL)
	}
	redirect := parsed.Query().Get("redirect_uri")
	state := parsed.Query().Get("state")

	response, err := http.Get(redirect + "?code=the-code&state=" + state)
	if err != nil {
		t.Fatalf("call the callback: %v", err)
	}
	response.Body.Close()

	token, err := session.Wait(context.Background(), noWaitClock(), nil)
	if err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if token.Access != "pkce-access" || token.Refresh != "pkce-refresh" {
		t.Fatalf("token = %+v", token)
	}
}

// TestExtractPastedCode covers the headless login: the operator opens the URL
// on another machine and pastes the redirect URL, its query, or the code back.
func TestExtractPastedCode(t *testing.T) {
	redirect := "http://127.0.0.1:36685/auth/callback?state=abc123&iss=https://accounts.google.com&code=4%2F0AXexample&scope=email&prompt=consent"
	code, state, ok := extractPastedCode(redirect)
	if !ok || code != "4/0AXexample" || state != "abc123" {
		t.Errorf("redirect URL: code=%q state=%q ok=%v", code, state, ok)
	}
	code, state, ok = extractPastedCode("code=the-code&state=the-state")
	if !ok || code != "the-code" || state != "the-state" {
		t.Errorf("query: code=%q state=%q ok=%v", code, state, ok)
	}
	code, state, ok = extractPastedCode("the-code#the-state")
	if !ok || code != "the-code" || state != "the-state" {
		t.Errorf("code#state: code=%q state=%q ok=%v", code, state, ok)
	}
}

// TestLooksLikePastedCode keeps a stray keypress from being exchanged.
func TestLooksLikePastedCode(t *testing.T) {
	for _, line := range []string{"", "hi", "y", "   "} {
		if looksLikePastedCode(line) {
			t.Errorf("%q must not look like a code", line)
		}
	}
	for _, line := range []string{"http://127.0.0.1:1/cb?code=x", "code=abc&state=s", "abcdef#state", "averylongopaquecodestring123"} {
		if !looksLikePastedCode(line) {
			t.Errorf("%q should look like a code", line)
		}
	}
}

// testJWT builds an unsigned JWT with the given JSON payload.
func testJWT(payload string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))
	body := base64.RawURLEncoding.EncodeToString([]byte(payload))
	return header + "." + body + ".sig"
}
