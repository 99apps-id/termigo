import { useChatStore } from "../store/chatStore";
import { AiChatBody } from "./AiMiniWindow";

/**
 * The AI chat docked as an in-app side panel (rather than the floating mini
 * window), so it sits BESIDE the workspace instead of over it. This is what
 * lets the chat stay visible next to an embedded browser tab: the native
 * browser webview composites above the DOM and would cover a floating chat, but
 * a docked panel occupies its own layout column that the webview never spans.
 *
 * Reuses the mini window's chat body verbatim, so both surfaces share one
 * session, one composer, and one approval/todo strip - only the frame differs.
 */
export function AiDockPanel() {
  const sessionId = useChatStore((s) => s.activeSessionId);
  const closePanel = useChatStore((s) => s.closePanel);
  const openMini = useChatStore((s) => s.openMini);

  if (!sessionId) return null;

  // The header's expand control pops the chat back out to the floating window.
  const popOut = () => {
    closePanel();
    openMini();
  };

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border/60 bg-card text-[12px]">
      <AiChatBody
        sessionId={sessionId}
        onClose={closePanel}
        onExpand={popOut}
        onHeaderPointerDown={() => {}}
      />
    </div>
  );
}
