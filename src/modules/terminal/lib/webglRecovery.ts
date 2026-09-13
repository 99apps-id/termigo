// Whether a terminal slot should get its WebGL renderer back after the browser
// lost the context.
//
// Small and dependency-free on purpose. This decision was got wrong once - an
// eager version recovered for every slot, including ones bound to no leaf - and
// recovering for an unbound slot is not a harmless extra: `rendererPool` reaps
// WebGL from those slots after a grace period precisely to keep GPU contexts
// free, and live contexts are a scarce, page-wide resource. Allocating one that
// is about to be disposed is how a page runs out of them.
//
// The visible slot is the one that matters. Without a re-attach, a terminal the
// user is looking at stays on the slow DOM renderer for the rest of the
// session, which is the whole reason this recovery exists.

export type WebglRecoveryState = {
  /** The addon is still attached, so there is nothing to recover. */
  hasAddon: boolean;
  /** The leaf this slot is bound to, or null when it holds none. */
  currentLeafId: number | null;
  /** The slot's host is hidden, so nothing is being painted. */
  parked: boolean;
};

export function shouldRecoverWebgl(
  state: WebglRecoveryState,
  webglEnabled: boolean,
): boolean {
  if (!webglEnabled) return false;
  if (state.hasAddon) return false;
  // A parked slot has a hidden host: re-attaching would build a renderer for a
  // surface nobody can see.
  if (state.parked) return false;
  // Unbound: `scheduleWebglReap` disposes WebGL for these, so a re-attach here
  // is a GPU context allocated only to be thrown away.
  if (state.currentLeafId === null) return false;
  return true;
}
