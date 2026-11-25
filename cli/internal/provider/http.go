package provider

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

// httpClient is the shared plumbing: one tuned transport, one JSON POST, one
// SSE reader. The per-provider clients only build payloads and decode chunks.
type httpClient struct {
	info    Provider
	baseURL string
	apiKey  string
	// accountID is the provider-side account a Codex token belongs to, sent in
	// the ChatGPT-Account-ID header. Empty for every other provider.
	accountID       string
	sessionID       string
	resolveKey      KeyResolver
	forceResolveKey KeyResolver
	http            *http.Client
}

// SetAccountID records the account a Codex token belongs to.
func (c *httpClient) SetAccountID(id string) { c.accountID = strings.TrimSpace(id) }

// SetSessionID records the conversation or client session id.
func (c *httpClient) SetSessionID(id string) { c.sessionID = strings.TrimSpace(id) }

// SetKeyResolver sets the dynamic key resolver callback.
func (c *httpClient) SetKeyResolver(fn KeyResolver) { c.resolveKey = fn }

// SetForceKeyResolver sets the force key renewal callback.
func (c *httpClient) SetForceKeyResolver(fn KeyResolver) { c.forceResolveKey = fn }

// currentKey returns the most current API key or OAuth access token,
// dynamically resolving via KeyResolver if available.
func (c *httpClient) currentKey() string {
	if c.resolveKey != nil {
		if fresh := strings.TrimSpace(c.resolveKey(c.info.ID)); fresh != "" {
			c.apiKey = fresh
			return fresh
		}
	}
	return c.apiKey
}

// refreshKey unconditionally renews the OAuth access token (e.g. after receiving a 401).
func (c *httpClient) refreshKey() string {
	if c.forceResolveKey != nil {
		if fresh := strings.TrimSpace(c.forceResolveKey(c.info.ID)); fresh != "" {
			c.apiKey = fresh
			return fresh
		}
	}
	return c.currentKey()
}

// SessionID returns the current session ID, or generates a stable binary-style ID.
func (c *httpClient) SessionID() string {
	if c.sessionID != "" {
		return c.sessionID
	}
	c.sessionID = deriveSessionID(c.apiKey)
	return c.sessionID
}

func deriveSessionID(seed string) string {
	sum := sha256.Sum256([]byte(seed + fmt.Sprintf("%d", time.Now().UnixNano())))
	return hex.EncodeToString(sum[:16]) + fmt.Sprintf("%d", time.Now().UnixMilli())
}

func newHTTPClient(info Provider, baseURL, apiKey string) (Client, error) {
	shared := &http.Client{
		// No overall timeout: a stream legitimately runs for minutes. A
		// stalled connection still fails fast because the header timeout
		// below only guards the start of the response.
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 20 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          16,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   20 * time.Second,
			ResponseHeaderTimeout: 120 * time.Second,
			ExpectContinueTimeout: time.Second,
		},
	}
	base := &httpClient{info: info, baseURL: strings.TrimRight(baseURL, "/"), apiKey: apiKey, http: shared}
	// A Codex login targets the ChatGPT Responses backend, not chat-completions.
	if info.ID == "openai-codex" {
		return &codexClient{httpClient: base}, nil
	}
	if info.Kind == KindAntigravity {
		return &antigravityClient{httpClient: base}, nil
	}
	if info.Kind == KindCopilot || info.ID == "github-copilot" {
		return &copilotClient{httpClient: base}, nil
	}
	if info.Kind == KindMuse {
		return &museClient{httpClient: base}, nil
	}
	switch info.Kind {
	case KindAnthropic:
		return &anthropicClient{httpClient: base}, nil
	case KindGoogle:
		return &googleClient{httpClient: base}, nil
	default:
		return &openAIClient{httpClient: base}, nil
	}
}

func (c *httpClient) ID() string { return c.info.ID }

// statusError turns a provider error body into an actionable message.
func (c *httpClient) statusError(response *http.Response) error {
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 8192))
	message := strings.TrimSpace(string(raw))
	var parsed struct {
		Error struct {
			Message string `json:"message"`
			Type    string `json:"type"`
		} `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &parsed) == nil {
		switch {
		case parsed.Error.Message != "":
			message = parsed.Error.Message
		case parsed.Message != "":
			message = parsed.Message
		}
	}
	if len(message) > 500 {
		message = clipRunes(message, 500) + "..."
	}
	if message == "" {
		message = http.StatusText(response.StatusCode)
	}
	hint := ""
	switch response.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		hint = " (check the API key with /setup)"
	case http.StatusTooManyRequests:
		hint = " (rate limited; retry shortly)"
	case http.StatusNotFound:
		hint = " (check the model id and base URL)"
	}
	return fmt.Errorf("%s returned %d: %s%s", c.info.Label, response.StatusCode, message, hint)
}

// sseReader reads Server-Sent Events and yields each event's joined data.
type sseReader struct {
	scanner *bufio.Scanner
}

// clipRunes returns the first limit bytes of text, moved back to a rune
// boundary.
//
// The provider's error body is free text and may be in any language, so a byte
// slice at a fixed offset can land inside a multi-byte character and store
// invalid UTF-8 that the terminal paints as a replacement glyph.
func clipRunes(text string, limit int) string {
	if limit <= 0 || len(text) <= limit {
		return text
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut]
}

func newSSEReader(body io.Reader) *sseReader {
	scanner := bufio.NewScanner(body)
	// Provider chunks can be large: a tool call argument or a long reasoning
	// block arrives in one event.
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	return &sseReader{scanner: scanner}
}

// next returns the next event payload, or io.EOF when the stream ends.
func (r *sseReader) next() (string, error) {
	var data []string
	for r.scanner.Scan() {
		line := strings.TrimRight(r.scanner.Text(), "\r")
		if line == "" {
			if len(data) == 0 {
				continue
			}
			return strings.Join(data, "\n"), nil
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		if after, ok := strings.CutPrefix(line, "data:"); ok {
			data = append(data, strings.TrimPrefix(after, " "))
		}
	}
	if err := r.scanner.Err(); err != nil {
		return "", err
	}
	if len(data) > 0 {
		return strings.Join(data, "\n"), nil
	}
	return "", io.EOF
}
