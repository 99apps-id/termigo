import { tool } from "ai";
import { z } from "zod";
import {
  candidateUrls,
  detectDevCommand,
  devPort,
  sameDevCommand,
} from "../lib/devServer";
import { findLocalUrl } from "../lib/devUrl";
import { native } from "../lib/native";
import { remoteUnsupported } from "../lib/remoteFs";
import { checkShellCommand } from "../lib/security";
import type { ToolContext } from "./context";

/**
 * Wait for a background process to print a local URL AND for that URL to start
 * answering, reading the process's log ring so the ACTUAL url the server chose
 * (port, path, host) is used rather than a guessed default.
 *
 * Returns the found url (or null on timeout), whether it became ready, and the
 * log tail for the caller to show the model.
 */
async function waitForDevServer(
  handle: number,
  portHint: number,
  timeoutSecs: number,
): Promise<{ url: string | null; ready: boolean; logsTail: string }> {
  const deadline = Date.now() + timeoutSecs * 1000;
  let offset = 0;
  let url: string | null = null;
  let logsTail = "";
  let exited = false;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  while (Date.now() < deadline) {
    let logs: Awaited<ReturnType<typeof native.shellBgLogs>> | null = null;
    try {
      logs = await native.shellBgLogs(handle, offset);
    } catch {
      // Log read failed (process gone?) — keep polling until the deadline.
    }
    if (logs) {
      offset = logs.next_offset;
      logsTail = logs.bytes.slice(-4000);
      const found = findLocalUrl(logs.bytes);
      if (found) url = found;
      if (logs.exited) exited = true;
    }

    if (url) {
      // Probe the discovered URL (and the loopback alias). A 4xx status is
      // still "up" — the server is listening even if the root 404s.
      for (const candidate of url.includes("localhost")
        ? [url, url.replace("localhost", "127.0.0.1")]
        : [url]) {
        const probe = await native.httpProbe(candidate, 1500).catch(() => null);
        if (probe?.ok) return { url: candidate, ready: true, logsTail };
      }
      // The process exited and its URL never answered — waiting out the whole
      // deadline would burn 60s on a dead server.
      if (exited) break;
    } else if (portHint > 0) {
      // No URL printed yet — probe the hinted port directly so a server that
      // logs to stderr (not captured) is still caught.
      for (const candidate of candidateUrls(portHint)) {
        const probe = await native.httpProbe(candidate, 1500).catch(() => null);
        if (probe?.ok) {
          url = candidate;
          return { url: candidate, ready: true, logsTail };
        }
      }
      if (exited) break;
    } else if (exited) {
      break;
    }
    await sleep(500);
  }
  return { url, ready: false, logsTail };
}

export function buildDevServerTools(ctx: ToolContext) {
  return {
    dev_server: tool({
      description:
        "Start this project's dev server in the background and open it in the in-app browser pane. Detects the command from package.json (scripts.dev/start/serve/develop) when not given, spawns it via bash_background (deduping an already-running instance), waits until the printed URL actually responds, then opens it with open_preview. Returns the handle (use bash_logs/bash_kill to watch or stop it) and the ready URL. Pass `command` to override detection. Asks for approval before spawning.",
      inputSchema: z.object({
        command: z
          .string()
          .optional()
          .describe(
            "Explicit dev command, e.g. `pnpm dev` or `vite --port 5173`. Detected from package.json when omitted.",
          ),
        open: z
          .boolean()
          .optional()
          .describe(
            "Open the server in the browser pane once ready. Default true.",
          ),
        timeout_secs: z
          .number()
          .int()
          .min(1)
          .max(120)
          .optional()
          .describe("How long to wait for the server to start. Default 60."),
      }),
      needsApproval: true,
      execute: async ({ command, open, timeout_secs }) => {
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "dev_server",
            "Start the server on the remote host with bash_run (nohup … &) and use forward_remote_port + open_preview for its URL.",
          );
        }
        const root = ctx.getWorkspaceRoot() ?? ctx.getCwd();
        if (!root) {
          return { error: "no workspace root; pass `command` explicitly" };
        }

        // Resolve the command: explicit wins, else detect from package.json.
        let resolved = command?.trim() ?? "";
        let portHint = 0;
        let note = "explicit command";
        if (!resolved) {
          let pkgJson: string | null = null;
          try {
            const r = await native.readFile(`${root}/package.json`);
            if (r.kind === "text") pkgJson = r.content;
          } catch {
            // No manifest — fall through to the explicit-command error.
          }
          const detected = detectDevCommand({ pkgJson });
          if (detected) {
            resolved = detected.command;
            portHint = detected.portHint;
            note = `detected from package.json script "${detected.script}" (port hint ${detected.portHint})`;
          }
        }
        if (!resolved) {
          return {
            error:
              "no dev command found. Pass `command` explicitly (e.g. `pnpm dev`).",
          };
        }
        if (!portHint) portHint = devPort(resolved);
        const safety = checkShellCommand(resolved);
        if (!safety.ok) return { error: safety.reason };

        // Dedupe: an identical dev server already running is reused, and its
        // URL is re-opened, instead of stacking a second process.
        try {
          const list = await native.shellBgList();
          const existing = list.find(
            (p) => !p.exited && sameDevCommand(resolved, p.command),
          );
          if (existing) {
            const waited = await waitForDevServer(
              existing.handle,
              portHint,
              Math.min(timeout_secs ?? 60, 30),
            );
            const opened =
              open !== false && waited.url
                ? ctx.openPreview(waited.url, `dev-${existing.handle}`)
                : false;
            return {
              handle: existing.handle,
              command: existing.command,
              url: waited.url,
              ready: waited.ready,
              reused: true,
              opened,
              note: "reused an already-running dev server",
              logs_tail: waited.logsTail,
            };
          }
        } catch {
          // List failed — proceed to spawn; dedupe is best-effort.
        }

        let handle: number;
        try {
          handle = await native.shellBgSpawn(resolved, root);
        } catch (e) {
          return { error: `could not spawn dev server: ${String(e)}` };
        }

        const waited = await waitForDevServer(
          handle,
          portHint,
          timeout_secs ?? 60,
        );
        const opened =
          open !== false && waited.url
            ? ctx.openPreview(waited.url, `dev-${handle}`)
            : false;

        return {
          handle,
          command: resolved,
          url: waited.url,
          ready: waited.ready,
          opened,
          note,
          cwd: root,
          logs_tail: waited.logsTail,
        };
      },
    }),
  } as const;
}
