import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Extension } from "@codemirror/state";
import { useEffect, useState } from "react";
import { serverForLanguage } from "./presets";
import { useLspRuntimeStore } from "./runtimeStore";
import { acquireDocExtension, type LspDocHandle } from "./sessionManager";

export function useLspExtension(
  path: string,
  langId: string | null,
  ready: boolean,
  active = true,
): Extension | null {
  const [ext, setExt] = useState<Extension | null>(null);
  const customServers = usePreferencesStore((s) => s.lspCustomServers);
  const lspActivation = usePreferencesStore((s) => s.lspActivation);
  const preset = serverForLanguage(langId, customServers, lspActivation);
  const activation = preset ? lspActivation[preset.id] : undefined;
  const idleShutdown = usePreferencesStore((s) => s.lspIdleShutdown);
  const generation = useLspRuntimeStore((s) =>
    preset ? (s.generations[preset.id] ?? 0) : 0,
  );

  const presetId = preset?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies(generation): re-acquire after a server crash tears the session down
  // biome-ignore lint/correctness/useExhaustiveDependencies(presetId): swapping the enabled server for a language must rebind the doc
  useEffect(() => {
    if (!ready || !langId || activation !== "enabled") {
      setExt(null);
      return;
    }
    // A hidden tab releases its LSP document so the server's existing idle
    // shutdown can reclaim the process; showing the tab re-acquires here.
    if (idleShutdown && !active) {
      setExt(null);
      return;
    }
    let cancelled = false;
    let handle: LspDocHandle | null = null;
    acquireDocExtension(path, langId)
      .then((h) => {
        if (!h) return;
        if (cancelled) {
          h.release();
          return;
        }
        handle = h;
        setExt(h.extension);
      })
      .catch((e) => console.error("[lsp] acquire failed", e));
    return () => {
      cancelled = true;
      handle?.release();
      setExt(null);
    };
  }, [
    path,
    langId,
    ready,
    activation,
    generation,
    presetId,
    active,
    idleShutdown,
  ]);

  return ext;
}
