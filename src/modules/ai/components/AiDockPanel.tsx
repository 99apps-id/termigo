import { lazy, Suspense } from "react";
import { useComposer } from "../lib/composer";
import { useChatStore } from "../store/chatStore";
import { AiChatBody } from "./AiMiniWindow";
import { ChipsRow } from "./ChipsRow";

const AiComposerInput = lazy(() =>
  import("./AiComposerInput").then((m) => ({ default: m.AiComposerInput })),
);

/**
 * The AI chat docked as an in-app side panel (rather than the floating mini
 * window), so it sits BESIDE the workspace instead of over it. This is what
 * lets the chat stay visible next to an embedded browser tab: the native
 * browser webview composites above the DOM and would cover a floating chat, but
 * a docked panel occupies its own layout column that the webview never spans.
 *
 * The composer lives INSIDE the panel (bottom), so you type where the chat is -
 * matching TEDI - instead of in the centre workspace bar. WorkspaceInputBar
 * hides its own AI composer while docked so there is only one.
 *
 * Reuses the mini window's chat body verbatim, so both surfaces share one
 * session, one composer, and one approval/todo strip - only the frame differs.
 */
export function AiDockPanel() {
  const sessionId = useChatStore((s) => s.activeSessionId);
  const closePanel = useChatStore((s) => s.closePanel);
  const openMini = useChatStore((s) => s.openMini);
  const c = useComposer();

  if (!sessionId) return null;

  // The header's expand control pops the chat back out to the floating window.
  const popOut = () => {
    closePanel();
    openMini();
  };

  const hasChips =
    c.files.length > 0 ||
    c.pickedSnippets.length > 0 ||
    c.pickedCommands.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border/60 bg-card text-[12px]">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <AiChatBody
          sessionId={sessionId}
          onClose={closePanel}
          onExpand={popOut}
          onHeaderPointerDown={() => {}}
        />
      </div>
      <div className="shrink-0 border-t border-border/60 bg-card/40 px-3 py-2">
        <div
          data-busy={c.isBusy ? "true" : undefined}
          className="termigo-composer-glow flex flex-col gap-2 rounded-xl bg-card/60 px-2.5 py-2"
        >
          {hasChips && (
            <ChipsRow
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
          )}
          <Suspense fallback={null}>
            <AiComposerInput />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
