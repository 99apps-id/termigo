export function pathToFileUri(path: string): string {
  let p = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(p)) {
    p = `${p[0].toUpperCase()}${p.slice(1)}`;
  } else if (/^\/[A-Za-z]:\//.test(p)) {
    p = `/${p[1].toUpperCase()}${p.slice(2)}`;
  }
  if (!p.startsWith("/")) p = `/${p}`;
  return `file://${p
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(/%3A/g, ":").replace(/%2B/g, "+"),
    )
    .join("/")}`;
}

export function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  let p = decodeURIComponent(uri.slice("file://".length));
  // Windows drive-letter URIs carry a leading slash: file:///C:/dir
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
  if (/^[A-Za-z]:\//.test(p)) {
    p = `${p[0].toUpperCase()}${p.slice(1)}`;
  }
  return p;
}
