import { tool } from "ai";
import { z } from "zod";
import { runSql } from "../sqlexplorer/bridge";

// SQL Explorer tool. The query travels over stdin (not a shell argv), so it
// cannot be shell-escaped; the engine and connection are supplied by the caller
// and validated on the Rust side. Only the output is returned, never the
// connection string, so a password in a DSN is not echoed back to the model.
export function buildSqlTools() {
  return {
    run_sql: tool({
      description:
        "Run a SQL query against a configured database engine (sqlite3, duckdb, psql, mysql). The query is piped over stdin; the connection string is left to the caller. Returns the query output. Use to explore schema or inspect data when the database is reachable from this machine.",
      inputSchema: z.object({
        engine: z
          .enum(["sqlite3", "sqlite", "duckdb", "psql", "postgres", "mysql", "mariadb"])
          .describe("Database engine / CLI to run against."),
        connection: z
          .string()
          .describe("Connection string or file path (e.g. ./app.db, postgres://u@h/db)."),
        query: z
          .string()
          .describe("The SQL to execute, e.g. SELECT * FROM users LIMIT 10;"),
      }),
      execute: async ({ engine, connection, query }) => {
        if (!query.trim()) return { error: "query cannot be empty" };
        if (query.length > 200_000) {
          return { error: "query too long (over 200000 characters)" };
        }
        try {
          const output = await runSql(engine, connection, query);
          return { output };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
    }),
  } as const;
}
