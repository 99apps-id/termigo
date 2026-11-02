import { tool } from "ai";
import { z } from "zod";
import {
  runSql,
  sqlExplain,
  sqlHealth,
  sqlSchema,
  type SqlEngine,
} from "../sqlexplorer/bridge";
import {
  findSqlConnection,
  getPublicSqlConnections,
} from "../sqlexplorer/connectionsStore";

// SQL Explorer tools. The query travels over stdin (not a shell argv), so it
// cannot be shell-escaped; the engine and connection are supplied by the caller
// or resolved from saved database connections in Settings. Only the output is
// returned, never the raw DSN with credentials.
export function buildSqlTools() {
  const resolve = (connection: string, engine?: SqlEngine) => {
    const saved = findSqlConnection(connection);
    return {
      saved,
      resolvedEngine: (engine ?? saved?.engine) as SqlEngine | undefined,
      resolvedConnection: saved ? saved.connection : connection,
    };
  };

  const inspect = async (
    action: "schema" | "explain" | "health",
    connection: string,
    engine: SqlEngine | undefined,
    query?: string,
  ) => {
    const { saved, resolvedEngine, resolvedConnection } = resolve(
      connection,
      engine,
    );
    if (!resolvedEngine) {
      return {
        error:
          "Engine is required when connection is not a saved connection name.",
      };
    }
    try {
      const output =
        action === "schema"
          ? await sqlSchema(resolvedEngine, resolvedConnection)
          : action === "explain"
            ? await sqlExplain(resolvedEngine, resolvedConnection, query ?? "")
            : await sqlHealth(resolvedEngine, resolvedConnection);
      return { output, engine: resolvedEngine, connectionName: saved?.name };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };

  return {
    list_sql_connections: tool({
      description:
        "List all saved database connections configured by the user in Settings. Returns connection name, ID, and engine type. Use this to discover available databases before running queries.",
      inputSchema: z.object({}),
      execute: async () => {
        const connections = getPublicSqlConnections();
        return {
          count: connections.length,
          connections,
        };
      },
    }),

    run_sql: tool({
      description:
        "Run a SQL query against a database. The connection argument can be the friendly name of a saved database connection (e.g. 'prod-db', discoverable via list_sql_connections) or a raw file path/connection string. If a saved connection name is used, the engine is resolved automatically. Returns the query output.",
      needsApproval: true,
      inputSchema: z.object({
        connection: z
          .string()
          .describe(
            "Saved connection name (e.g. 'prod-db'), database file path (e.g. ./app.db), or connection string.",
          ),
        query: z
          .string()
          .describe("The SQL to execute, e.g. SELECT * FROM users LIMIT 10;"),
        engine: z
          .enum([
            "sqlite3",
            "sqlite",
            "duckdb",
            "psql",
            "postgres",
            "mysql",
            "mariadb",
          ])
          .optional()
          .describe(
            "Database engine CLI. Optional when using a saved connection name.",
          ),
      }),
      execute: async ({ connection, query, engine }) => {
        if (!query.trim()) return { error: "query cannot be empty" };
        if (query.length > 200_000) {
          return { error: "query too long (over 200000 characters)" };
        }

        // Try to resolve as a saved connection first
        const saved = findSqlConnection(connection);
        const resolvedEngine = (engine ?? saved?.engine) as
          | SqlEngine
          | undefined;
        const resolvedConnection = saved ? saved.connection : connection;

        if (!resolvedEngine) {
          return {
            error:
              "Engine is required when connection is not a saved connection name. Supported engines: sqlite3, duckdb, psql, mysql, mariadb.",
          };
        }

        try {
          const output = await runSql(
            resolvedEngine,
            resolvedConnection,
            query,
          );
          return {
            output,
            engine: resolvedEngine,
            connectionName: saved ? saved.name : undefined,
          };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
    }),

    sql_schema: tool({
      description:
        "List tables and views from a configured database connection.",
      inputSchema: z.object({
        connection: z.string(),
        engine: z
          .enum([
            "sqlite3",
            "sqlite",
            "duckdb",
            "psql",
            "postgres",
            "mysql",
            "mariadb",
          ])
          .optional(),
      }),
      execute: ({ connection, engine }) =>
        inspect("schema", connection, engine),
    }),

    sql_explain: tool({
      description: "Return the database query plan without changing data.",
      inputSchema: z.object({
        connection: z.string(),
        query: z.string(),
        engine: z
          .enum([
            "sqlite3",
            "sqlite",
            "duckdb",
            "psql",
            "postgres",
            "mysql",
            "mariadb",
          ])
          .optional(),
      }),
      execute: ({ connection, query, engine }) =>
        inspect("explain", connection, engine, query),
    }),

    sql_health: tool({
      description:
        "Check whether a configured database connection responds to a read-only probe.",
      inputSchema: z.object({
        connection: z.string(),
        engine: z
          .enum([
            "sqlite3",
            "sqlite",
            "duckdb",
            "psql",
            "postgres",
            "mysql",
            "mariadb",
          ])
          .optional(),
      }),
      execute: ({ connection, engine }) =>
        inspect("health", connection, engine),
    }),
  } as const;
}
