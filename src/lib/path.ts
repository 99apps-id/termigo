// Shared path helpers. The canonical path form on the frontend is forward-slash
// (see TERMIGO.md), but paths can still arrive with backslashes from the OS / OSC 7,
// so anything that splits a path must handle BOTH separators. Defined once and
// used everywhere so display logic and the AI secret-path guard cannot drift
// apart (a divergent basename copy was a real correctness/security risk).

/** Convert backslashes to forward slashes (the canonical frontend form). */
export function toForwardSlash(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Split a path on both `/` and `\`, dropping empty segments. */
export function pathSegments(path: string): string[] {
  return path.split(/[\\/]/).filter(Boolean);
}

/**
 * Normalize a directory path for identity comparison: backslashes become `/`
 * (the canonical frontend form), repeated separators collapse, and trailing
 * separators are dropped. A UNC root keeps its leading `//` so it cannot
 * compare equal to a local `/server/share`.
 *
 * Case is deliberately preserved: `/Home/x` and `/home/x` are different
 * directories on Linux and macOS, so folding case here would merge two trees.
 * Callers that need Windows case-insensitivity fold it themselves.
 *
 * Used where two spellings of one directory must be recognized as one tree
 * (an index root, a cache payload, a workspace root).
 */
export function canonicalDirPath(path: string): string {
  const slashed = toForwardSlash(path);
  const collapsed = slashed.startsWith("//")
    ? `//${slashed.slice(2).replace(/\/{2,}/g, "/")}`
    : slashed.replace(/\/{2,}/g, "/");
  // A lone "/" has no preceding character to keep, so it survives as "/".
  return collapsed.replace(/(.)\/+$/, "$1");
}

/**
 * Last path segment. Handles both separators and trailing separators
 * ("foo/bar/" -> "bar"); a string with no separator returns itself; "/" -> "/".
 */
export function basename(path: string): string {
  const parts = pathSegments(path);
  return parts.length ? parts[parts.length - 1] : path;
}

/** Join a directory and a child segment with a single forward slash. */
export function joinPath(dir: string, child: string): string {
  return dir.endsWith("/") ? `${dir}${child}` : `${dir}/${child}`;
}

/** Parent directory in forward-slash form. Returns "" when there is no parent. */
export function dirname(path: string): string {
  const parts = pathSegments(path);
  if (parts.length <= 1) return "";
  const norm = toForwardSlash(path).replace(/\/+$/, "");
  const i = norm.lastIndexOf("/");
  return i <= 0 ? "" : norm.slice(0, i);
}

/** Percent-encode each `/`-separated segment (spaces, `#`, `?`, … become %xx)
 *  while leaving the separators intact, so a path with spaces or a literal `#`
 *  in a filename survives as a valid file:// URL. */
function encodeFileUrlPath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/**
 * True for a file the editor cannot show but the in-app browser can. Today
 * that is PDF alone: `fs_read_file` sniffs it as binary (it is not one of the
 * `<img>`-renderable formats), so an editor tab would only ever print
 * "Binary file", while the browser pane is a real WebView2 / WebKit surface
 * and both ship a built-in PDF viewer.
 *
 * Deliberately not a general "viewable in a browser" list: every entry has to
 * be a format the editor genuinely cannot handle AND the webview genuinely
 * can. Images already round-trip through `fs_read_file` as a data URL that
 * `EditorPane` renders, so adding them here would be a regression.
 */
export function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path);
}

/**
 * Convert a local filesystem path to a `file://` URL, or null if it isn't an
 * absolute local path. Handles Windows drive paths (`D:\dir\f.html` /
 * `D:/dir/f.html`), UNC paths (`\\server\share\f`), and POSIX absolute paths
 * (`/dir/f`). Used to open a local file in the in-app browser preview.
 */
export function pathToFileUrl(path: string): string | null {
  // Windows drive path: D:\… or D:/…  ->  file:///D:/…
  const drive = /^([a-zA-Z]):[\\/](.*)$/.exec(path);
  if (drive) {
    return `file:///${drive[1].toUpperCase()}:/${encodeFileUrlPath(drive[2].replace(/\\/g, "/"))}`;
  }
  // UNC path: \\server\share\…  ->  file://server/share/…
  const unc = /^\\\\([^\\/]+)[\\/](.*)$/.exec(path);
  if (unc) {
    return `file://${encodeURIComponent(unc[1])}/${encodeFileUrlPath(unc[2].replace(/\\/g, "/"))}`;
  }
  // POSIX absolute path: /…  ->  file:///…  (macOS / Linux)
  if (path.startsWith("/")) {
    return `file://${encodeFileUrlPath(path)}`;
  }
  return null;
}
