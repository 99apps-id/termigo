package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// CodexFlow is the OpenAI Codex device login. It is not RFC 8628: the start
// returns a user code and a device_auth_id, the operator approves at
// {issuer}/codex/device, and the poll then yields an authorization code plus
// the PKCE verifier the server generated, which the token exchange uses.
type CodexFlow struct {
	ClientID string
	Issuer   string
}

const codexDefaultIssuer = "https://auth.openai.com"

func (f CodexFlow) issuer() string {
	if strings.TrimSpace(f.Issuer) == "" {
		return codexDefaultIssuer
	}
	return strings.TrimRight(f.Issuer, "/")
}

func (f CodexFlow) deviceURL() string { return f.issuer() + "/api/accounts/deviceauth/usercode" }
func (f CodexFlow) pollURL() string   { return f.issuer() + "/api/accounts/deviceauth/token" }
func (f CodexFlow) tokenURL() string  { return f.issuer() + "/oauth/token" }
func (f CodexFlow) callback() string  { return f.issuer() + "/deviceauth/callback" }

// VerifyURL is where the operator approves the code.
func (f CodexFlow) VerifyURL() string { return f.issuer() + "/codex/device" }

// CodexDevice is what the operator must act on.
type CodexDevice struct {
	UserCode     string
	DeviceAuthID string
	Interval     time.Duration
}

// StartCodexDevice requests a device code.
func StartCodexDevice(ctx context.Context, flow CodexFlow) (CodexDevice, error) {
	body, status, err := requestJSON(ctx, http.MethodPost, flow.deviceURL(), nil, map[string]any{"client_id": flow.ClientID})
	if err != nil {
		return CodexDevice{}, err
	}
	if status >= 300 {
		return CodexDevice{}, statusError(flow.deviceURL(), status, body)
	}
	var parsed struct {
		UserCode     string  `json:"user_code"`
		DeviceAuthID string  `json:"device_auth_id"`
		Interval     flexInt `json:"interval"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return CodexDevice{}, err
	}
	if parsed.UserCode == "" || parsed.DeviceAuthID == "" {
		return CodexDevice{}, errors.New("the device code response is missing user_code or device_auth_id")
	}
	interval := time.Duration(parsed.Interval) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second
	}
	return CodexDevice{UserCode: parsed.UserCode, DeviceAuthID: parsed.DeviceAuthID, Interval: interval}, nil
}

// WaitCodexToken polls until the operator approves, the code expires, or ctx
// ends, then exchanges the authorization code for tokens.
func WaitCodexToken(ctx context.Context, flow CodexFlow, device CodexDevice, clock Clock) (Token, error) {
	interval := device.Interval
	if interval <= 0 {
		interval = 5 * time.Second
	}
	deadline := clock.now().Add(15 * time.Minute)
	for {
		if !clock.now().Before(deadline) {
			return Token{}, errors.New("the device code expired before it was approved")
		}
		if err := clock.sleep(ctx, interval); err != nil {
			return Token{}, err
		}
		body, status, err := requestJSON(ctx, http.MethodPost, flow.pollURL(), nil, map[string]any{
			"device_auth_id": device.DeviceAuthID,
			"user_code":      device.UserCode,
		})
		if err != nil {
			return Token{}, err
		}
		switch {
		case status == http.StatusBadRequest || status == http.StatusForbidden || status == http.StatusNotFound:
			// Still pending; keep waiting.
			continue
		case status >= 300:
			return Token{}, statusError(flow.pollURL(), status, body)
		}
		var grant struct {
			AuthorizationCode string `json:"authorization_code"`
			CodeVerifier      string `json:"code_verifier"`
		}
		if err := json.Unmarshal(body, &grant); err != nil {
			continue
		}
		if grant.AuthorizationCode == "" {
			continue
		}
		return exchangeCodexCode(ctx, flow, grant.AuthorizationCode, grant.CodeVerifier, clock)
	}
}

func exchangeCodexCode(ctx context.Context, flow CodexFlow, code, verifier string, clock Clock) (Token, error) {
	form := map[string]string{
		"grant_type":   "authorization_code",
		"code":         code,
		"redirect_uri": flow.callback(),
		"client_id":    flow.ClientID,
	}
	if strings.TrimSpace(verifier) != "" {
		form["code_verifier"] = verifier
	}
	body, status, err := requestForm(ctx, flow.tokenURL(), form)
	if err != nil {
		return Token{}, err
	}
	if status >= 300 {
		return Token{}, statusError(flow.tokenURL(), status, body)
	}
	var parsed codexToken
	if err := json.Unmarshal(body, &parsed); err != nil {
		return Token{}, err
	}
	if parsed.AccessToken == "" {
		return Token{}, errors.New("the token exchange returned no access_token")
	}
	return parsed.toToken(clock.now()), nil
}

// RefreshCodex renews a Codex token.
func RefreshCodex(ctx context.Context, flow CodexFlow, refreshToken string, clock Clock) (Token, error) {
	body, status, err := requestForm(ctx, flow.tokenURL(), map[string]string{
		"grant_type":    "refresh_token",
		"refresh_token": refreshToken,
		"client_id":     flow.ClientID,
	})
	if err != nil {
		return Token{}, err
	}
	if status >= 300 {
		return Token{}, statusError(flow.tokenURL(), status, body)
	}
	var parsed codexToken
	if err := json.Unmarshal(body, &parsed); err != nil {
		return Token{}, err
	}
	if parsed.AccessToken == "" {
		return Token{}, errors.New("refresh returned no access_token")
	}
	token := parsed.toToken(clock.now())
	if token.Refresh == "" {
		token.Refresh = refreshToken
	}
	return token, nil
}

type codexToken struct {
	AccessToken  string  `json:"access_token"`
	RefreshToken string  `json:"refresh_token"`
	IDToken      string  `json:"id_token"`
	ExpiresIn    flexInt `json:"expires_in"`
}

func (t codexToken) toToken(now time.Time) Token {
	token := Token{Access: t.AccessToken, Refresh: t.RefreshToken}
	if t.ExpiresIn > 0 {
		token.Expires = now.Add(time.Duration(t.ExpiresIn) * time.Second)
	}
	account := AccountIDFromJWT(t.AccessToken)
	if account == "" {
		account = AccountIDFromJWT(t.IDToken)
	}
	token.AccountID = account
	return token
}
