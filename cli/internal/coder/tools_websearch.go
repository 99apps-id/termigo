package coder

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

// webSearchHTMLEndpoint is the keyless results page. DuckDuckGo's instant
// answer API only knows topics it has a card for, so a normal query such as an
// error message returns nothing; the HTML page is the actual search. It is a
// variable so tests can point it at a local server instead of the network.
var webSearchHTMLEndpoint = "https://html.duckduckgo.com/html/"

// webSearchEndpoint is the keyless instant-answer API, kept as a fallback for
// the queries the HTML page refuses (it serves a bot check now and then).
var webSearchEndpoint = "https://api.duckduckgo.com/"

// webSearchWikipediaEndpoint is a second keyless source. Every DuckDuckGo host
// can be unreachable at once, because an ISP or a firewall may block the whole
// domain, and a search that only knows one vendor dies with it. Wikipedia
// answers entity and topic queries from anywhere.
var webSearchWikipediaEndpoint = "https://en.wikipedia.org/w/api.php"

// webSearchGitHubEndpoint is a third keyless source, aimed at the queries a
// coding agent actually makes: an error message, a library or a repository.
var webSearchGitHubEndpoint = "https://api.github.com/search/repositories"

// webSearchClient is the shared HTTP client for all web search and fetch
// operations. It uses a tuned transport with proper timeouts and a pure-Go
// DNS resolver on Windows, so the agent's web tools are not derailed by a
// misbehaving system resolver or a VPN tunnel that breaks the CGO lookup path.
var webSearchClient = &http.Client{
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           dialWithDoHFallback,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          16,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	},
	Timeout: 60 * time.Second,
}

// webSearchSource names where results came from, so the model knows how much
// to trust a general web search against a reference or code lookup.
type webSearchSource string

const (
	sourceDuckDuckGo webSearchSource = "duckduckgo"
	sourceWikipedia  webSearchSource = "wikipedia"
	sourceGitHub     webSearchSource = "github"
	sourceTavily     webSearchSource = "tavily"
	sourceBrave      webSearchSource = "brave"
)

// Keyed search endpoints. A keyed provider is tried first when its key is
// configured, which is what keeps search working where DuckDuckGo is blocked
// by DNS: an ISP can drop one hostname, not a paid API on another domain.
var (
	webSearchTavilyEndpoint = "https://api.tavily.com/search"
	webSearchBraveEndpoint  = "https://api.search.brave.com/res/v1/web/search"
)

// webSearchUserAgent identifies the tool. DuckDuckGo's HTML page answers a
// browser-like agent and rejects some empty ones, so the header is explicit.
const webSearchUserAgent = "Mozilla/5.0 (compatible; Termixgo/0.1; +https://github.com/99apps-id/termixgo)"

// webSearchTimeout bounds one search attempt. Discovery should be quick; the
// fetch tool remains for reading whatever the search finds.
const webSearchTimeout = 15 * time.Second

// webSearchTool searches the web and returns titles, URLs and snippets. It
// answers "what changed recently" where web_fetch only reads a known page.
type webSearchTool struct{}

func (t *webSearchTool) Name() string      { return "web_search" }
func (t *webSearchTool) Aliases() []string { return []string{"search_web", "websearch"} }
func (t *webSearchTool) Mutating() bool    { return false }
func (t *webSearchTool) Risk() Risk        { return RiskNetwork }
func (t *webSearchTool) Label(a map[string]any) string {
	return "Searching " + Shorten(argString(a, "query"), 50)
}
func (t *webSearchTool) DoneLabel(a map[string]any) string {
	return "Searched " + Shorten(argString(a, "query"), 50)
}
func (t *webSearchTool) Description() string {
	return "Search the web for documentation, changelogs or error messages and return titles with URLs and snippets. Use it before guessing at a new API, then read the best hit with web_fetch."
}
func (t *webSearchTool) Schema() map[string]any {
	return object(map[string]any{
		"query": strProp("Search query."),
		"count": intProp("Maximum results, 1 to 10. Defaults to 5."),
	}, "query")
}

// searchResult is one hit, ready to render.
type searchResult struct {
	title   string
	url     string
	snippet string
}

// line is the display form handed to the model: title, URL and snippet, each
// on its own line so a URL is never glued to the words around it.
func (r searchResult) line() string {
	parts := []string{r.title}
	if strings.TrimSpace(r.url) != "" {
		parts = append(parts, strings.TrimSpace(r.url))
	}
	if strings.TrimSpace(r.snippet) != "" {
		parts = append(parts, strings.TrimSpace(r.snippet))
	}
	return strings.Join(parts, "\n")
}

