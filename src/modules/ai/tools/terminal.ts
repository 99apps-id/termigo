import { tool } from "ai";
import { z } from "zod";
import { isSafePreviewUrl, unsafeBrowserUrl } from "../lib/browserGuard";
import { native } from "../lib/native";
import { checkShellCommand } from "../lib/security";
import { useArtifactsStore } from "../store/artifactsStore";
import { resolvePath, type ToolContext } from "./context";

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

export function buildTerminalTools(ctx: ToolContext) {
  return {
    suggest_command: tool({
      description:
        "Propose a single shell command. Renders a card in chat with an 'Insert' button — the command is NOT written to any terminal automatically; only the user's click inserts it at the prompt without executing. Use this when the answer IS a command.",
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
        // Reject control bytes — the user inserts via click, but the rendered
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
        "Return the tail of the active terminal's scrollback. Use this when the user references 'this error', 'the last command', or you need to interpret recent terminal output. Default is 80 lines; raise it only when you genuinely need more. Returns an empty string if there is no active terminal; refuses if the terminal is in Privacy mode.",
      inputSchema: z.object({
        lines: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe("Number of trailing lines to return. Default 80."),
      }),
      execute: async ({ lines }) => {
        if (ctx.isActiveTerminalPrivate()) {
          return {
            error:
              "active terminal is in Privacy mode; its buffer is withheld. Ask the user to switch to a regular tab if they want you to see it.",
          };
        }
        const buffer = ctx.getTerminalContext();
        if (!buffer) return { output: "", note: "no active terminal" };
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

    open_preview: tool({
      description:
        "Open a preview tab at the given URL, next to the terminal. A localhost/loopback dev server (e.g. http://localhost:5173) loads in a lightweight iframe; an external http(s) site loads in a real embedded browser (so pages that refuse to be framed still render). Use it to surface a dev server, or to browse a site the user asked about.",
      inputSchema: z.object({
        url: z
          .url()
          .describe(
            "Full http(s) URL to load (e.g. http://localhost:5173 or https://example.com). Must include scheme.",
          ),
      }),
      execute: async ({ url }) => {
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
          return {
            error:
              "URL blocked: not a loopback dev server and not a safe external host (SSRF/metadata/link-local are refused).",
            url,
          };
        }
        const ok = ctx.openPreview(url);
        if (!ok) return { error: "preview surface unavailable", url };
        // Surface in the Artifacts panel so the user can jump back to it.
        useArtifactsStore.getState().add(ctx.getSessionId() ?? "", {
          kind: "preview",
          title: url,
          payload: url,
        });
        return { url, ok: true };
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
        "Display a local report/document file in the in-app browser pane beside the workspace. Use it to SHOW the user a finished report: an .html or .md file renders styled (headings, tables, code), any other text file shows as text. Ideal right after generating a report. PDFs are saved to disk but not rendered in-pane — point the user to the .html/.md instead.",
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
        if (ext === "pdf") {
          return {
            error:
              "PDF cannot render in the in-app pane. Preview the .html version of the report instead, or open the .pdf in the system viewer.",
            path: abs,
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
        const ok = ctx.openCanvas(doc, title ?? path.split(/[/\\]/).pop());
        return ok
          ? { ok: true, path: abs }
          : { error: "preview surface unavailable", path: abs };
      },
    }),
  } as const;
}
