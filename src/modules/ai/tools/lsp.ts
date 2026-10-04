import { tool } from "ai";
import { z } from "zod";
import { resolvePath, type ToolContext } from "./context";
import { native } from "../lib/native";
import { checkReadable } from "../lib/security";
import {
  applyTextEdits,
  collectFileEdits,
  type LspWorkspaceEdit,
} from "../lib/workspaceEdit";
import { useDiagnosticsStore } from "@/modules/editor/lib/diagnosticsStore";
import { acquireQuerySession } from "@/modules/lsp/lib/sessionManager";
import {
  fileUriToPath,
  pathToFileUri,
} from "@/modules/lsp/lib/uri";

export type LspLocationResult = {
  path: string;
  line: number;
  character: number;
  preview?: string;
};

export type LspDiagnosticResult = {
  path: string;
  line: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
};

export type LspSymbolResult = {
  name: string;
  kind: string;
  line: number;
  containerName?: string;
};

type LspPos = { line: number; character: number };
type LspRange = { start: LspPos };
type LspLocation = { uri: string; range: LspRange };
type LspLocationLink = {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange?: LspRange;
};
// Mirror of the SDK's DefinitionResult union, declared locally so this module
// stays free of the protocol dependency.
type DefinitionResult =
  | LspLocation
  | LspLocation[]
  | LspLocationLink[]
  | null
  | undefined;

/** Normalize LSP definition/reference locations to filesystem paths. */
export function normalizeLspLocations(
  result: DefinitionResult,
): LspLocationResult[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  const out: LspLocationResult[] = [];
  for (const loc of list) {
    const uri = "uri" in loc ? loc.uri : loc.targetUri;
    const range = "uri" in loc ? loc.range : (loc.targetSelectionRange ?? loc.targetRange);
    out.push({
      path: fileUriToPath(uri) ?? uri,
      line: range.start.line + 1,
      character: range.start.character + 1,
    });
  }
  return out;
}

/** Normalize `{ start: { line, character } }` into a 1-based view. */
function toPos(p: { line: number; character: number }): LspPos {
  return { line: p.line - 1, character: p.character - 1 };
}