func (t *webSearchTool) Run(ctx context.Context, env *Env, args map[string]any) (Result, error) {
	query := strings.TrimSpace(argString(args, "query"))
	if query == "" {
		return Result{Output: "query is required", IsError: true}, nil
	}
	count := argInt(args, "count", 5, 1, 10)

	requestCtx, cancel := context.WithTimeout(ctx, webSearchTimeout)
	defer cancel()

	results, source, lastErr, reachable := searchWeb(requestCtx, query, configuredSearchProviders(env))
	if len(results) == 0 {
		switch {
		case lastErr != nil && !reachable:
			// Every source failed to connect: this really is offline or a
			// blocked DNS.
			return searchFailure(query, lastErr), nil
		case lastErr != nil && !isNetworkUnreachable(lastErr):
			// A source genuinely failed, such as a 502: report it rather than
			// hiding it as "no results".
			return Result{Output: fmt.Sprintf("search failed for %q: %v", query, lastErr), IsError: true}, nil
		case lastErr != nil:
			// Only an unreachable source (often a blocked DuckDuckGo host)
			// while another source answered: the network works, so this is a
			// no-results case, not an outage.
			return Result{Output: fmt.Sprintf("No results for %q. Some search sources were unreachable.", query)}, nil
		default:
			return Result{Output: fmt.Sprintf("No results for %q.", query)}, nil
		}
	}
	if len(results) > count {
		results = results[:count]
	}

	lines := make([]string, 0, len(results))
	for _, result := range results {
		lines = append(lines, result.line())
	}
	output := fmt.Sprintf("Source: %s\n\n%s", source, strings.Join(lines, "\n\n"))
	if len(output) > 6000 {
		output = clipBytes(output, 6000) + "\n... [truncated]"
	}
	return Result{Output: output}, nil
}

// searchProvider is one keyless search source in the fallback chain.
type searchProvider struct {
	source webSearchSource
	run    func(context.Context, string) ([]searchResult, error)
}

// configuredSearchProviders builds the chain. A keyed provider (Tavily,
// Brave) is tried first when its key is set, so search keeps working where
// DuckDuckGo is DNS-blocked; the keyless sources remain as a zero-config
// fallback.
func configuredSearchProviders(env *Env) []searchProvider {
	providers := make([]searchProvider, 0, 6)
	if key := webSearchKey(env, "tavily"); key != "" {
		providers = append(providers, searchProvider{sourceTavily, func(ctx context.Context, query string) ([]searchResult, error) {
			return searchTavily(ctx, key, query)
		}})
	}
	if key := webSearchKey(env, "brave"); key != "" {
		providers = append(providers, searchProvider{sourceBrave, func(ctx context.Context, query string) ([]searchResult, error) {
			return searchBrave(ctx, key, query)
		}})
	}
	return append(providers,
		searchProvider{sourceDuckDuckGo, searchDuckDuckGoHTML},
		searchProvider{sourceDuckDuckGo, searchInstantAnswer},
		searchProvider{sourceWikipedia, searchWikipedia},
		searchProvider{sourceGitHub, searchGitHub},
	)
}

// webSearchKey resolves a search provider's key from the secret store first,
// then the environment, so a key set either way is honoured.
func webSearchKey(env *Env, name string) string {
	if env.Secrets != nil {
		if value := strings.TrimSpace(env.Secrets.Get(name)); value != "" {
			return value
		}
	}
	return strings.TrimSpace(os.Getenv(strings.ToUpper(name) + "_API_KEY"))
}

