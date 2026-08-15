// Termigo uses a single tab store (`@/modules/tabs/lib/useTabs`) where tabs
// are a direct union. TEDI's extension host references an `ExtensionTabState`
// tone for the extension tab title; export the plain union here so the
// ported extension code compiles unchanged.
export type ExtensionTabState =
  | "idle"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "disconnected"
  | "error";
