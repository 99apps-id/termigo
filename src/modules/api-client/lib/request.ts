// Resolve an `ApiRequest` into the concrete URL, headers and body it sends.
//
// These are pure functions so the exact bytes that go over the wire can be
// unit-tested (and so the "send" path stays a thin `invoke` wrapper). Variables
// are substituted, query parameters are appended, and the body is chosen from
// the request's `bodyMode`.

import type { ApiRequest } from "../types";
import { substituteVariables } from "./variables";

/** Append enabled query params to a URL, preserving any existing query string. */
export function buildUrl(
  url: string,
  query: { id?: string; key: string; value: string; enabled: boolean }[],
  variables: Record<string, string>,
): string {
  const base = substituteVariables(url, variables);
  const params = query
    .filter((q) => q.enabled && q.key.trim() !== "")
    .map((q) => [
      encodeURIComponent(substituteVariables(q.key, variables)),
      encodeURIComponent(substituteVariables(q.value, variables)),
    ]);
  if (params.length === 0) return base;

  const [path, hash] = base.split("#", 2);
  const hashPart = hash ? `#${hash}` : "";
  const separator = path.includes("?") ? "&" : "?";
  const queryString = params.map(([k, v]) => (v ? `${k}=${v}` : k)).join("&");
  return `${path}${separator}${queryString}${hashPart}`;
}

/** Enabled headers with variables substituted. */
export function buildHeaders(
  headers: { id?: string; key: string; value: string; enabled: boolean }[],
  variables: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    if (!h.enabled || h.key.trim() === "") continue;
    out[h.key.trim()] = substituteVariables(h.value, variables);
  }
  return out;
}

/** Resolve the body string for a request, or `null` when there is none. */
export function resolveBody(
  req: Pick<ApiRequest, "bodyMode" | "body">,
  variables: Record<string, string>,
): string | null {
  if (req.bodyMode === "none") return null;
  if (req.body.trim() === "") return null;
  return substituteVariables(req.body, variables);
}
