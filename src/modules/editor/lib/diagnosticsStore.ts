import { create } from "zustand";

export type DiagnosticItem = {
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source: string | null;
};

export type DiagnosticCounts = { errors: number; warnings: number };

function countsOf(items: readonly DiagnosticItem[]): DiagnosticCounts {
  let errors = 0;
  let warnings = 0;
  for (const d of items) {
    if (d.severity === "error") errors += 1;
    else if (d.severity === "warning") warnings += 1;
  }
  return { errors, warnings };
}

type State = {
  /** Counts per path, surfaced by the statusbar badge. */
  byPath: Record<string, DiagnosticCounts>;
  /** Full diagnostics per path, read by the agent's lsp_diagnostics tool. */
  itemsByPath: Record<string, DiagnosticItem[]>;
  report: (path: string, items: DiagnosticItem[] | null) => void;
};

export const useDiagnosticsStore = create<State>((set) => ({
  byPath: {},
  itemsByPath: {},
  report: (path, items) =>
    set((s) => {
      const prev = s.itemsByPath[path];
      const same =
        items &&
        prev &&
        prev.length === items.length &&
        prev.every((d, i) => {
          const e = items[i];
          return (
            d.line === e.line &&
            d.column === e.column &&
            d.severity === e.severity &&
            d.message === e.message &&
            d.source === e.source
          );
        });
      if (same) return s;
      const byPath = { ...s.byPath };
      const itemsByPath = { ...s.itemsByPath };
      if (items && items.length > 0) {
        itemsByPath[path] = items;
        byPath[path] = countsOf(items);
      } else {
        delete byPath[path];
        delete itemsByPath[path];
      }
      return { byPath, itemsByPath };
    }),
}));