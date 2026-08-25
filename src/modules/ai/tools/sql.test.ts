import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSqlTools } from "./sql";

vi.mock("../sqlexplorer/bridge", () => ({
  runSql: vi.fn(async () => "1|alice\n2|bob\n"),
}));

import { runSql } from "../sqlexplorer/bridge";

const OPTS = { toolCallId: "t", messages: [] } as never;

type Exec = (
  args: Record<string, unknown>,
  options: { toolCallId: string; messages: never[] },
) => Promise<unknown>;

function execOf(tool: { execute?: unknown }): Exec {
  const fn = tool.execute;
  if (typeof fn !== "function") throw new Error("tool has no execute");
  return fn as Exec;
}

beforeEach(() => {
  vi.mocked(runSql).mockClear();
  vi.mocked(runSql).mockResolvedValue("1|alice\n2|bob\n");
});

describe("run_sql tool", () => {
  it("runs a query and returns the output", async () => {
    const tools = buildSqlTools();
    const r = (await execOf(tools.run_sql)(
      { engine: "sqlite3", connection: "./app.db", query: "SELECT * FROM users;" },
      OPTS,
    )) as { output?: string; error?: string };
    expect(r.output).toBe("1|alice\n2|bob\n");
    expect(vi.mocked(runSql)).toHaveBeenCalledWith(
      "sqlite3",
      "./app.db",
      "SELECT * FROM users;",
    );
  });

  it("refuses an empty query before touching the bridge", async () => {
    const tools = buildSqlTools();
    const r = (await execOf(tools.run_sql)(
      { engine: "sqlite3", connection: "./app.db", query: "   " },
      OPTS,
    )) as { error?: string };
    expect(r.error).toMatch(/empty/);
    expect(vi.mocked(runSql)).not.toHaveBeenCalled();
  });

  it("surfaces a bridge error", async () => {
    vi.mocked(runSql).mockRejectedValue(new Error("connection refused"));
    const tools = buildSqlTools();
    const r = (await execOf(tools.run_sql)(
      { engine: "psql", connection: "postgres://u@h/db", query: "SELECT 1;" },
      OPTS,
    )) as { error?: string };
    expect(r.error).toBe("connection refused");
  });
});
