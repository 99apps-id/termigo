// Whether a terminal slot needs a full repaint when it comes back from being
// parked (`display:none`).
//
// Small and dependency-free on purpose, like `webglRecovery.ts` next to it: the
// decision is the part that was got wrong, and a pool plus a WebGL context is
// not something a test can stand up.
//
// The failure this exists for was reported as a PowerShell prompt showing only
// its final character (`>`) instead of `PS C:\project\termigo-neo>`. The buffer
// held the whole prompt - a select-all copy returns it in full - so nothing was
// lost in transit or in the parser: the screen simply had not been repainted.
// A parked host cannot be measured, so xterm's renderer stops updating while
// the buffer keeps parsing writes, and on un-park every geometry guard in
// `rendererPool` compares against `lastW`/`lastH` that already match, so no fit
// and no resize reaches the renderer. It keeps the viewport and the glyph atlas
// it had while hidden, and paints a stale screen until something unrelated
// forces a repaint - which is why pressing Enter appeared to fix it.

export type UnparkRepaintState = {
  /** The slot was `display:none`, so its renderer stopped updating. */
  wasParked: boolean;
  /** The leaf the slot is bound to, or null when it holds none. */
  currentLeafId: number | null;
  /** Rows in the grid. A zero-row grid has nothing to paint. */
  rows: number;
};

export function shouldRepaintOnUnpark(state: UnparkRepaintState): boolean {
  // Only the transition needs it. A slot that was already visible has been
  // painting all along, and repainting it again is a wasted frame.
  if (!state.wasParked) return false;
  // Unbound: nothing is on screen for this slot to be wrong about.
  if (state.currentLeafId === null) return false;
  if (state.rows <= 0) return false;
  return true;
}
