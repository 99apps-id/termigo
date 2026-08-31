// Mermaid helpers for the Telegram bot. The bot can't render Mermaid natively,
// so a ```mermaid block from the agent's reply is rasterised to a PNG and sent
// as a photo. This module keeps the pure extraction testable and the DOM-based
// rendering lazy (mermaid is heavy) so importing it never pulls it in.

type MermaidModule = {
  initialize: (cfg: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
};

let mermaidPromise: Promise<MermaidModule> | null = null;

function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => m.default);
  }
  return mermaidPromise;
}

/** Extract the code of every fenced ```mermaid block in a reply. */
export function extractMermaidBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```mermaid\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    const code = m[1].trim();
    if (code) out.push(code);
    m = re.exec(text);
  }
  return out;
}

/**
 * Render a mermaid code block to a PNG data URL, or null on failure. Runs in
 * the webview (has canvas); mermaid SVG is drawn to an offscreen canvas and
 * exported. Failure is caught so a bad diagram never breaks the bot.
 */
export async function renderMermaidToPng(code: string): Promise<string | null> {
  try {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      theme: "base",
      themeVariables: {
        background: "#ffffff",
        primaryColor: "#f7f7f7",
        primaryTextColor: "#111111",
        primaryBorderColor: "#c9c9c9",
        lineColor: "#666666",
      },
    });
    const id = `tg-mermaid-${Math.random().toString(36).slice(2, 10)}`;
    const { svg } = await mermaid.render(id, code);
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("svg load failed"));
      });
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}