// searchTavily queries the Tavily search API, which needs a key but is a
// single request that is not scraped, so it is reliable where a SERP is not.
func searchTavily(ctx context.Context, key, query string) ([]searchResult, error) {
	payload, err := json.Marshal(map[string]any{
		"api_key":          key,
		"query":            query,
		"max_results":      6,
		"include_snippets": true,
		"include_answer":   false,
	})
	if err != nil {
		return nil, err
	}
	var results []searchResult
	err = doWithRetry(ctx, func() error {
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, webSearchTavilyEndpoint, bytes.NewReader(payload))
		if err != nil {
			return err
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("User-Agent", webSearchUserAgent)
		response, err := webSearchClient.Do(request)
		if err != nil {
			return err
		}
		defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return fmt.Errorf("search returned %s", response.Status)
		}
		body, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024))
		if err != nil {
			return fmt.Errorf("read search: %v", err)
		}
		var parsed struct {
			Results []struct {
				Title   string `json:"title"`
				URL     string `json:"url"`
				Content string `json:"content"`
			} `json:"results"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			return fmt.Errorf("read search: %v", err)
		}
		results = make([]searchResult, 0, len(parsed.Results))
		for _, item := range parsed.Results {
			results = append(results, searchResult{title: item.Title, url: item.URL, snippet: Shorten(strings.TrimSpace(item.Content), 300)})
		}
		return nil
	})
	return results, err
}

// searchBrave queries the Brave Search API.
func searchBrave(ctx context.Context, key, query string) ([]searchResult, error) {
	link := fmt.Sprintf("%s?q=%s&count=10", strings.TrimRight(webSearchBraveEndpoint, "/"), url.QueryEscape(query))
	var results []searchResult
	err := doWithRetry(ctx, func() error {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
		if err != nil {
			return err
		}
		request.Header.Set("Accept", "application/json")
		request.Header.Set("X-Subscription-Token", key)
		request.Header.Set("User-Agent", webSearchUserAgent)
		response, err := webSearchClient.Do(request)
		if err != nil {
			return err
		}
		defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return fmt.Errorf("search returned %s", response.Status)
		}
		body, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024))
		if err != nil {
			return fmt.Errorf("read search: %v", err)
		}
		var parsed struct {
			Web struct {
				Results []struct {
					Title       string `json:"title"`
					URL         string `json:"url"`
					Description string `json:"description"`
				} `json:"results"`
			} `json:"web"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			return fmt.Errorf("read search: %v", err)
		}
		results = make([]searchResult, 0, len(parsed.Web.Results))
		for _, item := range parsed.Web.Results {
			results = append(results, searchResult{title: item.Title, url: item.URL, snippet: item.Description})
		}
		return nil
	})
	return results, err
}

// searchWeb walks the sources in order and returns the first that answers.
//
// The chain exists because a single vendor is a single point of failure:
// DuckDuckGo can be unreachable in a whole country, and a search tool that
// dies there is worse than one that answers from Wikipedia or GitHub. A
// source that returns no results moves on; the first real error is kept so a
// total outage still reports a cause. It also reports whether any source was
// reachable, so an empty result from a reachable source is never misreported
// as the whole machine being offline.
func searchWeb(ctx context.Context, query string, providers []searchProvider) ([]searchResult, webSearchSource, error, bool) {
	var firstErr error
	reachable := false
	for _, provider := range providers {
		results, err := provider.run(ctx, query)
		// A provider that answered, even with no results or a bad HTTP status,
		// proves the network works. Only a DNS or connect failure leaves the
		// question of "nothing found" against "offline" open.
		if err == nil || !isNetworkUnreachable(err) {
			reachable = true
		}
		if len(results) > 0 {
			return results, provider.source, nil, true
		}
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return nil, "", firstErr, reachable
}

// searchWikipedia queries the MediaWiki opensearch API, which is keyless and
// reachable far more widely than DuckDuckGo. It answers topic and entity
// queries with a title, one-line description and canonical URL each.
func searchWikipedia(ctx context.Context, query string) ([]searchResult, error) {
	endpoint := strings.TrimSpace(webSearchWikipediaEndpoint)
	if endpoint == "" {
		return nil, nil
	}
	link := fmt.Sprintf("%s?action=opensearch&format=json&limit=10&search=%s",
		strings.TrimRight(endpoint, "/"), url.QueryEscape(query))
	body, err := fetchURL(ctx, link)
	if err != nil {
		return nil, err
	}
	var parsed []json.RawMessage
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		return nil, fmt.Errorf("read search: %v", err)
	}
	// The payload is [query, [titles], [descriptions], [urls]].
	if len(parsed) < 4 {
		return nil, nil
	}
	var titles, descriptions, urls []string
	_ = json.Unmarshal(parsed[1], &titles)
	_ = json.Unmarshal(parsed[2], &descriptions)
	_ = json.Unmarshal(parsed[3], &urls)
	results := make([]searchResult, 0, len(titles))
	for index, title := range titles {
		snippet := ""
		if index < len(descriptions) {
			snippet = descriptions[index]
		}
		link := ""
		if index < len(urls) {
			link = urls[index]
		}
		results = append(results, searchResult{title: title, url: link, snippet: snippet})
	}
	return results, nil
}

