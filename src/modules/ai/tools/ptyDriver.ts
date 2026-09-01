import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";

/**
 * Interactive PTY Conductor Tools
 *
 * Enables AI Agent to interact with interactive CLI wizards, REPLs, TUI apps,
 * and running dev servers by reading rendered screen buffers and sending keystrokes.
 */
export function buildPtyDriverTools(ctx: ToolContext) {
  return {
    pty_read_screen: tool({
      description:
        "Read the active terminal's screen buffer / scrollback output. Read-only, auto-executes.",
      inputSchema: z.object({
        max_lines: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .default(50)
          .describe("Maximum lines from the bottom of the buffer to return."),
      }),
      execute: async ({ max_lines }) => {
        const raw = ctx.getTerminalContext();
        if (!raw) {
          return {
            error: "No active terminal tab or terminal buffer is empty.",
            buffer: "",
          };
        }

        const lines = raw.split("\n");
        const tail = lines.slice(-max_lines).join("\n");
        return {
          lines_returned: Math.min(lines.length, max_lines),
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
