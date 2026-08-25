import { tool } from "ai";
import { z } from "zod";

export type Invariant = {
  id: string;
  fact: string;
  category?: "architecture" | "security" | "style" | "constraint";
  createdAt: number;
};

const pinnedInvariants: Invariant[] = [];

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
export function buildInvariantTools() {
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
        return {
          removed,
          remaining_count: pinnedInvariants.length,
        };
      },
    }),
  } as const;
}
