"use client";

import { isValidElement, type ReactNode } from "react";

import { ChatCodeBlock } from "./chat-code";
import { MermaidDiagram } from "./mermaid-diagram";

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
