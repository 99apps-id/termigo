import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSqlTools } from "./sql";

vi.mock("../sqlexplorer/bridge", () => ({
  runSql: vi.fn(async () => "1|alice\n2|bob\n"),
}));

vi.mock("../sqlexplorer/connectionsStore", () => ({
  findSqlConnection: vi.fn((nameOrId: string) => {
    if (nameOrId === "prod-db") {
      return {
        id: "conn-1",
        name: "prod-db",
        engine: "sqlite3",
        connection: "./data/production.db",
      };
    }
    return undefined;
  }),
  getPublicSqlConnections: vi.fn(() => [
    { id: "conn-1", name: "prod-db", engine: "sqlite3" },
  ]),
}));

import { runSql } from "../sqlexplorer/bridge";
import {
  findSqlConnection,
  getPublicSqlConnections,
} from "../sqlexplorer/connectionsStore";

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

describe("SQL tools", () => {
  describe("run_sql tool", () => {
    it("runs a query and returns the output", async () => {
      const tools = buildSqlTools();
      const r = (await execOf(tools.run_sql)(
        {
          engine: "sqlite3",
          connection: "./app.db",
          query: "SELECT * FROM users;",
        },
        OPTS,
      )) as { output?: string; error?: string };
      expect(r.output).toBe("1|alice\n2|bob\n");
      expect(vi.mocked(runSql)).toHaveBeenCalledWith(
        "sqlite3",
        "./app.db",
        "SELECT * FROM users;",
      );
    });

    it("resolves saved connection by name automatically", async () => {
      const tools = buildSqlTools();
      const r = (await execOf(tools.run_sql)(
        {
          connection: "prod-db",
          query: "SELECT * FROM orders;",
        },
        OPTS,
      )) as { output?: string; engine?: string; connectionName?: string };
      expect(vi.mocked(findSqlConnection)).toHaveBeenCalledWith("prod-db");
      expect(vi.mocked(runSql)).toHaveBeenCalledWith(
        "sqlite3",
        "./data/production.db",
        "SELECT * FROM orders;",
      );
      expect(r.output).toBe("1|alice\n2|bob\n");
      expect(r.engine).toBe("sqlite3");
      expect(r.connectionName).toBe("prod-db");
    });

    it("errors when engine is missing and connection is not saved", async () => {
      const tools = buildSqlTools();
      const r = (await execOf(tools.run_sql)(
        {
          connection: "unknown-conn",
          query: "SELECT 1;",
        },
        OPTS,
      )) as { error?: string };
      expect(r.error).toMatch(/Engine is required/);
      expect(vi.mocked(runSql)).not.toHaveBeenCalled();
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

  describe("list_sql_connections tool", () => {
    it("returns public list of saved database connections", async () => {
      const tools = buildSqlTools();
      const r = (await execOf(tools.list_sql_connections)({}, OPTS)) as {
        count: number;
        connections: Array<{ id: string; name: string; engine: string }>;
      };
      expect(vi.mocked(getPublicSqlConnections)).toHaveBeenCalled();
      expect(r.count).toBe(1);
      expect(r.connections[0]).toEqual({
        id: "conn-1",
        name: "prod-db",
        engine: "sqlite3",
      });
    });
  });
});
