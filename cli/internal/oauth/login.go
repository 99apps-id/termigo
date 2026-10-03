package oauth

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

// defaultRefreshLead is how early an access token is renewed, matching the
// 9router TOKEN_EXPIRY_BUFFER_MS. A provider can set a longer RefreshLead.
const defaultRefreshLead = 5 * time.Minute

// Login drives the flow a provider declares (device, codex, or pkce) and
// stores the token. It writes the code the operator must enter and the URL to
// open. in is used to prompt for client credentials a provider needs and the
// environment or the secret store does not already hold.
func Login(ctx context.Context, store *Store, provider string, in io.Reader, out io.Writer) error {
	spec, ok := SpecFor(provider)
	if !ok {
		return fmt.Errorf("%s does not use an OAuth login", provider)
	}
	clock := Clock{}
	var token Token
	var err error
	switch spec.Kind {
	case "codex":
		flow := CodexFlow{ClientID: spec.ClientID, Issuer: spec.Issuer}
		device, startErr := StartCodexDevice(ctx, flow)
		if startErr != nil {
			return startErr
		}
		fmt.Fprintf(out, "Open %s and enter code %s\n", flow.VerifyURL(), device.UserCode)
		token, err = WaitCodexToken(ctx, flow, device, clock)
	case "pkce":
		flow := pkceFlowFromSpec(spec, store)
		needsID := strings.TrimSpace(flow.ClientID) == ""
		needsSecret := strings.TrimSpace(spec.ClientSecretEnv) != "" && strings.TrimSpace(flow.ClientSecret) == ""
		if needsID || needsSecret {
			if in == nil {
				env := spec.ClientIDEnv
				if needsSecret {
					env = spec.ClientSecretEnv
				}
				return fmt.Errorf("%s needs OAuth client credentials in %s", provider, env)
			}
			id, secret, promptErr := promptClientCredentials(in, out, provider, flow.ClientID, flow.ClientSecret)
			if promptErr != nil {
				return promptErr
			}
			if saveErr := store.SaveClient(provider, id, secret); saveErr != nil {
				return saveErr
			}
			flow = pkceFlowFromSpec(spec, store)
		}
		// Persist the pair a release build stamped in, so a later refresh works
		// from a build that carries no stamp (a plain go build or an older
		// binary) without asking the operator to log in again.
		persistClientCredentials(store, provider, flow)
		var session *pkceSession
		var authURL string
		session, authURL, err = StartPKCE(flow)
		if err == nil {
			fmt.Fprintf(out, "Open this URL to log in:\n%s\n", authURL)
			openBrowser(authURL)
			fmt.Fprintf(out, "If this machine has no browser, open the URL on another machine, then paste the full redirect URL back here.\n")
			token, err = session.Wait(ctx, clock, in)
		}
	case "copilot":
		flow := DeviceFlow{ClientID: spec.ClientID, Scope: spec.Scope, DeviceURL: spec.DeviceURL, TokenURL: spec.TokenURL, VerifyHint: spec.VerifyHint}
		var code DeviceCode
		code, err = StartDevice(ctx, flow)
		if err == nil {
			target := code.VerificationURIComplete
			if strings.TrimSpace(target) == "" {
				target = code.VerificationURI
			}
			fmt.Fprintf(out, "Open %s and enter code %s\n", target, code.UserCode)
			openBrowser(target)
			var ghToken Token
			ghToken, err = WaitDevice(ctx, flow, code, clock)
			if err == nil {
				token, err = FetchCopilotToken(ctx, spec.CopilotTokenURL, ghToken.Access, clock)
			}
		}
	case "muse":
		flow := DeviceFlow{ClientID: spec.ClientID, Scope: spec.Scope, DeviceURL: spec.DeviceURL, TokenURL: spec.TokenURL, VerifyHint: spec.VerifyHint}
		var code DeviceCode
		code, err = StartDevice(ctx, flow)
		if err == nil {
			target := code.VerificationURIComplete
			if strings.TrimSpace(target) == "" {
				target = code.VerificationURI
			}
			fmt.Fprintf(out, "Open %s and enter code %s\n", target, code.UserCode)
			openBrowser(target)
			var device Token
			device, err = WaitDevice(ctx, flow, code, clock)
			if err == nil {
				var notice string
				token, notice, err = museTokenFromDevice(ctx, spec.MintURL, device, clock.now())
				if err == nil && strings.TrimSpace(notice) != "" {
					fmt.Fprintf(out, "%s\n", notice)
				}
			}
		}
	default:
		flow := DeviceFlow{ClientID: spec.ClientID, Scope: spec.Scope, DeviceURL: spec.DeviceURL, TokenURL: spec.TokenURL, VerifyHint: spec.VerifyHint}
		var code DeviceCode
		code, err = StartDevice(ctx, flow)
		if err == nil {
			target := code.VerificationURIComplete
			if strings.TrimSpace(target) == "" {
				target = code.VerificationURI
			}
			fmt.Fprintf(out, "Open %s and enter code %s\n", target, code.UserCode)
			token, err = WaitDevice(ctx, flow, code, clock)
		}
	}
	if err != nil {
		return err
	}
	token.LastRefresh = clock.now()
	if err := store.Save(provider, token); err != nil {
		return err
	}
	fmt.Fprintf(out, "Logged in to %s.\n", provider)
	return nil
}

