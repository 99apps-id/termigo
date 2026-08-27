import { useCallback, useRef } from "react";
import { sendMessage } from "@/modules/ai/store/chatRuntime";

/**
 * Renders the agent's self-contained HTML canvas (a graph, or a plan /
 * walkthrough with action buttons) inside a sandboxed iframe. Scripts and inline
 * handlers are stripped so nothing executes inside it; interactivity is opt-in
 * markup: any element with `data-canvas-action="<text>"` becomes a button that,
 * when clicked, sends `<text>` back to the agent as the user's next message
 * (e.g. a "Proceed" / "Execute" button in a plan). Being a DOM element, it sits
 * BELOW app modals and menus, unlike the native browser webview.
 */
function sanitize(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "");
}

export function CanvasView({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);

  // On (re)load, wire every [data-canvas-action] element to post its action back
  // to the agent. The iframe runs no scripts, so the handler lives in the parent
  // (allowed by allow-same-origin) - no inline JS that the app CSP would block.
  const wire = useCallback(() => {
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    doc.querySelectorAll<HTMLElement>("[data-canvas-action]").forEach((el) => {
      const marker = el as HTMLElement & { __termigoWired?: boolean };
      if (marker.__termigoWired) return;
      marker.__termigoWired = true;
      el.style.cursor = "pointer";
      el.addEventListener("click", () => {
        const action = el.getAttribute("data-canvas-action")?.trim();
        if (action) void sendMessage(action);
      });
    });
  }, []);

  return (
    <iframe
      ref={ref}
      title="Canvas"
      srcDoc={sanitize(html)}
      onLoad={wire}
      className="h-full w-full border-0 bg-white"
      sandbox="allow-same-origin allow-popups allow-forms"
    />
  );
}
