import { create } from "zustand";
import { type CustomCommand, listCustomCommands } from "../lib/customCommands";
import { useCustomCommandStatsStore } from "./customCommandStatsStore";
import { usePreferencesStore } from "@/modules/settings/preferences";

type State = {
  /** Custom commands loaded from the active workspace's `.termigo/commands`. */
  commands: CustomCommand[];
  /** Rescan the workspace's command directory and publish the result. Cheap
   *  (a readDir plus a few small files); safe to call on picker-open so a file
   *  the user just created shows up without an app restart. */
  loadFor: (workspaceRoot: string | null) => Promise<void>;
  /** Look one up by invocation name. */
  get: (name: string) => CustomCommand | null;
};

export const useCustomCommandsStore = create<State>((set, getState) => ({
  commands: [],
  loadFor: async (workspaceRoot) => {
    const extraDirs = usePreferencesStore.getState().customCommandDirs ?? [];
    const commands = await listCustomCommands(workspaceRoot, extraDirs);
    const names = commands.map((c) => c.name);
    useCustomCommandStatsStore.getState().touchMany(names);
    set({ commands });
  },
  get: (name) => getState().commands.find((c) => c.name === name) ?? null,
}));
