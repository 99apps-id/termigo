import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { checkShellCommand } from "../lib/security";
import type { ToolContext } from "./context";

/**
 * Talking to a process instead of running one.
 *
 * `bash_run` sends a command and waits for it to finish, which is why its
 * description says never to start `vim`, `less` or a debugger: an interactive
 * tool never finishes, so the call burns its timeout and returns nothing.
 *
 * A debugger session is a conversation - set a breakpoint, continue, read a
 * variable, step - and every turn ends at a prompt rather than at an exit.
 * These tools are that shape, so the agent can drive `pdb`, `dlv`, `gdb` or a
 * language REPL through the debugging a step debugger would otherwise be
 * needed for.
 *
 * The process is the agent's own. Nothing here touches the terminal the user
 * is looking at, which may be holding sudo or an SSH session to production.
 */

/** Prompts worth suggesting, so the model does not have to guess a literal. */
const PROMPT_HINTS = [
  "`(Pdb) ` for Python pdb",
  "`(dlv) ` for Delve",
  "`(gdb) ` for gdb",
  "`>>> ` for a Python REPL",
  "`debug> ` for node inspect",
].join(", ");

export function buildReplTools(_ctx: ToolContext) {
  return {
    repl_start: tool({
      description: `Start an interactive process and talk to it turn by turn - a debugger (pdb, dlv, gdb, node inspect) or a language REPL. Use this instead of bash_run for anything that prompts rather than exits; bash_run would hang on it.

Returns a handle plus whatever the process printed on startup. Pass \`until\` with the prompt the process ends each turn with, so the call returns as soon as it is ready instead of waiting out the timeout. Common ones: ${PROMPT_HINTS}.

Runs on this machine in the agent's own process. It is not the user's terminal, so it cannot see or disturb what they are doing there. Always asks for approval.`,
      inputSchema: z.object({
        command: z
          .string()
          .describe(
            "The shell command to start, e.g. `python -m pdb script.py`.",
          ),
        until: z
          .string()
          .optional()
          .describe("Literal prompt text that ends a turn, e.g. `(Pdb) `."),
        timeout_secs: z.number().int().optional(),
      }),
      needsApproval: true,
      execute: async ({ command, until, timeout_secs }) => {
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        try {
          const handle = await native.replOpen(command);
          const turn = await native.replSend({
            handle,
            until,
            sinceOffset: 0,
            timeoutSecs: timeout_secs,
          });
          return {
            handle,
            output: turn.output,
            ready: turn.matched,
            next_offset: turn.next_offset,
            ...(turn.exited ? { exited: true, exit_code: turn.exit_code } : {}),
            ...(turn.matched
              ? {}
              : {
                  note: until
                    ? "The prompt did not appear before the timeout. The process may still be starting; send again with no input to keep waiting."
                    : "No `until` was given, so this waited the full timeout. Pass the prompt text to make turns return promptly.",
                }),
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    repl_send: tool({
      description:
        "Send one line to a running interactive process and read its reply. Omit `input` to keep waiting without sending anything - that is how you wait again after a timeout, or read output a long-running step produced. Pass `since_offset` from the previous result so you get only what is new. Always asks for approval.",
      inputSchema: z.object({
        handle: z.number().int().describe("Handle from repl_start."),
        input: z
          .string()
          .optional()
          .describe("One line to send. The newline is added for you."),
        until: z
          .string()
          .optional()
          .describe("Literal prompt text that ends this turn."),
        since_offset: z
          .number()
          .int()
          .optional()
          .describe("`next_offset` from the previous turn."),
        timeout_secs: z.number().int().optional(),
      }),
      needsApproval: true,
      execute: async ({ handle, input, until, since_offset, timeout_secs }) => {
        try {
          const turn = await native.replSend({
            handle,
            input,
            until,
            sinceOffset: since_offset ?? 0,
            timeoutSecs: timeout_secs,
          });
          return {
            output: turn.output,
            matched: turn.matched,
            next_offset: turn.next_offset,
            ...(turn.dropped > 0
              ? {
                  dropped_bytes: turn.dropped,
                  note: "Output exceeded the buffer; the oldest bytes were dropped.",
                }
              : {}),
            ...(turn.exited ? { exited: true, exit_code: turn.exit_code } : {}),
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    repl_stop: tool({
      description:
        "End an interactive process started with repl_start. Auto-executes: stopping the agent's own process takes nothing away from the user.",
      inputSchema: z.object({
        handle: z.number().int(),
      }),
      execute: async ({ handle }) => {
        try {
          await native.replClose(handle);
          return { ok: true, handle };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    repl_list: tool({
      description:
        "List interactive processes this session started, with whether each is still running. Auto-executes.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const items = await native.replList();
          return { count: items.length, items };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  } as const;
}
