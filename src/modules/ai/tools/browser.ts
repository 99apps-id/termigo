import { tool } from "ai";
import { z } from "zod";
import { modelSupportsVision } from "../config";
import { unsafeBrowserUrl } from "../lib/browserGuard";
import { native } from "../lib/native";
import { useChatStore } from "../store/chatStore";
import type { ToolContext } from "./context";

// The read/act browser tools target the NATIVE embedded webview created by
// `browser_open` (label `browser-embed-<instance>`), driven through the
// `browser_embed_*` Rust commands. The older floating-window `ctx.browser*`
// bridge is left unused here: the floating WebviewWindow build hangs on some
// Windows/WebView2 setups, so everything the agent drives runs in the docked
// child instead. `instance` is the same short name passed to `browser_open`.
async function embedRead(instance: string) {
  try {
    return { text: await native.browserEmbedRead(instance) };
  } catch (e) {
    return { error: String(e) };
  }
}

async function embedEval(instance: string, js: string) {
  try {
    await native.browserEmbedEval(instance, js);
    return { ok: true as const };
  } catch (e) {
    return { error: String(e) };
  }
}

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

function resolveTargetSelector(
  ref?: string,
  selector?: string,
): { targetSelector: string } | { error: string } {
  if (ref && ref.trim()) {
    let clean = ref.trim();
    if (!clean.startsWith("@")) {
      clean = clean.startsWith("e") ? "@" + clean : "@e" + clean;
    } else if (
      clean.startsWith("@") &&
      !clean.startsWith("@e") &&
      /^\d+$/.test(clean.slice(1))
    ) {
      clean = "@e" + clean.slice(1);
    }
    if (!/^@e\d+$/.test(clean)) {
      return {
        error: `Invalid ref format "${ref}". Expected ref returned by browser_snapshot like "@e1", "@e2".`,
      };
    }
    return { targetSelector: `[data-termigo-ref="${clean}"]` };
  }
  if (selector && selector.trim()) {
    return { targetSelector: selector.trim() };
  }
  return { error: "Either selector or ref must be provided" };
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
          .describe(
            "A short name for this browser, e.g. 'docs'. Currently informational.",
          ),
        url: z
          .url()
          .describe(
            "Full http(s) URL. External sites allowed; SSRF targets are refused.",
          ),
      }),
      execute: async ({ instance, url }) => {
        const blocked = guard(url);
        if (blocked) return blocked;
        // Open as an embedded browser TAB (a native child webview docked in the
        // window) rather than a separate floating window: the floating
        // WebviewWindow build hangs on some Windows/WebView2 setups, and a docked
        // child shares the main window's environment and renders reliably.
        const ok = ctx.openPreview(url, instance);
        return ok
          ? {
              ok: true,
              url,
              instance,
              note: "Opened in an in-app browser tab. Use this same `instance` for browser_extract / browser_navigate / browser_click.",
            }
          : {
              error:
                "could not open a browser tab (preview surface unavailable)",
              url,
            };
      },
    }),

    browser_navigate: tool({
      description:
        "Navigate an open browser instance to a new URL. Refuses SSRF targets (metadata, loopback, link-local).",
      inputSchema: z.object({
        instance: z
          .string()
          .describe("Instance name returned by browser_open."),
        url: z.url().describe("Full http(s) URL to visit."),
      }),
      execute: async ({ instance, url }) => {
        const blocked = guard(url);
        if (blocked) return blocked;
        try {
          await native.browserEmbedNavigate(instance, url);
          return { ok: true as const, url };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    browser_back: tool({
      description: "Go back one page in the browser instance's history.",
      inputSchema: z.object({
        instance: z.string().describe("Instance name."),
      }),
      execute: async ({ instance }) =>
        await embedEval(instance, "history.back();"),
    }),

    browser_forward: tool({
      description: "Go forward one page in the browser instance's history.",
      inputSchema: z.object({
        instance: z.string().describe("Instance name."),
      }),
      execute: async ({ instance }) =>
        await embedEval(instance, "history.forward();"),
    }),

    browser_reload: tool({
      description: "Reload the current page in the browser instance.",
      inputSchema: z.object({
        instance: z.string().describe("Instance name."),
      }),
      execute: async ({ instance }) =>
        await embedEval(instance, "location.reload();"),
    }),

    browser_extract: tool({
      description:
        "Return the visible text of the current page in a browser instance - the fully rendered DOM, including content added by JavaScript. Call browser_wait first if the page may still be loading. If it returns the '(no readable text)' notice the page had not rendered yet: wait longer and call once more, and only then fall back to `fetch`.",
      inputSchema: z.object({
        instance: z.string().describe("Instance name."),
      }),
      execute: async ({ instance }) => await embedRead(instance),
    }),

    browser_snapshot: tool({
      description:
        "Capture an accessibility snapshot of the current page with short ref IDs (@e1, @e2, ...) assigned to all interactive elements (buttons, links, inputs). Returns a clean, token-efficient text representation of the UI tree. Pass the assigned ref ID directly to browser_click or browser_type instead of complex CSS selectors. Auto-executes.",
      inputSchema: z.object({
        instance: z.string().describe("Instance name."),
      }),
      execute: async ({ instance }) => {
        const js = `(()=>{
          try {
            var origExtract = window.__termigoExtract;
            window.__termigoExtract = function() {
              try {
                var counter = 1;
                var items = [];
                var interactive = document.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [role="link"], [role="tab"], [tabindex="0"]');
                interactive.forEach(function(el) {
                  if (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0) return;
                  var ref = '@e' + (counter++);
                  el.setAttribute('data-termigo-ref', ref);
                  var tag = el.tagName.toLowerCase();
                  var role = el.getAttribute('role') || tag;
                  var text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || (el.value !== undefined ? String(el.value) : '') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
                  var href = el.getAttribute('href');
                  var info = '[' + role + '] ' + (text ? '"' + text + '" ' : '') + 'ref=' + ref;
                  if (href && href !== '#' && !href.startsWith('javascript:')) {
                    info += ' href=' + href.slice(0, 60);
                  }
                  items.push(info);
                });
                var title = document.title || 'Untitled';
                var headingEls = Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 10).map(function(h) { return h.tagName.toLowerCase() + ': "' + h.innerText.replace(/\\s+/g, ' ').trim() + '"'; });
                var out = 'Title: ' + title + '\\nURL: ' + location.href + '\\nHeadings:\\n' + headingEls.map(function(h) { return '  ' + h; }).join('\\n') + '\\n\\nInteractive Elements (' + items.length + '):\\n' + items.slice(0, 80).map(function(i) { return '  ' + i; }).join('\\n');
                if (window.__TAURI__ && window.__TAURI__.event) {
                  window.__TAURI__.event.emit('termigo:browser-value', { instance: ${JSON.stringify(instance)}, kind: 'extract', value: out });
                }
              } catch(err) {
                if (origExtract) origExtract();
              } finally {
                window.__termigoExtract = origExtract;
              }
            };
          } catch(e) {}
        })();`;
        try {
          await native.browserEmbedEval(instance, js).catch(() => {});
          const snapshot = await native.browserEmbedRead(instance);
          return { snapshot };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    browser_click: tool({
      description:
        "Click an element in the browser instance by ref ID (e.g. '@e1' returned by browser_snapshot) or CSS selector.",
      inputSchema: z.object({
        instance: z.string().describe("Instance name."),
        selector: z
          .string()
          .optional()
          .describe("CSS selector for the element. Omit if using `ref`."),
        ref: z
          .string()
          .optional()
          .describe("Element reference ID from browser_snapshot, e.g. '@e1'."),
      }),
      execute: async ({ instance, selector, ref }) => {
        const target = resolveTargetSelector(ref, selector);
        if ("error" in target) return target;
        const targetSelector = target.targetSelector;
        const js = `(()=>{const el=document.querySelector(${cssJson(
          targetSelector,
        )});if(!el){throw new Error('No element matched selector: '+${cssJson(
          targetSelector,
        )});}el.click();})();`;
        return await embedEval(instance, js);
      },
    }),

    browser_type: tool({
      description:
        "Type text into an input in the browser instance by ref ID (e.g. '@e3') or CSS selector.",
      inputSchema: z.object({
        instance: z.string().describe("Instance name."),
        selector: z
          .string()
          .optional()
          .describe("CSS selector for the input. Omit if using `ref`."),
        ref: z
          .string()
          .optional()
          .describe("Element reference ID from browser_snapshot, e.g. '@e3'."),
        text: z.string().describe("Text to type."),
      }),
      execute: async ({ instance, selector, ref, text }) => {
        const target = resolveTargetSelector(ref, selector);
        if ("error" in target) return target;
        const targetSelector = target.targetSelector;
        const js = `(()=>{const el=document.querySelector(${cssJson(
          targetSelector,
        )});if(!el){throw new Error('No element matched selector: '+${cssJson(
          targetSelector,
        )});}if('value' in el){el.focus();el.value=${cssJson(text)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}else if(el.isContentEditable){el.focus();el.innerText=${cssJson(text)};el.dispatchEvent(new Event('input',{bubbles:true}));}else{throw new Error('Selector does not match an input-like element: '+${cssJson(targetSelector)});}})();`;
        return await embedEval(instance, js);
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

    browser_connect: tool({
      description:
        "Connect to a running Chrome, Edge, or Brave browser via Chrome DevTools Protocol (CDP) on localhost (e.g. port 9222 or custom). Inspects existing user tabs, cookies, or opens/focuses tabs in the user's actual browser session without starting a new headless browser. Auto-executes.",
      inputSchema: z.object({
        port: z
          .number()
          .int()
          .min(1024)
          .max(65535)
          .optional()
          .describe("CDP remote debugging port (default 9222)."),
        action: z
          .enum(["version", "list_tabs", "new_tab", "activate_tab", "close_tab"])
          .optional()
          .describe("Action to perform with CDP (default 'list_tabs')."),
        url: z
          .string()
          .optional()
          .describe("URL to open when action is 'new_tab'."),
        target_id: z
          .string()
          .optional()
          .describe("Tab/target ID for activate_tab or close_tab."),
      }),
      execute: async ({ port = 9222, action = "list_tabs", url, target_id }) => {
        const base = `http://127.0.0.1:${port}`;
        try {
          if (action === "version") {
            const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(3000) });
            if (!res.ok) return { error: `CDP error HTTP ${res.status}` };
            return await res.json();
          }
          if (action === "list_tabs") {
            const res = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(3000) });
            if (!res.ok) return { error: `CDP error HTTP ${res.status}` };
            const list = await res.json();
            if (!Array.isArray(list)) {
              return { error: `Port ${port} is not a valid Chrome DevTools Protocol endpoint.` };
            }
            return {
              count: list.length,
              tabs: list.filter((t) => t && t.type === "page").map((t) => ({
                id: t.id,
                title: t.title,
                url: t.url,
              })),
            };
          }
          if (action === "new_tab") {
            if (url) {
              const blocked = guard(url);
              if (blocked) return blocked;
            }
            const endpoint = url ? `${base}/json/new?${encodeURIComponent(url)}` : `${base}/json/new`;
            const res = await fetch(endpoint, { method: "PUT", signal: AbortSignal.timeout(3000) });
            if (!res.ok) return { error: `CDP error HTTP ${res.status}` };
            return await res.json();
          }
          if (action === "activate_tab") {
            if (!target_id || !target_id.trim()) {
              return { error: "action 'activate_tab' requires 'target_id'" };
            }
            const res = await fetch(`${base}/json/activate/${encodeURIComponent(target_id.trim())}`, { signal: AbortSignal.timeout(3000) });
            return { ok: res.ok, activated: target_id };
          }
          if (action === "close_tab") {
            if (!target_id || !target_id.trim()) {
              return { error: "action 'close_tab' requires 'target_id'" };
            }
            const res = await fetch(`${base}/json/close/${encodeURIComponent(target_id.trim())}`, { signal: AbortSignal.timeout(3000) });
            return { ok: res.ok, closed: target_id };
          }
          return { error: `Unsupported CDP action: ${action}` };
        } catch (e) {
          return {
            connected: false,
            error: `Could not connect to browser on port ${port}: ${String(e)}. Ensure your browser was launched with --remote-debugging-port=${port}`,
          };
        }
      },
    }),

    browser_screenshot: tool({
      description:
        "Capture a screenshot of the browser instance and SEE it - use this to inspect a page's visual layout, verify a UI change, or read something that is drawn rather than text (a chart, a canvas). Requires a vision-capable model and is Windows-only (WebView2). For plain page text, browser_extract is cheaper.",
      inputSchema: z.object({
        instance: z.string().describe("Instance name."),
      }),
      execute: async ({ instance }) => {
        const modelId = useChatStore.getState().selectedModelId;
        if (!modelSupportsVision(modelId)) {
          return {
            error:
              "the selected model has no vision capability, so it cannot see a screenshot - switch to a vision-capable model, or use browser_extract for the page text.",
          };
        }
        try {
          const data = await native.browserEmbedScreenshot(instance);
          return {
            kind: "screenshot" as const,
            instance,
            mediaType: "image/png",
            data,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
      // Feed the captured PNG to the model as a real visual part.
      toModelOutput: ({ output }) => {
        const o = output as {
          kind?: string;
          data?: string;
          mediaType?: string;
        };
        if (o && o.kind === "screenshot" && typeof o.data === "string") {
          return {
            type: "content",
            value: [
              { type: "text", text: "Screenshot of the browser page:" },
              {
                type: "image-data",
                data: o.data,
                mediaType: o.mediaType ?? "image/png",
              },
            ],
          };
        }
        return { type: "json", value: output as never };
      },
    }),

    browser_close: tool({
      description: "Close a browser instance and free its embedded webview.",
      inputSchema: z.object({
        instance: z.string().describe("Instance name."),
      }),
      execute: async ({ instance }) => {
        try {
          await native.browserEmbedClose(instance);
          return { ok: true as const };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  } as const;
}