// searchGitHub queries the repository search API, which is keyless at a low
// rate and the right source for a library or an error a project has fixed.
func searchGitHub(ctx context.Context, query string) ([]searchResult, error) {
	endpoint := strings.TrimSpace(webSearchGitHubEndpoint)
	if endpoint == "" {
		return nil, nil
	}
	link := fmt.Sprintf("%s?per_page=10&q=%s", strings.TrimRight(endpoint, "/"), url.QueryEscape(query))
	body, err := fetchURL(ctx, link)
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Items []struct {
			FullName    string `json:"full_name"`
			HTMLURL     string `json:"html_url"`
			Description string `json:"description"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		return nil, fmt.Errorf("read search: %v", err)
	}
	results := make([]searchResult, 0, len(parsed.Items))
	for _, item := range parsed.Items {
		results = append(results, searchResult{
			title:   item.FullName,
			url:     item.HTMLURL,
			snippet: Shorten(strings.TrimSpace(item.Description), 300),
		})
	}
	return results, nil
}

// searchFailure renders a failed search. It is reached only when no source
// answered at all, and it says so without claiming the machine has no network:
// the transport already retried the name over DNS-over-HTTPS, so a per-host
// block is not an outage the operator should hear about.
func searchFailure(query string, err error) Result {
	return Result{
		Output:  fmt.Sprintf("search failed for %q: %v\nHint: the tool already retried the resolver over DNS-over-HTTPS, so this is not proof the machine is offline. Do not tell the operator the machine cannot search or fetch. Try a different query, the lookup tool for weather/rates/crypto/wiki, or continue with local files.", query, err),
		IsError: true,
	}
}

// ------------------------------------------------------------------ HTML page

var (
	// ddgResultBlock opens one search result. Splitting on it is more robust
	// than one giant regex: a malformed block cannot swallow the ones after it.
	ddgResultBlock  = regexp.MustCompile(`(?is)<div[^>]*class="[^"]*result[^"]*web-result[^"]*"[^>]*>`)
	ddgAnchor       = regexp.MustCompile(`(?is)<a\b([^>]*)>(.*?)</a>`)
	ddgSnippetBlock = regexp.MustCompile(`(?is)<(?:a|td|div)\b([^>]*)>(.*?)</(?:a|td|div)>`)
	ddgAttribute    = regexp.MustCompile(`(?i)([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"`)
)

func searchDuckDuckGoHTML(ctx context.Context, query string) ([]searchResult, error) {
	endpoint := strings.TrimSpace(webSearchHTMLEndpoint)
	if endpoint == "" {
		return nil, nil
	}
	body, err := fetchSearchPage(ctx, endpoint, query)
	if err != nil {
		return nil, err
	}
	return parseDuckDuckGoHTML(body), nil
}

// parseDuckDuckGoHTML is deliberately structural and pure: a markup change
// degrades to "no results" rather than an error.
func parseDuckDuckGoHTML(body string) []searchResult {
	blocks := splitResultBlocks(body)
	if len(blocks) == 0 {
		blocks = []string{body}
	}
	var results []searchResult
	for _, block := range blocks {
		title, href, ok := firstResultAnchor(block)
		if !ok {
			continue
		}
		link := decodeDuckDuckGoURL(href)
		if !strings.HasPrefix(link, "http://") && !strings.HasPrefix(link, "https://") {
			continue
		}
		results = append(results, searchResult{
			title:   title,
			url:     link,
			snippet: firstResultSnippet(block),
		})
		if len(results) >= 10 {
			break
		}
	}
	return results
}

func splitResultBlocks(body string) []string {
	marks := ddgResultBlock.FindAllStringIndex(body, -1)
	if len(marks) == 0 {
		return nil
	}
	blocks := make([]string, 0, len(marks))
	for index, mark := range marks {
		end := len(body)
		if index+1 < len(marks) {
			end = marks[index+1][0]
		}
		blocks = append(blocks, body[mark[1]:end])
	}
	return blocks
}

func firstResultAnchor(block string) (string, string, bool) {
	for _, match := range ddgAnchor.FindAllStringSubmatch(block, -1) {
		attrs, inner := match[1], match[2]
		if !strings.Contains(strings.ToLower(attributeValue(attrs, "class")), "result__a") {
			continue
		}
		href := attributeValue(attrs, "href")
		title := cleanHTMLText(inner)
		if title == "" || href == "" {
			continue
		}
		return title, href, true
	}
	return "", "", false
}

