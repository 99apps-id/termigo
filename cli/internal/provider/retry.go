package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// userAgent identifies the client on every request.
const userAgent = "termigo-cli"

// Retry policy. A transient failure should cost a pause, not the whole turn:
// rate limits and short network faults are normal when a long agent run makes
// many requests in a row.
const (
	maxPostAttempts  = 4
	baseRetryDelay   = 700 * time.Millisecond
	maxRetryDelay    = 20 * time.Second
	streamStallDelay = 90 * time.Second
)

// errStreamStalled reports that the provider accepted the request and then
// went silent, which no header timeout can detect.
var errStreamStalled = errors.New("provider stopped sending data")

// retryError carries the provider's own retry hint, if it sent one.
type retryError struct {
	err   error
	after time.Duration
}

func (e *retryError) Error() string { return e.err.Error() }
func (e *retryError) Unwrap() error { return e.err }

// post sends a JSON body and returns the response, retrying transient
// failures before giving up.
//
// Retrying is only safe before the body is consumed: once a caller starts
// reading streamed chunks the request has already produced output, so this is
// the only place a retry can happen.
func (c *httpClient) post(ctx context.Context, url string, headers map[string]string, body any) (*http.Response, error) {
	return c.postWithStall(ctx, url, headers, body, streamStallDelay)
}

// postWithStall is post with an explicit stall window, which tests shorten so
// the watchdog can be exercised without waiting out the real timeout.
func (c *httpClient) postWithStall(ctx context.Context, url string, headers map[string]string, body any, stall time.Duration) (*http.Response, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("encode %s request: %w", c.info.Label, err)
	}

	var lastErr error
	for attempt := 1; attempt <= maxPostAttempts; attempt++ {
		if attempt > 1 {
			if err := sleepContext(ctx, retryDelay(attempt, lastErr)); err != nil {
				return nil, err
			}
		}

		streamCtx, cancel := context.WithCancel(ctx)
		request, err := http.NewRequestWithContext(streamCtx, http.MethodPost, url, bytes.NewReader(encoded))
		if err != nil {
			cancel()
			return nil, err
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Accept", "text/event-stream")
		request.Header.Set("User-Agent", userAgent)
		for key, value := range headers {
			request.Header.Set(key, value)
		}

		response, err := c.http.Do(request)
		if err != nil {
			cancel()
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			lastErr = fmt.Errorf("%s request failed: %w", c.info.Label, err)
			if !retryableTransport(err) {
				return nil, lastErr
			}
			continue
		}

		if response.StatusCode >= 200 && response.StatusCode < 300 {
			// The guard turns a silent provider into a clear failure instead
			// of a run that hangs until the operator gives up.
			response.Body = newStallGuard(response.Body, stall, cancel)
			return response, nil
		}

		after := parseRetryAfter(response.Header.Get("Retry-After"))
		statusErr := c.statusError(response)
		cancel()
		response.Body.Close()
		if !retryableStatus(response.StatusCode) {
			return nil, statusErr
		}
		lastErr = &retryError{err: statusErr, after: after}
	}
	return nil, lastErr
}

// retryableStatus reports whether a status is worth another attempt.
func retryableStatus(status int) bool {
	switch status {
	case http.StatusRequestTimeout, http.StatusTooManyRequests,
		http.StatusInternalServerError, http.StatusBadGateway,
		http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	}
	return false
}

// retryableTransport reports whether a transport failure is likely transient.
// A DNS or TLS configuration error is not: retrying it three times only makes
// the operator wait for the same answer.
func retryableTransport(err error) bool {
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) {
		return true
	}
	// A dropped or reset connection is worth another attempt. A DNS or TLS
	// configuration error is not, but the message is the only signal some
	// platforms give, and one retry costs far less than a failed turn.
	message := strings.ToLower(err.Error())
	for _, needle := range []string{
		"connection reset", "connection refused", "broken pipe",
		"unexpected eof", "server closed", "no such host", "i/o timeout",
	} {
		if strings.Contains(message, needle) {
			return true
		}
	}
	return false
}

// retryDelay computes the wait before an attempt, honouring a provider hint.
func retryDelay(attempt int, lastErr error) time.Duration {
	var hinted *retryError
	if errors.As(lastErr, &hinted) && hinted.after > 0 {
		if hinted.after > maxRetryDelay {
			return maxRetryDelay
		}
		return hinted.after
	}
	delay := baseRetryDelay
	for index := 1; index < attempt-1; index++ {
		delay *= 2
		if delay >= maxRetryDelay {
			return maxRetryDelay
		}
	}
	// Jitter keeps several parallel runs from retrying in lockstep.
	jitter := time.Duration(rand.Int63n(int64(delay / 2)))
	return delay + jitter
}

// parseRetryAfter reads a Retry-After header, which may be seconds or a date.
func parseRetryAfter(value string) time.Duration {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(trimmed); err == nil {
		if seconds < 0 {
			return 0
		}
		return time.Duration(seconds) * time.Second
	}
	if when, err := http.ParseTime(trimmed); err == nil {
		if wait := time.Until(when); wait > 0 {
			return wait
		}
	}
	return 0
}

// sleepContext waits, returning early when the context is cancelled so a stop
// during a backoff is immediate.
func sleepContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return ctx.Err()
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

// stallGuard aborts a stream that has produced nothing for a while.
//
// The response body is wrapped so every read rearms the timer. When the timer
// fires the request context is cancelled, which unblocks the pending read.
type stallGuard struct {
	body    io.ReadCloser
	timeout time.Duration
	stop    context.CancelFunc
	timer   *time.Timer

	mu      sync.Mutex
	stalled bool
	closed  bool
}

func newStallGuard(body io.ReadCloser, timeout time.Duration, stop context.CancelFunc) *stallGuard {
	guard := &stallGuard{body: body, timeout: timeout, stop: stop}
	guard.timer = time.AfterFunc(timeout, guard.fire)
	return guard
}

func (g *stallGuard) fire() {
	g.mu.Lock()
	if g.closed {
		g.mu.Unlock()
		return
	}
	g.stalled = true
	g.mu.Unlock()
	g.stop()
}

// Read forwards to the body and reports a stall as its own error, so a caller
// can tell a silent provider from a cancellation.
func (g *stallGuard) Read(buffer []byte) (int, error) {
	count, err := g.body.Read(buffer)
	if err != nil && g.didStall() {
		return count, errStreamStalled
	}
	if err == nil {
		g.rearm()
	}
	return count, err
}

func (g *stallGuard) rearm() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed || g.stalled {
		return
	}
	g.timer.Reset(g.timeout)
}

func (g *stallGuard) didStall() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.stalled
}

// Close stops the timer, cancels the request context and closes the body.
func (g *stallGuard) Close() error {
	g.mu.Lock()
	g.closed = true
	g.mu.Unlock()
	g.timer.Stop()
	g.stop()
	return g.body.Close()
}

// StallError reports whether an error came from the stall guard, and returns
// the operator-facing message.
func StallError(err error, timeout time.Duration) (string, bool) {
	if errors.Is(err, errStreamStalled) {
		return "stopped sending data for " + timeout.Round(time.Second).String() +
			"; the connection may have dropped. Try again, or switch model with /model", true
	}
	return "", false
}

// wrapStreamError turns a stream read failure into an actionable error. A
// stall is named separately because its fix differs from an API error: the
// connection dropped, not the request being wrong.
func wrapStreamError(label string, err error) error {
	if message, stalled := StallError(err, streamStallDelay); stalled {
		return fmt.Errorf("%s %s", label, message)
	}
	return fmt.Errorf("%s stream interrupted: %w", label, err)
}
