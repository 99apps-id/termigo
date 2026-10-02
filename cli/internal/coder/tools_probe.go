package coder

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type probeURLTool struct{}

func (t *probeURLTool) Name() string      { return "probe_url" }
func (t *probeURLTool) Aliases() []string { return []string{"health_check", "http_probe"} }
func (t *probeURLTool) Mutating() bool    { return false }
func (t *probeURLTool) Risk() Risk        { return RiskNetwork }
func (t *probeURLTool) Label(a map[string]any) string {
	return "Probing " + Shorten(argString(a, "url"), 50)
}
func (t *probeURLTool) DoneLabel(a map[string]any) string {
	return "Probed " + Shorten(argString(a, "url"), 50)
}
func (t *probeURLTool) Description() string {
	return "Send an HTTP request to a local service or dev-server on a loopback address (127.0.0.1, localhost, [::1]) to verify it is running and healthy. Non-loopback addresses are rejected for safety."
}
func (t *probeURLTool) Schema() map[string]any {
	return object(map[string]any{
		"url":             strProp("Loopback URL to probe (e.g. http://localhost:8080/health)."),
		"method":          strProp("HTTP method to use (GET, HEAD, POST). Defaults to GET."),
		"timeout_secs":    intProp("Timeout in seconds, 1 to 30. Defaults to 5."),
		"expected_status": intProp("Expected HTTP status code (e.g. 200). If mismatched, marks result as error."),
		"retry_count":     intProp("Number of retries if connection fails, 0 to 10. Defaults to 0."),
		"retry_delay_ms":  intProp("Delay between retries in milliseconds, 100 to 5000. Defaults to 500."),
	}, "url")
}

func isLoopbackHost(host string) bool {
	h, _, err := net.SplitHostPort(host)
	if err != nil {
		h = host
	}
	h = strings.Trim(h, "[]")
	if strings.EqualFold(h, "localhost") {
		return true
	}
	ip := net.ParseIP(h)
	if ip != nil && ip.IsLoopback() {
		return true
	}
	return false
}

func (t *probeURLTool) Run(ctx context.Context, env *Env, args map[string]any) (Result, error) {
	rawURL := strings.TrimSpace(argString(args, "url"))
	if rawURL == "" {
		return Result{Output: "URL is required.", IsError: true}, nil
	}

	parsed, err := url.Parse(rawURL)
	if err != nil {
		return Result{Output: fmt.Sprintf("invalid URL: %v", err), IsError: true}, nil
	}

	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return Result{Output: fmt.Sprintf("unsupported scheme %q; only http and https are allowed", scheme), IsError: true}, nil
	}

	if !isLoopbackHost(parsed.Host) {
		return Result{
			Output:  fmt.Sprintf("probe_url is restricted to loopback addresses (localhost, 127.0.0.1, [::1]); host %q is rejected", parsed.Host),
			IsError: true,
		}, nil
	}

	method := strings.ToUpper(strings.TrimSpace(argString(args, "method")))
	if method == "" {
		method = "GET"
	}
	switch method {
	case "GET", "HEAD", "POST":
	default:
		return Result{Output: fmt.Sprintf("unsupported method %q; use GET, HEAD, or POST", method), IsError: true}, nil
	}

	timeoutSecs := argInt(args, "timeout_secs", 5, 1, 30)
	retryCount := argInt(args, "retry_count", 0, 0, 10)
	retryDelayMs := argInt(args, "retry_delay_ms", 500, 100, 5000)
	expectedStatus := argInt(args, "expected_status", 0, 100, 599)

	var lastErr error
	var resp *http.Response
	var duration time.Duration

	client := &http.Client{
		Timeout: time.Duration(timeoutSecs) * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("stopped after 10 redirects")
			}
			if !isLoopbackHost(req.URL.Host) {
				return fmt.Errorf("redirect to non-loopback host %q blocked", req.URL.Host)
			}
			return nil
		},
	}

	for attempt := 0; attempt <= retryCount; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return Result{Output: "probe canceled", IsError: true}, nil
			case <-time.After(time.Duration(retryDelayMs) * time.Millisecond):
			}
		}

		req, reqErr := http.NewRequestWithContext(ctx, method, rawURL, nil)
		if reqErr != nil {
			return Result{Output: fmt.Sprintf("build request: %v", reqErr), IsError: true}, nil
		}
		req.Header.Set("User-Agent", "Termixgo-Probe/1.0")

		start := time.Now()
		resp, lastErr = client.Do(req)
		duration = time.Since(start)
		if lastErr == nil {
			break
		}
	}

	if lastErr != nil {
		return Result{
			Output:  fmt.Sprintf("Failed to connect to %s after %d attempt(s): %v", rawURL, retryCount+1, lastErr),
			IsError: true,
		}, nil
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	bodySnippet := strings.TrimSpace(string(bodyBytes))

	isErr := false
	if expectedStatus > 0 && resp.StatusCode != expectedStatus {
		isErr = true
	} else if resp.StatusCode >= 500 {
		isErr = true
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "HTTP %s (latency: %dms)\n", resp.Status, duration.Milliseconds())
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		fmt.Fprintf(&sb, "Content-Type: %s\n", ct)
	}
	if bodySnippet != "" {
		sb.WriteString("\nResponse Body:\n")
		sb.WriteString(bodySnippet)
	}

	if expectedStatus > 0 && resp.StatusCode != expectedStatus {
		fmt.Fprintf(&sb, "\nWarning: status code %d did not match expected %d", resp.StatusCode, expectedStatus)
	}

	return Result{
		Output:  sb.String(),
		IsError: isErr,
	}, nil
}
