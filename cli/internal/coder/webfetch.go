package coder

import (
	"context"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// webFetchTool retrieves a URL as text.
type webFetchTool struct{}

func (t *webFetchTool) Name() string      { return "web_fetch" }
func (t *webFetchTool) Aliases() []string { return []string{"fetch_url", "http_get"} }
func (t *webFetchTool) Mutating() bool    { return false }
func (t *webFetchTool) Risk() Risk        { return RiskNetwork }
func (t *webFetchTool) Label(a map[string]any) string {
	return "Fetching " + Shorten(argString(a, "url"), 50)
}
func (t *webFetchTool) DoneLabel(a map[string]any) string {
	return "Fetched " + Shorten(argString(a, "url"), 50)
}
func (t *webFetchTool) Description() string {
	return "Read the content of one known URL (a documentation page, changelog or article) as readable text. HTML is reduced to text. If the direct fetch is blocked by DNS it automatically retries through the r.jina.ai reader; set reader=true to force the reader for a JavaScript page. To find a URL for a question, use web_search first."
}
func (t *webFetchTool) Schema() map[string]any {
	return object(map[string]any{
		"url":    strProp("Absolute http or https URL."),
		"reader": boolProp("Force the r.jina.ai reader instead of a direct fetch. The tool already falls back to the reader automatically when a direct fetch is blocked or bot-blocked; set this for a JavaScript page."),
	}, "url")
}

// webReaderBase is the reader service web_fetch can route through when a site
// is blocked locally or needs JavaScript. Its host is reached instead of the
// target, so a DNS block on the target no longer blocks the read.
var webReaderBase = "https://r.jina.ai/"

// RE2 has no backreferences, so each container tag is spelled out.
var (
	scriptBlock  = regexp.MustCompile(`(?is)<script\b.*?</script\s*>|<style\b.*?</style\s*>|<noscript\b.*?</noscript\s*>|<template\b.*?</template\s*>`)
	commentBlock = regexp.MustCompile(`(?s)<!--.*?-->`)
	// blockBreak marks where text continues on a new line, so two blocks such
	// as <h1>Guide</h1><p>Body</p> do not run together into "GuideBody".
	blockBreak = regexp.MustCompile(`(?is)</(?:p|div|section|article|li|tr|h[1-6]|blockquote|pre|ul|ol|table|header|footer|nav|aside|figure|figcaption|details|summary)\s*>|<br\s*/?>`)
	tagPattern = regexp.MustCompile(`(?s)<[^>]*>`)
	spaceRun   = regexp.MustCompile(`[ \t\r\f\v]+`)
)

// errBlockedRedirect reports a redirect to a host the tool refuses to fetch.
var errBlockedRedirect = errors.New("redirect target is a link-local or cloud metadata address")

// fetchClient is the client web_fetch uses.
//
// The direct URL is checked before the request in Run; the redirect is checked
// here, because a redirect is a second URL the model did not choose and
// http.DefaultClient follows one blindly. Without this a page that redirected
// to 169.254.169.254 reached the cloud metadata endpoint the guard exists to
// keep out, which is the one host the operator cannot see being contacted.
//
// It shares the tuned transport from webSearchClient so DNS, timeouts and
// keep-alives are consistent across both web tools.
var fetchClient = &http.Client{
	Transport: webSearchClient.Transport,
	CheckRedirect: func(request *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("stopped after 5 redirects")
		}
		if isBlockedHost(request.URL.Hostname()) {
			return fmt.Errorf("%w: %s", errBlockedRedirect, request.URL.Hostname())
		}
		return nil
	},
	Timeout: 60 * time.Second,
}

