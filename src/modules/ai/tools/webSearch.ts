// Web search for the agent.
//
// Backed by DuckDuckGo's HTML results page, fetched through the same Rust
// `ai_http_request` guard as `fetch` (URL validated, SSRF-protected, pinned to
// the checked address). No API key is needed, which keeps a search tool usable
// out of the box. The model receives the top results' title / URL / snippet —
// it can then `fetch` any result for the full page.
//
// Parsing is deliberately light: the result markup is scraped with small,
// explicit regexes (not a full HTML parser dependency), and everything is
// wrapped so a markup change degrades to "no results" rather than a crash.

import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import { decodeEntities } from "../lib/htmlText";

type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: number[];
};

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

/**
 * Decode DuckDuckGo's redirect wrapper (`//duckduckgo.com/l/?uddg=<url>`).
 * A result that is already a plain URL is passed through unchanged.
 */
export function decodeDdgUrl(href: string): string {
  let raw = href.trim();
  if (raw.startsWith("//")) raw = `https:${raw}`;
  if (!raw.includes("uddg=")) return raw;
  const m = raw.match(/[?&]uddg=([^&]+)/);
  if (!m) return raw;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return raw;
  }
}

/**
 * Parse DuckDuckGo's HTML results page into an ordered list of
 * { title, url, snippet }. Purely structural: returns [] on any markup
 * change instead of throwing, so the tool degrades gracefully.
 */
export function parseDuckDuckGoResults(html: string): WebSearchResult[] {
  // DuckDuckGo nests each result in a `<div class="result ... web-result">`.
  // Splitting on the class is more robust than matching one giant regex,
  // because a single malformed block cannot swallow the rest.
  const blocks = html.split(
    /<div[^>]*class="[^"]*result[^"]*web-result[^"]*"/i,
  );
  const out: WebSearchResult[] = [];
  for (const block of blocks.slice(1)) {
    const titleMatch = block.match(
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!titleMatch) continue;
    const title = decodeEntities(stripTags(titleMatch[2])).trim();
    const url = decodeDdgUrl(titleMatch[1]);
    if (!title || !/^https?:\/\//i.test(url)) continue;

    const snippetMatch = block.match(
      /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
    );
    const snippet = snippetMatch
      ? decodeEntities(stripTags(snippetMatch[1])).trim()
      : "";

    out.push({ title, url, snippet: snippet.slice(0, 400) });
    if (out.length >= 10) break;
  }
  return out;
}

/** Remove HTML tags from a fragment (attributes, comments, scripts). */
function stripTags(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1") // no space before punctuation
    .trim();
}

function header(headers: Record<string, string>, name: string): string {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return "";
}

/** True when a response is text that can be parsed for results. */
function isTextual(contentType: string): boolean {
  return /text\/html|application\/xhtml|text\/plain/i.test(contentType);
}

import { capText, decodeEntities, extractTitle, htmlToMarkdown, looksLikeHtml } from "../lib/htmlText";
import { useChatStore } from "../store/chatStore";