func firstResultSnippet(block string) string {
	for _, match := range ddgSnippetBlock.FindAllStringSubmatch(block, -1) {
		attrs, inner := match[1], match[2]
		if !strings.Contains(strings.ToLower(attributeValue(attrs, "class")), "result__snippet") {
			continue
		}
		if text := cleanHTMLText(inner); text != "" {
			return Shorten(text, 400)
		}
	}
	return ""
}

// decodeDuckDuckGoURL unwraps the //duckduckgo.com/l/?uddg=<url> redirect a
// result link carries, and passes an already plain URL through untouched.
func decodeDuckDuckGoURL(href string) string {
	raw := strings.TrimSpace(href)
	if strings.HasPrefix(raw, "//") {
		raw = "https:" + raw
	}
	if !strings.Contains(raw, "uddg=") {
		return raw
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	if target := parsed.Query().Get("uddg"); target != "" {
		return target
	}
	return raw
}

func attributeValue(attrs, name string) string {
	want := strings.ToLower(name)
	for _, match := range ddgAttribute.FindAllStringSubmatch(attrs, -1) {
		if strings.ToLower(match[1]) == want {
			return html.UnescapeString(match[2])
		}
	}
	return ""
}

// cleanHTMLText strips tags from a fragment and decodes its entities.
func cleanHTMLText(fragment string) string {
	fragment = tagPattern.ReplaceAllString(fragment, " ")
	fragment = html.UnescapeString(fragment)
	fragment = strings.ReplaceAll(fragment, "\u00a0", " ")
	return strings.TrimSpace(strings.Join(strings.Fields(fragment), " "))
}

// --------------------------------------------------------- instant answer API

type webSearchTopic struct {
	Text     string           `json:"Text"`
	FirstURL string           `json:"FirstURL"`
	Topics   []webSearchTopic `json:"Topics"`
}

type webSearchResponse struct {
	AbstractText string           `json:"AbstractText"`
	AbstractURL  string           `json:"AbstractURL"`
	Related      []webSearchTopic `json:"RelatedTopics"`
}

func searchInstantAnswer(ctx context.Context, query string) ([]searchResult, error) {
	endpoint := strings.TrimSpace(webSearchEndpoint)
	if endpoint == "" {
		return nil, nil
	}
	body, err := fetchSearchPage(ctx, endpoint, query)
	if err != nil {
		return nil, err
	}
	var parsed webSearchResponse
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		return nil, fmt.Errorf("read search: %v", err)
	}
	var results []searchResult
	if strings.TrimSpace(parsed.AbstractText) != "" {
		results = append(results, searchResult{title: parsed.AbstractText, url: parsed.AbstractURL})
	}
	results = append(results, flattenSearchTopics(parsed.Related)...)
	return results, nil
}

func flattenSearchTopics(topics []webSearchTopic) []searchResult {
	var results []searchResult
	for _, topic := range topics {
		if len(topic.Topics) > 0 {
			results = append(results, flattenSearchTopics(topic.Topics)...)
			continue
		}
		if strings.TrimSpace(topic.Text) == "" {
			continue
		}
		results = append(results, searchResult{title: topic.Text, url: topic.FirstURL})
	}
	return results
}

// ----------------------------------------------------------------- transport

// fetchSearchPage issues one bounded GET for a page that takes the query in
// its own form, which is how both DuckDuckGo endpoints read it.
func fetchSearchPage(ctx context.Context, endpoint, query string) (string, error) {
	return fetchURL(ctx, appendQuery(endpoint, "q", query))
}

// fetchURL issues one bounded GET and returns the body as text.
// It retries on transient DNS/network errors with exponential backoff.
func fetchURL(ctx context.Context, link string) (string, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(time.Duration(1<<attempt) * time.Second):
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}
		body, err := retryableFetch(ctx, link)
		if err == nil {
			return body, nil
		}
		if isDNSFailure(err) {
			// A blocked or nonexistent name will not resolve on the next
			// attempt; retrying only delays the fallback to the next source.
			return "", err
		}
		if !isNetworkUnreachable(err) {
			return "", err
		}
		lastErr = err
	}
	return "", fmt.Errorf("search failed after retries: %w", lastErr)
}

