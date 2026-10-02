package oauth

import (
	"encoding/json"
	"strings"
)

// GrantError is an OAuth response that says the credential behind a request is
// dead, not merely expired: the refresh token was revoked, reused, or rejected.
// No retry can fix it, so the stored login has to be dropped and the operator
// asked to log in again. 9router marks the same set of codes "permanent" in
// classifyOAuthRefreshError and treats them as an unrecoverable refresh error.
type GrantError struct {
	Code    string
	Message string
}

func (e *GrantError) Error() string {
	message := strings.TrimSpace(e.Message)
	if message == "" {
		return "the login no longer works (" + e.Code + "); run termigo login again"
	}
	return "the login no longer works (" + e.Code + ": " + message + "); run termigo login again"
}

// permanentGrantCodes are the markers that mean a refresh token is never
// coming back. "invalid_grant" is the RFC 6749 answer for an expired or
// revoked grant; the others are what Google and OpenAI return when a rotated
// refresh token is replayed, which can also revoke the whole session.
var permanentGrantCodes = []string{
	"invalid_grant",
	"refresh_token_expired",
	"refresh_token_reused",
	"refresh_token_invalidated",
}

func isPermanentGrantCode(code string) bool {
	lower := strings.ToLower(strings.TrimSpace(code))
	if lower == "" {
		return false
	}
	for _, marker := range permanentGrantCodes {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

// grantCode pulls the error code out of an OAuth error body. Providers put it
// in "error" (a string or an object with "code"), or in "error_code".
func grantCode(payload map[string]any) (code, description string) {
	switch value := payload["error"].(type) {
	case string:
		code = value
	case map[string]any:
		if nested, ok := value["code"].(string); ok {
			code = nested
		} else if nested, ok := value["type"].(string); ok {
			code = nested
		}
	}
	if code == "" {
		if value, ok := payload["error_code"].(string); ok {
			code = value
		}
	}
	for _, key := range []string{"error_description", "message", "detail"} {
		if value, ok := payload[key].(string); ok && strings.TrimSpace(value) != "" {
			description = value
			break
		}
	}
	return code, description
}

// grantError reports the permanent failure hidden in a response body, if any.
func grantError(body []byte) *GrantError {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return nil
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(text), &payload); err != nil {
		// A non-JSON body can still carry the marker in plain text.
		if isPermanentGrantCode(text) {
			return &GrantError{Code: firstGrantMarker(text), Message: trimBody(text)}
		}
		return nil
	}
	code, description := grantCode(payload)
	combined := code + " " + description
	if !isPermanentGrantCode(combined) {
		return nil
	}
	if code == "" {
		code = firstGrantMarker(combined)
	}
	return &GrantError{Code: code, Message: trimBody(description)}
}

// firstGrantMarker finds which permanent marker a text carries, so the error
// the operator sees names the real cause.
func firstGrantMarker(text string) string {
	lower := strings.ToLower(text)
	for _, marker := range permanentGrantCodes {
		if strings.Contains(lower, marker) {
			return marker
		}
	}
	return "invalid_grant"
}

func trimBody(text string) string {
	if len(text) > 200 {
		return text[:200]
	}
	return text
}
