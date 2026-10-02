// Package oauth performs the model-provider logins that are not a static API
// key: an OAuth device flow and the refresh that keeps it alive. A token is
// stored as one JSON entry in the 0600 secret file, under oauth:<provider>.
package oauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/99apps-id/termigo/cli/internal/secrets"
)

// flexInt accepts a JSON number or a numeric string. Some OAuth servers send
// values such as interval and expires_in as strings, which a plain int field
// rejects during Unmarshal.
type flexInt int

func (f *flexInt) UnmarshalJSON(data []byte) error {
	text := strings.TrimSpace(string(data))
	if text == "" || text == "null" {
		return nil
	}
	if strings.HasPrefix(text, `"`) {
		var inner string
		if err := json.Unmarshal(data, &inner); err != nil {
			return err
		}
		text = strings.TrimSpace(inner)
		if text == "" {
			return nil
		}
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return fmt.Errorf("expected a number, got %s", text)
	}
	*f = flexInt(int(value))
	return nil
}

// KeyPrefix namespaces token entries in the secret store.
const KeyPrefix = "oauth:"

// Token is one OAuth credential. Access is the bearer sent to the provider,
// Refresh renews it, and Expires is when Access stops being valid. AccountID
// is the provider-side account a Codex token belongs to, needed in a header.
// LastRefresh records when this credential was last renewed: some vendors age
// a refresh token out long before its access token expires.
type Token struct {
	Access      string    `json:"access"`
	Refresh     string    `json:"refresh,omitempty"`
	Expires     time.Time `json:"expires,omitempty"`
	AccountID   string    `json:"accountId,omitempty"`
	LastRefresh time.Time `json:"lastRefresh,omitempty"`
}

// Valid reports whether the access token is usable at now, with room to spare.
func (t Token) Valid(now time.Time, skew time.Duration) bool {
	if strings.TrimSpace(t.Access) == "" {
		return false
	}
	if t.Expires.IsZero() {
		return true
	}
	return now.Add(skew).Before(t.Expires)
}

// Stale reports whether the credential has been left unrefreshed for longer
// than maxAge, which is how a provider with a short refresh-token life (OpenAI
// ages a Codex grant out in about eight days) gets renewed before it dies. An
// unknown age counts as stale so the first call refreshes it.
func (t Token) Stale(now time.Time, maxAge time.Duration) bool {
	if maxAge <= 0 {
		return false
	}
	if t.LastRefresh.IsZero() {
		return true
	}
	return !now.Before(t.LastRefresh.Add(maxAge))
}

// Store persists OAuth tokens in the secret store.
type Store struct {
	mu      sync.Mutex
	secrets *secrets.Store
}

// NewStore wraps a secret store.
func NewStore(store *secrets.Store) *Store { return &Store{secrets: store} }

// Load returns the stored token for a provider.
func (s *Store) Load(provider string) (Token, bool) {
	if s == nil || s.secrets == nil {
		return Token{}, false
	}
	s.mu.Lock()
	raw := s.secrets.Get(KeyPrefix + provider)
	s.mu.Unlock()
	if strings.TrimSpace(raw) == "" {
		return Token{}, false
	}
	var token Token
	if err := json.Unmarshal([]byte(raw), &token); err != nil {
		return Token{}, false
	}
	return token, true
}

// Save writes a token for a provider.
func (s *Store) Save(provider string, token Token) error {
	if s == nil || s.secrets == nil {
		return errors.New("no secret store is available")
	}
	data, err := json.Marshal(token)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.secrets.Set(KeyPrefix+provider, string(data))
}

// Delete removes a stored token.
func (s *Store) Delete(provider string) error {
	if s == nil || s.secrets == nil {
		return errors.New("no secret store is available")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.secrets.Delete(KeyPrefix + provider)
}

// LoadClient returns stored OAuth client credentials for a provider. They are
// the public installed-app pair a vendor's CLI ships, kept out of the source so
// GitHub secret scanning does not flag the repository.
func (s *Store) LoadClient(provider string) (id, secret string) {
	if s == nil || s.secrets == nil {
		return "", ""
	}
	s.mu.Lock()
	raw := s.secrets.Get(KeyPrefix + provider + ":client")
	s.mu.Unlock()
	if strings.TrimSpace(raw) == "" {
		return "", ""
	}
	var parsed struct {
		ClientID     string `json:"clientId"`
		ClientSecret string `json:"clientSecret"`
	}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return "", ""
	}
	return parsed.ClientID, parsed.ClientSecret
}

// SaveClient stores OAuth client credentials for a provider.
func (s *Store) SaveClient(provider, id, secret string) error {
	if s == nil || s.secrets == nil {
		return errors.New("no secret store is available")
	}
	data, err := json.Marshal(map[string]string{"clientId": id, "clientSecret": secret})
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.secrets.Set(KeyPrefix+provider+":client", string(data))
}

// Clock makes the poll loop testable.
type Clock struct {
	Now   func() time.Time
	Sleep func(ctx context.Context, d time.Duration) error
}

