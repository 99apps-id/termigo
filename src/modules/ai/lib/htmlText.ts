// Turning a fetched page into something worth spending context on.
//
// Handing raw HTML to a model wastes most of the budget on markup it has to
// parse before it can read anything, and a single page of modern JS framework
// output can exceed the whole reply. So script/style content is dropped, tags
// are removed, and entities are decoded.
//
// Deliberately regex-based rather than DOM-based: this runs in the agent's
// path, the input is untrusted third-party HTML, and building a real DOM would
// mean either a parser dependency or handing that HTML to the webview.

/** Cap on the text handed back, mirroring the read_file byte cap. */
export const FETCH_TEXT_CAP = 25 * 1024;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&[a-z]+;|&#\d+;/gi, (m) => {
      const named = ENTITIES[m.toLowerCase()];
      if (named !== undefined) return named;
      const num = /^&#(\d+);$/.exec(m);
      if (num) {
        const code = Number(num[1]);
        // Ignore anything outside the Unicode range rather than throwing.
        if (code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
      }
      return m;
    })
    .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    });
}

/** True when the content type is something the model can read as text. */
export function isTextual(contentType: string): boolean {
  const t = contentType.toLowerCase();
  return (
    t.startsWith("text/") ||
    t.includes("json") ||
    t.includes("xml") ||
    t.includes("javascript") ||
    t.includes("x-www-form-urlencoded")
  );
}

export function looksLikeHtml(contentType: string, body: string): boolean {
  if (contentType.toLowerCase().includes("html")) return true;
  return /^\s*(<!doctype html|<html[\s>])/i.test(body);
}

/** Page title, when the document has one worth reporting. */
export function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const t = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
  return t || null;
}

/** Tags after which text should continue on a new line. */
const BLOCK_END =
  /<\/(?:p|div|section|article|li|tr|h[1-6]|blockquote)\s*>|<br\s*\/?>/gi;

/**
 * Strip HTML down to readable text.
 *
 * Script and style bodies go first: their contents are not markup, so removing
 * tags alone would leave the JS and CSS behind as if it were prose.
 *
 * Then the document is split on block boundaries and each piece is flattened
 * independently. Splitting first is what lets whitespace be collapsed the way
 * HTML actually treats it - newlines in the source are just whitespace, so
 * "a\n\nb" inside one paragraph is "a b" - while two paragraphs still land on
 * separate lines.
 */
export function htmlToText(html: string): string {
  const cleaned = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const lines = cleaned
    .split(BLOCK_END)
    .map((chunk) =>
      decodeEntities(chunk.replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((line) => line.length > 0);

  return lines.join("\n");
}

/** Apply the byte cap, reporting whether anything was cut. */
export function capText(
  text: string,
  cap = FETCH_TEXT_CAP,
): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };
  return { text: text.slice(0, cap), truncated: true };
}
