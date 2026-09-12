import { cn } from "@/lib/utils";
import { AiInputBarConnect } from "@/modules/ai";
import { Chip } from "@/modules/ai/components/Chip";
import { ChipsRow } from "@/modules/ai/components/ChipsRow";
import { QueuedSteerRow } from "@/modules/ai/components/QueuedSteerRow";
import { useComposer } from "@/modules/ai/lib/composer";
import { useBlockController } from "@/modules/terminal/lib/blockController";
import { focusLeafInput } from "@/modules/terminal/lib/useTerminalSession";
import {
  CommandLineIcon,
  Folder01Icon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { inputSurfaces } from "./inputSurfaces";
import { OsIcon } from "./OsIcon";
import { useGitBranch } from "./useGitBranch";
import { useSystemInfo } from "./useSystemInfo";

const ShellInput = lazy(() => import("@/modules/terminal/block/ShellInput"));
const AiComposerInput = lazy(() =>
  import("@/modules/ai/components/AiComposerInput").then((m) => ({
    default: m.AiComposerInput,
  })),
);

export const TOGGLE_BLOCK_INPUT_EVENT = "termigo:toggle-block-input";

type Props = {
  isBlockTab: boolean;
  isTerminalTab: boolean;
  activeLeafId: number | null;
  cwd: string | null;
  home: string | null;
  hasComposer: boolean;
  panelOpen: boolean;
  keysLoaded: boolean;
  onConnect: () => void;
};

export function WorkspaceInputBar({
  isBlockTab,
  isTerminalTab,
  activeLeafId,
  cwd,
  home,
  hasComposer,
  panelOpen,
  keysLoaded,
  onConnect,
}: Props) {
  const c = useComposer();
  const { os, shell } = useSystemInfo();

  const controller = useBlockController(isBlockTab ? activeLeafId : null);
  const blockMode = controller?.blockMode ?? "prompt";

  // Re-resolve the branch chip when a command finishes (covers `git checkout`).
  const [promptNonce, setPromptNonce] = useState(0);
  const prevBlockMode = useRef(blockMode);
  useEffect(() => {
    if (prevBlockMode.current !== "prompt" && blockMode === "prompt") {
      setPromptNonce((n) => n + 1);
    }
    prevBlockMode.current = blockMode;
  }, [blockMode]);
  const branch = useGitBranch(isTerminalTab ? cwd : null, promptNonce);

  // One surface per bar (see inputSurfaces.ts). The AI composer lives in the
  // dock, or here on a non-block tab; a block tab types into its shell and has
  // nothing to switch to, so there is no mode and no toggle.
  const surfaces = inputSurfaces({ isBlockTab, hasComposer, panelOpen });

  const mounted = keysLoaded || isBlockTab;
  const open = isBlockTab || (keysLoaded && panelOpen);

  const [aiLoaded, setAiLoaded] = useState(false);
  useEffect(() => {
    if (open && surfaces.ai) setAiLoaded(true);
  }, [open, surfaces.ai]);
  const renderAi = surfaces.ai && hasComposer && aiLoaded;

  // `terminal.toggleInput` used to flip this bar between Shell and AI. With one
  // surface left it focuses the shell input, which is what the shortcut means
  // once there is nothing to toggle.
  useEffect(() => {
    if (!surfaces.shell) return;
    const onToggle = () => {
      if (activeLeafId != null) focusLeafInput(activeLeafId);
    };
    window.addEventListener(TOGGLE_BLOCK_INPUT_EVENT, onToggle);
    return () => window.removeEventListener(TOGGLE_BLOCK_INPUT_EVENT, onToggle);
  }, [surfaces.shell, activeLeafId]);

  if (!mounted) return null;
  // When the AI chat is docked, its composer lives inside the dock panel. For a
  // non-terminal tab the centre bar would then hold only the AI composer, so
  // hide it entirely and let the dock own the typing area. Terminal/block tabs
  // keep the centre bar for their shell input.
  if (panelOpen && !isBlockTab) return null;

  const terminalChips = isTerminalTab ? (
    <>
      {os && <Chip tone="neutral" iconNode={<OsIcon os={os} />} title={os} />}
      {cwd && (
        <Chip tone="blue" icon={Folder01Icon} title={cwd}>
          {relPath(cwd, home)}
        </Chip>
      )}
      {branch && (
        <Chip tone="violet" icon={GitBranchIcon} title={`Branch: ${branch}`}>
          {branch}
        </Chip>
      )}
      {shell && (
        <Chip tone="emerald" icon={CommandLineIcon}>
          {shell}
        </Chip>
      )}
    </>
  ) : null;

  const content =
    !hasComposer && !isBlockTab ? (
      <AiInputBarConnect onAdd={onConnect} />
    ) : (
      <div className="shrink-0 border-t border-border bg-card px-3 py-2 shadow-2xs dark:border-border/60 dark:bg-card/40">
        <div
          data-busy={surfaces.ai && c.isBusy ? "true" : undefined}
          className={cn(
            "flex flex-col gap-2",
            // The AI composer sits in a rounded box with an animated accent glow
            // circling its border; the terminal shell input keeps its plain look.
            surfaces.ai
              ? "termigo-composer-glow rounded-xl border border-border/80 bg-card px-2.5 py-2 shadow-xs dark:border-transparent dark:bg-card/60"
              : "rounded-lg px-1 py-1",
          )}
        >
          <QueuedSteerRow />
          <ChipsRow
            leading={terminalChips}
            files={c.files}
            onRemoveFile={c.removeFile}
            snippets={c.pickedSnippets}
            onRemoveSnippet={(id) => {
              const snip = c.pickedSnippets.find((s) => s.id === id);
              c.removeSnippet(id);
              if (!snip) return;
              const re = new RegExp(`(^|\\s)#${snip.handle}\\b ?`);
              c.setValue((v) => v.replace(re, (_m, lead: string) => lead));
            }}
            commands={c.pickedCommands}
            onRemoveCommand={(name) => c.removeCommand(name)}
          />

          <div className="flex items-end gap-2.5">
            <div className="relative min-w-0 flex-1">
              {surfaces.shell && controller && activeLeafId != null && (
                <Suspense fallback={null}>
                  <ShellInput
                    leafId={activeLeafId}
                    mode={blockMode}
                    focused
                    onSubmit={controller.submitCommand}
                    onInterrupt={controller.interrupt}
                    getCwd={controller.getCwd}
                  />
                </Suspense>
              )}
              {renderAi && (
                <Suspense fallback={null}>
                  <AiComposerInput />
                </Suspense>
              )}
            </div>
          </div>
        </div>
      </div>
    );

  return (
    <div
      data-ai-input-bar
      data-state={open ? "open" : "closed"}
      className="termigo-reveal"
      aria-hidden={!open}
    >
      <div>{content}</div>
    </div>
  );
}

function relPath(p: string, home: string | null): string {
  if (!home) return p;
  const h = home.replace(/\/+$/, "");
  if (p === h || p.startsWith(`${h}/`)) return `~${p.slice(h.length)}`;
  return p;
}
