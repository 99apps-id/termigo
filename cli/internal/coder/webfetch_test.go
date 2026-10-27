package coder

import (
	"context"
	"errors"
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

// TestDialGuardRefusesMetadataAddresses pins the dial-time guard. A name whose
// record points at the metadata endpoint is only caught here, because the URL
// checks run before resolution.
func TestDialGuardRefusesMetadataAddresses(t *testing.T) {
	blocked := []string{
		"169.254.169.254:80",
		"[fe80::1]:80",
		"[fd00:ec2::254]:80",
	}
	for _, address := range blocked {
		err := blockMetadataAddress("tcp", address, nil)
		if !errors.Is(err, errBlockedAddress) {
			t.Errorf("%s: err = %v, want a refusal", address, err)
		}
	}

	// Loopback and the private ranges stay reachable: the local dev server is a
	// supported target and the guard would otherwise break every test fetch.
	allowed := []string{"127.0.0.1:8080", "[::1]:8080", "10.0.0.5:80", "192.168.1.10:443"}
	for _, address := range allowed {
		if err := blockMetadataAddress("tcp", address, nil); err != nil {
			t.Errorf("%s: err = %v, want the dial allowed", address, err)
		}
	}
}

// TestIsBlockedHostCoversBothIPFamilies keeps the literal check aligned with
// the dial guard, including the IPv6 metadata address.
func TestIsBlockedHostCoversBothIPFamilies(t *testing.T) {
	for _, host := range []string{
		"169.254.169.254",
		"metadata.google.internal",
		"fd00:ec2::254",
		"[fd00:ec2::254]",
		"169.254.1.1",
	} {
		if !isBlockedHost(host) {
			t.Errorf("%s should be refused", host)
		}
	}
	for _, host := range []string{"example.com", "127.0.0.1", "localhost", "10.0.0.1"} {
		if isBlockedHost(host) {
			t.Errorf("%s should be allowed", host)
		}
	}
}
