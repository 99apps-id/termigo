import { Suspense, lazy } from "react";
import { useChatStore } from "../store/chatStore";
import { useComposer } from "../lib/composer";
import { AiChatBody } from "./AiMiniWindow";

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
  const isBusy = useComposer().isBusy;

  if (!sessionId) return null;

  // The header's expand control pops the chat back out to the floating window.
  const popOut = () => {
    closePanel();
    openMini();
  };

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
          data-busy={isBusy ? "true" : undefined}
          className="termigo-composer-glow rounded-xl bg-card/60 px-2.5 py-2"
        >
          <Suspense fallback={null}>
            <AiComposerInput />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
