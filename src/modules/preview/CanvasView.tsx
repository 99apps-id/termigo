import { useCallback, useRef } from "react";

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

// The agent's HTML paints its own <body>. When it omits a background — or leans
// on the OS being in dark mode — the report renders dark-on-dark inside the
// canvas. Prepend a LIGHT base: a `color-scheme: light` hint (so the iframe's UA
// colors and form controls are light) plus low-specificity white/near-black
// defaults. These come first in source order, so any explicit theme the agent
// ships still wins; only unstyled reports fall back to a clean light sheet.
const LIGHT_BASE = `<meta name="color-scheme" content="light" />
<style>
  :root { color-scheme: light; }
  html, body { background: #ffffff; color: #1a1a1a; }
  body { margin: 0; padding: 16px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  a { color: #2563eb; }
</style>
`;

function wrapCanvas(html: string): string {
  return LIGHT_BASE + sanitize(html);
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
        if (!action) return;
        // Lazy-import the chat runtime so the preview surface (eagerly reachable
        // from the main window) does not pull the AI/markdown/editor stack into
        // the startup bundle — see src/app/eager-budget.test.ts.
        void import("@/modules/ai/store/chatRuntime").then(({ sendMessage }) =>
          sendMessage(action),
        );
      });
    });
  }, []);

  return (
    <iframe
      ref={ref}
      title="Canvas"
      srcDoc={wrapCanvas(html)}
      onLoad={wire}
      className="h-full w-full border-0 bg-white"
      sandbox="allow-same-origin allow-popups allow-forms"
    />
  );
}
