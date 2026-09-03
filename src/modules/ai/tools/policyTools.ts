import { tool } from "ai";
import { z } from "zod";
import { loadPolicies } from "../lib/policyEngine";

export function buildPolicyTools() {
  return {
    list_policies: tool({
      description:
        "List active agentic policies for this workspace. Returns policy names and descriptions.",
      inputSchema: z.object({}),
      execute: async () => {
        const policies = await loadPolicies();
        return {
          policies: policies.rules.map((r) => ({
            id: r.id,
            description: r.description,
            block: r.block ?? false,
          })),
        };
      },
    }),
  } as const;
}
