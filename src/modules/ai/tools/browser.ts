import { tool } from "ai";
import { z } from "zod";
import { modelSupportsVision } from "../config";
import { unsafeBrowserUrl } from "../lib/browserGuard";
import { native } from "../lib/native";
import { remoteUnsupported } from "../lib/remoteFs";
import { useChatStore } from "../store/chatStore";
import { resolvePath, type ToolContext } from "./context";
import { isLoopbackTarget } from "./fetch";

// The read/act browser tools target the NATIVE embedded webview created by
// `browser_open` (label `browser-embed-<instance>`), driven through the
// `browser_embed_*` Rust commands. The older floating-window `ctx.browser*`
// bridge is left unused here: the floating WebviewWindow build hangs on some
// Windows/WebView2 setups, so everything the agent drives runs in the docked
// child instead. `instance` is the same short name passed to `browser_open`.
// Tracks consecutive unreadable extracts per instance to prevent infinite wait and extract loops.
const emptyExtractCounts = new Map<string, number>();
// Tracks consecutive screenshot calls per instance to prevent infinite screenshot loops.
const consecutiveScreenshotCounts = new Map<string, number>();

async function embedRead(instance: string) {
  try {
    const text = await native.browserEmbedRead(instance);
    const isUnreadable =
      !text ||
      text.trim().length === 0 ||
      text.startsWith("(no readable text");

    if (isUnreadable) {
      const count = (emptyExtractCounts.get(instance) ?? 0) + 1;
      emptyExtractCounts.set(instance, count);
      if (count >= 2) {
        return {
          text: "",
          error:
            "No readable text could be extracted from this page after multiple attempts. The page may block injected scripts, be offline, or render without DOM text. Do not retry browser_extract or browser_wait again on this page. Fall back to fetch if available, or continue the task using local workspace files and inform the user.",
        };
      }
      return {
        text: "(no readable text returned from the page. It may block scripts, be offline, or render without DOM text. Do not retry browser_extract in a loop.)",
        // Structured marker so the agent loop detects the failure by field, not
        // by matching this human-readable string.
        noReadableText: true as const,
      };
    }

    emptyExtractCounts.delete(instance);
    return { text };
  } catch (e) {
    const errStr = String(e);
    const isOffline =
      /getaddrinfo|econnrefused|enetunreach|offline|dns|unreachable/i.test(
        errStr,
      );
    return {
      error: errStr,
      ...(isOffline
        ? {
            isOffline: true,
            hint: "The network appears to be offline or the browser host is unreachable. Do not retry external browser requests; continue using local files.",
          }
        : {}),
    };
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

// `browser_open` renders in the embedded preview pane (same surface as
// `open_preview`), so it shares the same URL policy: safe external hosts are
// allowed, and loopback dev servers are allowed too. The Rust `browser_open`
// command is registered but the TypeScript tool path uses `ctx.openPreview`.
function isLoopbackHost(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(host)
      ? host.split(".").map(Number)
      : null;
    return (
      host === "localhost" ||
      host === "[::1]" ||
      host === "::1" ||
      host.endsWith(".localhost") ||
      (ipv4 !== null && ipv4[0] === 127)
    );
  } catch {
    return false;
  }
}

function guardUrl(url: string): string | null {
  const bad = unsafeBrowserUrl(url);
  if (bad === null) return null;
  if (isLoopbackHost(url)) return null;
  return bad;
}

function cssJson(value: string): string {
  // JSON.stringify doubles as a safe JS string literal for selectors / text.
  return JSON.stringify(value);
}

function resolveTargetSelector(
  ref?: string,
  selector?: string,
): { targetSelector: string } | { error: string } {
  if (ref?.trim()) {
    let clean = ref.trim();
    if (!clean.startsWith("@")) {
      clean = clean.startsWith("e") ? `@${clean}` : `@e${clean}`;
    } else if (
      clean.startsWith("@") &&
      !clean.startsWith("@e") &&
      /^\d+$/.test(clean.slice(1))
    ) {
      clean = `@e${clean.slice(1)}`;
    }
    if (!/^@e\d+$/.test(clean)) {
      return {
        error: `Invalid ref format "${ref}". Expected ref returned by browser_snapshot like "@e1", "@e2".`,
      };
    }
    return { targetSelector: `[data-termigo-ref="${clean}"]` };
  }
  if (selector?.trim()) {
    return { targetSelector: selector.trim() };
  }
  return { error: "Either selector or ref must be provided" };
}

/** Click JS for a resolved selector. Pure, so the injected string is testable. */
export function buildClickJs(targetSelector: string): string {
  return `(()=>{const el=document.querySelector(${cssJson(
    targetSelector,
  )});if(!el){throw new Error('No element matched selector: '+${cssJson(
    targetSelector,
  )});}el.click();})();`;
}

/**
 * Type JS for a resolved selector.
 *
 * A React controlled input tracks its value separately from the DOM node, so
 * assigning `el.value` directly is seen as an untracked mutation and `onChange`
 * never fires. Setting the value through the element's own prototype setter
 * updates the value React is watching, which is the documented way to drive a
 * controlled component from injected script. Contenteditable targets fall back
 * to text plus an input event.
 */
export function buildTypeJs(targetSelector: string, text: string): string {
  return `(()=>{const el=document.querySelector(${cssJson(
    targetSelector,
  )});if(!el){throw new Error('No element matched selector: '+${cssJson(
    targetSelector,
  )});}el.focus();if('value' in el&&typeof el.value==='string'){const proto=Object.getPrototypeOf(el);const desc=proto?Object.getOwnPropertyDescriptor(proto,'value'):null;if(desc&&desc.set){desc.set.call(el,${cssJson(
    text,
  )});}else{el.value=${cssJson(
    text,
  )};}el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}else if(el.isContentEditable){el.innerText=${cssJson(
    text,
  )};el.dispatchEvent(new Event('input',{bubbles:true}));}else{throw new Error('Selector does not match an input-like element: '+${cssJson(
    targetSelector,
  )});}})();`;
}

/** Keys the agent may send to the page. Small on purpose: login and form
 *  flows need Enter/Tab/Escape plus arrows, anything else is out of scope. */
export const PRESS_KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  " ",
] as const;

