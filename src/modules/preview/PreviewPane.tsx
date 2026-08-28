import { Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { BrowserPane } from "./BrowserPane";
import { CanvasView } from "./CanvasView";
import {
  PreviewAddressBar,
  type PreviewAddressBarHandle,
} from "./PreviewAddressBar";

export type PreviewPaneHandle = {
  reload: () => void;
  focusAddressBar: () => void;
  getUrl: () => string;
};

type Props = {
  url: string;
  visible: boolean;
  onUrlChange: (url: string) => void;
  /** Agent canvas HTML; when set the pane renders it instead of `url`. */
  html?: string;
  /** Stable name for the native embedded browser webview (agent-opened tabs). */
  browserInstance?: string;
};

// Tear the iframe down after this much invisibility — a background dev
// server page can hold hundreds of MB inside the WebView.
const SUSPEND_AFTER_MS = 30_000;

export const PreviewPane = forwardRef<PreviewPaneHandle, Props>(
  function PreviewPane(
    { url, visible, onUrlChange, html, browserInstance },
    ref,
  ) {
    // `nonce` is part of the iframe `key`. Bumping it remounts the iframe,
    // which is the only reliable cross-origin reload (calling
    // contentWindow.location.reload() throws on cross-origin frames).
    const [nonce, setNonce] = useState(0);
    const [loaded, setLoaded] = useState(visible);
    const addressRef = useRef<PreviewAddressBarHandle>(null);
    // Stable per-mount id for the native embedded webview (external URLs).
    const instanceId = useRef(
      `pv-${Math.random().toString(36).slice(2, 10)}`,
    ).current;

    useEffect(() => {
      if (visible) {
        setLoaded(true);
        return;
      }
      const t = setTimeout(() => setLoaded(false), SUSPEND_AFTER_MS);
      return () => clearTimeout(t);
    }, [visible]);

    useImperativeHandle(
      ref,
      () => ({
        reload: () => {
          setLoaded(true);
          setNonce((n) => n + 1);
        },
        focusAddressBar: () => addressRef.current?.focus(),
        getUrl: () => url,
      }),
      [url],
    );

    // External URLs render in a NATIVE embedded webview (a real browser), not
    // the iframe - public sites refuse to be framed (X-Frame-Options), which is
    // the whole reason the embedded browser exists. Local dev servers keep the
    // lightweight iframe.
    const external = url ? !isLocalUrl(url) : false;

    // Agent canvas: render the HTML the agent produced (a graph, a plan) in a
    // sandboxed iframe, no address bar. It is a DOM element, so app modals and
    // menus sit above it.
    if (html !== undefined) {
      return (
        <div
          className="flex h-full w-full flex-col overflow-hidden rounded-md border border-border/60 bg-white"
          style={{
            visibility: visible ? "visible" : "hidden",
            pointerEvents: visible ? "auto" : "none",
          }}
        >
          <div className="relative min-h-0 flex-1">
            <CanvasView key={html} html={html} />
          </div>
        </div>
      );
    }

    return (
      <div
        className="flex h-full w-full flex-col overflow-hidden rounded-md border border-border/60 bg-background"
        style={{
          visibility: visible ? "visible" : "hidden",
          pointerEvents: visible ? "auto" : "none",
        }}
      >
        <PreviewAddressBar
          ref={addressRef}
          url={url}
          onSubmit={onUrlChange}
          onReload={() => setNonce((n) => n + 1)}
        />
        <div
          className={
            url
              ? external
                ? "relative min-h-0 flex-1 bg-background"
                : "relative min-h-0 flex-1 bg-white"
              : "relative min-h-0 flex-1 bg-background"
          }
        >
          {url ? (
            external ? (
              <BrowserPane
                instance={browserInstance ?? instanceId}
                url={url}
                visible={visible}
              />
            ) : loaded ? (
              <iframe
                key={`${url}#${nonce}`}
                src={url}
                title="Preview"
                className="h-full w-full border-0"
                // sandbox grants the bare minimum for a dev preview: scripts,
                // same-origin (cookies/storage for the previewed app), forms,
                // popups for "open in new tab". Critically OMITS
                // `allow-top-navigation*` — without it the iframe cannot
                // navigate the parent Tauri webview to an attacker origin,
                // which would otherwise expose `window.__TAURI__` IPC.
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
                referrerPolicy="no-referrer"
                allow="clipboard-read; clipboard-write; fullscreen"
              />
            ) : (
              <SuspendedState
                onReload={() => {
                  setLoaded(true);
                  setNonce((n) => n + 1);
                }}
              />
            )
          ) : (
            <EmptyState />
          )}
        </div>
      </div>
    );
  },
);

function SuspendedState({ onReload }: { onReload: () => void }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-2xl border border-border/60 bg-card text-muted-foreground">
        <HugeiconsIcon icon={Globe02Icon} size={18} strokeWidth={1.5} />
      </div>
      <div className="space-y-1">
        <p className="text-[12.5px] font-medium text-foreground">
          Preview suspended
        </p>
        <p className="max-w-xs text-[11px] leading-relaxed text-muted-foreground">
          Released to free memory after sitting in the background.
        </p>
      </div>
      <button
        type="button"
        onClick={onReload}
        className="rounded-md border border-border/60 bg-card px-3 py-1 text-[11px] hover:bg-accent/50"
      >
        Reload
      </button>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl border border-border/60 bg-card text-muted-foreground">
        <HugeiconsIcon icon={Globe02Icon} size={20} strokeWidth={1.5} />
      </div>
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-foreground">
          Nothing to preview yet
        </p>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          Type a URL above, or open the{" "}
          <span className="rounded bg-muted px-1 py-0.5 font-mono text-[10.5px]">
            Ports
          </span>{" "}
          dropdown to jump straight to your running dev server. Public sites
          often block embedding — open them in your browser via the link icon if
          you see a blank page.
        </p>
      </div>
    </div>
  );
}

function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname;
    return (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "0.0.0.0" ||
      h === "[::1]" ||
      h.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}
