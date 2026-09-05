import { consumeLaunchFiles } from "@/lib/launchDir";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect } from "react";

type Params = {
  booted: boolean;
  handleOpenFile: (path: string, pin?: boolean) => void;
};

/**
 * Handles cold and warm start launch files.
 * - Cold start: CLI arguments / initial files drained from get_launch_files after space restore.
 * - Warm start: Listens to Tauri event "termigo:open-file".
 */
export function useWorkspaceBoot({ booted, handleOpenFile }: Params) {
  const openLaunchFiles = useCallback(
    (paths: string[]) => {
      for (const path of paths) handleOpenFile(path, true);
    },
    [handleOpenFile],
  );

  // Warm start: the backend emits once the window already exists.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    (async () => {
      const off = await listen<string[]>("termigo:open-file", (e) => {
        openLaunchFiles(e.payload);
      });
      if (disposed) off();
      else unlisten = off;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openLaunchFiles]);

  // Cold start: wait for booted so replaceTabs does not wipe launch tabs.
  useEffect(() => {
    if (!booted) return;
    void (async () => {
      openLaunchFiles(await consumeLaunchFiles());
    })();
  }, [booted, openLaunchFiles]);

  return { openLaunchFiles };
}
