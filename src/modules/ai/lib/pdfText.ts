// Minimal PDF text extraction for the agent.
//
// Deliberately dependency-free: a full PDF library would add hundreds of KB to
// the client bundle for a tool that mostly reads reports and docs. This parser
// handles the common case — content streams with FlateDecode (the default for
// almost every producer) or no compression, extracting the text shown by the
// `Tj` / `TJ` operators. Scanned PDFs (images only) yield no text; the model is
// told that and can fall back to describing the pages visually via read_image
// on page renders, or the user can OCR externally.
//
// Parsing is forgiving on purpose: a malformed object never throws — it is
// skipped, and whatever text was recovered so far is returned.

/**
 * Is this byte a candidate for the start of a zlib (FlateDecode) stream?
 * A zlib header starts with CMF where the low nibble is 8 (deflate); common
 * concrete headers are 0x78 0x9c / 0x78 0x01 / 0x78 0xda / 0x78 0x5e.
 */
function looksZlib(data: Uint8Array, at: number): boolean {
  if (at + 2 > data.length) return false;
  const cmf = data[at];
  if ((cmf & 0x0f) !== 8) return false; // not deflate
  const flg = data[at + 1];
  // (CMF*256 + FLG) must divide by 31 per the zlib spec.
  return (cmf * 256 + flg) % 31 === 0;
}

/** Inflate a zlib stream via the platform's DecompressionStream. */
async function inflate(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === "undefined") return null;
  try {
    const ds = new DecompressionStream("deflate");
    // Copy to an ArrayBuffer-backed view; Blob rejects a generic Uint8Array.
    const copy = new Uint8Array(data);
    const stream = new Blob([copy]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/** Decode a PDF literal string `(...)` or hex string `<...>`. */
function decodePdfString(raw: string): string {
  const s = raw.trim();
  if (s.startsWith("<") && s.endsWith(">")) {
    let hex = s.slice(1, -1).replace(/\s+/g, "");
    if (!/^[0-9a-fA-F]*$/.test(hex)) return "";
    if (hex.length % 2 !== 0) hex += "0";
    let out = "";
    for (let i = 0; i + 1 < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    return out;
  }
  // Literal string: keep interior whitespace (a leading space is real text),
  // unescape PDF escapes.
  const inner =
    raw.startsWith("(") && raw.endsWith(")") ? raw.slice(1, -1) : raw;
  return inner
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\[0-7]{1,3}/g, (m) =>
      String.fromCharCode(parseInt(m.slice(1), 8) & 0xff),
    );
}

/** Extract text from one decompressed content stream. */
function extractStreamText(content: string): string {
  const out: string[] = [];
  // `Tj` shows one string (literal `(...)` or hex `<...>`). `TJ` shows an array
  // of strings and kerning numbers; extract every string inside the array.
  const tjRe =
    /(?:\(((?:\\.|[^\\()])*)\)|(<[0-9a-fA-F\s]*>))\s*-?\d*\.?\d*\s*Tj/g;
  for (const m of content.matchAll(tjRe)) {
    out.push(decodePdfString(m[1] ?? m[2]));
  }
  const tjArrRe = /\[([\s\S]*?)\]\s*TJ/g;
  for (const m of content.matchAll(tjArrRe)) {
    const arrRe = /(?:\(((?:\\.|[^\\()])*)\)|(<[0-9a-fA-F\s]*>))/g;
    for (const s of m[1].matchAll(arrRe)) {
      out.push(decodePdfString(s[1] ?? s[2]));
    }
  }
  return out.join("");
}

/**
 * Split a PDF binary into content-stream candidates. A stream block is
 * `<< ... >> stream\n <bytes> endstream`; the bytes run until the first
 * `endstream` marker. We return { data, maybeFlate } per block.
 */
function streamBlocks(
  pdf: Uint8Array,
): Array<{ data: Uint8Array; flate: boolean }> {
  const text = new TextDecoder("latin1").decode(pdf);
  const blocks: Array<{ data: Uint8Array; flate: boolean }> = [];
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  for (const m of text.matchAll(re)) {
    // The dict that precedes `stream` declares /Filter /FlateDecode when the
    // data is compressed. Read back a generous window to check.
    const before = text.slice(Math.max(0, m.index - 1024), m.index);
    const flate = /\/FlateDecode/.test(before);
    const raw = m[1];
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 0xff;
    blocks.push({ data: bytes, flate });
  }
  return blocks;
}

/** Extract readable text from a PDF's bytes, one string per page. Never throws. */
export async function extractPdfPages(pdf: Uint8Array): Promise<string[]> {
  const blocks = streamBlocks(pdf);
  const pages: string[] = [];
  for (const block of blocks) {
    let content = block.data;
    if (block.flate || looksZlib(block.data, 0)) {
      const inflated = await inflate(block.data);
      if (inflated) content = inflated;
    }
    const text = extractStreamText(new TextDecoder("latin1").decode(content));
    if (text.trim()) pages.push(text);
  }
  return pages;
}

/** Convenience: all page text joined with blank lines, trimmed. */
export async function extractPdfText(pdf: Uint8Array): Promise<string> {
  return (await extractPdfPages(pdf)).join("\n\n").trim();
}
