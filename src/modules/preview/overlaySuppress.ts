import { useSyncExternalStore } from "react";

/**
 * A native webview composites ABOVE the DOM, so a dialog, dropdown, command
 * palette, approval popup or any popper drawn over the embedded browser would be
 * hidden behind it. There is no way to put a native webview BEHIND the DOM, so
 * the reliable answer is to HIDE the webview while an overlay overlaps it: the
 * modal is never covered, and the page reappears the moment the overlay closes.
 *
 * A shallow <body> observer flips {@link useAnyOverlayOpen} when any overlay is
 * mounted, so the per-frame geometry test only runs while something is open.
 * Ported from TEDI (hide-only; the Windows region "holes" path is omitted).
 */
// The floating AI mini-window (`[data-ai-mini-window]`) is included so a browser
// tab beneath it never steals clicks meant for the chat — its approval buttons,
// composer and controls composite in the DOM and would otherwise sit behind the
// native webview. It is a direct-ish <body> child, so the shallow observer sees
// it even though the approval card nested inside is not itself listed here.
const OVERLAY_SELECTOR =
  '[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"], [role="menu"], [data-ai-mini-window]';

/** Radix renders a visually-hidden [role="tooltip"] inside every tooltip popper;
 *  tooltips are transient and non-interactive, so ignore them (a hover would
 *  otherwise flash the whole page away). */
function isTooltip(el: Element): boolean {
  return (
    el.querySelector('[data-slot="tooltip-content"], [role="tooltip"]') !== null
  );
}

function hasRealOverlay(): boolean {
  const els = document.querySelectorAll(OVERLAY_SELECTOR);
  for (let i = 0; i < els.length; i++) {
    if (!isTooltip(els[i])) return true;
  }
  return false;
}

let isOpen = false;
let rafId = 0;
let observer: MutationObserver | null = null;
let refCount = 0;
const listeners = new Set<() => void>();

function recompute() {
  rafId = 0;
  const next = hasRealOverlay();
  if (next === isOpen) return;
  isOpen = next;
  for (const l of listeners) l();
}

function schedule() {
  if (rafId) return;
  rafId = requestAnimationFrame(recompute);
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (refCount++ === 0) {
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true });
    schedule();
  }
  return () => {
    listeners.delete(onChange);
    if (--refCount === 0 && observer) {
      observer.disconnect();
      observer = null;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    }
  };
}

/** True while any dialog / dropdown / menu / popover is mounted. */
export function useAnyOverlayOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isOpen,
    () => false,
  );
}

/** Whether any open overlay's box intersects `rect` (viewport CSS px). */
export function anyOverlayIntersects(rect: DOMRect): boolean {
  const overlays = document.querySelectorAll(OVERLAY_SELECTOR);
  for (let i = 0; i < overlays.length; i++) {
    if (isTooltip(overlays[i])) continue;
    const o = overlays[i].getBoundingClientRect();
    if (o.width < 1 || o.height < 1) continue;
    if (
      o.left < rect.right &&
      o.right > rect.left &&
      o.top < rect.bottom &&
      o.bottom > rect.top
    ) {
      return true;
    }
  }
  return false;
}
