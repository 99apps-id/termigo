// Pulling a dev server's URL out of raw process output — ported from TEDI's
// `detectUrl.ts` (IlhamriSKY/TEDI), which exercises it against bytes captured
// from real servers (Vite, npm, Laravel, uvicorn, docker-compose).
//
// The `dev_server` tool spawns a dev command in the background, then reads its
// log ring with `findLocalUrl` to learn the ACTUAL URL the server printed
// (port, path, host) instead of guessing a default port. Free of Tauri/xterm
// imports so it stays unit-testable.

/** Colour/style escapes, stripped before matching.
 *
 * Vite prints the port in bold — `http://localhost:\x1b[1m5173\x1b[22m/` —
 * which breaks the match twice over: the escape splits the port off the host,
 * and its trailing `m` sits against `http` so the `\b` never fires.
 */
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Loopback http(s) urls. A remote server's url is tunnelled before it gets here. */
export const LOCAL_URL_RE =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:\/[^\s\x1b]*)?/g;

/** `http://localhost:8000/admin].` -> `http://localhost:8000/admin`. */
export function stripTrailingPunct(url: string): string {
  return url.replace(/[.,);\]]+$/, "");
}

/** Fast gate on raw bytes, so a normal log chunk never pays for a decode. */
export function containsSchemeSeparator(bytes: Uint8Array): boolean {
  const n = bytes.length;
  for (let i = 0; i < n - 2; i++) {
    if (bytes[i] === 0x3a && bytes[i + 1] === 0x2f && bytes[i + 2] === 0x2f) {
      return true;
    }
  }
  return false;
}

/**
 * `http://0.0.0.0:9000` -> `http://127.0.0.1:9000`.
 *
 * `0.0.0.0` is a BIND address, never a connect one. The browser pane cannot
 * navigate to it either, and our loopback-only probe rejects it. `php artisan
 * serve --host=0.0.0.0`, uvicorn and most docker-compose setups print exactly
 * this. Rewritten here because this is the one function that hands a url to
 * the app, so every consumer sees the same string.
 */
export function loopbackHost(url: string): string {
  return url.replace(/^(https?:\/\/)0\.0\.0\.0(?=[:/]|$)/, "$1127.0.0.1");
}

/**
 * The last local url in `text`, or null. Last, because a server that reprints
 * its banner should be read at its newest address.
 */
export function findLocalUrl(text: string): string | null {
  const matches = text.replace(CSI_RE, "").match(LOCAL_URL_RE);
  if (!matches || matches.length === 0) return null;
  return loopbackHost(stripTrailingPunct(matches[matches.length - 1])) || null;
}