// persistClientCredentials saves the resolved client pair to the secret store
// when it is not already there, so a refresh never depends on the build stamp
// or the environment after the first login.
func persistClientCredentials(store *Store, provider string, flow PKCEFlow) {
	if store == nil || strings.TrimSpace(flow.ClientID) == "" {
		return
	}
	id, secret := store.LoadClient(provider)
	if strings.TrimSpace(id) == "" {
		_ = store.SaveClient(provider, flow.ClientID, flow.ClientSecret)
		return
	}
	if strings.TrimSpace(secret) == "" && strings.TrimSpace(flow.ClientSecret) != "" {
		_ = store.SaveClient(provider, id, flow.ClientSecret)
	}
}

// pkceFlowFromSpec maps a spec to the PKCE flow, resolving a client credential
// from the environment, then the secret store, when the spec names one.
func pkceFlowFromSpec(spec Spec, store *Store) PKCEFlow {
	clientID := spec.ClientID
	if spec.ClientIDEnv != "" {
		if value := strings.TrimSpace(os.Getenv(spec.ClientIDEnv)); value != "" {
			clientID = value
		}
	}
	clientSecret := spec.ClientSecret
	if spec.ClientSecretEnv != "" {
		if value := strings.TrimSpace(os.Getenv(spec.ClientSecretEnv)); value != "" {
			clientSecret = value
		}
	}
	if store != nil && (strings.TrimSpace(clientID) == "" || strings.TrimSpace(clientSecret) == "") {
		if id, secret := store.LoadClient(spec.Provider); strings.TrimSpace(id) != "" {
			if strings.TrimSpace(clientID) == "" {
				clientID = id
			}
			if strings.TrimSpace(clientSecret) == "" {
				clientSecret = secret
			}
		}
	}
	return PKCEFlow{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		AuthorizeURL: spec.AuthorizeURL,
		TokenURL:     spec.TokenURL,
		Scopes:       spec.Scopes,
		RedirectPort: spec.RedirectPort,
		RedirectPath: spec.RedirectPath,
		ExtraAuth:    spec.ExtraAuth,
		ExchangeJSON: spec.ExchangeJSON,
		RefreshJSON:  spec.RefreshJSON,
		RefreshScope: spec.RefreshScope,
	}
}

// AccessToken returns a valid access token for a provider, refreshing and
// saving when the stored one has expired. It returns "" when no login exists.
// A credential the vendor has already aged out is dropped rather than sent,
// so the next action is a re-login instead of a stream of dead bearers.
func AccessToken(ctx context.Context, store *Store, provider string) string {
	token, ok := store.Load(provider)
	if !ok {
		return ""
	}
	spec, ok := SpecFor(provider)
	if !ok || strings.TrimSpace(token.Refresh) == "" {
		return token.Access
	}
	if provider == "muse" {
		if !token.Expires.IsZero() {
			token.Expires = time.Time{}
			_ = store.Save(provider, token)
		}
		if strings.TrimSpace(token.Access) != "" {
			return token.Access
		}
	}
	lead := spec.RefreshLead
	if lead <= 0 {
		lead = defaultRefreshLead
	}
	if token.Valid(time.Now(), lead) && !token.Stale(time.Now(), spec.MaxRefreshAge) {
		return token.Access
	}
	refreshed, err := refreshTokenOnce(ctx, store, spec, token)
	if err == nil && strings.TrimSpace(refreshed.Access) != "" {
		return refreshed.Access
	}
	var grant *GrantError
	if errors.As(err, &grant) {
		// The refresh token itself is dead (revoked, or reused after a
		// rotation). Keep sending its bearer only if the access token still
		// works; otherwise drop the login so HasKey, /status and the setup
		// wizard all agree the operator must log in again.
		if token.Valid(time.Now(), 0) || (provider == "muse" && strings.TrimSpace(token.Access) != "") {
			return token.Access
		}
		_ = store.Delete(provider)
		return ""
	}
	// A network hiccup or a vendor-side 5xx is not the credential's fault.
	// Hand back what we have and let the next call try again.
	return token.Access
}

