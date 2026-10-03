package telegram

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// withTransferTimeout shortens the transfer deadline so a test proves the
// deadline fires in milliseconds instead of waiting out the real minute.
func withTransferTimeout(t *testing.T, d time.Duration) {
	t.Helper()
	original := downloadUploadTimeout
	downloadUploadTimeout = d
	t.Cleanup(func() { downloadUploadTimeout = original })
}

// stallServer answers a request by never writing a byte, holding the
// connection open until the client gives up, which is exactly the shape of a
// stuck transfer the deadline exists to bound.
//
// The fallback timer matters for the POST case: a handler that never reads the
// request body does not see the client's disconnect until shutdown, so
// Server.Close would block on it for the whole test binary timeout. Five
// seconds is far above every deadline a test sets and far below the timeout
// the suite allows.
func stallServer() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	}))
}

// TestMarkdownChunksFitsInOnePart proves a body whose converted HTML stays
// under the cap is never split: chunking exists for the overflow, not as a
// tax on every message.
func TestMarkdownChunksFitsInOnePart(t *testing.T) {
	text := "hello **world**\nsecond line\n"
	chunks := markdownChunks(text, messageLimit)
	if len(chunks) != 1 || chunks[0] != text {
		t.Fatalf("a fitting body must pass through whole, got %d chunks", len(chunks))
	}
	if markdownChunks("", messageLimit) != nil {
		t.Fatal("empty input must chunk to nil")
	}
}

// TestMarkdownChunksEntityHeavyBody proves the split is measured on the
// CONVERTED body, not the raw Markdown. Nine hundred "&<>" lines are 3.6 KB
// raw - inside the 3800 target a raw splitter would have shipped in one
// message - but every entity expands when escaped, and the converted body is
// three times that. Telegram refuses the oversized body and clampText drops
// the tail, which is the field truncation this splitter exists to prevent.
func TestMarkdownChunksEntityHeavyBody(t *testing.T) {
	text := strings.Repeat("&<>\n", 900)
	if len(text) > telegramChunkLimit {
		t.Fatalf("test premise: raw size %d should be inside the 3800-byte raw target", len(text))
	}
	if converted := len(markdownToTelegramHTML(text)); converted <= messageLimit {
		t.Fatalf("test premise: converted size %d should exceed the cap", converted)
	}
	chunks := markdownChunks(text, messageLimit)
	if len(chunks) < 2 {
		t.Fatalf("an expanding body must split, got %d chunks", len(chunks))
	}
	total := 0
	for i, part := range chunks {
		if n := len(markdownToTelegramHTML(part)); n > messageLimit {
			t.Fatalf("chunk %d converts to %d bytes, past the %d cap", i, n, messageLimit)
		}
		total += len(part)
	}
	if strings.Join(chunks, "") != text {
		t.Fatalf("chunks must rejoin into the original exactly, lost %d of %d bytes",
			len(text)-total, len(text))
	}
}

// TestMarkdownChunksLargePlainBody proves a big but cheap body still arrives
// whole: every chunk fits, and the parts rejoin without a gap.
func TestMarkdownChunksLargePlainBody(t *testing.T) {
	var b strings.Builder
	for i := 0; b.Len() < 30_000; i++ {
		fmt.Fprintf(&b, "line %d: plain prose\n", i)
	}
	text := b.String()
	chunks := markdownChunks(text, messageLimit)
	if len(chunks) < 2 {
		t.Fatalf("30 KB must split into several messages, got %d", len(chunks))
	}
	for i, part := range chunks {
		if n := len(markdownToTelegramHTML(part)); n > messageLimit {
			t.Fatalf("chunk %d converts to %d bytes, past the %d cap", i, n, messageLimit)
		}
	}
	if strings.Join(chunks, "") != text {
		t.Fatal("chunks must rejoin into the original exactly")
	}
}

// TestDownloadFileHasItsOwnDeadline proves a stalled file server fails within
// the transfer timeout instead of hanging the update handler: the shared
// client keeps Timeout 0 for the long-poll, so the per-request context is the
// only bound a download has.
func TestDownloadFileHasItsOwnDeadline(t *testing.T) {
	withTransferTimeout(t, 250*time.Millisecond)
	stalled := stallServer()
	defer stalled.Close()

	client := newClientAt("test-token", stalled.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	start := time.Now()
	_, err := client.DownloadFile(ctx, "photos/file_123.jpg")
	if err == nil {
		t.Fatal("a stalled download should fail, not hang forever")
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("download took %v to fail; the transfer deadline did not bound it", elapsed)
	}
	if !strings.Contains(err.Error(), "context deadline exceeded") {
		t.Errorf("expected a deadline error, got: %v", err)
	}
}

// TestSendDocumentHasItsOwnDeadline proves an upload that never answers is
// bounded the same way.
func TestSendDocumentHasItsOwnDeadline(t *testing.T) {
	withTransferTimeout(t, 250*time.Millisecond)
	stalled := stallServer()
	defer stalled.Close()

	client := newClientAt("test-token", stalled.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	start := time.Now()
	_, err := client.SendDocument(ctx, 12345, "notes.txt", []byte("hello"), "caption")
	if err == nil {
		t.Fatal("a stalled upload should fail, not hang forever")
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("upload took %v to fail; the transfer deadline did not bound it", elapsed)
	}
}

// TestDownloadFileSucceedsQuickly proves the deadline only bounds a slow
// transfer: a server that answers right away still delivers the bytes.
func TestDownloadFileSucceedsQuickly(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "file-bytes")
	}))
	defer server.Close()

	client := newClientAt("test-token", server.URL)
	data, err := client.DownloadFile(context.Background(), "photos/file_1.jpg")
	if err != nil {
		t.Fatalf("download failed: %v", err)
	}
	if string(data) != "file-bytes" {
		t.Fatalf("data = %q", string(data))
	}
}

// TestGetUpdatesStillLongPolls proves the transfer deadline was not bolted
// onto the shared client, which would break the long-poll: a getUpdates call
// must keep using the caller's own window.
func TestGetUpdatesStillLongPolls(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Answer after 2s, which exceeds nothing but proves the call waits
		// for the server rather than tripping a short client timeout.
		time.Sleep(2 * time.Second)
		fmt.Fprint(w, `{"ok":true,"result":[]}`)
	}))
	defer server.Close()

	client := newClientAt("test-token", server.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	start := time.Now()
	updates, err := client.GetUpdates(ctx, 0, 5)
	if err != nil {
		t.Fatalf("getUpdates failed: %v", err)
	}
	if len(updates) != 0 {
		t.Fatalf("updates = %+v, want none", updates)
	}
	if time.Since(start) < 1500*time.Millisecond {
		t.Fatal("getUpdates returned before the server answered; the long-poll window was cut short")
	}
}
