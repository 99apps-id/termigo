import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import type { ToolContext } from "./context";

export type Invariant = {
  id: string;
  fact: string;
  category?: "architecture" | "security" | "style" | "constraint";
  createdAt: number;
};

const pinnedInvariants: Invariant[] = [];

/** Relative to the workspace root. JSON rather than markdown: the entries are
 *  machine-written and machine-read, and the prompt block is generated from
 *  them, so the file only needs to round-trip. Hand-editing still works. */
export const INVARIANTS_REL_PATH = ".termigo/invariants.json";

function invariantsPath(workspaceRoot: string): string {
  return `${workspaceRoot.replace(/[\\/]+$/, "")}/${INVARIANTS_REL_PATH}`;
}

/**
 * Load persisted invariants from `.termigo/invariants.json` and make them the
 * active set. Called once per run before the system prompt is assembled, so a
 * constraint pinned in an earlier session still reaches the model. A missing
 * or unreadable file is the normal case and yields an empty set.
 */
export async function hydrateInvariants(
  workspaceRoot: string | null,
): Promise<void> {
  pinnedInvariants.length = 0;
  if (!workspaceRoot) return;
  try {
    const r = await native.readFile(invariantsPath(workspaceRoot));
    if (r.kind !== "text" || !r.content.trim()) return;
    const parsed: unknown = JSON.parse(r.content);
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.fact !== "string" || !e.fact.trim()) continue;
      pinnedInvariants.push({
        id: typeof e.id === "string" ? e.id : `inv-${pinnedInvariants.length}`,
        fact: e.fact,
        category:
          e.category === "architecture" ||
          e.category === "security" ||
          e.category === "style" ||
          e.category === "constraint"
            ? e.category
            : undefined,
        createdAt: typeof e.createdAt === "number" ? e.createdAt : Date.now(),
      });
    }
  } catch {
    // Absent or corrupt file: start from an empty set rather than failing the
    // run over a cache of pinned facts.
  }
}

/**
 * Write the active set back to disk. Fire-and-forget at the call sites: a
 * failed write loses persistence for this change but must not fail the tool
 * call the model is waiting on.
 */
export async function persistInvariants(
  workspaceRoot: string | null,
): Promise<void> {
  if (!workspaceRoot) return;
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  try {
    await native.createDir(`${root}/.termigo`);
  } catch {
    // Already present, or the failure resurfaces on the write below.
  }
  await native.writeFile(
    invariantsPath(workspaceRoot),
    `${JSON.stringify(pinnedInvariants, null, 2)}\n`,
  );
}

/**
 * Format active invariants into a markdown system prompt block.
 */
export function formatInvariantsBlock(): string {
  if (pinnedInvariants.length === 0) return "";
  const lines = pinnedInvariants.map(
    (inv, idx) => `${idx + 1}. [${inv.category ?? "general"}] ${inv.fact}`,
  );
  return `<pinned_invariants>\nThe following architectural constraints MUST be respected throughout the entire session:\n${lines.join("\n")}\n</pinned_invariants>`;
}

/**
 * Get list of all currently pinned invariants.
 */
export function getPinnedInvariants(): readonly Invariant[] {
  return pinnedInvariants;
}

/**
 * Clear all invariants (useful for tests and session resets).
 */
export function clearPinnedInvariants(): void {
  pinnedInvariants.length = 0;
}

/**
 * Build invariant pinning tools for AI Agent.
 */
export function buildInvariantTools(ctx: ToolContext) {
  return {
    pin_invariant: tool({
      description:
        "Pin a critical project invariant or architectural rule (e.g. 'always use pnpm', 'DB queries must be parameterized') into persistent working memory so it is never lost or forgotten in long sessions. Auto-executes.",
      inputSchema: z.object({
        fact: z.string().describe("The core rule or invariant to pin."),
        category: z
          .enum(["architecture", "security", "style", "constraint"])
          .optional()
          .default("architecture")
          .describe("Category of the constraint."),
      }),
      execute: async ({ fact, category }) => {
        const id = `inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const invariant: Invariant = {
          id,
          fact,
          category,
          createdAt: Date.now(),
        };
        pinnedInvariants.push(invariant);
        // Persist so the pin survives the session; the write is fire-and-forget
        // because the in-memory pin already took effect for this run.
        void persistInvariants(ctx.getWorkspaceRoot()).catch(() => {});

        return {
          id,
          fact,
          category,
          total_pinned: pinnedInvariants.length,
          note: "Invariant successfully pinned to system prompt layer.",
        };
      },
    }),

    list_invariants: tool({
      description: "List all active pinned invariants and architectural rules. Read-only, auto-executes.",
      inputSchema: z.object({}),
      execute: async () => {
        return {
          invariants: pinnedInvariants,
          count: pinnedInvariants.length,
        };
      },
    }),

    unpin_invariant: tool({
      description: "Remove a pinned invariant by its ID. Auto-executes.",
      inputSchema: z.object({
        id: z.string().describe("ID of the invariant to remove."),
      }),
      execute: async ({ id }) => {
        const index = pinnedInvariants.findIndex((i) => i.id === id);
        if (index === -1) {
          return { error: `Invariant with ID ${id} not found.` };
        }
        const [removed] = pinnedInvariants.splice(index, 1);
        void persistInvariants(ctx.getWorkspaceRoot()).catch(() => {});
        return {
          removed,
          remaining_count: pinnedInvariants.length,
        };
      },
    }),
  } as const;
}
