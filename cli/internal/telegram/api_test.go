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
