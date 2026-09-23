import { memo, useMemo, type CSSProperties } from "react";

export type AnsiSpan = {
  text: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  color?: string;
  bgColor?: string;
};

const STANDARD_COLORS: Record<number, string> = {
  30: "var(--terminal-ansi-black)",
  31: "var(--terminal-ansi-red)",
  32: "var(--terminal-ansi-green)",
  33: "var(--terminal-ansi-yellow)",
  34: "var(--terminal-ansi-blue)",
  35: "var(--terminal-ansi-magenta)",
  36: "var(--terminal-ansi-cyan)",
  37: "var(--terminal-ansi-white)",
  90: "var(--terminal-ansi-bright-black)",
  91: "var(--terminal-ansi-bright-red)",
  92: "var(--terminal-ansi-bright-green)",
  93: "var(--terminal-ansi-bright-yellow)",
  94: "var(--terminal-ansi-bright-blue)",
  95: "var(--terminal-ansi-bright-magenta)",
  96: "var(--terminal-ansi-bright-cyan)",
  97: "var(--terminal-ansi-bright-white)",
};

const STANDARD_BG_COLORS: Record<number, string> = {
  40: "var(--terminal-ansi-black)",
  41: "var(--terminal-ansi-red)",
  42: "var(--terminal-ansi-green)",
  43: "var(--terminal-ansi-yellow)",
  44: "var(--terminal-ansi-blue)",
  45: "var(--terminal-ansi-magenta)",
  46: "var(--terminal-ansi-cyan)",
  47: "var(--terminal-ansi-white)",
  100: "var(--terminal-ansi-bright-black)",
  101: "var(--terminal-ansi-bright-red)",
  102: "var(--terminal-ansi-bright-green)",
  103: "var(--terminal-ansi-bright-yellow)",
  104: "var(--terminal-ansi-bright-blue)",
  105: "var(--terminal-ansi-bright-magenta)",
  106: "var(--terminal-ansi-bright-cyan)",
  107: "var(--terminal-ansi-bright-white)",
};

/** Standard 256-color palette index to rgb hex (for 16..231 cube and 232..255 grayscale). */
function color256ToHex(code: number): string | null {
  if (code < 16) {
    const std = code < 8 ? 30 + code : 90 + (code - 8);
    return STANDARD_COLORS[std] ?? null;
  }
  if (code >= 16 && code <= 231) {
    // 6x6x6 color cube
    const c = code - 16;
    const r = Math.floor(c / 36);
    const g = Math.floor((c % 36) / 6);
    const b = c % 6;
    const steps = [0, 95, 135, 175, 215, 255];
    return `rgb(${steps[r]}, ${steps[g]}, ${steps[b]})`;
  }
  if (code >= 232 && code <= 255) {
    // grayscale ramp
    const gray = 8 + (code - 232) * 10;
    return `rgb(${gray}, ${gray}, ${gray})`;
  }
  return null;
}

/**
 * Parse text containing ANSI SGR escape sequences into styled spans.
 * Strips non-SGR escape sequences (e.g. cursor motion, clear screen).
 */