export type PressKey = (typeof PRESS_KEYS)[number];

/**
 * Key-press JS for an optional resolved selector. Pure, so the injected
 * string is testable.
 *
 * Synthetic key events do not trigger a form's implicit submission (that
 * needs a trusted keypress), so a login that ignores Enter still needs its
 * submit button clicked via browser_click. React key handlers DO observe
 * these events, since React listens at the root for bubbled keydown.
 */
export function buildPressJs(
  targetSelector: string | null,
  key: PressKey,
): string {
  const target =
    targetSelector === null
      ? "document.activeElement||document.body"
      : `document.querySelector(${cssJson(targetSelector)})`;
  return `(()=>{const el=${target};if(!el){throw new Error('No element matched selector: '+${cssJson(
    targetSelector ?? "(focused element)",
  )});}if(el.focus){el.focus();}const init={key:${cssJson(
    key,
  )},bubbles:true,cancelable:true,composed:true};el.dispatchEvent(new KeyboardEvent('keydown',init));el.dispatchEvent(new KeyboardEvent('keypress',init));el.dispatchEvent(new KeyboardEvent('keyup',init));})();`;
}

/** Select-dropdown JS for a resolved selector. Pure, testable. */
export function buildSelectJs(
  targetSelector: string,
  wanted: string,
): string {
  return `(()=>{const el=document.querySelector(${cssJson(
    targetSelector,
  )});if(!el){throw new Error('No element matched selector: '+${cssJson(
    targetSelector,
  )});}if(!(el instanceof HTMLSelectElement)){throw new Error('Selector does not match a <select> dropdown: '+${cssJson(
    targetSelector,
  )});}const opts=Array.from(el.options);let idx=opts.findIndex(o=>o.value===${cssJson(
    wanted,
  )});if(idx<0){idx=opts.findIndex(o=>(o.text||'').trim()===${cssJson(
    wanted,
  )});}if(idx<0){throw new Error('No option with value or label '+${cssJson(
    wanted,
  )});}el.selectedIndex=idx;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})();`;
}

/** Scroll JS: an element into view, an absolute Y, or top/bottom. Pure. */
export function buildScrollJs(
  targetSelector: string | null,
  to: "top" | "bottom" | null,
  y: number | null,
): string {
  if (targetSelector !== null) {
    return `(()=>{const el=document.querySelector(${cssJson(
      targetSelector,
    )});if(!el){throw new Error('No element matched selector: '+${cssJson(
      targetSelector,
    )});}el.scrollIntoView({block:'center'});})();`;
  }
  if (y !== null) {
    return `(()=>{window.scrollTo(0,${Math.trunc(y)});})();`;
  }
  const top = to !== "bottom";
  return `(()=>{window.scrollTo(0,${top ? "0" : "document.body.scrollHeight"});})();`;
}

