import { tool } from "ai";
import { z } from "zod";
import { unsafeBrowserUrl } from "../lib/browserGuard";
import type { ToolContext } from "./context";

// The agent browser is for external pages, so it mirrors TEDI's `unsafeBrowserUrl`
// policy: refuse non-http(s), cloud metadata, loopback, link-local and non-loopback
// IPv6. This duplicates the Rust guard so a bypass in one layer is caught by the
// other. Use `browser_open` for the agent browser; `open_preview` remains the
// loopback-only local dev server surface.
function guardUrl(url: string): string | null {
  return unsafeBrowserUrl(url);
}

function cssJson(value: string): string {
  // JSON.stringify doubles as a safe JS string literal for selectors / text.
  return JSON.stringify(value);
}

export function buildBrowserTools(ctx: ToolContext) {
  const guard = (url: string): { error: string } | null => {
    const reason = guardUrl(url);
    return reason === null ? null : { error: reason };
  };

  return {
    browser_open: tool({
      description:
        "Open a web URL in an in-app browser tab, next to the terminal, and switch to it. The page renders in a real embedded browser (runs JavaScript, so JS-heavy sites work). Use it to show the user a site or to render a page. To read a page's content, prefer the `fetch` tool. SSRF targets are refused.",
      inputSchema: z.object({
        instance: z
          .string()
          .describe("A short name for this browser, e.g. 'docs'. Currently informational."),
        url: z
          .url()
          .describe("Full http(s) URL. External sites allowed; SSRF targets are refused."),
      }),
      execute: async ({ instance, url }) => {
        const blocked = guard(url);
        if (blocked) return blocked;
        // Open as an embedded browser TAB (a native child webview docked in the
        // window) rather than a separate floating window: the floating
        // WebviewWindow build hangs on some Windows/WebView2 setups, and a docked
        // child shares the main window's environment and renders reliably.
        const ok = ctx.openPreview(url);
        return ok
          ? { ok: true, url, instance, note: "Opened in an in-app browser tab." }
          : { error: "could not open a browser tab (preview surface unavailable)", url };
      },
    }),

    browser_navigate: tool({
      description:
        "Navigate an open browser instance to a new URL. Refuses SSRF targets (metadata, loopback, link-local).",
      inputSchema: z.object({
        instance: z.string().describe("Instance name returned by browser_open."),
        url: z.url().describe("Full http(s) URL to visit."),
      }),
      execute: async ({ instance, url }) => {
        const blocked = guard(url);
        if (blocked) return blocked;
        return await ctx.browserNavigate(instance, url);
      },
    }),

    browser_back: tool({
      description: "Go back one page in the browser instance's history.",
      inputSchema: z.object({
        instance: z.string().describe("Instance name."),
      }),
      execute: async ({ instance }) => await ctx.browserBack(instance),
    }),

    browser_forward: tool({
      description: "Go forward one page in the browser instance's history.",
      inputSchema: z.object({
        instance: z.string().describe("Instance name."),
      }),
      execute: async ({ instance }) => await ctx.browserForward(instance),
    }),

    browser_reload: tool({
      description: "Reload the current page in the browser instance.",
      inputSchema: z.object({
        instance: z.string().describe("Instance name."),
      }),
      execute: async ({ instance }) => await ctx.browserReload(instance),
    }),

    browser_extract: tool({
      description:
        "Return the visible text of the current page in a browser instance - the fully rendered DOM, including content added by JavaScript. Call browser_wait first if the page may still be loading. If it returns the '(no readable text)' notice the page had not rendered yet: wait longer and call once more, and only then fall back to `fetch`.",
      inputSchema: z.object({
        instance: z.string().describe("Instance name."),
      }),
      execute: async ({ instance }) => await ctx.browserExtract(instance),
    }),

    browser_click: tool({
      description:
        "Click an element in the browser instance by CSS selector. The selector must match exactly one element.",
      inputSchema: z.object({
        instance: z.string().describe("Instance name."),
        selector: z.string().describe("CSS selector for the element to click."),
      }),
      execute: async ({ instance, selector }) => {
        const js = `(()=>{const el=document.querySelector(${cssJson(
          selector,
        )});if(!el){return;}el.click();})();`;
        return await ctx.browserEval(instance, js);
      },
    }),

    browser_type: tool({
      description:
        "Type text into an input in the browser instance by CSS selector, focusing it and firing input/change events.",
      inputSchema: z.object({
        instance: z.string().describe("Instance name."),
        selector: z.string().describe("CSS selector for the input element."),
        text: z.string().describe("Text to type."),
      }),
      execute: async ({ instance, selector, text }) => {
        const js = `(()=>{const el=document.querySelector(${cssJson(
          selector,
        )});if(!el){return;}el.focus();el.value=${cssJson(text)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})();`;
        return await ctx.browserEval(instance, js);
      },
    }),

    browser_wait: tool({
      description:
        "Wait a short time (ms) before the next action, so a page can settle after navigation or a click. Prefer small values (200-1000ms) and poll browser_extract when checking for content.",
      inputSchema: z.object({
        instance: z.string().describe("Instance name."),
        ms: z
          .number()
          .int()
          .min(50)
          .max(15000)
          .describe("Milliseconds to wait."),
      }),
      execute: async ({ ms }) => {
        await new Promise((r) => setTimeout(r, ms));
        return { waited: ms };
      },
    }),

    browser_screenshot: tool({
      description:
        "Capture a screenshot of the browser instance. Returns a data URL; on platforms without native webview capture it reports why it cannot.",
      inputSchema: z.object({
        instance: z.string().describe("Instance name."),
      }),
      execute: async ({ instance }) => await ctx.browserScreenshot(instance),
    }),

    browser_console: tool({
      description:
        "Return the console lines captured from the browser instance, useful for debugging a page the agent is driving.",
      inputSchema: z.object({
        instance: z.string().describe("Instance name."),
      }),
      execute: async ({ instance }) => await ctx.browserConsole(instance),
    }),

    browser_url: tool({
      description: "Return the current URL of the browser instance.",
      inputSchema: z.object({
        instance: z.string().describe("Instance name."),
      }),
      execute: async ({ instance }) => await ctx.browserUrl(instance),
    }),

    browser_close: tool({
      description: "Close a browser instance and free its webview window.",
      inputSchema: z.object({
        instance: z.string().describe("Instance name."),
      }),
      execute: async ({ instance }) => await ctx.browserClose(instance),
    }),

    browser_list: tool({
      description:
        "List open browser instances. Use this to learn the current '<env>' browsers before driving one.",
      inputSchema: z.object({}),
      execute: async () => {
        const instances = await ctx.browserList();
        return { instances };
      },
    }),
  } as const;
}
