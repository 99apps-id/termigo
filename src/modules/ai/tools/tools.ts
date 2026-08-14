import { buildManagedAgentTools } from "./agent";
import { buildEditTools } from "./edit";
import { buildFetchTools } from "./fetch";
import { buildForwardTools } from "./forward";
import { buildFileOpsTools } from "./fileops";
import { buildReplaceTools } from "./replace";
import { buildSkillTools } from "./skills";
import { buildFsTools } from "./fs";
import { buildSearchTools } from "./search";
import { buildShellTools } from "./shell";
import { buildSubagentTools } from "./subagent";
import { buildTerminalTools } from "./terminal";
import { buildMemoryTools } from "./memory";
import { buildTodoTools } from "./todo";

export { resolvePath, type ToolContext } from "./context";

/**
 * AI tool definitions.
 *
 * Approval policy:
 *  - Read-only tools (`read_file`, `list_directory`, `grep`, `glob`)
 *    auto-execute, but go through the security guard which refuses obvious
 *    secret paths (.env*, .ssh/, credentials, etc.).
 *  - Mutating tools (`write_file`, `edit`, `multi_edit`, `create_directory`,
 *    `run_command`) require explicit user approval — the AI SDK pauses on
 *    tool-call and surfaces a `tool-approval-request` part that the UI
 *    renders as a confirmation card.
 *  - `edit` / `multi_edit` additionally enforce a read-before-edit invariant
 *    (the model must have called read_file on the path earlier in the
 *    session).
 *
 * The model sees absolute paths only after they are resolved against the
 * active terminal's cwd (provided via `getCwd`); it should not invent paths
 * outside that.
 */
export function buildTools(ctx: import("./context").ToolContext) {
  const base = {
    ...buildFsTools(ctx),
    ...buildFileOpsTools(ctx),
    ...buildFetchTools(),
    ...buildForwardTools(ctx),
    ...buildReplaceTools(ctx),
    ...buildEditTools(ctx),
    ...buildSearchTools(ctx),
    ...buildShellTools(ctx),
    ...buildSubagentTools(ctx),
    ...buildTerminalTools(ctx),
    ...buildTodoTools(ctx),
    ...buildMemoryTools(ctx),
    ...buildManagedAgentTools(ctx),
  } as const;

  // Skill tools last, and told what the others are called: the dependency
  // checker compares a skill against the real registry rather than a list kept
  // by hand, so adding or renaming a tool later cannot leave the check stale.
  return { ...base, ...buildSkillTools(ctx, Object.keys(base)) } as const;
}

export type ChatTools = ReturnType<typeof buildTools>;