func (t *webFetchTool) Run(ctx context.Context, env *Env, args map[string]any) (Result, error) {
	raw := strings.TrimSpace(argString(args, "url"))
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return Result{Output: "url must be an absolute http or https URL", IsError: true}, nil
	}
	if isBlockedHost(parsed.Hostname()) {
		return Result{Output: "That host is a link-local or cloud metadata address, which the agent does not fetch.", IsError: true}, nil
	}
	forcedReader := argBool(args, "reader", false)

	result, status, transportErr := fetchOnce(ctx, raw, forcedReader)
	if transportErr == nil {
		// A direct fetch that came back empty or bot-blocked (403/429) is what
		// the reader fixes, so it is retried automatically rather than asking
		// the model to know about the flag.
		blocked := status == http.StatusForbidden || status == http.StatusTooManyRequests
		if !forcedReader && (blocked || strings.TrimSpace(result.Output) == "") {
			if viaReader, _, readerErr := fetchOnce(ctx, raw, true); readerErr == nil {
				return viaReader, nil
			}
		}
		return result, nil
	}
	if errors.Is(transportErr, errBlockedRedirect) {
		return Result{Output: "That URL redirects to a link-local or cloud metadata address, which the agent does not fetch.", IsError: true}, nil
	}
	if !forcedReader && isNetworkUnreachable(transportErr) {
		if viaReader, _, readerErr := fetchOnce(ctx, raw, true); readerErr == nil {
			return viaReader, nil
		}
	}
	if isNetworkUnreachable(transportErr) {
		return Result{
			Output:  fmt.Sprintf("fetch failed: %v\nHint: the direct fetch, the DNS-over-HTTPS resolver and the r.jina.ai reader all failed for this host, so this is about this URL, not the machine. Do not tell the operator the machine cannot fetch. Try another URL, web_search, or the lookup tool.", transportErr),
			IsError: true,
		}, nil
	}
	return Result{Output: fmt.Sprintf("fetch failed: %v", transportErr), IsError: true}, nil
}

// fetchOnce performs one fetch. A non-nil error is a transport failure, so the
// caller can decide whether to retry through the reader; an HTTP status or a
// refused host is returned as an error Result instead. status is 0 when the
// request never reached the server.
func fetchOnce(ctx context.Context, raw string, reader bool) (Result, int, error) {
	target := raw
	if reader {
		target = strings.TrimRight(webReaderBase, "/") + "/" + raw
	}
	requestCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, target, nil)
	if err != nil {
		return Result{}, 0, err
	}
	request.Header.Set("User-Agent", "Termixgo/0.1 (+https://github.com/99apps-id/termixgo)")
	response, err := fetchClient.Do(request)
	if err != nil {
		return Result{}, 0, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Result{Output: fmt.Sprintf("fetch returned %s", response.Status), IsError: true}, response.StatusCode, nil
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024))
	if err != nil {
		return Result{}, 0, err
	}
	text := string(body)
	if !reader && looksLikeHtml(response.Header.Get("Content-Type"), text) {
		text = htmlToText(text)
	}
	if len(text) > 20000 {
		text = clipBytes(text, 20000) + "\n... [truncated]"
	}
	if reader {
		// Name the source, so the model knows a reader service, not the local
		// machine, read the page.
		text = "Source: reader (r.jina.ai)\n\n" + text
	}
	return Result{Output: text}, response.StatusCode, nil
}

// isBlockedHost refuses the cloud metadata addresses and the link-local range,
// which are never the documentation the model meant to read.
//
// Loopback and the private ranges are deliberately allowed: a documentation
// server running on the operator's own machine is a legitimate target, and the
// project's own tests fetch from one. That does leave the tool able to reach a
// service on the local network, which is recorded in the audit rather than
// enforced here.
func isBlockedHost(host string) bool {
	trimmed := strings.ToLower(strings.TrimSpace(host))
	if trimmed == "169.254.169.254" || trimmed == "metadata.google.internal" {
		return true
	}
	if ip := net.ParseIP(trimmed); ip != nil && ip.IsLinkLocalUnicast() {
		return true
	}
	return false
}

// htmlToText reduces a page to readable text.
//
// The document is split on block boundaries first and each piece is flattened
// on its own. A plain tag strip leaves the tags empty, so adjacent blocks such
// as <h1>Guide</h1><p>Use it</p> merged into "GuideUse it"; splitting first
// keeps the boundary and lets whitespace collapse the way HTML treats it.
func htmlToText(raw string) string {
	cleaned := scriptBlock.ReplaceAllString(raw, " ")
	cleaned = commentBlock.ReplaceAllString(cleaned, " ")
	chunks := blockBreak.Split(cleaned, -1)
	lines := make([]string, 0, len(chunks))
	for _, chunk := range chunks {
		text := tagPattern.ReplaceAllString(chunk, " ")
		text = html.UnescapeString(text)
		text = strings.ReplaceAll(text, "\u00a0", " ")
		text = spaceRun.ReplaceAllString(text, " ")
		if trimmed := strings.TrimSpace(text); trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	return strings.Join(lines, "\n")
}

// looksLikeHtml reports whether a body should be reduced to text, from its
// content type or, when that is missing, from the document itself.
func looksLikeHtml(contentType, body string) bool {
	if strings.Contains(strings.ToLower(contentType), "html") {
		return true
	}
	trimmed := strings.ToLower(strings.TrimSpace(body))
	return strings.HasPrefix(trimmed, "<!doctype html") || strings.HasPrefix(trimmed, "<html")
}
