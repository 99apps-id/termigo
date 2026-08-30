// cURL → request parser for the API client.
//
// Lets the user paste a cURL command (copy from a dev-tools "Copy as cURL", or
// a README) and get a populated request back. It is deliberately tolerant: it
// handles the flags an API client needs (-X, -H, -d, --data, --data-raw,
// --insecure, -u) and ignores the rest, so a half-remembered command still
// imports instead of erroring.

import { type ApiRequest, emptyRequest, makeId } from "../types";

function stripQuotes(s: string): string {
  let v = s.trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      v = v.slice(1, -1);
    }
  }
  return v;
}

function parseHeaderValue(s: string): string {
  // Headers may be `key: value` or `key:value`; anything after the first colon
  // is the value.
  const idx = s.indexOf(":");
  if (idx === -1) return s.trim();
  return s.slice(idx + 1).trim();
}

/**
 * Parse a cURL command line into an `ApiRequest`. Returns `null` when the input
 * does not look like a cURL invocation.
 */
export function parseCurl(input: string): ApiRequest | null {
  const trimmed = input.trim();
  // Match `curl` at the start; allow `cmd /c curl` style only loosely.
  const m = /^(?:curl|curl\.exe)\s+(.*)$/i.exec(trimmed);
  if (!m) return null;

  const req = emptyRequest("Imported request");
  const argc = m[1];

  // Tokenise respecting single and double quotes.
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;
  for (const ch of argc) {
    if (escaping) {
      cur += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'";
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) tokens.push(cur);

  let i = 0;
  const setMethod = (mth: string) => {
    req.method = mth.toUpperCase() as ApiRequest["method"];
  };

  while (i < tokens.length) {
    const tok = tokens[i];
    const next = () => (i + 1 < tokens.length ? tokens[i + 1] : undefined);

    if (tok === "-X" || tok === "--request") {
      const v = next();
      if (v) setMethod(v);
      i += 2;
      continue;
    }
    if (tok === "-H" || tok === "--header") {
      const v = next();
      if (v) {
        const hv = stripQuotes(v);
        const idx = hv.indexOf(":");
        const key = (idx === -1 ? hv : hv.slice(0, idx)).trim();
        const value = parseHeaderValue(hv);
        if (key) {
          if (key.toLowerCase() === "content-type") {
            if (value.includes("json")) req.bodyMode = "json";
            else if (value.includes("x-www-form-urlencoded"))
              req.bodyMode = "form";
            else req.bodyMode = "raw";
          }
          req.headers.push({
            id: makeId(),
            key,
            value,
            enabled: true,
          });
        }
      }
      i += 2;
      continue;
    }
    if (
      tok === "-d" ||
      tok === "--data" ||
      tok === "--data-raw" ||
      tok === "--data-binary" ||
      tok === "--data-urlencode"
    ) {
      const v = next();
      if (v) {
        req.body = stripQuotes(v);
        if (req.bodyMode === "none") req.bodyMode = "json";
      }
      i += 2;
      continue;
    }
    if (tok === "-u" || tok === "--user") {
      const v = next();
      if (v) {
        const basic = stripQuotes(v);
        req.headers.push({
          id: makeId(),
          key: "Authorization",
          value: `Basic ${btoa(basic)}`,
          enabled: true,
        });
      }
      i += 2;
      continue;
    }
    if (tok === "--insecure" || tok === "-k") {
      i += 1;
      continue;
    }
    if (tok.startsWith("-") || tok.startsWith("--")) {
      // Unknown flag: skip its value if it takes one (best-effort).
      const takesValue =
        tok === "--url" ||
        tok.startsWith("--connect") ||
        tok.startsWith("--compressed");
      i += takesValue ? 2 : 1;
      continue;
    }
    // First non-flag token is the URL.
    if (!req.url) {
      req.url = stripQuotes(tok);
      i += 1;
      continue;
    }
    i += 1;
  }

  return req;
}
