import { describe, expect, it } from "vitest";
import { SUBAGENTS } from "./registry";
import {
  resolveSubagentLabel,
  resolveSubagentType,
  routeSubagentType,
} from "./resolveSubagent";

describe("resolveSubagentType", () => {
  it("returns exact ids unchanged", () => {
    for (const id of Object.keys(SUBAGENTS)) {
      expect(resolveSubagentType(id)).toBe(id);
    }
  });

  it("matches ids case-insensitively and by label", () => {
    expect(resolveSubagentType("PENTEST")).toBe("pentest");
    expect(resolveSubagentType("Code review")).toBe("code-review");
    expect(resolveSubagentType("codereview")).toBe("code-review");
  });

  it("resolves synonyms the model tends to invent", () => {
    expect(resolveSubagentType("search")).toBe("explore");
    expect(resolveSubagentType("analyze")).toBe("explore");
    expect(resolveSubagentType("review")).toBe("code-review");
    expect(resolveSubagentType("audit")).toBe("security");
    expect(resolveSubagentType("implement")).toBe("builder");
    expect(resolveSubagentType("recon")).toBe("pentest");
    expect(resolveSubagentType("plan")).toBe("general");
    // Pentest specialists resolve by name and by their own synonyms, while the
    // bare/ambiguous words stay on the generalist.
    expect(resolveSubagentType("pentest-web")).toBe("pentest-web");
    expect(resolveSubagentType("webapp")).toBe("pentest-web");
    expect(resolveSubagentType("api")).toBe("pentest-web");
    expect(resolveSubagentType("network")).toBe("pentest-network");
    expect(resolveSubagentType("activedirectory")).toBe("pentest-network");
    expect(resolveSubagentType("osint")).toBe("pentest-recon");
    expect(resolveSubagentType("Pentest · Recon")).toBe("pentest-recon");
    expect(resolveSubagentType("scan")).toBe("pentest");
    expect(resolveSubagentType("screenshot")).toBe("vision");
    expect(resolveSubagentType("image")).toBe("vision");
    expect(resolveSubagentType("diagram")).toBe("vision");
  });

  it("falls back to general for anything unknown, never throws", () => {
    expect(resolveSubagentType("qwerty-nonsense")).toBe("general");
    expect(resolveSubagentType("")).toBe("general");
    // @ts-expect-error exercising a non-string input
    expect(resolveSubagentType(undefined)).toBe("general");
  });
});

describe("resolveSubagentLabel", () => {
  it("shows the label of the agent that actually runs", () => {
    expect(resolveSubagentLabel("search")).toBe(SUBAGENTS.explore.label);
    expect(resolveSubagentLabel("recon")).toBe(SUBAGENTS.pentest.label);
  });
});

describe("routeSubagentType", () => {
  it("routes frontend work to the builder", () => {
    const r = routeSubagentType("Fix the React frontend — update src/App.tsx");
    expect(r.type).toBe("builder");
    expect(r.route).toBe("frontend");
  });

  it("routes backend / api / db work to the builder", () => {
    expect(
      routeSubagentType("Write the API schema and auth middleware").type,
    ).toBe("builder");
    expect(routeSubagentType("Update the database migration").type).toBe(
      "builder",
    );
  });

  it("routes infra / deploy work to the generalist", () => {
    expect(routeSubagentType("Audit the Docker compose setup").type).toBe(
      "general",
    );
    expect(routeSubagentType("Review the CI/CD pipeline").type).toBe("general");
  });

  it("routes testing work to code-review", () => {
    expect(routeSubagentType("Add unit tests for the parser").type).toBe(
      "code-review",
    );
  });

  it("falls back to general for an ambiguous prompt", () => {
    const r = routeSubagentType("Summarize what you find");
    expect(r.type).toBe("general");
    expect(r.route).toBeNull();
  });
});
