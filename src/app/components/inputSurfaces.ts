// Which composer the centre bar shows.
//
// The bar used to offer a Shell / AI switch on a block tab, so one input could
// be either the terminal's or a chat's. Two composers for one bar meant the
// same keystrokes could land in the shell or in a chat depending on a toggle
// the user had to notice - and the AI composer already has its own home in the
// dock. One surface per bar:
//
//   block tab                 -> the shell input, always
//   another tab, dock open    -> no centre bar at all (the dock types there)
//   another tab, dock closed  -> the AI composer
//
// Pure and separate from the component so the rule is testable without a
// renderer, and so putting a toggle back has to delete a test that says why it
// was removed.

export type InputSurfaces = {
  /** The block's shell input: the terminal's own typing surface. */
  shell: boolean;
  /** The AI composer. */
  ai: boolean;
};

export function inputSurfaces(opts: {
  isBlockTab: boolean;
  hasComposer: boolean;
  panelOpen: boolean;
}): InputSurfaces {
  // A block tab types into its shell. Never a chat.
  if (opts.isBlockTab) return { shell: true, ai: false };
  // The dock owns the composer while it is open.
  return { shell: false, ai: opts.hasComposer && !opts.panelOpen };
}