/** Hover JS for a resolved selector. Pure, testable. */
export function buildHoverJs(targetSelector: string): string {
  return `(()=>{const el=document.querySelector(${cssJson(
    targetSelector,
  )});if(!el){throw new Error('No element matched selector: '+${cssJson(
    targetSelector,
  )});}const r=el.getBoundingClientRect();const init={bubbles:true,cancelable:true,composed:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2};el.dispatchEvent(new PointerEvent('pointerover',init));el.dispatchEvent(new MouseEvent('mouseover',init));el.dispatchEvent(new MouseEvent('mouseenter',init));el.dispatchEvent(new MouseEvent('mousemove',init));if(el.focus){el.focus();}})();`;
}

/**
 * Read an arbitrary page-computed value through the extract event channel.
 *
 * `browserEmbedEval` reports only ok/error, so producers temporarily replace
 * `window.__termigoExtract` with a function emitting `computeJs`, then a read
 * triggers it. The override is deleted afterwards so later extracts return to
 * page text. Same pattern as `browser_snapshot`, with the restore included.
 */
async function embedReadValue(
  instance: string,
  computeJs: string,
): Promise<string> {
  const producer = `(()=>{try{window.__termigoExtract=function(){var out;try{out=(${computeJs});}catch(e){out={error:String((e&&e.message)||e)};}var s=(typeof out==='string')?out:JSON.stringify(out);try{if(window.__TAURI__&&window.__TAURI__.event){window.__TAURI__.event.emit('termigo:browser-value',{instance:${JSON.stringify(instance)},kind:'extract',value:String(s).slice(0,200000)});}}catch(e){}};}catch(e){}})();`;
  await native.browserEmbedEval(instance, producer).catch(() => {});
  try {
    return await native.browserEmbedRead(instance);
  } finally {
    await native
      .browserEmbedEval(
        instance,
        "(()=>{try{delete window.__termigoExtract;}catch(e){}})();",
      )
      .catch(() => {});
  }
}

/** Largest page-context download the agent may pull into the workspace. */
export const MAX_DOWNLOAD_BYTES = 8_000_000;
/** Value-channel payloads are sliced at 200k chars; chunks stay under it. */
export const DOWNLOAD_CHUNK_CHARS = 150_000;
/** Largest local file the agent may attach to a page file input. */
export const MAX_UPLOAD_BYTES = 12_000_000;

/** Page-context download starter: fetch with page cookies into a data URL. */
export function buildDownloadStartJs(url: string): string {
  return `(()=>{try{window.__termigoDl={done:false};fetch(${cssJson(
    url,
  )}).then(r=>{if(!r.ok){throw new Error('HTTP '+r.status);}return r.blob();}).then(b=>{if(b.size>${MAX_DOWNLOAD_BYTES}){window.__termigoDl={done:true,error:'file too large ('+b.size+' bytes, max ${MAX_DOWNLOAD_BYTES}'};return;}var fr=new FileReader();fr.onload=()=>{window.__termigoDl={done:true,dataUrl:String(fr.result)};};fr.onerror=()=>{window.__termigoDl={done:true,error:'read failed'};};fr.readAsDataURL(b);}).catch(e=>{window.__termigoDl={done:true,error:String((e&&e.message)||e)};});}catch(e){window.__termigoDl={done:true,error:String(e)}}})();`;
}

/** Poll probe: ok once the page-context download finished (or failed). */
export const DOWNLOAD_READY_JS =
  "(()=>{const s=window.__termigoDl;if(!s||!s.done){throw new Error('download pending');}})();";

/** Chunk reader for the finished page-context download (0-based index). */
export function buildDownloadChunkJs(index: number): string {
  return `(()=>{var s=window.__termigoDl;var d=(s&&s.dataUrl)||'';var n=${DOWNLOAD_CHUNK_CHARS};var a=d.slice(${index}*n,(${index}+1)*n);var last=((${index}+1)*n>=d.length);if(last){try{delete window.__termigoDl;}catch(e){}}return {chunk:a,last:last,total:d.length,error:(s&&s.error)||null};})()`;
}