// retryableFetch issues one GET and returns the body. The caller decides
// whether the error is retryable.
func retryableFetch(ctx context.Context, link string) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("User-Agent", webSearchUserAgent)
	request.Header.Set("Accept", "text/html,application/json;q=0.9,*/*;q=0.5")
	request.Header.Set("Accept-Language", "en-US,en;q=0.9")
	response, err := webSearchClient.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("search returned %s", response.Status)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024))
	if err != nil {
		return "", fmt.Errorf("read search: %v", err)
	}
	return string(body), nil
}

// doWithRetry runs fn up to three times, sleeping 1s then 2s between
// attempts when the error looks like a DNS or connectivity failure.
func doWithRetry(ctx context.Context, fn func() error) error {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(time.Duration(1<<attempt) * time.Second):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		if err := fn(); err == nil {
			return nil
		} else if !isNetworkUnreachable(err) {
			return err
		} else {
			lastErr = err
		}
	}
	return fmt.Errorf("request failed after retries: %w", lastErr)
}

// appendQuery adds a query parameter without losing an existing query string.
func appendQuery(endpoint, key, value string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(endpoint), "/")
	separator := "?"
	if strings.Contains(trimmed, "?") {
		separator = "&"
	}
	return trimmed + separator + key + "=" + url.QueryEscape(value)
}

// dohEndpoint is the DNS-over-HTTPS resolver used only when the system
// resolver fails. A browser often reaches a site the OS resolver is blocked on
// because the browser resolves over HTTPS; this gives the web tools the same
// path instead of failing on a blocked or poisoned ISP DNS.
var dohEndpoint = "https://cloudflare-dns.com/dns-query"

var dohClient = &http.Client{Timeout: 10 * time.Second}

// dialWithDoHFallback dials an address, and when the host name cannot be
// resolved by the system resolver it resolves over HTTPS and dials the pinned
// IP. A literal address and a successful system lookup use the plain dialer,
// so the fallback only runs where DNS is actually broken.
func dialWithDoHFallback(ctx context.Context, network, addr string) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	host, port, err := net.SplitHostPort(addr)
	if err != nil || net.ParseIP(host) != nil {
		return dialer.DialContext(ctx, network, addr)
	}
	conn, dialErr := dialer.DialContext(ctx, network, addr)
	if dialErr == nil {
		return conn, nil
	}
	if !isDNSFailure(dialErr) {
		return nil, dialErr
	}
	ips, resolveErr := dohResolve(ctx, host)
	if resolveErr != nil || len(ips) == 0 {
		return nil, dialErr
	}
	lastErr := dialErr
	for _, ip := range ips {
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip, port))
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

// dohResolve resolves a host over the DNS-over-HTTPS JSON API.
func dohResolve(ctx context.Context, host string) ([]string, error) {
	link := dohEndpoint + "?name=" + url.QueryEscape(host) + "&type=A"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("accept", "application/dns-json")
	response, err := dohClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("doh returned %s", response.Status)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Answer []struct {
			Type int    `json:"type"`
			Data string `json:"data"`
		} `json:"Answer"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	var ips []string
	for _, answer := range parsed.Answer {
		if answer.Type == 1 && net.ParseIP(answer.Data) != nil {
			ips = append(ips, answer.Data)
		}
	}
	return ips, nil
}

// isDNSFailure reports a name-resolution failure. It is a subset of
// isNetworkUnreachable that must not be retried: a blocked or nonexistent
// name does not resolve on a second attempt, so retrying only delays the
// fallback to the next search source.
func isDNSFailure(err error) bool {
	if err == nil {
		return false
	}
	lowered := strings.ToLower(err.Error())
	for _, needle := range []string{
		"no such host",
		"getaddrinfo",
		"temporary failure in name resolution",
		"server misbehaving",
		"no addresses",
	} {
		if strings.Contains(lowered, needle) {
			return true
		}
	}
	return false
}

// isNetworkUnreachable reports whether an error is a DNS or connectivity
// failure, the case where retrying another URL fails the same way.
func isNetworkUnreachable(err error) bool {
	if err == nil {
		return false
	}
	lowered := strings.ToLower(err.Error())
	for _, needle := range []string{
		"no such host",
		"getaddrinfo",
		"temporary failure in name resolution",
		"server misbehaving",
		"network is unreachable",
		"no route to host",
		"connection refused",
		"connection reset",
		"i/o timeout",
		"context deadline exceeded",
	} {
		if strings.Contains(lowered, needle) {
			return true
		}
	}
	return false
}
