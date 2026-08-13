// Termigo mounts the SSH file explorer as a right-side panel instead of
// TEDI's dual sidebar/right-slot layout, so the persisted "prefer right slot"
// preference is a no-op here. Kept as a stub so the ported component compiles
// without editing its call sites.
export async function setSshInRightPanel(_value: boolean): Promise<void> {}
