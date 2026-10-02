package coder

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestWebFetchReducesHTMLToText proves web_fetch returns readable text and does
// not leak script or style bodies.
func TestWebFetchReducesHTMLToText(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "text/html")
		fmt.Fprint(writer, "<html><body><h1>Guide</h1><p>Use it</p><script>var secret=1</script><style>.x{color:red}</style></body></html>")
	}))
	defer server.Close()

	result, err := (&webFetchTool{}).Run(context.Background(), &Env{}, map[string]any{"url": server.URL})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.IsError {
		t.Fatalf("web_fetch errored: %s", result.Output)
	}
	if !strings.Contains(result.Output, "Guide") || !strings.Contains(result.Output, "Use it") {
		t.Errorf("output = %q, want the page text", result.Output)
	}
	if strings.Contains(result.Output, "secret") || strings.Contains(result.Output, "color:red") {
		t.Errorf("script or style leaked into %q", result.Output)
	}
}

// TestWebFetchRefusesMetadataHost keeps the SSRF guard: the cloud metadata
// address is refused before any request.
func TestWebFetchRefusesMetadataHost(t *testing.T) {
	result, err := (&webFetchTool{}).Run(context.Background(), &Env{}, map[string]any{"url": "http://169.254.169.254/latest/meta-data/"})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !result.IsError {
		t.Fatalf("metadata host should be refused, got %q", result.Output)
	}
}
