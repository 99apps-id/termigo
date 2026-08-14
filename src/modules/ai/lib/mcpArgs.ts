// Turning the add-server form's free text into a command, args and env.
//
// The form takes one line for the command and one box for environment
// variables, because that is how every MCP server is documented:
// `npx -y @scope/server` and `KEY=value`. Asking for a JSON array instead
// would make the common case harder than editing the file by hand, which is
// what this replaces.

/**
 * Split a command line into the program and its arguments.
 *
 * Quotes are honoured because package names and paths contain spaces often
 * enough, and a naive split would turn one argument into two without saying so.
 */
export function parseCommandLine(input: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (const ch of input.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);

  return { command: tokens[0] ?? "", args: tokens.slice(1) };
}

/**
 * Parse `KEY=value` lines.
 *
 * Splits on the FIRST `=` only: values are routinely tokens and URLs that
 * contain more, and splitting on every one would truncate them all.
 */
export function parseEnvLines(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    // Anything that is not a shell-legal name is a typo, not a variable.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = line.slice(at + 1).trim();
  }
  return out;
}

/** Render env back into the form's text box. */
export function formatEnvLines(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}
