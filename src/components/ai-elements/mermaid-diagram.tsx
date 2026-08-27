"use client";

import { useEffect, useId, useState } from "react";

import { Shimmer } from "./shimmer";
import { useIsStreaming } from "./chat-code";

/**
 * Lazily-loaded, cached mermaid module. Mermaid is heavy (pulls in dagre,
 * cytoscape, …), so keep it out of the initial bundle and load the chunk only
 * when a diagram actually renders.
 */
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => m.default);
  }
  return mermaidPromise;
}

function Notice({ children }: { children: string }) {
  return (
    <div className="not-prose my-2 flex items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
      <span className="inline-block size-1.5 animate-pulse rounded-full bg-muted-foreground/60" />
      <Shimmer duration={1.2}>{children}</Shimmer>
    </div>
  );
}

/**
 * Renders a fenced ```mermaid block as an SVG diagram. The diagram always uses
 * mermaid's LIGHT theme on a WHITE card, regardless of the app theme, so the
 * text is always legible (a dark diagram on a dark chat was unreadable). Click
 * the diagram to open it enlarged in a pop-up overlay.
 *
 * The source is untrusted (AI output), so mermaid runs with
 * `securityLevel: "strict"` and the SVG it returns is already sanitized, which
 * is what makes the `dangerouslySetInnerHTML` injection safe.
 */
export function MermaidDiagram({ code }: { code: string }) {
  const streaming = useIsStreaming();
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    if (streaming || !code.trim()) return;
    let cancelled = false;
    setFailed(false);

    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "default",
          fontFamily: "inherit",
        });
        const { svg: out } = await mermaid.render(id, code);
        if (!cancelled) setSvg(out);
      })
      .catch(() => {
        if (cancelled) return;
        setSvg(null);
        setFailed(true);
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
      });

    return () => {
      cancelled = true;
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    };
  }, [code, streaming, id]);

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomed(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  if (streaming) return <Notice>Generating diagram…</Notice>;

  if (failed) {
    return (
      <div className="not-prose my-2 overflow-hidden rounded-lg border border-border/50 bg-muted/30">
        <div className="border-b border-border/40 bg-muted/20 px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          mermaid
        </div>
        <pre className="m-0 overflow-x-auto px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-foreground">
          {code}
        </pre>
      </div>
    );
  }

  if (!svg) return <Notice>Rendering diagram…</Notice>;

  return (
    <>
      <button
        type="button"
        title="Click to enlarge"
        onClick={() => setZoomed(true)}
        className="not-prose my-2 flex w-full cursor-zoom-in justify-center overflow-x-auto rounded-lg border border-black/10 bg-white p-3 [&_svg]:h-auto [&_svg]:max-w-full"
        // Safe: SVG is produced by mermaid in strict mode (sanitized, no scripts).
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {zoomed ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setZoomed(false)}
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative max-h-[90vh] max-w-[92vw] overflow-auto rounded-xl bg-white p-6 shadow-2xl [&_svg]:h-auto [&_svg]:w-auto"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          <button
            type="button"
            onClick={() => setZoomed(false)}
            className="absolute right-4 top-4 rounded-md bg-white/90 px-2.5 py-1 text-[12px] font-medium text-black shadow hover:bg-white"
          >
            Close
          </button>
        </div>
      ) : null}
    </>
  );
}
