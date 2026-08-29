import { SUBAGENTS, type SubagentType } from "./registry";

/**
 * Map a caller-provided sub-agent "type" onto a real roster id.
 *
 * Models invent semantic names ("search", "review", "implement", "audit")
 * instead of the exact ids, and a bare `z.enum` rejects those outright - the
 * tool call then fails with a validation error and the run stalls. This mirrors
 * TEDI's resolver, adapted to Termigo's roster: exact id, then case-insensitive
 * id or label, then a normalized match, then a synonym, and finally a safe
 * fallback. It never throws on an unknown name.
 */
const SYNONYMS: Record<string, SubagentType> = {
  // explore: read/search this codebase
  explore: "explore",
  exploration: "explore",
  explorer: "explore",
  search: "explore",
  find: "explore",
  locate: "explore",
  grep: "explore",
  codebase: "explore",
  code: "explore",
  read: "explore",
  analyze: "explore",
  analysis: "explore",
  investigate: "explore",
  trace: "explore",
  understand: "explore",
  // code review
  review: "code-review",
  reviewer: "code-review",
  codereview: "code-review",
  verify: "code-review",
  check: "code-review",
  validate: "code-review",
  // security review / audit
  security: "security",
  audit: "security",
  vuln: "security",
  vulnerability: "security",
  injection: "security",
  secrets: "security",
  authz: "security",
  // pentest / offensive — bare/ambiguous words stay on the generalist, which
  // covers the whole engagement (and owns the final report).
  pentest: "pentest",
  pentesting: "pentest",
  recon: "pentest",
  scan: "pentest",
  portscan: "pentest",
  nmap: "pentest",
  exploit: "pentest",
  offensive: "pentest",
  // pentest specialists — dispatched by name for focused, parallel work.
  reconnaissance: "pentest-recon",
  osint: "pentest-recon",
  subdomain: "pentest-recon",
  subdomains: "pentest-recon",
  attacksurface: "pentest-recon",
  fingerprint: "pentest-recon",
  web: "pentest-web",
  webapp: "pentest-web",
  webapplication: "pentest-web",
  api: "pentest-web",
  appscan: "pentest-web",
  network: "pentest-network",
  infra: "pentest-network",
  infrastructure: "pentest-network",
  activedirectory: "pentest-network",
  // builder: mutating work
  builder: "builder",
  build: "builder",
  implement: "builder",
  implementation: "builder",
  edit: "builder",
  fix: "builder",
  refactor: "builder",
  write: "builder",
  develop: "builder",
  worker: "builder",
  coder: "builder",
  // general: research / planning / catch-all
  general: "general",
  research: "general",
  plan: "general",
  planner: "general",
  advisor: "general",
  consult: "general",
  debug: "general",
  architecture: "general",
  reasoning: "general",
  // vision: looking at images / screenshots / mockups / diagrams
  vision: "vision",
  image: "vision",
  images: "vision",
  screenshot: "vision",
  screengrab: "vision",
  diagram: "vision",
  visual: "vision",
  see: "vision",
  look: "vision",
  ocr: "vision",
  mockup: "vision",
  design: "vision",
};

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function resolveSubagentType(type: string): SubagentType {
  const raw = typeof type === "string" ? type : String(type ?? "");
  const key = raw.toLowerCase().trim();
  const keys = Object.keys(SUBAGENTS) as SubagentType[];

  // 1. Exact id.
  if ((SUBAGENTS as Record<string, unknown>)[raw]) return raw as SubagentType;
  // 2. Case-insensitive id or display label.
  const byId = keys.find(
    (k) => k.toLowerCase() === key || SUBAGENTS[k].label.toLowerCase() === key,
  );
  if (byId) return byId;
  // 3. Normalized (ignore case + separators): "code review" / "codereview".
  const nk = norm(key);
  if (nk) {
    const byNorm = keys.find(
      (k) => norm(k) === nk || norm(SUBAGENTS[k].label) === nk,
    );
    if (byNorm) return byNorm;
  }
  // 4. Synonym.
  if (SYNONYMS[key]) return SYNONYMS[key];
  // 5. Safe fallback: the generic worker. Writes it makes still ask for approval.
  return "general";
}

/** Friendly label for a caller-provided type, resolved the same way the runtime
 *  resolves it, so a spawn card shows the agent that actually runs. */
export function resolveSubagentLabel(type: string): string {
  const raw = typeof type === "string" ? type : String(type ?? "");
  const def = SUBAGENTS[resolveSubagentType(raw)];
  return def?.label ?? raw;
}
