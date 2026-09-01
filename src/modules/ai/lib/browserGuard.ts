// SSRF guard for URLs the agent can open in an in-app browser/preview.
//
// Ported from TEDI's `unsafeBrowserUrl`. The host allow/deny logic here is the
// security foundation for any browser the agent drives; the existing preview is
// loopback-only, but the guard must also stop the tricks that LOOK like a
// different host to the model yet resolve to a local or metadata address:
// decimal/hex-dotted IPv4, IPv6 link-local, and cloud metadata endpoints.

/** Normalize an IPv4 host to dotted-quad, or return null when not IPv4.
 *  Accepts dotted, decimal (`2130706433`), hex (`0x7f000001`) and octal
 *  (`017700000001`) forms, so a model that writes a numeric IP cannot slip
 *  past a string comparison. */
export function normalizeIpv4(host: string): string | null {
  const h = host.toLowerCase();
  const isDecimal = (s: string) => s !== "" && /^[0-9]+$/.test(s);
  const isHex = (s: string) => /^0x[0-9a-f]+$/.test(s);
  if (h.includes(".")) {
    const parts = h.split(".");
    if (parts.length !== 4) return null;
    const out: number[] = [];
    for (const p of parts) {
      if (!isDecimal(p)) return null;
      const n = Number.parseInt(p, 10);
      if (!Number.isFinite(n) || n < 0 || n > 255) return null;
      out.push(n);
    }
    return out.join(".");
  }
  if (isDecimal(h) || isHex(h) || isOctal(h)) {
    let base = 10;
    let digits = h;
    if (isHex(h)) {
      base = 16;
      digits = h.slice(2);
    } else if (isOctal(h)) {
      base = 8;
      digits = h.slice(1);
    }
    const n = Number.parseInt(digits, base);
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null;
    const b = BigInt(n);
    return [
      Number((b >> 24n) & 0xffn),
      Number((b >> 16n) & 0xffn),
      Number((b >> 8n) & 0xffn),
      Number(b & 0xffn),
    ].join(".");
  }
  return null;
}

/** Octal form (`017700000001`) — a leading zero with only 0-7 digits. */
function isOctal(s: string): boolean {
  return /^0[0-7]+$/.test(s);
}

/** Whether a hostname is on the IPv4 loopback range (127.0.0.0/8). */
export function isLoopbackIpv4(host: string): boolean {
  const ip = normalizeIpv4(host);
  return ip?.startsWith("127.") ?? false;
}

/** Whether a hostname is an IPv6 loopback / ULA link-local we refuse. */
function isBlockedIpv6(host: string): boolean {
  if (!host.includes(":")) return false;
  const h = host.toLowerCase();
  // Loopback ::1 is allowed by the preview; everything else IPv6 (link-local
  // fe80::, ULA fd00::, etc.) is refused as a probable SSRF target.
  return h !== "[::1]" && h !== "::1";
}

function isCloudMetadataHost(host: string): boolean {
  return (
    host === "169.254.169.254" ||
    host === "metadata.google.internal" ||
    host.endsWith(".metadata.google.internal") ||
    host.endsWith(".compute.internal") ||
    host === "instance-data" ||
    host.endsWith(".internal")
  );
}

/**
 * Return a reason the URL is unsafe to open in an in-app browser, or null when
 * safe. A null result means the URL is a web page an agent may open; it does
 * NOT mean the host is localhost.
 */
export function unsafeBrowserUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "invalid URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "only http/https URLs are allowed";
  }
  const host = u.hostname.toLowerCase();

  if (isCloudMetadataHost(host)) {
    return "Refused: cloud-metadata endpoints are blocked";
  }
  // IP-literal tricks that resolve to loopback or link-local are refused.
  const ipv4 = normalizeIpv4(host);
  if (ipv4 === "0.0.0.0") {
    return "Refused: wildcard bind addresses are not valid browser targets";
  }
  if (ipv4?.startsWith("127.")) {
    return "Refused: loopback addresses are blocked in an in-app browser";
  }
  if (ipv4?.startsWith("169.254.")) {
    return "Refused: link-local addresses are blocked";
  }
  if (isBlockedIpv6(host)) {
    return "Refused: non-loopback IPv6 addresses are blocked";
  }
  return null;
}

/**
 * Whether a URL is safe for the loopback-only preview: http(s) on a loopback
 * host (localhost, 127.0.0.0/8, [::1]), with the SSRF tricks already rejected.
 */
export function isSafePreviewUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const bad = unsafeBrowserUrl(url);
  // unsafeBrowserUrl rejects loopback too, which the preview allows, so treat
  // its loopback refusal as acceptable here and re-allow it.
  const host = u.hostname.toLowerCase();
  const ipv4 = normalizeIpv4(host);
  const loopback =
    host === "localhost" ||
    host === "[::1]" ||
    host === "::1" ||
    ipv4?.startsWith("127.") ||
    host.endsWith(".localhost");
  if (bad === null) return loopback;
  // A refused URL is only acceptable if the only reason is loopback.
  if (bad.includes("loopback")) return loopback;
  return false;
}
