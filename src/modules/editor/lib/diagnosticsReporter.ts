import {
  diagnosticCount,
  forEachDiagnostic,
  type Diagnostic,
} from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  type DiagnosticItem,
  useDiagnosticsStore,
} from "./diagnosticsStore";

function toItem(state: EditorView["state"], d: Diagnostic, from: number): DiagnosticItem {
  const line = state.doc.lineAt(Math.min(from, Math.max(0, state.doc.length - 1)));
  return {
    line: line.number,
    column: from - line.from + 1,
    severity: d.severity,
    message: d.message,
    source: d.source ?? null,
  };
}

export function diagnosticsReporter(getPath: () => string): Extension {
  return EditorView.updateListener.of((update) => {
    if (
      !update.docChanged &&
      !update.transactions.some((tr) => tr.effects.length > 0)
    ) {
      return;
    }
    const total = diagnosticCount(update.state);
    let items: DiagnosticItem[] = [];
    if (total > 0) {
      const seen = new Set<Diagnostic>();
      forEachDiagnostic(update.state, (d, from) => {
        if (seen.has(d)) return;
        seen.add(d);
        items.push(toItem(update.state, d, from));
      });
    }
    useDiagnosticsStore.getState().report(getPath(), items);
  });
}