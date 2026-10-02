package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

// FetchCopilotToken exchanges or refreshes a GitHub OAuth token for a Copilot session token.
func FetchCopilotToken(ctx context.Context, endpoint, githubAccessToken string, clock Clock) (Token, error) {
	if endpoint == "" {
		endpoint = "https://api.github.com/copilot_internal/v2/token"
	}
	headers := map[string]string{
		"Authorization":         "token " + githubAccessToken,
		"Accept":                "application/json",
		"User-Agent":            "GitHubCopilotChat/0.38.0",
		"Editor-Version":        "vscode/1.110.0",
		"Editor-Plugin-Version": "copilot-chat/0.38.0",
		"x-github-api-version":  "2025-04-01",
	}
	body, status, err := requestJSON(ctx, http.MethodGet, endpoint, headers, nil)
	if err != nil {
		return Token{}, err
	}
	if status >= 300 {
		return Token{}, statusError(endpoint, status, body)
	}
	var parsed struct {
		Token     string  `json:"token"`
		ExpiresAt flexInt `json:"expires_at"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return Token{}, err
	}
	if parsed.Token == "" {
		return Token{}, errors.New("copilot token response contained no token")
	}
	now := clock.now()
	expires := now.Add(30 * time.Minute)
	if parsed.ExpiresAt > 0 {
		expires = time.Unix(int64(parsed.ExpiresAt), 0)
	}
	return Token{
		Access:      parsed.Token,
		Refresh:     githubAccessToken, // Store the long-lived GitHub access token as Refresh
		Expires:     expires,
		LastRefresh: now,
	}, nil
}