func (c Clock) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c Clock) sleep(ctx context.Context, d time.Duration) error {
	if c.Sleep != nil {
		return c.Sleep(ctx, d)
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// DeviceFlow is a standard RFC 8628 device authorization. xAI/Grok uses it.
type DeviceFlow struct {
	ClientID  string
	Scope     string
	DeviceURL string
	TokenURL  string
	// VerifyHint is a URL to show the operator when the server returns none.
	VerifyHint string
}

// DeviceCode is what the operator must act on.
type DeviceCode struct {
	DeviceCode              string
	UserCode                string
	VerificationURI         string
	VerificationURIComplete string
	Interval                time.Duration
	ExpiresIn               time.Duration
}

type deviceResponse struct {
	DeviceCode              string  `json:"device_code"`
	UserCode                string  `json:"user_code"`
	VerificationURI         string  `json:"verification_uri"`
	VerificationURIComplete string  `json:"verification_uri_complete"`
	Interval                flexInt `json:"interval"`
	ExpiresIn               flexInt `json:"expires_in"`
}

// StartDevice requests a device code.
func StartDevice(ctx context.Context, flow DeviceFlow) (DeviceCode, error) {
	form := map[string]string{"client_id": flow.ClientID}
	if strings.TrimSpace(flow.Scope) != "" {
		form["scope"] = flow.Scope
	}
	body, status, err := requestForm(ctx, flow.DeviceURL, form)
	if err != nil {
		return DeviceCode{}, err
	}
	if status >= 300 {
		return DeviceCode{}, statusError(flow.DeviceURL, status, body)
	}
	var parsed deviceResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return DeviceCode{}, fmt.Errorf("read device code: %v", err)
	}
	if parsed.DeviceCode == "" || parsed.UserCode == "" {
		return DeviceCode{}, errors.New("the device code response is missing device_code or user_code")
	}
	interval := time.Duration(parsed.Interval) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second
	}
	expires := time.Duration(parsed.ExpiresIn) * time.Second
	if expires <= 0 {
		expires = 15 * time.Minute
	}
	verification := parsed.VerificationURIComplete
	if verification == "" {
		verification = parsed.VerificationURI
	}
	if verification == "" {
		verification = flow.VerifyHint
	}
	return DeviceCode{
		DeviceCode:              parsed.DeviceCode,
		UserCode:                parsed.UserCode,
		VerificationURI:         parsed.VerificationURI,
		VerificationURIComplete: verification,
		Interval:                interval,
		ExpiresIn:               expires,
	}, nil
}

type tokenResponse struct {
	AccessToken  string  `json:"access_token"`
	RefreshToken string  `json:"refresh_token"`
	IDToken      string  `json:"id_token"`
	ExpiresIn    flexInt `json:"expires_in"`
	Error        string  `json:"error"`
}

// WaitDevice polls until the operator approves, the code expires, or ctx ends.
func WaitDevice(ctx context.Context, flow DeviceFlow, code DeviceCode, clock Clock) (Token, error) {
	deadline := clock.now().Add(code.ExpiresIn)
	interval := code.Interval
	for {
		if !clock.now().Before(deadline) {
			return Token{}, errors.New("the device code expired before it was approved")
		}
		if err := clock.sleep(ctx, interval); err != nil {
			return Token{}, err
		}
		body, status, err := requestForm(ctx, flow.TokenURL, map[string]string{
			"grant_type":  "urn:ietf:params:oauth:grant-type:device_code",
			"device_code": code.DeviceCode,
			"client_id":   flow.ClientID,
		})
		if err != nil {
			return Token{}, err
		}
		if status >= 500 {
			return Token{}, statusError(flow.TokenURL, status, body)
		}
		var parsed tokenResponse
		_ = json.Unmarshal(body, &parsed)
		switch parsed.Error {
		case "":
			if parsed.AccessToken == "" {
				return Token{}, fmt.Errorf("the token response had no access_token")
			}
			return tokenFrom(parsed, clock.now()), nil
		case "authorization_pending":
			continue
		case "slow_down":
			interval += 5 * time.Second
		case "access_denied":
			return Token{}, errors.New("the login was denied")
		case "expired_token":
			return Token{}, errors.New("the device code expired")
		default:
			return Token{}, fmt.Errorf("login failed: %s", parsed.Error)
		}
	}
}

// RefreshDevice renews an RFC 8628 device-flow token.
func RefreshDevice(ctx context.Context, flow DeviceFlow, refreshToken string, clock Clock) (Token, error) {
	body, status, err := requestForm(ctx, flow.TokenURL, map[string]string{
		"grant_type":    "refresh_token",
		"refresh_token": refreshToken,
		"client_id":     flow.ClientID,
	})
	if err != nil {
		return Token{}, err
	}
	if status >= 300 {
		return Token{}, statusError(flow.TokenURL, status, body)
	}
	var parsed tokenResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return Token{}, fmt.Errorf("read refresh: %v", err)
	}
	if parsed.AccessToken == "" {
		return Token{}, fmt.Errorf("refresh returned no access_token")
	}
	token := tokenFrom(parsed, clock.now())
	if token.Refresh == "" {
		token.Refresh = refreshToken
	}
	return token, nil
}

func tokenFrom(parsed tokenResponse, now time.Time) Token {
	token := Token{Access: parsed.AccessToken, Refresh: parsed.RefreshToken}
	if parsed.ExpiresIn > 0 {
		token.Expires = now.Add(time.Duration(parsed.ExpiresIn) * time.Second)
	}
	// The ChatGPT account id rides in the token claims; the Codex client needs
	// it for the ChatGPT-Account-ID header later.
	token.AccountID = AccountIDFromJWT(parsed.AccessToken)
	if token.AccountID == "" {
		token.AccountID = AccountIDFromJWT(parsed.IDToken)
	}
	return token
}

// AccountIDFromJWT reads the ChatGPT account id out of an access or id token.
func AccountIDFromJWT(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		return ""
	}
	if auth, ok := claims["https://api.openai.com/auth"].(map[string]any); ok {
		if value, ok := auth["chatgpt_account_id"].(string); ok && value != "" {
			return value
		}
	}
	if value, ok := claims["chatgpt_account_id"].(string); ok {
		return value
	}
	return ""
}
