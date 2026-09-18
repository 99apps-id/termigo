import { tool } from "ai";
import { z } from "zod";
import { isSafePreviewUrl, unsafeBrowserUrl } from "../lib/browserGuard";
import { native } from "../lib/native";
import { checkShellCommand } from "../lib/security";
import { useArtifactsStore } from "../store/artifactsStore";
import { resolvePath, type ToolContext } from "./context";
import { clampedInt } from "./clampedNumber";

function escHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );
}

// A compact Markdown → HTML pass so a `.md` report renders (not raw text) in the
// preview canvas: fenced code, headings, --- rules, tables, lists, bold, inline
// code, paragraphs. Everything is escaped first.
function mdToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const inl = (s: string) =>
    escHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const fence = /^\s*```/.test(l);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]))
        body.push(lines[i++]);
      i++;
      out.push(`<pre>${escHtml(body.join("\n"))}</pre>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) {
      out.push("<hr>");
      i++;
      continue;
    }
    const h = /^\s*(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      out.push(`<h${h[1].length}>${inl(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (
      /^\s*\|.*\|\s*$/.test(l) &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] || "")
    ) {
      const cells = (r: string) =>
        r
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((c) => c.trim());
      const head = cells(l);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]))
        rows.push(cells(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inl(c)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inl(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
      continue;
    }
    const li = /^\s*[-*+]\s+(.*)$/.exec(l);
    if (li) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        items.push(`<li>${inl(m[1])}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\s*$/.test(l)) {
      i++;
      continue;
    }
    out.push(`<p>${inl(l.trim())}</p>`);
    i++;
  }
  return out.join("\n");
}

/** Extensions that are finished, deliverable documents but cannot be rendered
 *  in the preview pane: the pane shows text, while these are ZIP containers
 *  (`native.readFile` reports them as `binary`). They are still worth reporting
 *  as delivered, because the Telegram relay attaches them by extension. */
const BINARY_DOC_EXT = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "rtf",
  "epub",
]);

const PREVIEW_DOC_CSS = `<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#1a1a1a;background:#fff;margin:0;padding:20px;line-height:1.55;max-width:100%;}
  *{overflow-wrap:anywhere;word-break:break-word;}
  pre{background:#0f1417;color:#d7dee2;padding:10px 12px;border-radius:6px;overflow-x:auto;white-space:pre-wrap;font-size:12px;}
  code{background:#eef1f3;padding:1px 4px;border-radius:3px;font-size:12px;}
  pre code{background:none;padding:0;}
  table{border-collapse:collapse;width:100%;table-layout:fixed;margin:10px 0;font-size:13px;}
  th,td{border:1px solid #d6dbe0;padding:5px 8px;text-align:left;vertical-align:top;}
  th{background:#f2f4f6;}
  h1,h2,h3{color:#10151a;} hr{border:none;border-top:1px solid #d6dbe0;margin:16px 0;}
  a{color:#1a6f62;}
</style>`;

// The canvas strips <script> and runs no scripts (sandbox without
// allow-scripts), so an HTML view that relies on the Mermaid CDN renders as a
// blank card. Catch that before opening the canvas: if the content is clearly a
// Mermaid document, return the fenced block so the model can show it in chat
// (which renders Mermaid properly) instead of a blank preview.
function findMermaidFlows(html: string): string[] {
  const flows: string[] = [];
  // Fenced ```mermaid code inside the HTML.
  const fence = /```mermaid\s*\n([\s\S]*?)(?:```|$)/gi;
  // <pre class="mermaid">…</pre> (common Mermaid-hosted export).
  const pre =
    /<pre[^>]*class=["'][^"']*\bmermaid\b[^"']*["'][^>]*>([\s\S]*?)<\/pre>/gi;
  for (const m of html.matchAll(fence)) flows.push(m[1].trim());
  for (const m of html.matchAll(pre)) flows.push(m[1].trim());
  return flows.filter(Boolean);
}

