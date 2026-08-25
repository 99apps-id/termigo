// Typed wrapper over the `sql_run` Tauri command. The engine and connection
// are user-configured in Settings; the query is piped over stdin on the Rust
// side so it never appears in a shell argv.

import { invoke } from "@tauri-apps/api/core";

export async function runSql(
  engine: string,
  connection: string,
  query: string,
): Promise<string> {
  try {
    return await invoke<string>("sql_run", { engine, connection, query });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }
}

export type SqlEngine =
  | "sqlite3"
  | "sqlite"
  | "duckdb"
  | "psql"
  | "postgres"
  | "mysql"
  | "mariadb";

export const SQL_ENGINES: { id: SqlEngine; label: string }[] = [
  { id: "sqlite3", label: "SQLite (sqlite3)" },
  { id: "duckdb", label: "DuckDB (duckdb)" },
  { id: "psql", label: "Postgres (psql)" },
  { id: "mysql", label: "MySQL (mysql)" },
  { id: "mariadb", label: "MariaDB (mariadb)" },
];

/** A saved SQL connection, persisted in the SQL Explorer settings section. */
export type SqlConnection = {
  id: string;
  name: string;
  engine: SqlEngine;
  connection: string;
};