// ForceRefreshToken forces a renewal of the access token using the stored refresh
// token regardless of local expiration timestamps.
func ForceRefreshToken(ctx context.Context, store *Store, provider string) string {
	token, ok := store.Load(provider)
	if !ok {
		return ""
	}
	spec, ok := SpecFor(provider)
	if !ok || strings.TrimSpace(token.Refresh) == "" {
		return token.Access
	}
	refreshed, err := refreshTokenOnce(ctx, store, spec, token)
	if err == nil && strings.TrimSpace(refreshed.Access) != "" {
		return refreshed.Access
	}
	var grant *GrantError
	if errors.As(err, &grant) {
		if provider == "muse" && strings.TrimSpace(token.Access) != "" {
			return token.Access
		}
		_ = store.Delete(provider)
		return ""
	}
	return token.Access
}

// refreshFlights serialises refreshes per provider, the way 9router's
// withCredentialRefreshLock does. Refresh tokens rotate on use at these
// vendors, and replaying an already-rotated token can invalidate the whole
// session (the OpenAI comment on codex refreshLeadMs is blunt about it: a
// lost rotation logs the account out). Two goroutines that both found a token
// expired must therefore make one HTTP refresh, not two.
var refreshFlights sync.Map // provider -> *sync.Mutex

func refreshTokenOnce(ctx context.Context, store *Store, spec Spec, token Token) (Token, error) {
	lock, _ := refreshFlights.LoadOrStore(spec.Provider, new(sync.Mutex))
	lock.(*sync.Mutex).Lock()
	defer lock.(*sync.Mutex).Unlock()

	// Another caller may have refreshed while this one queued behind the
	// lock. Its saved token is now the good one; do not replay a rotated
	// refresh token against it.
	if current, ok := store.Load(spec.Provider); ok && current.Access != token.Access {
		lead := spec.RefreshLead
		if lead <= 0 {
			lead = defaultRefreshLead
		}
		if current.Valid(time.Now(), lead) {
			return current, nil
		}
		token = current
		if strings.TrimSpace(token.Refresh) == "" {
			return Token{}, fmt.Errorf("the stored %s login has no refresh token", spec.Provider)
		}
	}

	clock := Clock{}
	var refreshed Token
	var err error
	switch spec.Kind {
	case "copilot":
		refreshed, err = FetchCopilotToken(ctx, spec.CopilotTokenURL, token.Refresh, clock)
	case "muse":
		refreshed, err = MintMetaKey(ctx, spec.MintURL, token.Refresh)
		if err == nil {
			refreshed.Expires = time.Time{}
			if strings.TrimSpace(refreshed.Refresh) == "" {
				refreshed.Refresh = token.Refresh
			}
		}
	case "codex":
		refreshed, err = RefreshCodex(ctx, CodexFlow{ClientID: spec.ClientID, Issuer: spec.Issuer}, token.Refresh, clock)
	case "pkce":
		flow := pkceFlowFromSpec(spec, store)
		if strings.TrimSpace(flow.ClientID) == "" {
			// No client credentials to refresh with; keep the current access
			// token until the operator logs in again.
			return token, nil
		}
		refreshed, err = RefreshPKCE(ctx, flow, token.Refresh, clock)
	default:
		refreshed, err = RefreshDevice(ctx, DeviceFlow{ClientID: spec.ClientID, DeviceURL: spec.DeviceURL, TokenURL: spec.TokenURL}, token.Refresh, clock)
	}
	if err != nil || strings.TrimSpace(refreshed.Access) == "" {
		return Token{}, err
	}
	if refreshed.AccountID == "" {
		refreshed.AccountID = token.AccountID
	}
	refreshed.LastRefresh = clock.now()
	if err := store.Save(spec.Provider, refreshed); err != nil {
		return Token{}, err
	}
	return refreshed, nil
}