export function buildTerminalTools(ctx: ToolContext) {
  return {
    suggest_command: tool({
      description:
        "Propose a single shell command. Renders a card in chat with an 'Insert' button - the command is NOT written to any terminal automatically; only the user's click inserts it at the prompt without executing. Use this when the answer IS a command.",
      inputSchema: z.object({
        command: z
          .string()
          .describe("The shell command. Single line, no trailing newline."),
        explanation: z
          .string()
          .optional()
          .describe("Optional one-line note shown beside the command."),
      }),
      execute: async ({ command, explanation }) => {
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        // Reject control bytes - the user inserts via click, but the rendered
        // command must reflect exactly what will land at the prompt.
        if (/[\n\r\x00\x1b\x07]/.test(command)) {
          return {
            error: "command must be a single line without control bytes",
          };
        }
        return { command, explanation };
      },
    }),

    get_terminal_output: tool({
      description:
        "Return the tail of a terminal's scrollback. Defaults to the active terminal; pass `tab_id` from `list_terminals` to read another one - a dev server left running in a different tab, for instance. Use this when the user references 'this error', 'the last command', or you need to interpret recent output. Default is 80 lines; raise it only when you genuinely need more. Refuses if that terminal is in Privacy mode.",
      inputSchema: z.object({
        lines: clampedInt(1, 2000, 80).describe(
          "Number of trailing lines to return. Default 80, clamped between 1 and 2000.",
        ),
        tab_id: z
          .number()
          .int()
          .optional()
          .describe("From `list_terminals`. Omit for the active terminal."),
      }),
      execute: async ({ lines, tab_id }) => {
        let buffer: string | null;
        if (tab_id === undefined) {
          if (ctx.isActiveTerminalPrivate()) {
            return {
              error:
                "active terminal is in Privacy mode; its buffer is withheld. Ask the user to switch to a regular tab if they want you to see it.",
            };
          }
          buffer = ctx.getTerminalContext();
          if (!buffer) return { output: "", note: "no active terminal" };
        } else {
          const found = ctx.listTerminals().find((t) => t.tabId === tab_id);
          if (!found) {
            return {
              error: `no terminal with tab_id ${tab_id}; call list_terminals`,
            };
          }
          if (found.private) {
            return {
              error: `"${found.title}" is in Privacy mode; its buffer is withheld.`,
            };
          }
          buffer = ctx.getTerminalContextFor(tab_id);
          if (!buffer) {
            return { output: "", note: `"${found.title}" has no output yet` };
          }
        }
        const n = lines ?? 80;
        const parts = buffer.split("\n");
        const sliced =
          parts.length <= n ? buffer : parts.slice(parts.length - n).join("\n");
        const MAX = 24_000;
        const capped =
          sliced.length > MAX
            ? `…[truncated]…\n${sliced.slice(sliced.length - MAX)}`
            : sliced;
        return { output: capped, lines_returned: Math.min(parts.length, n) };
      },
    }),

    list_terminals: tool({
      description:
        "List every open terminal: its `tab_id`, title, working directory, which one is active, and whether it is in Privacy mode. Use this before assuming what is running - a dev server or a watcher may already be up in another tab. Pass a `tab_id` to `get_terminal_output` to read one. Read-only: this cannot switch, close, or type into a terminal. Auto-executes.",
      inputSchema: z.object({}),
      execute: async () => {
        const terminals = ctx.listTerminals();
        if (terminals.length === 0) return { count: 0, terminals: [] };
        return {
          count: terminals.length,
          terminals: terminals.map((t) => ({
            tab_id: t.tabId,
            title: t.title,
            cwd: t.cwd,
            active: t.isActive,
            // Listed rather than hidden: the agent should know a terminal
            // exists and is off limits, or it reads the gap as "no terminal"
            // and asks the user where they are.
            ...(t.private ? { private: true } : {}),
          })),
        };
      },
    }),

    open_preview: tool({
      description:
        "Open a preview tab at the given URL, next to the terminal. A localhost/loopback dev server (e.g. http://localhost:5173) or external site loads in an in-app browser tab. Pass `instance` if you want to inspect or drive it with browser tools (browser_screenshot, browser_extract, browser_snapshot, browser_console). Default instance is 'preview'.",
      inputSchema: z.object({
        url: z
          .url()
          .describe(
            "Full http(s) URL to load (e.g. http://localhost:5173 or https://example.com). Must include scheme.",
          ),
        instance: z
          .string()
          .optional()
          .describe(
            "Short browser instance name for browser tools to drive or inspect this tab (e.g. 'preview'). Defaults to 'preview'.",
          ),
      }),
      execute: async ({ url, instance }) => {
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return { error: "invalid URL", url };
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return { error: "only http/https URLs are allowed", url };
        }
        // A loopback dev server is allowed (isSafePreviewUrl re-allows loopback
        // the raw guard refuses); any other host must pass the SSRF guard, which
        // rejects decimal/hex IPv4, IPv6 link-local and cloud-metadata tricks. An
        // allowed external URL renders in the native embedded browser.
        if (!isSafePreviewUrl(url) && unsafeBrowserUrl(url) !== null) {
          // The dev-server banner prints `http://0.0.0.0:5173` and models copy
          // it verbatim; a nameless error made them retry the same URL. Say
          // what to send instead.
          if (parsed.hostname === "0.0.0.0" || parsed.hostname === "[::]") {
            const port = parsed.port ? `:${parsed.port}` : "";
            return {
              error: `0.0.0.0 is a wildcard bind address, not a target to connect to. Open http://localhost${port} instead (same server).`,
              url,
            };
          }
          return {
            error:
              "URL blocked: not a loopback dev server and not a safe external host (SSRF/metadata/link-local are refused).",
            url,
          };
        }
        const targetInstance = (instance ?? "preview").trim() || "preview";
        const ok = ctx.openPreview(url, targetInstance);
        if (!ok) return { error: "preview surface unavailable", url };
        // Surface in the Artifacts panel so the user can jump back to it.
        useArtifactsStore.getState().add(ctx.getSessionId() ?? "", {
          kind: "preview",
          title: url,
          payload: url,
        });
        return { url, instance: targetInstance, ok: true };
      },
    }),

    render_view: tool({
      description:
        'Render a self-contained HTML VIEW in a canvas tab beside the workspace: a graph / chart, or a plan / walkthrough the user should see and act on. Interactivity is markup-only (scripts are stripped): give any element data-canvas-action="<text>" and a click sends <text> back to you as the user\'s next message - e.g. a Proceed or Execute button on a plan, or step actions. Use inline SVG for charts. Reusing the same title updates the view in place. Auto-executes.',
      inputSchema: z.object({
        html: z
          .string()
          .describe(
            "Complete self-contained HTML. Inline SVG and inline styles are fine; <script> and inline on* handlers are removed. Put data-canvas-action on any button you want to send an action back.",
          ),
        title: z
          .string()
          .optional()
          .describe(
            "Canvas tab title. Reusing the same title updates that canvas instead of opening a new one.",
          ),
      }),
      execute: async ({ html, title }) => {
        // Mermaid only renders in chat (the canvas disables scripts), so if the
        // view is a Mermaid document, return the fenced block instead of
        // opening a blank canvas.
        const flows = findMermaidFlows(html);
        if (flows.length > 0) {
          return {
            error:
              "The canvas cannot run Mermaid's <script> (scripts are stripped), so this diagram would render blank. Show it in chat instead:",
            mermaid: flows.join("\n\n"),
          };
        }
        const ok = ctx.openCanvas(html, title);
        if (!ok) return { error: "canvas surface unavailable" };
        // Record the canvas as an artifact so the user can reopen it later
        // without asking the model to re-render it.
        useArtifactsStore.getState().add(ctx.getSessionId() ?? "", {
          kind: "canvas",
          title: title ?? "Canvas",
          payload: html,
        });
        return { ok: true, title: title ?? "Canvas" };
      },
    }),

    preview_file: tool({
      description:
        "Display a local report/document file in the in-app browser pane beside the workspace. Use it to SHOW the user a finished report: an .html or .md file renders styled (headings, tables, code), any other text file shows as text. Ideal right after generating a report. Office and PDF documents (.docx, .xlsx, .pptx, .pdf, .odt, ...) cannot render in the pane, but calling this registers them as deliverables so the file is attached when the session is relayed to Telegram — point the user to the .html/.md version when they need an in-pane view.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            "Path to the file to preview (absolute, or relative to the active terminal cwd).",
          ),
        title: z
          .string()
          .optional()
          .describe("Preview tab title. Reusing a title updates that view."),
      }),
      execute: async ({ path, title }) => {
        const abs = resolvePath(path, ctx.getCwd());
        const ext = abs.slice(abs.lastIndexOf(".") + 1).toLowerCase();
        // A finished Office/PDF document cannot render here, but it IS a
        // deliverable: returning `ok` with the path is precisely what lets the
        // Telegram relay attach it (`sendReportFiles` switches on the
        // extension). A bare error instead stranded the file on whichever
        // machine wrote it, which is useless for a report the user asked to be
        // sent to them.
        if (BINARY_DOC_EXT.has(ext)) {
          return {
            ok: true,
            path: abs,
            notice: `${ext.toUpperCase()} cannot render in the in-app pane; the file is saved and is attached when this session is relayed to Telegram. Preview the .html or .md version for an in-pane view.`,
          };
        }
        let content: string;
        try {
          const r = await native.readFile(abs);
          if (r.kind !== "text") {
            return { error: `not a text file (${r.kind})`, path: abs };
          }
          content = r.content;
        } catch (e) {
          return { error: String(e), path: abs };
        }
        const doc =
          ext === "html" || ext === "htm"
            ? content
            : ext === "md" || ext === "markdown"
              ? `${PREVIEW_DOC_CSS}\n${mdToHtml(content)}`
              : `${PREVIEW_DOC_CSS}\n<pre>${escHtml(content)}</pre>`;
        const isPureDiagram =
          ext === "mmd" ||
          (!content.includes("#") &&
            !content.includes("<h") &&
            /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph)\b/m.test(
              content,
            ));

        const flows = findMermaidFlows(content);
        if (isPureDiagram && flows.length > 0) {
          return {
            notice:
              "This file is a standalone Mermaid diagram. The preview canvas disables scripts, so render it directly in chat using a fenced ```mermaid block:",
            mermaid: flows.join("\n\n"),
            path: abs,
          };
        }

        const paneTitle = title ?? (path.split(/[/\\]/).pop() || "Document");
        const ok = ctx.openCanvas(doc, paneTitle);
        if (ok) {
          useArtifactsStore.getState().add(ctx.getSessionId() ?? "", {
            kind: "file",
            title: paneTitle,
            payload: abs,
          });
          return {
            ok: true,
            path: abs,
            ...(flows.length > 0
              ? {
                  hasMermaid: true,
                  note: "Document opened in preview pane. Mermaid code blocks are rendered as syntax blocks; you can also emit the diagram in chat for interactive visualization.",
                }
              : {}),
          };
        }
        return { error: "preview surface unavailable", path: abs };
      },
    }),
  } as const;
}
