package oauth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// museExpiry returns the expiration timestamp for a minted Muse key.
// The device grant yields a durable dca token with no refresh grant, and the
// minted inference key is stable for the account with no advertised expiry.
// The session persists indefinitely and is renewed on demand from the stored
// dca token, so it returns a zero time.Time and never expires locally.
func museExpiry(deviceExpiry, now time.Time) time.Time {
	return time.Time{}
}

// metaDefaultMintURL is where a Meta Muse device token is exchanged for an LLM
// API key. The device grant yields a durable "dca:" token that the model
// endpoint rejects; the minted key is the credential that works.
const metaDefaultMintURL = "https://api.meta.ai/muse-code/key"

// metaUserAgent identifies the caller as the Muse CLI. Meta gates the mint and
// the Responses endpoint on this identity, so the official client string is
// reused rather than sending the Termigo user agent.
const metaUserAgent = "muse-code/1.0.2"

// metaMintedKey is the subset of the mint response Termigo needs.
type metaMintedKey struct {
	APIKey       string `json:"api_key"`
	APIKeyCamel  string `json:"apiKey"`
	Key          string `json:"key"`
	BaseURL      string `json:"base_url"`
	UserEmail    string `json:"user_email"`
	UserFullName string `json:"user_full_name"`
	// IsSubsActive is false when the account's Muse Code subscription is
	// inactive, in which case the minted key (if any) cannot chat.
	IsSubsActive *bool `json:"is_subs_active"`
	// RequirePayment and the action URLs mark an account that must
	// subscribe before the model endpoint serves it.
	RequirePayment          bool   `json:"require_payment"`
	ActionURL               string `json:"action_url"`
	RequirePaymentActionURL string `json:"require_payment_action_url"`
	SubscriptionTierName    string `json:"subs_tier_name"`
}

// key returns the minted credential under any name the server uses.
func (m metaMintedKey) key() string {
	for _, value := range []string{m.APIKey, m.APIKeyCamel, m.Key} {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

// metaMintAttempts bounds the mint retries. The endpoint is aggressively
// rate-limited (429) and intermittently fails (5xx), and the device code is
// one-shot, so a transient failure is retried here instead of failing the
// login.
const metaMintAttempts = 3

// metaMintRetryWait pauses between mint retries. It is a variable so a test
// can remove the delay.
var metaMintRetryWait = 2 * time.Second

// MintMetaKey exchanges a Meta device (dca) token for the API key the Responses
// endpoint accepts.
//
// The onboard flag enrolls the account on first login; without it a fresh
// account mints a key the model endpoint answers with 404 model_not_found,
// which reads as a broken chat rather than a missing subscription. The key
// becomes the stored access token and the dca token is kept as the refresh,
// so a revoked or expired key can be re-minted without another login.
func MintMetaKey(ctx context.Context, mintURL, dcaToken string) (Token, error) {
	dcaToken = strings.TrimSpace(dcaToken)
	if dcaToken == "" {
		return Token{}, fmt.Errorf("muse: missing device token")
	}
	if strings.TrimSpace(mintURL) == "" {
		mintURL = metaDefaultMintURL
	}
	var body []byte
	var status int
	var err error
	for attempt := 1; ; attempt++ {
		body, status, err = requestJSON(ctx, http.MethodPost, mintURL, map[string]string{
			"Authorization": "Bearer " + dcaToken,
			"User-Agent":    metaUserAgent,
			"x-api-version": "1.0.0",
		}, map[string]any{"onboard": true})
		if err != nil {
			return Token{}, fmt.Errorf("muse: mint request failed: %w", err)
		}
		transient := status == http.StatusTooManyRequests || status >= 500
		if !transient || attempt >= metaMintAttempts {
			break
		}
		if waitErr := sleepWithContext(ctx, metaMintRetryWait); waitErr != nil {
			return Token{}, waitErr
		}
	}
	if status >= 300 {
		return Token{}, statusError(mintURL, status, body)
	}
	var minted metaMintedKey
	if err := json.Unmarshal(body, &minted); err != nil {
		return Token{}, fmt.Errorf("muse: read mint response: %v", err)
	}
	if err := checkMintSubscription(minted); err != nil {
		return Token{}, err
	}
	// user_email is the one field in the mint that says which Meta account this
	// key came from. It is stored as the account id, which App already hands to
	// the client, so a credential that cannot reach a model can name the account
	// behind it instead of leaving the operator to work out which machine
	// logged in as whom.
	return Token{Access: minted.key(), Refresh: dcaToken, AccountID: strings.TrimSpace(minted.UserEmail)}, nil
}

// checkMintSubscription rejects a mint response whose account cannot chat: an
// inactive subscription or a payment demand. Failing here keeps a key the
// model endpoint would answer with 404 model_not_found out of the store, so
// the operator gets the real cause at login instead of a broken chat. It is a
// pure function so the rejection is testable without a network server.
func checkMintSubscription(minted metaMintedKey) error {
	if minted.IsSubsActive != nil && !*minted.IsSubsActive {
		return fmt.Errorf("muse: the Muse Code subscription is inactive; activate it on muse.ai first")
	}
	if minted.key() == "" {
		action := strings.TrimSpace(minted.ActionURL)
		if action == "" {
			action = strings.TrimSpace(minted.RequirePaymentActionURL)
		}
		if minted.RequirePayment || action != "" {
			if action != "" {
				return fmt.Errorf("muse: a Muse Code subscription is required: %s", action)
			}
			return fmt.Errorf("muse: a Muse Code subscription is required")
		}
		return fmt.Errorf("muse: the mint response had no api_key")
	}
	return nil
}

// sleepWithContext pauses, returning early when the context ends.
func sleepWithContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// museTokenFromDevice builds the stored Muse credential from a completed
// device grant. Minting is best effort: when the mint fails the durable dca
// token is kept as a dca-only login and the key is minted lazily before the
// first request, so a transient mint outage does not fail the login.
func museTokenFromDevice(ctx context.Context, mintURL string, device Token, now time.Time) (Token, string, error) {
	dca := strings.TrimSpace(device.Access)
	if dca == "" {
		dca = strings.TrimSpace(device.Refresh)
	}
	if dca == "" {
		return Token{}, "", fmt.Errorf("muse: the device grant returned no token")
	}
	minted, err := MintMetaKey(ctx, mintURL, dca)
	if err == nil {
		minted.Expires = museExpiry(device.Expires, now)
		minted.Refresh = dca
		return minted, "", nil
	}
	deferred := Token{Access: "", Refresh: dca, Expires: time.Time{}}
	return deferred, fmt.Sprintf("Muse key mint deferred (%v); will mint on first use.", err), nil
}