/** File-upload JS: attach local bytes to a file input. Pure, testable. */
export function buildUploadJs(
  targetSelector: string,
  fileName: string,
  mediaType: string,
  base64: string,
): string {
  return `(()=>{const el=document.querySelector(${cssJson(
    targetSelector,
  )});if(!el){throw new Error('No element matched selector: '+${cssJson(
    targetSelector,
  )});}if(!(el instanceof HTMLInputElement)||el.type!=='file'){throw new Error('Selector does not match a file input: '+${cssJson(
    targetSelector,
  )});}const bin=atob(${cssJson(
    base64,
  )});const bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++){bytes[i]=bin.charCodeAt(i);}const f=new File([bytes],${cssJson(
    fileName,
  )},{type:${cssJson(
    mediaType || "application/octet-stream",
  )}});const dt=new DataTransfer();dt.items.add(f);el.files=dt.files;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})();`;
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
          .optional()
          .default("default")
          .describe(
            "A short name for this browser, e.g. 'docs'. Defaults to 'default'.",
          ),
        url: z
          .url()
          .describe(
            "Full http(s) URL. External sites allowed; SSRF targets are refused.",
          ),
      }),
      execute: async ({ instance = "default", url }) => {
        const blocked = guard(url);
        if (blocked) return blocked;
        // Open as an embedded browser TAB (a native child webview docked in the
        // window) rather than a separate floating window: the floating
        // WebviewWindow build hangs on some Windows/WebView2 setups, and a docked
        // child shares the main window's environment and renders reliably.
        const ok = ctx.openPreview(url, instance);
        if (ok) {
          consecutiveScreenshotCounts.delete(instance);
        }
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
          .optional()
          .default("default")
          .describe("Instance name returned by browser_open (default 'default')."),
        url: z.url().describe("Full http(s) URL to visit."),
      }),
      execute: async ({ instance = "default", url }) => {
        const blocked = guard(url);
        if (blocked) return blocked;
        try {
          await native.browserEmbedNavigate(instance, url);
          emptyExtractCounts.delete(instance);
          consecutiveScreenshotCounts.delete(instance);
          return { ok: true as const, url };
        } catch (e) {
          const errStr = String(e);
          const isOffline =
            /getaddrinfo|econnrefused|enetunreach|offline|dns|unreachable/i.test(
              errStr,
            );
          return {
            error: errStr,
            url,
            ...(isOffline
              ? {
                  isOffline: true,
                  hint: "Browser navigation failed because the network is offline or the host is unreachable. Stop attempting browser navigation and continue working with local workspace resources.",
                }
              : {}),
          };
        }
      },
    }),

    browser_back: tool({
      description: "Go back one page in the browser instance's history.",
      inputSchema: z.object({
        instance: z.string().optional().default("default").describe("Instance name."),
      }),
      execute: async ({ instance = "default" }) =>
        await embedEval(instance, "history.back();"),
    }),

    browser_forward: tool({
      description: "Go forward one page in the browser instance's history.",
      inputSchema: z.object({
        instance: z.string().optional().default("default").describe("Instance name."),
      }),
      execute: async ({ instance = "default" }) =>
        await embedEval(instance, "history.forward();"),
    }),

    browser_reload: tool({
      description: "Reload the current page in the browser instance.",
      inputSchema: z.object({
        instance: z.string().optional().default("default").describe("Instance name."),
      }),
      execute: async ({ instance = "default" }) =>
        await embedEval(instance, "location.reload();"),
    }),

    browser_extract: tool({
      description:
        "Return the visible text of the current page in a browser instance - the fully rendered DOM, including content added by JavaScript. If it returns no readable text, do not loop on browser_wait; fall back to other tools or continue with local files.",
      inputSchema: z.object({
        instance: z.string().optional().default("default").describe("Instance name."),
      }),
      execute: async ({ instance = "default" }) => await embedRead(instance),
    }),

    browser_console: tool({
      description:
        "Return the captured console logs and JavaScript errors for a browser instance. Use this to diagnose hydration errors, script exceptions, or warnings when a page fails to load or render properly. Auto-executes.",
      inputSchema: z.object({
        instance: z.string().optional().default("default").describe("Instance name."),
      }),
      execute: async ({ instance = "default" }) => {
        try {
          const res = await ctx.browserConsole(instance);
          if (res && typeof res === "object" && "error" in res && res.error) {
            return { error: String(res.error) };
          }
          const logs =
            res && typeof res === "object" && "console" in res
              ? String(res.console)
              : String(res);
          return {
            console: logs || "(no console output captured for this page)",
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    browser_storage: tool({
      description:
        "List or clear cookies, localStorage, or sessionStorage of the page in a browser instance. Use it to inspect a login session (which cookies exist), to log out by clearing, or to reset page state for a fresh test. Only script-accessible cookies are listed; HttpOnly cookies are invisible to this tool by browser design. Clearing asks for approval.",
      inputSchema: z.object({
        instance: z.string().optional().default("default").describe("Instance name."),
        target: z
          .enum(["cookies", "localStorage", "sessionStorage"])
          .describe("Which storage to inspect."),
        action: z.enum(["list", "clear"]).describe("Read or wipe the storage."),
      }),
      execute: async ({ instance = "default", target, action }) => {
        if (action === "clear") {
          const js =
            target === "cookies"
              ? "(()=>{document.cookie.split(';').forEach(c=>{const n=c.split('=')[0].trim();if(!n){return;}['/'].concat([location.pathname]).forEach(p=>{document.cookie=n+'=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path='+p;});});})();"
              : `(()=>{try{${target === "localStorage" ? "localStorage" : "sessionStorage"}.clear();}catch(e){throw new Error(String((e&&e.message)||e));}})();`;
          return await embedEval(instance, js);
        }
        const compute =
          target === "cookies"
            ? "({cookies: document.cookie})"
            : `(()=>{var o={};try{var s=${target === "localStorage" ? "localStorage" : "sessionStorage"};for(var i=0;i<s.length&&i<100;i++){var k=s.key(i);if(k===null){continue;}var v=s.getItem(k);o[String(k).slice(0,120)]=v===null?'':String(v).slice(0,500);}}catch(e){return {error:String((e&&e.message)||e)};}return o;})()`;
        try {
          const raw = await embedReadValue(instance, compute);
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            return { value: raw };
          }
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    browser_network: tool({
      description:
        "List the page's recent network requests (URL, type, duration, bytes) from the browser resource timing buffer, newest last, capped at 200 entries. Use it to confirm a form submission reached its API, to find XHR endpoints, or to see what a page loads. Response bodies are not included; use browser_console or fetch for content. Auto-executes.",
      inputSchema: z.object({
        instance: z.string().optional().default("default").describe("Instance name."),
      }),
      execute: async ({ instance = "default" }) => {
        const compute = `(()=>{var out=[];try{var es=performance.getEntriesByType('resource');for(var i=Math.max(0,es.length-200);i<es.length;i++){var e=es[i];out.push({url:String(e.name).slice(0,200),type:e.initiatorType,ms:Math.round(e.duration),bytes:(typeof e.transferSize==='number'?e.transferSize:null)});}return {requests:out,count:es.length};}catch(e){return {error:String((e&&e.message)||e)};}})()`;
        try {
          const raw = await embedReadValue(instance, compute);
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            return { value: raw };
          }
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    browser_snapshot: tool({
      description:
        "Capture an accessibility snapshot of the current page with short ref IDs (@e1, @e2, ...) assigned to all interactive elements (buttons, links, inputs). Returns a clean, token-efficient text representation of the UI tree. Pass the assigned ref ID directly to browser_click or browser_type instead of complex CSS selectors. Auto-executes.",
      inputSchema: z.object({
        instance: z.string().optional().default("default").describe("Instance name."),
      }),
      execute: async ({ instance = "default" }) => {
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
        instance: z.string().optional().default("default").describe("Instance name."),
        selector: z
          .string()
          .optional()
          .describe("CSS selector for the element. Omit if using `ref`."),
        ref: z
          .string()
          .optional()
          .describe("Element reference ID from browser_snapshot, e.g. '@e1'."),
      }),
      execute: async ({ instance = "default", selector, ref }) => {
        const target = resolveTargetSelector(ref, selector);
        if ("error" in target) return target;
        const targetSelector = target.targetSelector;
        const js = buildClickJs(targetSelector);
        consecutiveScreenshotCounts.delete(instance);
        return await embedEval(instance, js);
      },
    }),

    browser_type: tool({
      description:
        "Type text into an input in the browser instance by ref ID (e.g. '@e3') or CSS selector.",
      inputSchema: z.object({
        instance: z.string().optional().default("default").describe("Instance name."),
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
      execute: async ({ instance = "default", selector, ref, text }) => {
        const target = resolveTargetSelector(ref, selector);
        if ("error" in target) return target;
        const targetSelector = target.targetSelector;
        const js = buildTypeJs(targetSelector, text);
        consecutiveScreenshotCounts.delete(instance);
        return await embedEval(instance, js);
      },
    }),

    browser_press: tool({
      description:
        "Press a keyboard key in the browser instance, optionally focused on an element by ref ID (e.g. '@e3') or CSS selector. Use Enter to submit a login or search form after browser_type, Tab to move between fields, Escape to dismiss a dialog. If Enter does not submit the form, snapshot the page and click its submit button instead.",
      inputSchema: z.object({
        instance: z.string().optional().default("default").describe("Instance name."),
        key: z
          .enum(PRESS_KEYS)
          .describe("Key to press: Enter, Tab, Escape, arrows, or space."),
        selector: z
          .string()
          .optional()
          .describe(
            "CSS selector of the element to focus first. Omit to press on the currently focused element.",
          ),
        ref: z
          .string()
          .optional()
          .describe("Element reference ID from browser_snapshot, e.g. '@e3'."),
      }),
      execute: async ({ instance = "default", key, selector, ref }) => {
        let targetSelector: string | null = null;
        if (ref?.trim() || selector?.trim()) {
          const target = resolveTargetSelector(ref, selector);
          if ("error" in target) return target;
          targetSelector = target.targetSelector;
        }
        const js = buildPressJs(targetSelector, key);
        consecutiveScreenshotCounts.delete(instance);
        return await embedEval(instance, js);
      },
    }),

    browser_select: tool({
      description:
        "Pick an option in a native <select> dropdown by ref ID (e.g. '@e4') or CSS selector, matching the option value first then its visible label. browser_type does not work on dropdowns, so this is the tool for them. Auto-executes.",
      inputSchema: z.object({
        instance: z.string().optional().default("default").describe("Instance name."),
        selector: z
          .string()
          .optional()
          .describe("CSS selector for the <select>. Omit if using `ref`."),
        ref: z
          .string()
          .optional()
          .describe("Element reference ID from browser_snapshot, e.g. '@e4'."),
        option: z
          .string()
          .describe("Option value or visible label to pick."),
      }),
      execute: async ({ instance = "default", selector, ref, option }) => {
        const target = resolveTargetSelector(ref, selector);
        if ("error" in target) return target;
        const js = buildSelectJs(target.targetSelector, option);
        consecutiveScreenshotCounts.delete(instance);
        return await embedEval(instance, js);
      },
    }),

    browser_scroll: tool({
      description:
        "Scroll the page to an element (by ref ID or selector), an absolute Y offset, or top/bottom. Use it before a screenshot to inspect content below the fold, or to bring a lazy-loaded section into view. Auto-executes.",
      inputSchema: z.object({
        instance: z.string().optional().default("default").describe("Instance name."),
        selector: z.string().optional().describe("CSS selector to scroll to."),
        ref: z
          .string()
          .optional()
          .describe("Element reference ID from browser_snapshot, e.g. '@e5'."),
        to: z
          .enum(["top", "bottom"])
          .optional()
          .describe("Scroll to the page top or bottom."),
        y: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Absolute vertical offset in CSS pixels."),
      }),
      execute: async ({ instance = "default", selector, ref, to, y }) => {
        let targetSelector: string | null = null;
        if (ref?.trim() || selector?.trim()) {
          const target = resolveTargetSelector(ref, selector);
          if ("error" in target) return target;
          targetSelector = target.targetSelector;
        } else if (y === undefined && to === undefined) {
          return {
            error: "give an element (ref/selector), an absolute `y`, or `to`.",
          };
        }
        const js = buildScrollJs(targetSelector, to ?? null, y ?? null);
        consecutiveScreenshotCounts.delete(instance);
        return await embedEval(instance, js);
      },
    }),

    browser_hover: tool({
      description:
        "Hover over an element by ref ID (e.g. '@e6') or CSS selector to reveal menus, tooltips, or hover states before clicking or screenshotting. Auto-executes.",
      inputSchema: z.object({
        instance: z.string().optional().default("default").describe("Instance name."),
        selector: z.string().optional().describe("CSS selector. Omit if using `ref`."),
        ref: z
          .string()
          .optional()
          .describe("Element reference ID from browser_snapshot, e.g. '@e6'."),
      }),
      execute: async ({ instance = "default", selector, ref }) => {
        const target = resolveTargetSelector(ref, selector);
        if ("error" in target) return target;
        const js = buildHoverJs(target.targetSelector);
        consecutiveScreenshotCounts.delete(instance);
        return await embedEval(instance, js);
      },
    }),

    browser_wait_for: tool({
      description:
        "Wait until page text appears or an element exists, polling until a timeout. Prefer this over browser_wait with a fixed delay after navigation, login submit, or a click that loads content: it returns as soon as the condition holds instead of sleeping blindly. Auto-executes.",
      inputSchema: z.object({
        instance: z.string().optional().default("default").describe("Instance name."),
        kind: z
          .enum(["text", "selector"])
          .describe("'text': substring of the rendered page; 'selector': element exists."),
        value: z
          .string()
          .describe("Text to wait for, or CSS selector that must match."),
        timeout_ms: z
          .number()
          .int()
          .min(500)
          .max(30000)
          .optional()
          .describe("How long to poll. Default 5000."),
      }),
      execute: async (
        { instance = "default", kind, value, timeout_ms },
        { abortSignal }: { abortSignal?: AbortSignal } = {},
      ) => {
        const deadline = Date.now() + (timeout_ms ?? 5000);
        const started = Date.now();
        for (;;) {
          if (abortSignal?.aborted) return { error: "wait aborted" };
          let found = false;
          try {
            if (kind === "text") {
              const text = await native.browserEmbedRead(instance);
              found =
                typeof text === "string" &&
                !text.startsWith("(no readable text") &&
                text.includes(value);
            } else {
              await native.browserEmbedEval(
                instance,
                `(()=>{if(!document.querySelector(${cssJson(value)})){throw new Error('not present');}})();`,
              );
              found = true;
            }
          } catch {
            found = false;
          }
          if (found) return { ok: true as const, waited_ms: Date.now() - started };
          if (Date.now() >= deadline) {
            return {
              error: `timed out waiting for ${kind} "${value.slice(0, 120)}". The content may need a login, a different page state, or a longer timeout.`,
            };
          }
          await new Promise((r) => setTimeout(r, 300));
        }
      },
    }),

    browser_wait: tool({
      description:
        "Wait a short time (ms) before the next action, so a page can settle after navigation or a click. Prefer small values (200-1000ms) and poll browser_extract when checking for content.",
      inputSchema: z.object({
        instance: z.string().optional().default("default").describe("Instance name."),
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
            if (!target_id?.trim()) {
              return { error: "action 'activate_tab' requires 'target_id'" };
            }
            const res = await fetch(`${base}/json/activate/${encodeURIComponent(target_id.trim())}`, { signal: AbortSignal.timeout(3000) });
            return { ok: res.ok, activated: target_id };
          }
          if (action === "close_tab") {
            if (!target_id?.trim()) {
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
        instance: z.string().optional().default("default").describe("Instance name."),
      }),
      execute: async ({ instance = "default" }) => {
        const modelId =
          ctx.getModelId?.() ?? useChatStore.getState().selectedModelId;
        if (!modelSupportsVision(modelId)) {
          return {
            error:
              "the selected model has no vision capability, so it cannot see a screenshot - switch to a vision-capable model, or use browser_extract for the page text.",
          };
        }
        const count = (consecutiveScreenshotCounts.get(instance) ?? 0) + 1;
        consecutiveScreenshotCounts.set(instance, count);
        if (count >= 3) {
          return {
            error:
              "Consecutive browser_screenshot limit reached for instance '" +
              instance +
              "'. Do not repeatedly take screenshots in a loop. If the page appears dark or blank, it may have a dark theme (such as bg-black or #0a0a0a) or still be starting. Verify page content using curl.exe http://localhost:<port> or browser_extract / browser_console instead.",
          };
        }
        try {
          const data = await native.browserEmbedScreenshot(instance);
          return {
            kind: "screenshot" as const,
            instance,
            mediaType: "image/png",
            data,
            ...(count === 2
              ? {
                  hint: "Note: Consecutive screenshot taken. If the captured image appears dark or blank, the web page may have a dark background (such as bg-black or #0a0a0a), or may still be hydrating. Verify content using browser_extract, browser_console, or curl.exe instead of looping on browser_screenshot.",
                }
              : {}),
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
          hint?: string;
        };
        if (o && o.kind === "screenshot" && typeof o.data === "string") {
          return {
            type: "content",
            value: [
              {
                type: "text",
                text: o.hint
                  ? `Screenshot of the browser page (${o.hint}):`
                  : "Screenshot of the browser page:",
              },
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

    browser_upload: tool({
      description:
        "Attach a local workspace file to a file input in the browser instance by ref ID or CSS selector. Use it to submit forms with attachments. Reads the file from this machine, so it asks for approval, refuses while an SSH session is active (the file would come from the wrong machine), and refuses files over 12 MB.",
      inputSchema: z.object({
        instance: z.string().optional().default("default").describe("Instance name."),
        selector: z
          .string()
          .optional()
          .describe("CSS selector for the file input. Omit if using `ref`."),
        ref: z
          .string()
          .optional()
          .describe("Element reference ID from browser_snapshot, e.g. '@e7'."),
        path: z
          .string()
          .describe(
            "File to attach (absolute, or relative to the active terminal cwd).",
          ),
      }),
      needsApproval: true,
      execute: async ({ instance = "default", selector, ref, path }) => {
        const target = resolveTargetSelector(ref, selector);
        if ("error" in target) return target;
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "browser_upload",
            "Download the file from the host first, or run the upload from a local workspace.",
          );
        }
        let abs: string;
        try {
          abs = resolvePath(path, ctx.getCwd());
        } catch (e) {
          return { error: String(e) };
        }
        let file: { media_type: string; data: string; size: number };
        try {
          file = await native.readFileBase64(abs);
        } catch (e) {
          return { error: String(e), path: abs };
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          return {
            error: `file is ${file.size} bytes, over the ${MAX_UPLOAD_BYTES} byte upload cap`,
            path: abs,
          };
        }
        const fileName = abs.split(/[/\\]/).pop() || "upload";
        const js = buildUploadJs(
          target.targetSelector,
          fileName,
          file.media_type,
          file.data,
        );
        consecutiveScreenshotCounts.delete(instance);
        return await embedEval(instance, js);
      },
    }),

    browser_download: tool({
      description:
        "Download a file through the page in a browser instance and save it into the workspace. The fetch runs in page context, so session cookies apply and authenticated downloads behind a login work; a plain fetch/http_request cannot do that. Asks for approval, refuses while an SSH session is active, and refuses files over 8 MB.",
      inputSchema: z.object({
        instance: z.string().optional().default("default").describe("Instance name."),
        url: z
          .url()
          .describe(
            "Full http(s) URL of the file. Loopback dev assets allowed; other hosts must pass the SSRF guard.",
          ),
        path: z
          .string()
          .describe(
            "Where to save it (absolute, or relative to the active terminal cwd).",
          ),
      }),
      needsApproval: true,
      execute: async (
        { instance = "default", url, path },
        { abortSignal }: { abortSignal?: AbortSignal } = {},
      ) => {
        if (!isLoopbackTarget(url)) {
          const blocked = guard(url);
          if (blocked) return blocked;
        }
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "browser_download",
            "Save to the remote host with a shell download command instead.",
          );
        }
        let abs: string;
        try {
          abs = resolvePath(path, ctx.getCwd());
        } catch (e) {
          return { error: String(e) };
        }
        try {
          await native.browserEmbedEval(instance, buildDownloadStartJs(url));
        } catch (e) {
          return { error: String(e) };
        }
        const deadline = Date.now() + 25_000;
        for (;;) {
          if (abortSignal?.aborted) return { error: "download aborted" };
          try {
            await native.browserEmbedEval(instance, DOWNLOAD_READY_JS);
            break;
          } catch {
            if (Date.now() >= deadline) {
              return { error: "download timed out waiting for the page fetch" };
            }
            await new Promise((r) => setTimeout(r, 300));
          }
        }
        let dataUrl = "";
        let total = 0;
        let parts: string[] = [];
        try {
          for (let i = 0; i * DOWNLOAD_CHUNK_CHARS < MAX_DOWNLOAD_BYTES + 50000; i++) {
            const raw = await embedReadValue(instance, buildDownloadChunkJs(i));
            let chunk: {
              chunk?: string;
              last?: boolean;
              total?: number;
              error?: string | null;
            };
            try {
              chunk = JSON.parse(raw) as typeof chunk;
            } catch {
              return { error: "could not read the download from the page" };
            }
            if (chunk.error) return { error: chunk.error };
            if (typeof chunk.chunk !== "string") {
              return { error: "could not read the download from the page" };
            }
            parts.push(chunk.chunk);
            total = chunk.total ?? total;
            if (chunk.last) break;
          }
          dataUrl = parts.join("");
          parts = [];
        } catch (e) {
          return { error: String(e) };
        }
        const marker = ";base64,";
        const at = dataUrl.indexOf(marker);
        if (at < 0) return { error: "page did not produce a file body" };
        const base64 = dataUrl.slice(at + marker.length);
        try {
          await native.writeFileBase64(abs, base64);
        } catch (e) {
          return { error: String(e), path: abs };
        }
        return { ok: true as const, path: abs, bytes: Math.floor((base64.length * 3) / 4) };
      },
    }),

    browser_close: tool({
      description: "Close a browser instance and free its embedded webview.",
      inputSchema: z.object({
        instance: z.string().optional().default("default").describe("Instance name."),
      }),
      execute: async ({ instance = "default" }) => {
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
