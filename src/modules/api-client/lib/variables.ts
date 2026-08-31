// Variable substitution for the API client.
//
// Environments define `{{name}}` placeholders; before a request is sent every
// occurrence is replaced with the active environment's value. A variable left
// undefined stays as-is so the user sees exactly what was sent, rather than an
// empty string that hides the mistake.

import type { ApiEnvironment } from "../types";

/** Build a `name -> value` map from an environment's enabled variables. */
export function variableMap(
  env?: ApiEnvironment | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) return out;
  for (const v of env.variables) {
    if (!v.enabled) continue;
    if (v.key.trim() === "") continue;
    out[v.key.trim()] = v.value;
  }
  return out;
}

/** Replace every `{{name}}` with the matching variable value. */
export function substituteVariables(
  input: string,
  variables: Record<string, string>,
): string {
  return input.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, name: string) => {
    const key = name.trim();
    return Object.hasOwn(variables, key)
      ? variables[key]
      : whole;
  });
}
