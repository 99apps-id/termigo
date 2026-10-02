package oauth

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Spec describes how one provider logs in. Kind is "device" for RFC 8628,
// "codex" for the OpenAI Codex device flow, or "pkce" for an authorization
// code with PKCE and a loopback callback.
type Spec struct {
	Provider   string
	Kind       string
	ClientID   string
	Scope      string
	DeviceURL  string
	TokenURL   string
	VerifyHint string
	Issuer     string

	// PKCE fields. ClientSecret is the public installed-app secret some
	// vendors ship (Google), not a confidential secret. A secret that GitHub
	// secret scanning flags is read from the environment instead of being
	// committed, which is why the Google client has env names here.
	ClientSecret    string
	ClientIDEnv     string
	ClientSecretEnv string
	AuthorizeURL    string
	Scopes          []string
	RedirectPort    int
	RedirectPath    string
	ExtraAuth       map[string]string
	ExchangeJSON    bool
	RefreshJSON     bool
	// RefreshScope is sent on a PKCE refresh when a vendor requires it (the
	// OpenAI token endpoint expects the original scope on the refresh grant).
	// Empty means the refresh carries no scope, as Claude and Google expect.
	RefreshScope string

	// CopilotTokenURL is the GitHub Copilot token minting endpoint.
	CopilotTokenURL string

	// RefreshLead overrides how early the access token is renewed; zero is
	// the five-minute default. MaxRefreshAge renews a credential that has
	// gone unrenewed for that long even while its access token still looks
	// valid, for vendors that age the grant itself out (9router calls this
	// maxRefreshAgeMs). Values follow the 9router registry presets.
	RefreshLead   time.Duration
	MaxRefreshAge time.Duration
}

// specs are the providers Termixgo can log in to. The client ids are the
// public ones the vendor's own CLI ships, as extracted from Hermes and
// OpenCode on this machine.
var specs = map[string]Spec{
	"xai-oauth": {
		Provider:  "xai-oauth",
		Kind:      "device",
		ClientID:  "b1a00492-073a-47ea-816f-4c329264a828",
		Scope:     "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write",
		DeviceURL: "https://auth.x.ai/oauth2/device/code",
		TokenURL:  "https://auth.x.ai/oauth2/token",
	},
	"openai-codex": {
		Provider:    "openai-codex",
		Kind:        "pkce",
		ClientID:    "app_EMoamEEZ73f0CkXaXp7hrann",
		RefreshLead: 10 * time.Minute,
		// The Codex CLI logs in with an authorization code on a fixed loopback
		// port, not the old device flow: the device session is what answered
		// client_id_not_found_in_session. The extra params are the ones the
		// CLI sends, and the codex_cli_simplified_flow flag is required.
		AuthorizeURL: "https://auth.openai.com/oauth/authorize",
		TokenURL:     "https://auth.openai.com/oauth/token",
		Scopes:       []string{"openid", "profile", "email", "offline_access"},
		RedirectPort: 1455,
		RedirectPath: "/auth/callback",
		ExtraAuth: map[string]string{
			"id_token_add_organizations": "true",
			"codex_cli_simplified_flow":  "true",
			"originator":                 "codex_cli_rs",
		},
		RefreshScope: "openid profile email offline_access",
		// OpenAI ages a Codex refresh grant out in about eight days even
		// while the hour-long access token keeps rotating, so the credential
		// is renewed by age as well as by expiry (9router maxRefreshAgeMs).
		MaxRefreshAge: 8 * 24 * time.Hour,
	},
	"claude-oauth": {
		Provider:     "claude-oauth",
		Kind:         "pkce",
		ClientID:     "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
		AuthorizeURL: "https://claude.ai/oauth/authorize",
		TokenURL:     "https://api.anthropic.com/v1/oauth/token",
		Scopes:       []string{"org:create_api_key", "user:profile", "user:inference"},
		RedirectPort: 54545,
		RedirectPath: "/callback",
		ExtraAuth:    map[string]string{"code": "true"},
		ExchangeJSON: true,
		RefreshJSON:  true,
		RefreshLead:  4 * time.Hour, // 9router refreshLeadMs
	},
	// Antigravity shares Google's OAuth. The client id and the public
	// installed-app secret are read from the environment rather than committed,
	// because GitHub secret scanning flags the Google pair. Its inference is a
	// separate Cloud Code client and is not wired yet.
	"antigravity": {
		Provider:        "antigravity",
		Kind:            "pkce",
		ClientIDEnv:     "TERMIXGO_ANTIGRAVITY_CLIENT_ID",
		ClientSecretEnv: "TERMIXGO_ANTIGRAVITY_CLIENT_SECRET",
		AuthorizeURL:    "https://accounts.google.com/o/oauth2/v2/auth",
		TokenURL:        "https://oauth2.googleapis.com/token",
		Scopes: []string{
			"https://www.googleapis.com/auth/cloud-platform",
			"https://www.googleapis.com/auth/userinfo.email",
			"https://www.googleapis.com/auth/userinfo.profile",
			"https://www.googleapis.com/auth/cclog",
			"https://www.googleapis.com/auth/experimentsandconfigs",
		},
		RedirectPath: "/auth/callback",
		ExtraAuth:    map[string]string{"access_type": "offline", "prompt": "consent"},
	},
	"github-copilot": {
		Provider:        "github-copilot",
		Kind:            "copilot",
		ClientID:        "Iv1.b507a08c87ecfe98",
		Scope:           "read:user",
		DeviceURL:       "https://github.com/login/device/code",
		TokenURL:        "https://github.com/login/oauth/access_token",
		VerifyHint:      "https://github.com/login/device",
		CopilotTokenURL: "https://api.github.com/copilot_internal/v2/token",
		RefreshLead:     5 * time.Minute,
	},
}

