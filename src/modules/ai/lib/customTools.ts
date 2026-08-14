// Tools the agent defines for itself.
//
// A skill is instructions the model reads. A tool is something it calls. The
// step between them is where self-extension usually goes wrong: letting an
// agent write code and then executing that code needs a sandbox, and a
// half-built sandbox is worse than none.
//
// So a custom tool here is not code. It is a shell command template with named
// parameters, stored in `.termigo/tools.json`. Running one goes through the
// same path bash_run already uses, which means checkShellCommand, the approval
// tiers and the remote/local routing all apply unchanged. Nothing new can be
// executed that could not be executed before; what changes is that a command
// worth repeating becomes something the model can find and call by name.
//
// Every parameter is shell-quoted on substitution, with no escape hatch. A
// template author who wants a flag conditional on a value writes two templates.
// The alternative - a "raw" mode - would put the security of every custom tool
// in the hands of whoever wrote it, which is the model.

import { shellQuote } from "./remoteSearch";

export const TOOLS_REL_PATH = ".termigo/tools.json";

/** Custom tools are a shortcut, not a plugin system. */
export const MAX_CUSTOM_TOOLS = 40;

export type CustomTool = {
  name: string;
  description: string;
  /** Parameter names, substituted into the template. */
  parameters: { name: string; description: string; required?: boolean }[];
  /** Shell command with `{{param}}` placeholders. */
  command: string;
};

// Re-exported so callers have one entry point; the light module stays
// importable on its own for anything on the startup path.
export { CUSTOM_TOOL_PREFIX, customToolName, isCustomTool } from "./customToolNames";

/** Names must be safe identifiers: they become part of a tool name. */
export function isValidToolName(name: string): boolean {
  return /^[a-z][a-z0-9_]{0,47}$/.test(name);
}

export function slugifyToolName(input: string): string | null {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48)
    .replace(/_+$/g, "");
  return isValidToolName(slug) ? slug : null;
}

/** Placeholder names a template refers to, in order of first appearance. */
export function templatePlaceholders(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi)) {
    const name = m[1];
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export type ToolValidation = { ok: true } | { ok: false; reason: string };

/**
 * Check a definition before it is stored.
 *
 * The placeholder/parameter cross-check matters more than it looks: a template
 * referring to `{{branch}}` with no such parameter would run with the literal
 * text `{{branch}}` in the command, which is a silently wrong command rather
 * than a failure.
 */
export function validateTool(tool: CustomTool): ToolValidation {
  if (!isValidToolName(tool.name)) {
    return {
      ok: false,
      reason: `"${tool.name}" is not a valid tool name: lowercase letters, digits and underscores`,
    };
  }
  if (!tool.description.trim()) {
    return { ok: false, reason: "a tool needs a description saying when to use it" };
  }
  if (!tool.command.trim()) {
    return { ok: false, reason: "a tool needs a command" };
  }

  const placeholders = templatePlaceholders(tool.command);
  const declared = new Set(tool.parameters.map((p) => p.name));
  for (const p of tool.parameters) {
    if (!/^[a-z][a-z0-9_]*$/.test(p.name)) {
      return { ok: false, reason: `"${p.name}" is not a valid parameter name` };
    }
  }
  const undeclared = placeholders.filter((p) => !declared.has(p));
  if (undeclared.length > 0) {
    return {
      ok: false,
      reason: `the command uses ${undeclared.map((u) => `{{${u}}}`).join(", ")} but does not declare ${undeclared.length > 1 ? "those parameters" : "that parameter"}`,
    };
  }
  const unused = [...declared].filter((d) => !placeholders.includes(d));
  if (unused.length > 0) {
    return {
      ok: false,
      reason: `${unused.join(", ")} ${unused.length > 1 ? "are" : "is"} declared but never used in the command`,
    };
  }
  return { ok: true };
}

export type RenderResult =
  | { ok: true; command: string }
  | { ok: false; reason: string };

/**
 * Substitute arguments into the template.
 *
 * Every value is shell-quoted, so an argument can only ever be one argument.
 * This is the entire security story of custom tools: the template is fixed and
 * written once, the values vary and are never trusted.
 */
export function renderCommand(
  tool: CustomTool,
  args: Record<string, unknown>,
): RenderResult {
  for (const p of tool.parameters) {
    const value = args[p.name];
    const missing = value === undefined || value === null || value === "";
    if (missing && p.required !== false) {
      return { ok: false, reason: `missing required parameter "${p.name}"` };
    }
  }

  const command = tool.command.replace(
    /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi,
    (_match, name: string) => {
      const value = args[name];
      if (value === undefined || value === null) return "''";
      return shellQuote(String(value));
    },
  );
  return { ok: true, command };
}

/** JSON Schema for the model, built from the declared parameters. */
export function toolInputSchema(tool: CustomTool): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of tool.parameters) {
    properties[p.name] = { type: "string", description: p.description };
    if (p.required !== false) required.push(p.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/** Description shown to the model, with the template so intent is visible. */
export function describeCustomTool(tool: CustomTool): string {
  return `${tool.description.trim()}\n\nRuns: ${tool.command}\n(A tool defined in this workspace. Asks for approval.)`;
}

/** Parse the store, ignoring entries that would not run correctly. */
export function parseToolsFile(content: string): CustomTool[] {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return [];
  }
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { tools?: unknown })?.tools)
      ? (raw as { tools: unknown[] }).tools
      : [];

  const out: CustomTool[] = [];
  for (const entry of list) {
    const e = entry as Partial<CustomTool>;
    const tool: CustomTool = {
      name: String(e.name ?? ""),
      description: String(e.description ?? ""),
      command: String(e.command ?? ""),
      parameters: Array.isArray(e.parameters)
        ? e.parameters.map((p) => ({
            name: String(p?.name ?? ""),
            description: String(p?.description ?? ""),
            required: p?.required !== false,
          }))
        : [],
    };
    // A broken definition is skipped rather than offered: a tool that cannot
    // run correctly is worse in the list than absent from it.
    if (validateTool(tool).ok) out.push(tool);
  }
  return out.slice(0, MAX_CUSTOM_TOOLS);
}

export function formatToolsFile(tools: readonly CustomTool[]): string {
  return `${JSON.stringify({ tools }, null, 2)}\n`;
}

/** Replace a tool of the same name, or append. */
export function upsertTool(
  tools: readonly CustomTool[],
  tool: CustomTool,
): CustomTool[] {
  const idx = tools.findIndex((t) => t.name === tool.name);
  if (idx === -1) return [...tools, tool];
  const next = [...tools];
  next[idx] = tool;
  return next;
}
