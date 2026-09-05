import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SqlConnection } from "./bridge";

type State = {
  connections: SqlConnection[];
  addConnection: (conn: Omit<SqlConnection, "id">) => string;
  removeConnection: (id: string) => void;
  updateConnection: (conn: SqlConnection) => void;
};

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useSqlConnectionsStore = create<State>()(
  persist(
    (set) => ({
      connections: [],
      addConnection: (conn) => {
        const id = makeId();
        set((s) => ({ connections: [...s.connections, { ...conn, id }] }));
        return id;
      },
      removeConnection: (id) =>
        set((s) => ({
          connections: s.connections.filter((c) => c.id !== id),
        })),
      updateConnection: (conn) =>
        set((s) => ({
          connections: s.connections.map((c) => (c.id === conn.id ? conn : c)),
        })),
    }),
    { name: "termigo-sql-connections" },
  ),
);

/**
 * Find a saved database connection by ID or case-insensitive name.
 */
export function findSqlConnection(nameOrId: string): SqlConnection | undefined {
  const norm = nameOrId.trim().toLowerCase();
  if (!norm) return undefined;
  const list = useSqlConnectionsStore.getState().connections;
  return (
    list.find((c) => c.id === nameOrId.trim()) ??
    list.find((c) => c.name.trim().toLowerCase() === norm)
  );
}

/**
 * Public summary of saved connections for AI discovery.
 * DSN/passwords are stripped to prevent credential exposure.
 */
export function getPublicSqlConnections(): Array<{
  id: string;
  name: string;
  engine: SqlConnection["engine"];
}> {
  return useSqlConnectionsStore.getState().connections.map((c) => ({
    id: c.id,
    name: c.name,
    engine: c.engine,
  }));
}
