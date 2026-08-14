// Fetching a URL for the agent.
//
// Routed through the Rust `ai_http_request` command, which already validates
// the URL, resolves the host, refuses private/loopback/link-local addresses and
// pins the connection to the addresses it checked. Using the webview's own
// fetch would skip all of that and run into CORS besides.
//
// `allow_private_network` is NOT exposed to the model, and is passed false
// explicitly rather than left to default. The whole point of the guard is that
// an agent following instructions from a fetched page cannot be talked into
// probing the machine's own network, so the decision must not be an argument
// the model gets to choose.

import { tool } from "ai";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import {
  capText,
  extractTitle,
  htmlToText,
  isTextual,
  looksLikeHtml,
} from "../lib/htmlText";

type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: number[];
};

/** Header lookup that does not care about case, as HTTP does not. */
function header(headers: Record<string, string>, name: string): string {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return "";
}

export function buildFetchTools() {
  return {
    fetch: tool({
      description:
        "Fetch a URL over HTTP(S) and return its text. Always fetches from THIS machine, never from a connected SSH host — for a URL only reachable inside the server's network, use bash_run with curl instead. HTML is reduced to readable text; JSON and plain text come back as-is. Private, loopback and link-local addresses are refused. Binary responses are reported but not returned. Asks for approval.",
      inputSchema: z.object({
        url: z.string().describe("Absolute http(s) URL."),
        raw: z
          .boolean()
          .optional()
          .describe(
            "Return the body unmodified instead of reducing HTML to text. Use when you need the markup itself.",
          ),
      }),
      needsApproval: true,
      execute: async ({ url, raw }) => {
        let resp: HttpResponse;
        try {
          resp = await invoke<HttpResponse>("ai_http_request", {
            url,
            method: "GET",
            headers: null,
            body: null,
            // Never model-controlled. See the note at the top of this file.
            allowPrivateNetwork: false,
          });
        } catch (e) {
          return { error: String(e), url };
        }

        const contentType = header(resp.headers, "content-type");
        const bytes = new Uint8Array(resp.body);

        if (!isTextual(contentType)) {
          // Returned rather than decoded: feeding a binary blob through a text
          // decoder produces replacement characters that cost context and tell
          // the model nothing.
          return {
            url,
            status: resp.status,
            contentType,
            bytes: bytes.length,
            error: "response is not text; nothing to read",
          };
        }

        const body = new TextDecoder("utf-8").decode(bytes);
        const isHtml = looksLikeHtml(contentType, body);
        const text = !raw && isHtml ? htmlToText(body) : body;
        const capped = capText(text);

        return {
          url,
          // Stated rather than assumed: with an SSH session open the model may
          // well think this reached the server, and a page that differs
          // between the two networks would mislead it silently.
          fetchedFrom: "local machine",
          status: resp.status,
          contentType,
          ...(isHtml ? { title: extractTitle(body) } : {}),
          content: capped.text,
          ...(capped.truncated
            ? { truncated: true, hint: "response was longer than the cap" }
            : {}),
        };
      },
    }),
  };
}
