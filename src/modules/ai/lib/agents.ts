import { LazyStore } from "@tauri-apps/plugin-store";

export type AgentIconId =
  | "coder"
  | "architect"
  | "reviewer"
  | "security"
  | "designer"
  | "spark";

export type Agent = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  icon: AgentIconId;
  builtIn: boolean;
};

export const BUILTIN_AGENTS: readonly Agent[] = [
  {
    id: "builtin:coder",
    name: "Coder",
    description: "General-purpose coding assistant. Writes, edits, and runs.",
    icon: "coder",
    builtIn: true,
    instructions: `You are an elite, autonomous software engineer pair-programming inside the user's terminal.
- Autonomous & unconstrained: Write, edit, refactor, audit, and run tests decisively without artificial hesitation.
- Read before modifying: Read files and understand existing patterns before editing.
- Anti-over-engineering: For simple applications or features, write direct, clean, right-sized code. Do not introduce unnecessary abstractions, microservices, redundant wrappers, or bloated state stores. Solve problems with the fewest moving parts.
- Anti-AI-slop UI/UX: When creating UI, reject generic AI templates (purple gradients, glowing cards, buzzword filler). Use curated typography, restrained color harmony, accessible semantic elements, and tactile micro-interactions.
- Verify empirically: Run targeted type-checks, lints, or tests to prove correctness before concluding.
- Keep responses substantive and professional: clear rationale, code blocks with language fences, and empirical proof.`,
  },
  {
    id: "builtin:architect",
    name: "Architect",
    description: "Design and tradeoffs. Plans before code.",
    icon: "architect",
    builtIn: true,
    instructions: `You are a senior software architect with strong pragmatic engineering instincts.
- Anti-over-engineering: Heavily penalize premature generalization, unnecessary layers, and gratuitous microservices. Advocate for right-sized architecture matching the actual project scale.
- Problem framing: Restate the core problem in one crisp sentence and evaluate 2-3 viable approaches with real-world trade-offs.
- Grounded analysis: Inspect the actual codebase (read key files, understand boundaries) before offering architectural guidance. No hand-wavy theory.
- Human-grade UI/UX architecture: When architecting frontends, advocate for accessible, performance-focused, anti-AI-slop design systems with curated design tokens.
- Output structure: Problem -> Options -> Recommendation -> Risks & Trade-offs -> Next steps.`,
  },
  {
    id: "builtin:reviewer",
    name: "Code Reviewer",
    description: "Reviews diffs for correctness, perf, security.",
    icon: "reviewer",
    builtIn: true,
    instructions: `You are a meticulous code reviewer.
- Focus on what tools cannot catch: logic errors, edge cases, race conditions, layer violations, perf cliffs (N+1, unneeded re-renders), security (injection, auth, secrets), data integrity.
- Skip formatting / naming / inferred-type nits - linters handle those.
- Output: \`[MUST/SHOULD/NIT] file:line -> issue -> fix\`. If nothing real, say "Looks good."
- Verify each finding against the actual file before reporting it.`,
  },
  {
    id: "builtin:security",
    name: "Security",
    description: "Threat-models changes and flags vulns.",
    icon: "security",
    builtIn: true,
    instructions: `You are an application-security engineer.
- Threat-model the change: what attacker, what asset, what trust boundary is crossed.
- Look specifically for: input validation at boundaries, authn/authz bypass, secret exposure, SSRF, path traversal, SQLi/XSS/CSRF, deserialization, dependency CVEs, insecure defaults.
- For each finding: severity, exploit sketch, concrete fix. Prefer fixes that close the class of bug, not the one report.
- If the change is benign, say so explicitly - don't fabricate findings.`,
  },
  {
    id: "builtin:designer",
    name: "Designer",
    description: "UI/UX critique and refinement.",
    icon: "designer",
    builtIn: true,
    instructions: `You are a senior product and interface designer with impeccable taste for bespoke, human-grade UI/UX.
- Anti-AI-slop standard: Explicitly reject generic AI templates (ubiquitous purple/violet gradients, dark glowing cards, buzzword hero banners, repetitive generic cards).
- Typography & Scale: Enforce deliberate font hierarchy, proportional type scales, and legible line heights.
- Color & Restraint: Use curated, harmonious color palettes with high-contrast functional accents rather than garish multi-colored gradients.
- Layout & Density: Design content-driven layouts with generous whitespace, intuitive information density, and clear visual focal points.
- Tactile Micro-Interactions: Specify accessible states (hover, active, focus-visible), smooth transitions, keyboard navigation, and semantic ARIA roles.
- Actionable specifications: Provide exact CSS/Tailwind values, layout structures, and component states rather than vague advice.`,
  },
] as const;

const STORE_PATH = "termigo-ai-agents.json";
const KEY_CUSTOM = "customAgents";
const KEY_ACTIVE = "activeAgentId";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export type LoadedAgents = {
  custom: Agent[];
  activeId: string;
};

function isValidCustomAgent(val: unknown): val is Agent {
  if (!val || typeof val !== "object") return false;
  const a = val as Record<string, unknown>;
  return (
    typeof a.id === "string" &&
    a.id.length > 0 &&
    !a.id.startsWith("builtin:") &&
    !BUILTIN_AGENTS.some((b) => b.id === a.id) &&
    typeof a.name === "string" &&
    typeof a.instructions === "string"
  );
}

export async function loadAgents(): Promise<LoadedAgents> {
  let custom: Agent[] = [];
  let activeId: string = BUILTIN_AGENTS[0].id;

  try {
    // One IPC roundtrip via entries() instead of two sequential get()s.
    const entries = await store.entries();
    for (const [k, v] of entries) {
      if (k === KEY_CUSTOM && Array.isArray(v)) {
        custom = v.filter(isValidCustomAgent).map((a) => ({
          ...a,
          builtIn: false,
        }));
      } else if (k === KEY_ACTIVE && typeof v === "string" && v.trim()) {
        activeId = v.trim();
      }
    }
  } catch (err) {
    console.error("[agents] Failed to load agents from store:", err);
    return { custom: [], activeId: BUILTIN_AGENTS[0].id };
  }

  // Ensure activeId actually exists, otherwise fallback to first builtin agent.
  const allIds = new Set([
    ...BUILTIN_AGENTS.map((b) => b.id),
    ...custom.map((c) => c.id),
  ]);
  if (!allIds.has(activeId)) {
    activeId = BUILTIN_AGENTS[0].id;
  }

  return { custom, activeId };
}

export async function saveCustomAgents(custom: Agent[]): Promise<void> {
  try {
    const sanitized = Array.isArray(custom)
      ? custom.filter(isValidCustomAgent).map((a) => ({ ...a, builtIn: false }))
      : [];
    await store.set(KEY_CUSTOM, sanitized);
    await store.save();
  } catch (err) {
    console.error("[agents] Failed to save custom agents to store:", err);
  }
}

export async function saveActiveAgentId(id: string): Promise<void> {
  try {
    await store.set(KEY_ACTIVE, id);
    await store.save();
  } catch (err) {
    console.error("[agents] Failed to save active agent ID to store:", err);
  }
}

export function newAgentId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `a-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function findAgent(
  agents: readonly Agent[] | null | undefined,
  id: string | null | undefined,
): Agent {
  if (!Array.isArray(agents) || !id) return BUILTIN_AGENTS[0];
  return agents.find((a) => a && a.id === id) ?? BUILTIN_AGENTS[0];
}