export function buildWebSearchTools() {
  return {
    web_search: tool({
      description:
        "Search the web for a query and return top results (title, URL, snippet). Uses DuckDuckGo by default (zero-config, free) with automatic fallback to configured search APIs (Tavily, Brave). Read-only; asks for approval.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "The search query — keep it concrete, like a search engine query.",
          ),
      }),
      needsApproval: true,
      execute: async ({ query }) => {
        const apiKeys = useChatStore.getState().apiKeys as Record<string, string | undefined>;
        const tavilyKey = apiKeys.tavily?.trim();
        const braveKey = apiKeys.brave?.trim();

        // 1. Tavily Search (if key is configured)
        if (tavilyKey) {
          try {
            const res = await fetch("https://api.tavily.com/search", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                api_key: tavilyKey,
                query,
                max_results: 6,
                include_snippets: true,
              }),
            });
            if (res.ok) {
              const json = (await res.json()) as {
                results?: Array<{ title?: string; url?: string; content?: string }>;
              };
              const results: WebSearchResult[] = (json.results ?? []).map((r) => ({
                title: r.title || "",
                url: r.url || "",
                snippet: r.content || "",
              }));
              return { provider: "tavily", query, count: results.length, results };
            }
          } catch {
            // Fall through to DuckDuckGo on network failure
          }
        }

        // 2. Brave Search (if key is configured)
        if (braveKey) {
          try {
            const res = await fetch(
              `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`,
              {
                headers: {
                  Accept: "application/json",
                  "X-Subscription-Token": braveKey,
                },
              },
            );
            if (res.ok) {
              const json = (await res.json()) as {
                web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
              };
              const results: WebSearchResult[] = (json.web?.results ?? []).map((r) => ({
                title: r.title || "",
                url: r.url || "",
                snippet: r.description || "",
              }));
              return { provider: "brave", query, count: results.length, results };
            }
          } catch {
            // Fall through to DuckDuckGo
          }
        }

        // 3. DuckDuckGo HTML scraper (default zero-config fallback)
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(
          query,
        )}`;
        let resp: HttpResponse;
        try {
          resp = await invoke<HttpResponse>("ai_http_request", {
            url,
            method: "GET",
            headers: {
              "User-Agent":
                "Mozilla/5.0 (compatible; TermigoBot/1.0; +https://github.com/99apps-id/termigo)",
            },
            body: null,
            allowPrivateNetwork: false,
          });
        } catch (e) {
          const errStr = String(e);
          const isOffline =
            /getaddrinfo|econnrefused|enetunreach|offline|dns|unreachable|network/i.test(
              errStr,
            );
          return {
            error: errStr,
            query,
            ...(isOffline
              ? {
                  isOffline: true,
                  hint: "Search failed because the machine is offline or DNS resolution failed. DO NOT retry search queries or web tools. Continue the task using local repository files, documentation, and tools.",
                }
              : {}),
          };
        }

        const contentType = header(resp.headers, "content-type");
        if (!isTextual(contentType)) {
          return {
            query,
            status: resp.status,
            error: "search returned a non-text response",
          };
        }
        const body = new TextDecoder("utf-8").decode(new Uint8Array(resp.body));
        const results = parseDuckDuckGoResults(body);
        return {
          provider: "duckduckgo",
          query,
          count: results.length,
          results,
          note:
            results.length === 0
              ? "No parseable results — the markup may have changed, or the query returned nothing."
              : undefined,
        };
      },
    }),

    web_fetch: tool({
      description:
        "Fetch and extract clean, readable text/markdown from a web page (stripping scripts, styling, ads, and navigation boilerplate). For single-page JavaScript web apps, set `use_reader: true` to render via reader mode. Read-only; asks for approval.",
      inputSchema: z.object({
        url: z.string().describe("Absolute HTTP or HTTPS URL to fetch."),
        use_reader: z
          .boolean()
          .optional()
          .describe(
            "If true, use reader service (r.jina.ai) to render JavaScript SPAs into clean markdown.",
          ),
      }),
      needsApproval: true,
      execute: async ({ url, use_reader }) => {
        const fetchUrl = use_reader ? `https://r.jina.ai/${encodeURI(url)}` : url;
        let resp: HttpResponse;
        try {
          resp = await invoke<HttpResponse>("ai_http_request", {
            url: fetchUrl,
            method: "GET",
            headers: {
              "User-Agent":
                "Mozilla/5.0 (compatible; TermigoBot/1.0; +https://github.com/99apps-id/termigo)",
            },
            body: null,
            allowPrivateNetwork: false,
          });
        } catch (e) {
          return { error: String(e), url };
        }

        const contentType = header(resp.headers, "content-type");
        const bytes = new Uint8Array(resp.body);
        if (bytes.length === 0) {
          return {
            url,
            status: resp.status,
            content: "",
            note: "Empty response body.",
          };
        }

        const body = new TextDecoder("utf-8").decode(bytes);
        if (use_reader) {
          const capped = capText(body);
          return {
            url,
            readerMode: true,
            status: resp.status,
            content: capped.text,
            ...(capped.truncated ? { truncated: true } : {}),
          };
        }

        const isHtml = looksLikeHtml(contentType, body);
        const text = isHtml ? htmlToMarkdown(body) : body;
        const capped = capText(text);

        return {
          url,
          status: resp.status,
          contentType,
          ...(isHtml ? { title: extractTitle(body) } : {}),
          content: capped.text,
          ...(capped.truncated ? { truncated: true } : {}),
        };
      },
    }),
  } as const;
}
