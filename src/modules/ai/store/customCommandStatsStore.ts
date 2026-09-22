import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CustomCommand } from "../lib/customCommands";
import { useCustomCommandsStore } from "./customCommandsStore";

export type CommandStats = {
  /** How many times this command was executed. */
  count: number;
  /** Last executed timestamp. */
  lastUsed: number | null;
  /** Whether the user favorited this command. */
  favorite: boolean;
};

type State = {
  /** Stats keyed by command name. */
  stats: Record<string, CommandStats>;
  /** Mark a command as used now. */
  recordUse: (name: string) => void;
  /** Toggle favorite for a command. */
  toggleFavorite: (name: string) => void;
  /** Get stats for a command. */
  get: (name: string) => CommandStats | null;
  /** Get recently used commands, sorted by lastUsed desc. */
  getRecent: (limit?: number) => CustomCommand[];
  /** Get favorite commands. */
  getFavorites: () => CustomCommand[];
  /** Merge external commands into the recency list (used when commands are loaded). */
  touchMany: (names: string[]) => void;
};

const MAX_RECENT = 20;

export const useCustomCommandStatsStore = create<State>()(
  persist(
    (set, getState) => ({
      stats: {},
      recordUse: (name) => {
        set((s) => ({
          stats: {
            ...s.stats,
            [name]: {
              count: (s.stats[name]?.count ?? 0) + 1,
              lastUsed: Date.now(),
              favorite: s.stats[name]?.favorite ?? false,
            },
          },
        }));
      },
      toggleFavorite: (name) => {
        set((s) => ({
          stats: {
            ...s.stats,
            [name]: {
              count: s.stats[name]?.count ?? 0,
              lastUsed: s.stats[name]?.lastUsed ?? null,
              favorite: !(s.stats[name]?.favorite ?? false),
            },
          },
        }));
      },
      get: (name: string) => getState().stats[name] ?? null,
      getRecent: (limit = MAX_RECENT) => {
        const all = useCustomCommandsStore.getState().commands;
        const stats = getState().stats;
        return all
          .filter((c: CustomCommand) => stats[c.name]?.lastUsed != null)
          .sort(
            (a: CustomCommand, b: CustomCommand) =>
              (stats[b.name].lastUsed ?? 0) - (stats[a.name].lastUsed ?? 0),
          )
          .slice(0, limit);
      },
      getFavorites: () => {
        const all = useCustomCommandsStore.getState().commands;
        const stats = getState().stats;
        return all.filter((c: CustomCommand) => stats[c.name]?.favorite);
      },
      touchMany: (names) => {
        const now = Date.now();
        set((s) => {
          const next = { ...s.stats };
          for (const name of names) {
            if (!next[name]) {
              next[name] = { count: 0, lastUsed: now, favorite: false };
            }
          }
          return { stats: next };
        });
      },
    }),
    {
      name: "termigo-custom-command-stats",
      partialize: ({ stats }) => ({ stats }),
    }
  )
);