export function buildLspTools(ctx: ToolContext) {
  return {
    lsp_definitions: tool({
      description:
        "Find the definition of a symbol at the given file and position using a live Language Server Protocol session. Line and character are 1-indexed. Returns target file paths and positions. Read-only, but starts the relevant language server on first use if it is enabled and not already running.",
      inputSchema: z.object({
        path: z.string().describe("Relative or absolute path to the source file."),
        line: z.number().int().min(1).describe("1-indexed line number."),
        character: z.number().int().min(1).describe("1-indexed character / column number."),
      }),
      execute: async ({ path: rawPath, line, character }) => {
        const path = resolvePath(rawPath, ctx.getCwd());
        const secret = checkReadable(path);
        if (!secret.ok) {
          return { error: `Access denied: ${secret.reason}`, path: rawPath };
        }
        if (ctx.getRemoteSession()) {
          return {
            error: "lsp_definitions is local-only; use grep on the remote host to locate symbols.",
            path: rawPath,
          };
        }
        const uri = pathToFileUri(path);
        const q = await acquireQuerySession(path);
        if (!q) {
          return {
            error:
              "No enabled language server covered this file (or the server binary is missing). Enable LSP for its language in Settings, or install the server.",
            path: rawPath,
          };
        }
        try {
          const result = await q.client.textDocumentDefinition({
            textDocument: { uri: q.uri },
            position: toPos({ line, character }),
          });
          const defs = normalizeLspLocations(result);
          return {
            path: rawPath,
            uri,
            line,
            character,
            definitions: defs,
            count: defs.length,
          };
        } catch (e) {
          return { error: String(e), path: rawPath };
        } finally {
          q.release();
        }
      },
    }),

    lsp_references: tool({
      description:
        "Find all references to a symbol across the workspace using a live Language Server Protocol session. Line and character are 1-indexed. Returns target file paths and positions. Read-only, but starts the relevant language server on first use if enabled.",
      inputSchema: z.object({
        path: z.string().describe("Relative or absolute path to the source file."),
        line: z.number().int().min(1).describe("1-indexed line number."),
        character: z.number().int().min(1).describe("1-indexed character / column number."),
        includeDeclaration: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include the symbol declaration in the reference results."),
      }),
      execute: async ({ path: rawPath, line, character, includeDeclaration }) => {
        const path = resolvePath(rawPath, ctx.getCwd());
        const secret = checkReadable(path);
        if (!secret.ok) {
          return { error: `Access denied: ${secret.reason}`, path: rawPath };
        }
        if (ctx.getRemoteSession()) {
          return {
            error: "lsp_references is local-only; use grep on the remote host to locate symbols.",
            path: rawPath,
          };
        }
        const uri = pathToFileUri(path);
        const q = await acquireQuerySession(path);
        if (!q) {
          return {
            error:
              "No enabled language server covered this file (or the server binary is missing). Enable LSP for its language in Settings, or install the server.",
            path: rawPath,
          };
        }
        try {
          const result = await q.client.textDocumentReferences({
            textDocument: { uri: q.uri },
            position: toPos({ line, character }),
            context: { includeDeclaration: includeDeclaration ?? true },
          });
          const refs = normalizeLspLocations(result ?? []);
          return {
            path: rawPath,
            uri,
            line,
            character,
            references: refs,
            count: refs.length,
          };
        } catch (e) {
          return { error: String(e), path: rawPath };
        } finally {
          q.release();
        }
      },
    }),

    lsp_rename: tool({
      description:
        "Rename a symbol across the whole workspace using a live Language Server Protocol session, applying the server's rename edit to every affected file. Line and character are 1-indexed and must point at the symbol. Prefer this over a sequence of edit calls for a cross-file rename: the server computes every reference, so nothing is missed and no unrelated text is rewritten. Local-only; writes the files the server names.",
      inputSchema: z.object({
        path: z.string().describe("Relative or absolute path to the source file."),
        line: z.number().int().min(1).describe("1-indexed line number of the symbol."),
        character: z
          .number()
          .int()
          .min(1)
          .describe("1-indexed character / column of the symbol."),
        newName: z.string().min(1).describe("The new symbol name."),
      }),
      execute: async ({ path: rawPath, line, character, newName }) => {
        const path = resolvePath(rawPath, ctx.getCwd());
        const secret = checkReadable(path);
        if (!secret.ok) {
          return { error: `Access denied: ${secret.reason}`, path: rawPath };
        }
        if (ctx.getRemoteSession()) {
          return {
            error:
              "lsp_rename is local-only; use edit on the remote host to rename symbols.",
            path: rawPath,
          };
        }
        const q = await acquireQuerySession(path);
        if (!q) {
          return {
            error:
              "No enabled language server covered this file (or the server binary is missing). Enable LSP for its language in Settings, or install the server.",
            path: rawPath,
          };
        }
        try {
          const edit = (await q.client.textDocumentRename({
            textDocument: { uri: q.uri },
            position: toPos({ line, character }),
            newName,
          })) as unknown as LspWorkspaceEdit | null;
          if (!edit) {
            return {
              path: rawPath,
              newName,
              changed: 0,
              files: [],
              note: "The language server returned no rename edit; the position may not be on a renamable symbol.",
            };
          }
          const plans = collectFileEdits(edit);
          if (plans.length === 0) {
            return {
              path: rawPath,
              newName,
              changed: 0,
              files: [],
              note: "The language server's rename edit named no files.",
            };
          }
          const files: Array<{ path: string; edits?: number; error?: string }> =
            [];
          for (const plan of plans) {
            const guard = checkReadable(plan.path);
            if (!guard.ok) {
              files.push({
                path: plan.path,
                error: `Access denied: ${guard.reason}`,
              });
              continue;
            }
            const read = await native.readFile(plan.path);
            if (read.kind !== "text") {
              files.push({
                path: plan.path,
                error: "Skipped: not a readable text file.",
              });
              continue;
            }
            const updated = applyTextEdits(read.content, plan.edits);
            if (updated === read.content) {
              files.push({ path: plan.path, edits: 0 });
              continue;
            }
            await native.writeFile(plan.path, updated);
            files.push({ path: plan.path, edits: plan.edits.length });
          }
          const changed = files.filter(
            (f) => !f.error && (f.edits ?? 0) > 0,
          ).length;
          return {
            path: rawPath,
            newName,
            changed,
            files,
            ...(changed === 0
              ? {
                  note: "The rename produced no text change; the symbol may already have that name.",
                }
              : {}),
          };
        } catch (e) {
          return { error: String(e), path: rawPath };
        } finally {
          q.release();
        }
      },
    }),

    lsp_diagnostics: tool({
      description:
        "Get the latest LSP diagnostics (errors, warnings, type mismatches) that the editor has received for a file. Read-only. If no diagnostics are known yet for the file, returns an empty list and suggests run_checks (lint) as the definitive source for compiler feedback.",
      inputSchema: z.object({
        path: z.string().optional().describe("Optional file path to limit diagnostics to a specific file."),
      }),
      execute: async ({ path: rawPath }) => {
        const target = rawPath
          ? resolvePath(rawPath, ctx.getCwd())
          : (ctx.getWorkspaceRoot() ?? ctx.getCwd());
        if (target) {
          const secret = checkReadable(target);
          if (!secret.ok) {
            return { error: `Access denied: ${secret.reason}`, path: rawPath };
          }
        }
        const items = useDiagnosticsStore.getState().itemsByPath[target ?? ""];
        const normalized: LspDiagnosticResult[] = (items ?? []).map((d) => ({
          path: target ?? "",
          line: d.line,
          severity: d.severity,
          message: d.message,
          ...(d.source ? { source: d.source } : {}),
        }));
        return {
          path: target ?? null,
          diagnostics: normalized,
          count: normalized.length,
          note:
            normalized.length === 0
              ? "No LSP diagnostics known for this file. Use run_checks (lint) for definitive compiler feedback."
              : "Diagnostics as surfaced by the editor's live language server.",
        };
      },
    }),
  } as const;
}