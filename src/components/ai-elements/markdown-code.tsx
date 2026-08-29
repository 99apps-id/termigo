"use client";

import { isValidElement, type ReactNode } from "react";

import { getLspNavigator } from "@/modules/lsp";
import { ChatCodeBlock } from "./chat-code";
import { MermaidDiagram } from "./mermaid-diagram";

// A file reference inside inline code: `path/to/file.ext`, optionally with a
// `:line` (and `:col`). The path needs a real extension so prose in backticks
// (`npm run build`, `useState`) is not mistaken for a file, and a `://` rules
// out URLs. This is exactly the `file_path:line` shape agents are told to emit.
const FILE_REF_RE =
  /^([A-Za-z0-9_.\-/\\@~]+\.([A-Za-z][A-Za-z0-9]{0,9}))(?::(\d+))?(?::\d+)?$/;

// Extensions common enough that a bare `name.ext` (no path, no line) is almost
// always a file, not a member access like `array.map`. When the token has a
// path separator or a `:line` we accept any extension; this list only rescues
// the separator-less, line-less case.
const KNOWN_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "mdx", "css", "scss",
  "html", "rs", "go", "py", "rb", "java", "kt", "c", "h", "cpp", "hpp", "cc",
  "cs", "php", "swift", "sh", "bash", "zsh", "toml", "yaml", "yml", "ini",
  "cfg", "conf", "env", "sql", "lock", "txt", "csv", "xml", "svg", "vue",
  "svelte", "gradle", "dockerfile", "tsconfig",
]);

export function parseFileRef(
  text: string,
): { path: string; line: number } | null {
  const t = text.trim();
  if (!t || t.includes("://") || t.includes(" ")) return null;
  const m = FILE_REF_RE.exec(t);
  if (!m) return null;
  const path = m[1];
  const ext = m[2].toLowerCase();
  const line = m[3] ? Number.parseInt(m[3], 10) : 1;
  const hasSep = /[\\/]/.test(path);
  const hasLine = m[3] !== undefined;
  // A separator or an explicit line makes it unambiguously a path; otherwise
  // require a known file extension so `obj.map` / `arr.length` stay plain code.
  if (!hasSep && !hasLine && !KNOWN_EXTS.has(ext)) return null;
  return { path, line };
}

/** Inline code that names a file: a clickable pill that opens it in the editor
 *  (at the line, when given) through the shared LSP navigator. */
function FileRefCode({
  ref,
  text,
}: {
  ref: { path: string; line: number };
  text: string;
}) {
  return (
    <button
      type="button"
      onClick={() => getLspNavigator()?.openFile(ref.path, ref.line)}
      title={`Open ${ref.path}${ref.line > 1 ? `:${ref.line}` : ""}`}
      className="cursor-pointer rounded px-0.5 font-mono text-[11px] text-foreground underline decoration-primary/50 underline-offset-2 hover:bg-primary/10 hover:text-primary hover:decoration-primary"
    >
      {text}
    </button>
  );
}

export function markdownCodeText(children?: ReactNode): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map((child) => markdownCodeText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(children)) {
    return markdownCodeText(children.props.children);
  }
  return "";
}

/**
 * Streamdown `components.code` override. Handles both inline (`code`) and
 * fenced blocks (className "language-X"). Fenced blocks delegate to the
 * Lezer-based renderer; inline stays a plain pill.
 */
export function MarkdownCode({
  className,
  children,
  ...rest
}: {
  className?: string;
  children?: ReactNode;
}) {
  const match = className?.match(/language-(\w+)/);
  if (!match) {
    // Inline code that is really a file reference becomes a clickable pill that
    // opens the file in the editor. Anything else stays a plain code pill.
    const text = markdownCodeText(children);
    const fileRef = parseFileRef(text);
    if (fileRef && getLspNavigator()) {
      return <FileRefCode ref={fileRef} text={text} />;
    }
    return (
      <code
        className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[11px] text-foreground"
        {...rest}
      >
        {children}
      </code>
    );
  }

  const lang = match[1] ?? null;
  const code = markdownCodeText(children).replace(/\n$/, "");
  // A ```mermaid fence renders as a diagram instead of a code block.
  if (lang?.toLowerCase() === "mermaid") {
    return <MermaidDiagram code={code} />;
  }
  return <ChatCodeBlock code={code} lang={lang} />;
}
