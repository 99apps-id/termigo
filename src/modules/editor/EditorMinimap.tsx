import type { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import {
  useDiagnosticsStore,
  type DiagnosticItem,
} from "./lib/diagnosticsStore";

type Props = {
  getView: () => EditorView | null;
  repaintSignal: number;
  path: string;
};

const ROW_PX = 2;
const COL_PX = 2;
const MAX_COLS = 90;
const MAX_HEIGHT = 1400;
const VIEWPORT_COLOR = "color-mix(in srgb, var(--foreground) 22%, transparent)";
const VIEWPORT_BORDER =
  "color-mix(in srgb, var(--foreground) 38%, transparent)";

type Mark = "error" | "warning" | "info";

function rankOf(severity: DiagnosticItem["severity"]): Mark {
  if (severity === "error") return "error";
  if (severity === "warning") return "warning";
  return "info";
}

/** Highest-severity mark per 0-based row. Pure so it is unit-testable. */
export function collectMarks(
  items: readonly Pick<DiagnosticItem, "line" | "severity">[] | undefined,
): Map<number, Mark> {
  const marks = new Map<number, Mark>();
  if (!items) return marks;
  for (const d of items) {
    const row = d.line - 1;
    if (row < 0) continue;
    const mark = rankOf(d.severity);
    const prev = marks.get(row);
    if (prev === "error") continue;
    if (prev === "warning" && mark !== "error") continue;
    marks.set(row, mark);
  }
  return marks;
}

type Palette = {
  fg: string;
  muted: string;
  primary: string;
  error: string;
  warning: string;
};

// Canvas fillStyle cannot resolve var(): an unparseable assignment is silently
// ignored and the previous color sticks. Read the computed values instead.
function themeVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

function readPalette(): Palette {
  return {
    fg: themeVar("--foreground", "#e8e8e8"),
    muted: themeVar("--muted-foreground", "#8a8a8a"),
    primary: themeVar("--primary", "#8b5cf6"),
    error: themeVar("--destructive", "#e5484d"),
    warning: themeVar("--warning", "#f59e0b"),
  };
}

function lineStyle(
  line: string,
  pal: Palette,
): { color: string; alpha: number } | null {
  const t = line.trimStart();
  if (t === "") return null;
  if (t.startsWith("//") || t.startsWith("#") || t.startsWith("*"))
    return { color: pal.muted, alpha: 1 };
  if (
    t.startsWith("import ") ||
    t.startsWith("from ") ||
    t.startsWith("export ") ||
    t.startsWith("return ") ||
    t.startsWith("const ") ||
    t.startsWith("let ") ||
    t.startsWith("var ") ||
    t.startsWith("function ") ||
    t.startsWith("class ")
  )
    return { color: pal.primary, alpha: 1 };
  if (/^["'`]/.test(t) || t.startsWith("<") || t.startsWith("{"))
    return { color: pal.fg, alpha: 0.55 };
  return { color: pal.fg, alpha: 0.38 };
}

function paint(
  canvas: HTMLCanvasElement,
  lines: string[],
  marks: Map<number, Mark>,
  pal: Palette,
  dpr: number,
): number {
  const width = MAX_COLS * COL_PX;
  const height = Math.min(lines.length * ROW_PX, MAX_HEIGHT);
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) return height;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  const rows = Math.min(lines.length, Math.floor(MAX_HEIGHT / ROW_PX));
  for (let i = 0; i < rows; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = Math.min(
      line.length - line.trimStart().length,
      MAX_COLS - 1,
    );
    let len = 0;
    for (let c = indent; c < line.length && indent + len < MAX_COLS; c++) {
      len += line[c] === "\t" ? 4 : 1;
    }
    if (len === 0) continue;
    const style = lineStyle(line, pal);
    if (!style) continue;
    ctx.globalAlpha = style.alpha;
    ctx.fillStyle = style.color;
    ctx.fillRect(indent * COL_PX, i * ROW_PX, len * COL_PX, 1);
  }
  ctx.globalAlpha = 0.9;
  for (const [row, mark] of marks) {
    if (row >= rows) continue;
    const y = row * ROW_PX;
    if (mark === "error") {
      ctx.fillStyle = pal.error;
      ctx.fillRect(0, y, width, ROW_PX);
    } else if (mark === "warning") {
      ctx.fillStyle = pal.warning;
      ctx.fillRect(0, y, width, ROW_PX);
    } else {
      ctx.fillStyle = pal.muted;
      ctx.fillRect(width - 8, y, 8, ROW_PX);
    }
  }
  ctx.globalAlpha = 1;
  return height;
}

export function EditorMinimap({ getView, repaintSignal, path }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const heightRef = useRef(1);
  const dragRef = useRef(false);
  const getViewRef = useRef(getView);
  getViewRef.current = getView;
  const items = useDiagnosticsStore((s) => s.itemsByPath[path]);

  const syncViewportRef = useRef(() => {});
  syncViewportRef.current = () => {
    const view = getViewRef.current();
    const box = boxRef.current;
    if (!view || !box) return;
    const { scrollTop, clientHeight, scrollHeight } = view.scrollDOM;
    const h = heightRef.current;
    if (scrollHeight <= 0) return;
    const top = (scrollTop / scrollHeight) * h;
    const vh = Math.max(24, (clientHeight / scrollHeight) * h);
    box.style.transform = `translateY(${top}px)`;
    box.style.height = `${Math.min(vh, h)}px`;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: repaint ticks on the version prop and the subscribed diagnostics; view identity is stable per pane
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    const repaint = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const view = getViewRef.current();
        if (!view) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const lines = view.state.doc.toString().split("\n");
        heightRef.current = paint(
          canvas,
          lines,
          collectMarks(items),
          readPalette(),
          dpr,
        );
        syncViewportRef.current();
      });
    };
    // Initial paint on mount; the view exists by the time the pane renders
    // the minimap next to it. Repaints also ride on repaintSignal below.
    repaint();
    const timer = window.setInterval(repaint, 5000);
    const scroller = getViewRef.current()?.scrollDOM ?? null;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => syncViewportRef.current());
    };
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
      scroller?.removeEventListener("scroll", onScroll);
    };
  }, [repaintSignal, items]);

  function jumpTo(clientY: number) {
    const view = getViewRef.current();
    const wrap = wrapRef.current;
    if (!view || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    const { scrollHeight, clientHeight } = view.scrollDOM;
    view.scrollDOM.scrollTop = ratio * (scrollHeight - clientHeight);
    view.focus();
  }

  return (
    <div
      ref={wrapRef}
      role="presentation"
      aria-hidden="true"
      className="relative h-full w-[104px] shrink-0 cursor-pointer select-none overflow-hidden border-l border-border/60 bg-muted/20"
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        dragRef.current = true;
        jumpTo(e.clientY);
        const move = (ev: MouseEvent) => {
          if (dragRef.current) jumpTo(ev.clientY);
        };
        const up = () => {
          dragRef.current = false;
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: `${MAX_COLS * COL_PX}px`, height: "100%" }}
        className="absolute inset-y-0 left-1/2 -translate-x-1/2"
      />
      <div
        ref={boxRef}
        className="pointer-events-none absolute inset-x-1 top-0 rounded-[3px] border"
        style={{
          backgroundColor: VIEWPORT_COLOR,
          borderColor: VIEWPORT_BORDER,
        }}
      />
    </div>
  );
}
