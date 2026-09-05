import {
  CodeIcon,
  File01Icon,
  HashtagIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo } from "react";
import { SLASH_COMMANDS } from "../lib/slashCommands";

export type ContextChip =
  | { kind: "selection"; source: "terminal" | "editor"; lines: number }
  | { kind: "file"; name: string; lines: number }
  | { kind: "snippet"; name: string };

const SELECTION_RE =
  /<selection\s+source="(terminal|editor)">\n?([\s\S]*?)\n?<\/selection>/g;
const FILE_RE = /<file\s+name="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/file>/g;
const SNIPPET_RE = /<snippet\s+name="([^"]+)">\n?[\s\S]*?\n?<\/snippet>/g;

function countLines(s: string): number {
  if (!s) return 0;
  const trimmed = s.replace(/\n+$/, "");
  if (!trimmed) return 0;
  return trimmed.split("\n").length;
}

export function stripUserContextBlocks(text: string): {
  text: string;
  chips: ContextChip[];
} {
  const chips: ContextChip[] = [];
  let out = text;
  out = out.replace(SELECTION_RE, (_m, source: string, body: string) => {
    chips.push({
      kind: "selection",
      source: source === "editor" ? "editor" : "terminal",
      lines: countLines(body),
    });
    return "";
  });
  out = out.replace(FILE_RE, (_m, name: string, body: string) => {
    chips.push({ kind: "file", name, lines: countLines(body) });
    return "";
  });
  out = out.replace(SNIPPET_RE, (_m, name: string) => {
    chips.push({ kind: "snippet", name });
    return "";
  });
  return { text: out.trim(), chips };
}

export const ContextChips = memo(function ContextChips({
  chips,
}: {
  chips: ContextChip[];
}) {
  return (
    <div className="mb-1 flex flex-wrap gap-1">
      {chips.map((c, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: context chips are a positional, fixed-order list
          key={i}
          className="inline-flex items-center gap-1 rounded-md border border-border/80 bg-card px-1.5 py-0.5 text-[10.5px] text-muted-foreground shadow-2xs dark:border-border/50 dark:bg-card/60"
        >
          {chipIcon(c)}
          <span className="font-medium text-foreground">{chipLabel(c)}</span>
          {"lines" in c && c.lines > 0 ? (
            <span className="opacity-75">· {c.lines}L</span>
          ) : null}
        </span>
      ))}
    </div>
  );
});

function chipIcon(c: ContextChip) {
  if (c.kind === "selection") {
    return (
      <HugeiconsIcon
        icon={c.source === "editor" ? CodeIcon : TerminalIcon}
        size={10}
        strokeWidth={1.75}
      />
    );
  }
  if (c.kind === "file") {
    return <HugeiconsIcon icon={File01Icon} size={10} strokeWidth={1.75} />;
  }
  return <HugeiconsIcon icon={HashtagIcon} size={10} strokeWidth={1.75} />;
}

function chipLabel(c: ContextChip): string {
  if (c.kind === "selection") {
    return c.source === "editor" ? "Editor selection" : "Terminal selection";
  }
  if (c.kind === "file") return c.name;
  return `#${c.name}`;
}

export function CommandSnippet({ name }: { name: string }) {
  const meta = SLASH_COMMANDS[name];
  if (!meta) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-muted/50 px-2 py-1 font-mono text-[11px] dark:border-border/50 dark:bg-muted/40">
        /{name}
      </div>
    );
  }
  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-border/80 bg-muted/50 px-2 py-1 dark:border-border/50 dark:bg-muted/40">
      <HugeiconsIcon
        icon={meta.icon}
        size={12}
        strokeWidth={1.75}
        className="shrink-0 text-foreground"
      />
      <span className="font-mono text-[11px] text-foreground">
        {meta.invocation}
      </span>
      <span className="truncate text-[11px] text-muted-foreground">
        {meta.label}
      </span>
    </div>
  );
}
