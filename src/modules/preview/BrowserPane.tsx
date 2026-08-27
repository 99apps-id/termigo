import { useEffect, useRef } from "react";
import { error as logError, info as logInfo } from "@tauri-apps/plugin-log";
import { native } from "@/modules/ai/lib/native";

type Props = {
  /** Stable id for this browser instance (the tab id works well). */
  instance: string;
  url: string;
  visible: boolean;
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
export function BrowserPane({ instance, url, visible }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const createdUrl = useRef<string | null>(null);
  const lastKey = useRef<string>("");

  // Bounds sync: a rAF loop catches every move (splitter drags, sidebar
  // resizes) that a ResizeObserver alone would miss. Only invokes on a real
  // change, so it is not an IPC call every frame.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = boxRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const bounds = {
          x: Math.round(r.left * dpr),
          y: Math.round(r.top * dpr),
          width: Math.round(r.width * dpr),
          height: Math.round(r.height * dpr),
        };
        const key = `${visible}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${url}`;
        if (key !== lastKey.current) {
          lastKey.current = key;
          if (createdUrl.current === null) {
            void logInfo(
              `BrowserPane: first update instance=${instance} visible=${visible} box=${bounds.width}x${bounds.height} url=${url}`,
            );
          }
          void native
            .browserEmbedUpdate(instance, url, bounds, visible)
            .then(() => {
              createdUrl.current = url;
            })
            .catch((e) => {
              void logError(`BrowserPane: browserEmbedUpdate failed: ${String(e)}`);
            });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [instance, url, visible]);

  // Navigate an already-created webview when the URL changes (the update path
  // only navigates on first create).
  useEffect(() => {
    if (createdUrl.current && createdUrl.current !== url) {
      void native.browserEmbedNavigate(instance, url).then(() => {
        createdUrl.current = url;
      }).catch(() => {});
    }
  }, [instance, url]);

  // Tear the native webview down when the pane unmounts (tab closed).
  useEffect(() => {
    return () => {
      void native.browserEmbedClose(instance).catch(() => {});
    };
  }, [instance]);

  return <div ref={boxRef} className="size-full" />;
}
