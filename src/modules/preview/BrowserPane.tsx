import { native } from "@/modules/ai/lib/native";
import { listen } from "@tauri-apps/api/event";
import { error as logError, info as logInfo } from "@tauri-apps/plugin-log";
import { useEffect, useRef } from "react";
import { anyOverlayIntersects, useAnyOverlayOpen } from "./overlaySuppress";

// The embedded webview's injected script emits this when the page navigates
// (load / popstate / hashchange / pushState), carrying the new location.href —
// see `embed_init_script` in src-tauri browser.rs.
const BROWSER_VALUE_EVENT = "termigo:browser-value";

type Props = {
  /** Stable id for this browser instance (the tab id works well). */
  instance: string;
  url: string;
  visible: boolean;
  /** Force the native webview hidden even while visible — used while the
   *  address bar is focused so the DOM keyboard is not stolen. */
  suppress?: boolean;
  /** Fired when the page navigates itself (a link, back/forward) so the address
   *  bar can follow the real URL instead of showing the one we asked for. */
  onNavigate?: (url: string) => void;
};

/**
 * Hosts a NATIVE embedded webview (created by the Rust `browser_embed_*`
 * commands) docked over this component's box. The webview composites ABOVE the
 * DOM, so this div stays empty and only serves as the positioning reference:
 * a requestAnimationFrame loop measures its rectangle and pushes physical-pixel
 * bounds to Rust whenever they change, and hides the webview when the pane is
 * not visible. Unlike the iframe preview, an external site renders here because
 * it is a real browser, not an embedded frame subject to X-Frame-Options.
 */
export function BrowserPane({
  instance,
  url,
  visible,
  suppress,
  onNavigate,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const createdUrl = useRef<string | null>(null);
  const lastKey = useRef<string>("");
  const suppressRef = useRef(suppress);
  suppressRef.current = suppress;
  // The last URL the page reported navigating to itself. Kept so the navigate
  // effect below does NOT push it straight back (which would reload the page
  // the browser is already on) when the address bar follows a self-navigation.
  const reportedUrl = useRef<string | null>(null);
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  // Hide the native webview while a modal / dropdown / approval popup overlaps
  // it, so the overlay is never covered (a native webview cannot sit behind the
  // DOM). Read through a ref so the rAF loop sees the latest without re-subscribing.
  const overlayOpen = useAnyOverlayOpen();
  const overlayOpenRef = useRef(overlayOpen);
  overlayOpenRef.current = overlayOpen;

  // Bounds sync: a rAF loop catches every move (splitter drags, sidebar
  // resizes) that a ResizeObserver alone would miss. Only invokes on a real
  // change, so it is not an IPC call every frame.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = boxRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        // Yield to any overlay drawn over the pane by hiding the webview.
        const show =
          visible &&
          !suppressRef.current &&
          !(overlayOpenRef.current && anyOverlayIntersects(r));
        const dpr = window.devicePixelRatio || 1;
        const bounds = {
          x: Math.round(r.left * dpr),
          y: Math.round(r.top * dpr),
          width: Math.round(r.width * dpr),
          height: Math.round(r.height * dpr),
        };
        const key = `${show}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${url}`;
        if (key !== lastKey.current) {
          lastKey.current = key;
          if (createdUrl.current === null) {
            void logInfo(
              `BrowserPane: first update instance=${instance} visible=${show} box=${bounds.width}x${bounds.height} url=${url}`,
            );
          }
          void native
            .browserEmbedUpdate(instance, url, bounds, show)
            .then(() => {
              createdUrl.current = url;
            })
            .catch((e) => {
              void logError(
                `BrowserPane: browserEmbedUpdate failed: ${String(e)}`,
              );
            });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [instance, url, visible]);

  // Navigate an already-created webview when the URL changes (the update path
  // only navigates on first create). Skip when the change merely echoes a URL
  // the page navigated to itself — re-navigating there would reload it.
  useEffect(() => {
    if (
      createdUrl.current &&
      createdUrl.current !== url &&
      reportedUrl.current !== url
    ) {
      void native
        .browserEmbedNavigate(instance, url)
        .then(() => {
          createdUrl.current = url;
        })
        .catch(() => {});
    }
  }, [instance, url]);

  // Follow the embedded page's own navigations (links, back/forward) so the
  // address bar reflects where it actually is. The injected script emits the
  // new location.href; we relay it up as long as it really differs.
  useEffect(() => {
    const un = listen<{ instance?: string; kind?: string; value?: string }>(
      BROWSER_VALUE_EVENT,
      (e) => {
        const p = e.payload;
        if (!p || p.instance !== instance || p.kind !== "url") return;
        const next = typeof p.value === "string" ? p.value : "";
        if (!next || next === createdUrl.current) return;
        reportedUrl.current = next;
        createdUrl.current = next;
        onNavigateRef.current?.(next);
      },
    );
    return () => {
      void un.then((f) => f());
    };
  }, [instance]);

  // Tear the native webview down when the pane unmounts (tab closed).
  useEffect(() => {
    return () => {
      void native.browserEmbedClose(instance).catch(() => {});
    };
  }, [instance]);

  return <div ref={boxRef} className="size-full" />;
}