export function parseAnsiText(raw: string): AnsiSpan[] {
  if (!raw) return [];

  // Strip non-SGR escape sequences (e.g. \x1b[2K, \x1b[?25h, etc.)
  const text = raw
    .replace(/\x1B\[[0-9;]*[A-HJKSTfhilmnsu]/g, (match) =>
      match.endsWith("m") ? match : "",
    )
    .replace(/\x1B\([B0-2]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const ansiRegex = /\x1B\[([0-9;]*)m/g;
  const spans: AnsiSpan[] = [];

  let lastIndex = 0;
  let bold = false;
  let dim = false;
  let italic = false;
  let underline = false;
  let strikethrough = false;
  let color: string | undefined;
  let bgColor: string | undefined;

  let match: RegExpExecArray | null = ansiRegex.exec(text);

  while (match !== null) {
    const chunk = text.slice(lastIndex, match.index);
    if (chunk) {
      spans.push({
        text: chunk,
        bold: bold || undefined,
        dim: dim || undefined,
        italic: italic || undefined,
        underline: underline || undefined,
        strikethrough: strikethrough || undefined,
        color,
        bgColor,
      });
    }

    const codeStr = match[1] ?? "";
    const codes = codeStr.length === 0 ? [0] : codeStr.split(";").map(Number);

    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) {
        bold = false;
        dim = false;
        italic = false;
        underline = false;
        strikethrough = false;
        color = undefined;
        bgColor = undefined;
      } else if (code === 1) {
        bold = true;
      } else if (code === 2) {
        dim = true;
      } else if (code === 3) {
        italic = true;
      } else if (code === 4) {
        underline = true;
      } else if (code === 9) {
        strikethrough = true;
      } else if (code === 22) {
        bold = false;
        dim = false;
      } else if (code === 23) {
        italic = false;
      } else if (code === 24) {
        underline = false;
      } else if (code === 29) {
        strikethrough = false;
      } else if (code === 39) {
        color = undefined;
      } else if (code === 49) {
        bgColor = undefined;
      } else if (STANDARD_COLORS[code]) {
        color = STANDARD_COLORS[code];
      } else if (STANDARD_BG_COLORS[code]) {
        bgColor = STANDARD_BG_COLORS[code];
      } else if (code === 38) {
        // Extended foreground: 38;5;n or 38;2;r;g;b
        if (codes[i + 1] === 5 && i + 2 < codes.length) {
          color = color256ToHex(codes[i + 2]) ?? color;
          i += 2;
        } else if (codes[i + 1] === 2 && i + 4 < codes.length) {
          color = `rgb(${codes[i + 2]}, ${codes[i + 3]}, ${codes[i + 4]})`;
          i += 4;
        }
      } else if (code === 48) {
        // Extended background: 48;5;n or 48;2;r;g;b
        if (codes[i + 1] === 5 && i + 2 < codes.length) {
          bgColor = color256ToHex(codes[i + 2]) ?? bgColor;
          i += 2;
        } else if (codes[i + 1] === 2 && i + 4 < codes.length) {
          bgColor = `rgb(${codes[i + 2]}, ${codes[i + 3]}, ${codes[i + 4]})`;
          i += 4;
        }
      }
    }

    lastIndex = ansiRegex.lastIndex;
    match = ansiRegex.exec(text);
  }

  // Trailing chunk after last escape sequence
  if (lastIndex < text.length) {
    const chunk = text.slice(lastIndex);
    if (chunk) {
      spans.push({
        text: chunk,
        bold: bold || undefined,
        dim: dim || undefined,
        italic: italic || undefined,
        underline: underline || undefined,
        strikethrough: strikethrough || undefined,
        color,
        bgColor,
      });
    }
  }

  return spans;
}

export type AnsiOutputProps = {
  text: string;
  className?: string;
};

/**
 * ANSI-aware output inline in chat.
 *
 * Efficiently renders terminal output with ANSI colors, bold, dim, and text
 * styling mapped to Termigo's theme variables (`--terminal-ansi-*`).
 */
export const AnsiOutput = memo(function AnsiOutput({
  text,
  className,
}: AnsiOutputProps) {
  const spans = useMemo(() => parseAnsiText(text), [text]);

  if (spans.length === 0) {
    return <span className={className}> </span>;
  }

  return (
    <span className={className}>
      {spans.map((span, idx) => {
        const style: CSSProperties = {};
        if (span.color) style.color = span.color;
        if (span.bgColor) style.backgroundColor = span.bgColor;
        if (span.bold) style.fontWeight = "bold";
        if (span.dim) style.opacity = 0.65;
        if (span.italic) style.fontStyle = "italic";
        if (span.underline || span.strikethrough) {
          const dec = [];
          if (span.underline) dec.push("underline");
          if (span.strikethrough) dec.push("line-through");
          style.textDecoration = dec.join(" ");
        }

        const hasStyles = Object.keys(style).length > 0;
        return hasStyles ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional in the output
          <span key={idx} style={style}>
            {span.text}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional in the output
          <span key={idx}>{span.text}</span>
        );
      })}
    </span>
  );
});
