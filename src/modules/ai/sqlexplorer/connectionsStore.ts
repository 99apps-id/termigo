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
