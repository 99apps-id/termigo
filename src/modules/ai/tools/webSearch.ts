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
  if (!href.includes("uddg=")) return href;
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (!m) return href;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return href;
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

export function buildWebSearchTools() {
  return {
    web_search: tool({
      description:
        "Search the web (DuckDuckGo) for a query and return the top results — each with title, URL and a short snippet. Use when the answer lives outside the workspace: current docs, a library's README, an error message, a known issue. Read-only; the search itself asks for approval (the results page is fetched from this machine). Follow up by calling fetch on any promising URL for the full page. Private/loopback addresses are refused by the fetch guard.",
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
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(
          query,
        )}`;
        let resp: HttpResponse;
        try {
          resp = await invoke<HttpResponse>("ai_http_request", {
            url,
            method: "GET",
            headers: {
              // DDG serves the HTML variant to browsers; without a UA it may
              // redirect to a JS-only page that has no results markup.
              "User-Agent":
                "Mozilla/5.0 (compatible; TermigoBot/1.0; +https://github.com/99apps-id/termigo)",
            },
            body: null,
            // Never model-controlled — same invariant as `fetch`.
            allowPrivateNetwork: false,
          });
        } catch (e) {
          return { error: String(e), query };
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
  } as const;
}
