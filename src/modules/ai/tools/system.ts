// Clipboard and environment-variable tools for the agent.
//
// Clipboard read/write and env inspection go through Rust (`system.rs`) so the
// agent does not touch the DOM clipboard API (which needs focus and can be
// denied) and cannot read the raw webview clipboard by other means. Env access
// is read-only: listing and reading is what answers "what is PATH?" or "is
// NODE_ENV set?"; setting is deliberately not exposed (it would mutate the
// parent process and not reach any already-spawned shell).

import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";

const CLIPBOARD_TEXT_CAP = 8 * 1024;

export function buildSystemTools() {
  return {
    clipboard_get: tool({
      description:
        "Read the current clipboard text. Use when the user says 'copy this' was expected to be on the clipboard, or to grab something they copied elsewhere. Returns up to 8KB. Read-only, auto-executes.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const text = await native.clipboardGet();
          if (!text)
            return { text: "", note: "clipboard is empty or not text" };
          const capped =
            text.length > CLIPBOARD_TEXT_CAP
              ? `${text.slice(0, CLIPBOARD_TEXT_CAP)}\n… [truncated]`
              : text;
          return { text: capped, length: text.length };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    clipboard_set: tool({
      description:
        "Replace the clipboard with the given text. Use when the user asks you to copy something — a command, a code snippet, a path. Requires approval (it overwrites what the user may have on the clipboard).",
      inputSchema: z.object({
        text: z
          .string()
          .max(4000)
          .describe("The exact text to put on the clipboard."),
      }),
      needsApproval: true,
      execute: async ({ text }) => {
        try {
          await native.clipboardSet(text);
          return { ok: true, length: text.length };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    env_get: tool({
      description:
        "Read one environment variable of the Termigo process, e.g. PATH, HOME, USER, NODE_ENV. Use to answer questions about the environment ('what is PATH?', 'is CI set?'). Read-only, auto-executes.",
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .max(200)
          .describe("Environment variable name, e.g. PATH."),
      }),
      execute: async ({ name }) => {
        try {
          const value = await native.envGet(name);
          if (value === null) return { name, present: false };
          return { name, present: true, value };
        } catch (e) {
          return { error: String(e), name };
        }
      },
    }),

    env_list: tool({
      description:
        "List the Termigo process environment variables (up to 200, values capped). Use to see the environment at a glance — PATH, HOME, language, or whether a variable exists. Read-only, auto-executes.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const vars = await native.envList();
          return {
            count: vars.length,
            vars: vars.map((v) => ({ name: v.name, value: v.value })),
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  } as const;
}