// AntigravityClientID and AntigravityClientSecret are Google's public
// installed-app credential. They are never committed: a release build stamps
// them here with -ldflags, sourced from an environment variable or the local
// .env.local file, so the operator never types them:
//
//	-X internal/oauth.AntigravityClientID=...
//	-X internal/oauth.AntigravityClientSecret=...
//
// A build with no stamp falls back to TERMIXGO_ANTIGRAVITY_CLIENT_ID and
// TERMIXGO_ANTIGRAVITY_CLIENT_SECRET, then to a one-time prompt.
var (
	AntigravityClientID     string
	AntigravityClientSecret string
)

// SpecFor returns the login spec for a provider, filling the Antigravity client
// pair from the build stamp when the binary carried one.
func SpecFor(provider string) (Spec, bool) {
	spec, ok := specs[provider]
	if !ok && provider == "github" {
		spec, ok = specs["github-copilot"]
	}
	if !ok {
		return Spec{}, false
	}
	if provider == "antigravity" {
		if strings.TrimSpace(spec.ClientID) == "" {
			spec.ClientID = strings.TrimSpace(AntigravityClientID)
		}
		if strings.TrimSpace(spec.ClientSecret) == "" {
			spec.ClientSecret = strings.TrimSpace(AntigravityClientSecret)
		}
		if strings.TrimSpace(spec.ClientID) == "" || strings.TrimSpace(spec.ClientSecret) == "" {
			if id, secret := readEnvLocalAntigravity(); id != "" && secret != "" {
				if strings.TrimSpace(spec.ClientID) == "" {
					spec.ClientID = id
				}
				if strings.TrimSpace(spec.ClientSecret) == "" {
					spec.ClientSecret = secret
				}
			}
		}
	}
	return spec, true
}

// readEnvLocalAntigravity attempts to read Antigravity client credentials from
// a local .env.local file if present in the workspace or next to the executable.
func readEnvLocalAntigravity() (string, string) {
	candidates := []string{".env.local"}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), ".env.local"))
	}
	for _, path := range candidates {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var id, secret string
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if after, ok := strings.CutPrefix(line, "TERMIXGO_ANTIGRAVITY_CLIENT_ID="); ok {
				id = strings.Trim(strings.TrimSpace(after), `"'`)
			} else if after, ok := strings.CutPrefix(line, "TERMIXGO_ANTIGRAVITY_CLIENT_SECRET="); ok {
				secret = strings.Trim(strings.TrimSpace(after), `"'`)
			}
		}
		if id != "" && secret != "" {
			return id, secret
		}
	}
	return "", ""
}

// Supported lists the providers with a login, sorted.
func Supported() []string {
	names := make([]string, 0, len(specs))
	for name := range specs {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
