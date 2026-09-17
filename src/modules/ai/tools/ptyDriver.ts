import { tool } from "ai";
import { z } from "zod";
import { checkShellCommand } from "../lib/security";
import type { ToolContext } from "./context";

/**
 * Interactive PTY Conductor Tools
 *
 * Enables AI Agent to interact with interactive CLI wizards, REPLs, TUI apps,
 * and running dev servers by reading rendered screen buffers and sending keystrokes.
 */
export function buildPtyDriverTools(ctx: ToolContext) {
  return {
    pty_session: tool({
      description:
        "Execute a shell command or interact with an active interactive PTY (pseudo-terminal) session. Use this tool when a command needs a full interactive terminal environment, when bash_run cannot run an interactive tool or complex pipeline, or to drive terminal prompts and REPLs directly in the user's terminal. Actions: 'run' (default) executes a command in the PTY and captures output; 'write' sends keystrokes/input; 'read' inspects the screen buffer; 'wait' waits for a pattern/prompt; 'ctrl_c' sends Ctrl+C interrupt. Requires approval.",
      inputSchema: z.object({
        action: z
          .enum(["run", "write", "read", "wait", "ctrl_c"])
          .optional()
          .default("run")
          .describe(
            "Action to perform: 'run' (default) executes command in PTY and waits for output; 'write' sends input/keystrokes; 'read' returns screen buffer; 'wait' waits for a regex/substring; 'ctrl_c' sends Ctrl+C.",
          ),
        command: z
          .string()
          .optional()
          .describe(
            "Shell command to execute in the PTY session (used when action is 'run').",
          ),
        cmd: z.string().optional().describe("Alias for command."),
        input: z
          .string()
          .optional()
          .describe(
            "Text or keystrokes to inject into the terminal (used when action is 'write').",
          ),
        text: z.string().optional().describe("Alias for input."),
        wait_for: z
          .string()
          .optional()
          .describe(
            "Substring or regex to wait for in the terminal output before returning.",
          ),
        timeout_secs: z
          .union([z.number(), z.string()])
          .optional()
          .default(30)
          .describe(
            "Maximum seconds to wait for output or completion. Default 30s.",
          ),
        max_lines: z
          .union([z.number(), z.string()])
          .optional()
          .default(80)
          .describe("Maximum lines from the screen buffer to return."),
      }),
      needsApproval: true,
      execute: async ({
        action: rawAction = "run",
        command: rawCommand,
        cmd,
        input: rawInput,
        text,
        wait_for,
        timeout_secs = 30,
        max_lines = 80,
      }) => {
        let action = rawAction;
        if (
          action === ("exec" as string) ||
          action === ("execute" as string) ||
          action === ("shell" as string)
        ) {
          action = "run";
        }
        const command = rawCommand ?? cmd;
        const input = rawInput ?? text;
        const parsedTimeout =
          typeof timeout_secs === "string"
            ? parseInt(timeout_secs, 10) || 30
            : Number(timeout_secs) || 30;
        const parsedMaxLines =
          typeof max_lines === "string"
            ? parseInt(max_lines, 10) || 80
            : Number(max_lines) || 80;
        const timeoutMs = Math.min(Math.max(1, parsedTimeout), 300) * 1000;
        const maxLines = Math.min(Math.max(1, parsedMaxLines), 500);

        if (action === "read") {
          const raw = ctx.getTerminalContext();
          if (!raw) {
            return {
              error: "No active terminal tab or terminal buffer is empty.",
              buffer: "",
            };
          }
          const lines = raw.split("\n");
          const tail = lines.slice(-maxLines).join("\n");
          return {
            action: "read",
            lines_returned: Math.min(lines.length, maxLines),
            total_lines: lines.length,
            buffer: tail,
          };
        }

        if (action === "ctrl_c") {
          const ok = ctx.injectIntoActivePty("\x03");
          if (!ok) {
            return {
              error: "Failed to send Ctrl+C: no active terminal tab found.",
              sent: false,
            };
          }
          await new Promise((r) => setTimeout(r, 200));
          const raw = ctx.getTerminalContext() ?? "";
          const lines = raw.split("\n");
          const tail = lines.slice(-maxLines).join("\n");
          return {
            action: "ctrl_c",
            sent: true,
            buffer: tail,
            note: "Sent Ctrl+C to active terminal PTY.",
          };
        }

        if (action === "wait") {
          if (!wait_for) {
            return { error: "wait_for parameter is required for action='wait'" };
          }
          let re: RegExp;
          try {
            re = new RegExp(wait_for, "i");
          } catch (e) {
            return { error: `Invalid regex pattern: ${String(e)}` };
          }
          const start = Date.now();
          let matched = false;
          while (Date.now() - start < timeoutMs) {
            const raw = ctx.getTerminalContext() ?? "";
            if (re.test(raw)) {
              matched = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 150));
          }
          const raw = ctx.getTerminalContext() ?? "";
          const lines = raw.split("\n");
          const tail = lines.slice(-maxLines).join("\n");
          return {
            action: "wait",
            found: matched,
            pattern: wait_for,
            buffer: tail,
            timed_out: !matched,
          };
        }

        if (action === "write") {
          if (input === undefined) {
            return { error: "input parameter is required for action='write'" };
          }
          const ok = ctx.injectIntoActivePty(input);
          if (!ok) {
            return {
              error: "Failed to inject input: no active terminal tab found.",
              sent: false,
            };
          }
          if (wait_for) {
            let re: RegExp | null = null;
            try {
              re = new RegExp(wait_for, "i");
            } catch (e) {
              return { error: `Invalid regex pattern: ${String(e)}` };
            }
            const start = Date.now();
            let matched = false;
            while (Date.now() - start < timeoutMs) {
              const raw = ctx.getTerminalContext() ?? "";
              if (re.test(raw)) {
                matched = true;
                break;
              }
              await new Promise((r) => setTimeout(r, 150));
            }
            const raw = ctx.getTerminalContext() ?? "";
            const lines = raw.split("\n");
            const tail = lines.slice(-maxLines).join("\n");
            return {
              action: "write",
              sent: true,
              input,
              matched,
              pattern: wait_for,
              buffer: tail,
              timed_out: !matched,
            };
          }
          await new Promise((r) => setTimeout(r, 300));
          const raw = ctx.getTerminalContext() ?? "";
          const lines = raw.split("\n");
          const tail = lines.slice(-maxLines).join("\n");
          return {
            action: "write",
            sent: true,
            input,
            buffer: tail,
          };
        }

        // Default: action === "run"
        if (!command || !command.trim()) {
          return { error: "command parameter is required for action='run'" };
        }

        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };

        const initialRaw = ctx.getTerminalContext();
        if (initialRaw === null) {
          return {
            error:
              "No active terminal tab found. Please ensure a terminal tab is open.",
          };
        }

        const sendText =
          command.endsWith("\r") || command.endsWith("\n")
            ? command
            : `${command}\r`;
        const ok = ctx.injectIntoActivePty(sendText);
        if (!ok) {
          return {
            error: "Failed to inject command into active terminal PTY.",
          };
        }

        const start = Date.now();
        let matched = false;
        let lastBuf = initialRaw;
        let stableSince = 0;
        let re: RegExp | null = null;
        if (wait_for) {
          try {
            re = new RegExp(wait_for, "i");
          } catch (e) {
            return { error: `Invalid regex pattern: ${String(e)}` };
          }
        }

        while (Date.now() - start < timeoutMs) {
          await new Promise((r) => setTimeout(r, 200));
          const currentBuf = ctx.getTerminalContext() ?? "";
          if (re && re.test(currentBuf)) {
            matched = true;
            break;
          }
          if (!wait_for) {
            if (currentBuf !== initialRaw) {
              if (currentBuf === lastBuf) {
                if (stableSince === 0) {
                  stableSince = Date.now();
                } else if (Date.now() - stableSince >= 1000) {
                  break;
                }
              } else {
                lastBuf = currentBuf;
                stableSince = Date.now();
              }
            }
          }
        }

        const finalBuf = ctx.getTerminalContext() ?? "";
        const lines = finalBuf.split("\n");
        const tail = lines.slice(-maxLines).join("\n");
        return {
          action: "run",
          command,
          output: tail,
          timed_out: wait_for ? !matched : false,
          ...(wait_for ? { matched, pattern: wait_for } : {}),
        };
      },
    }),

    pty_read_screen: tool({
      description:
        "Read the active terminal's screen buffer / scrollback output. Read-only, auto-executes.",
      inputSchema: z.object({
        max_lines: z
          .union([z.number(), z.string()])
          .optional()
          .default(50)
          .describe("Maximum lines from the bottom of the buffer to return."),
      }),
      execute: async ({ max_lines = 50 }) => {
        const parsedMax =
          typeof max_lines === "string"
            ? parseInt(max_lines, 10) || 50
            : Number(max_lines) || 50;
        const clamped = Math.min(Math.max(1, parsedMax), 500);
        const raw = ctx.getTerminalContext();
        if (!raw) {
          return {
            error: "No active terminal tab or terminal buffer is empty.",
            buffer: "",
          };
        }

        const lines = raw.split("\n");
        const tail = lines.slice(-clamped).join("\n");
        return {
          lines_returned: Math.min(lines.length, clamped),
          total_lines: lines.length,
          buffer: tail,
        };
      },
    }),

    pty_send_input: tool({
      description:
        "Type interactive input into the active terminal (e.g. answering [y/N] prompts, sending Enter, or injecting text). Requires approval.",
      inputSchema: z.object({
        input: z
          .string()
          .describe("Text or keystroke to send into the terminal prompt."),
      }),
      needsApproval: true,
      execute: async ({ input }) => {
        const ok = ctx.injectIntoActivePty(input);
        if (!ok) {
          return {
            error: "Failed to inject input: no active terminal tab found.",
            sent: false,
          };
        }

        return {
          sent: true,
          input,
          note: "Input injected into active terminal prompt.",
        };
      },
    }),

    pty_wait_for_pattern: tool({
      description:
        "Check if a specific regex or substring has appeared in the active terminal buffer. Read-only, auto-executes.",
      inputSchema: z.object({
        pattern: z
          .string()
          .describe(
            "Substring or regex pattern to look for in terminal output.",
          ),
      }),
      execute: async ({ pattern }) => {
        const raw = ctx.getTerminalContext();
        if (!raw) {
          return {
            found: false,
            error: "No active terminal buffer.",
          };
        }

        let re: RegExp;
        try {
          re = new RegExp(pattern, "i");
        } catch (e) {
          return {
            found: false,
            error: `Invalid regex pattern: ${String(e)}`,
          };
        }
        const matched = re.test(raw);
        return {
          pattern,
          found: matched,
          note: matched
            ? "Pattern found in terminal output"
            : "Pattern has not appeared in terminal buffer yet",
        };
      },
    }),
  } as const;
}
