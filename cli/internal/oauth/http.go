package oauth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// client is the shared HTTP client for the login flows.
var client = &http.Client{Timeout: 30 * time.Second}

// requestForm posts url-encoded form data. The body and status are returned
// even for a 4xx, because a device poll answers "authorization_pending" with a
// 400 that the caller must read rather than treat as a hard failure.
func requestForm(ctx context.Context, endpoint string, form map[string]string) ([]byte, int, error) {
	values := url.Values{}
	for key, value := range form {
		values.Set(key, value)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(values.Encode()))
	if err != nil {
		return nil, 0, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	return send(request)
}

// requestJSON posts or gets a JSON body.
func requestJSON(ctx context.Context, method, endpoint string, headers map[string]string, payload any) ([]byte, int, error) {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return nil, 0, err
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, 0, err
	}
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("Accept", "application/json")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	return send(request)
}

func send(request *http.Request) ([]byte, int, error) {
	response, err := client.Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, response.StatusCode, err
	}
	return body, response.StatusCode, nil
}

// statusError names a non-success response with a little of its body. A body
// that says the grant itself is dead comes back as a *GrantError instead, so a
// caller can tell "retry later" from "log in again" without parsing text.
func statusError(endpoint string, status int, body []byte) error {
	if grant := grantError(body); grant != nil {
		return grant
	}
	text := strings.TrimSpace(string(body))
	if len(text) > 200 {
		text = text[:200]
	}
	return fmt.Errorf("%s returned %d: %s", endpoint, status, text)
}
