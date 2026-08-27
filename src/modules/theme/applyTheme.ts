import type { Theme, ThemeColors, ThemeMode, TerminalPalette } from "./types";

const COLOR_VAR: Record<keyof ThemeColors, string> = {
  background: "--background",
  foreground: "--foreground",
  card: "--card",
  cardForeground: "--card-foreground",
  popover: "--popover",
  popoverForeground: "--popover-foreground",
  primary: "--primary",
  primaryForeground: "--primary-foreground",
  secondary: "--secondary",
  secondaryForeground: "--secondary-foreground",
  muted: "--muted",
  mutedForeground: "--muted-foreground",
  accent: "--accent",
  accentForeground: "--accent-foreground",
  destructive: "--destructive",
  border: "--border",
  input: "--input",
  ring: "--ring",
  sidebar: "--sidebar",
  sidebarForeground: "--sidebar-foreground",
  sidebarPrimary: "--sidebar-primary",
  sidebarPrimaryForeground: "--sidebar-primary-foreground",
  sidebarAccent: "--sidebar-accent",
  sidebarAccentForeground: "--sidebar-accent-foreground",
  sidebarBorder: "--sidebar-border",
  sidebarRing: "--sidebar-ring",
  radius: "--radius",
};

const ANSI_VARS: readonly string[] = [
  "--terminal-ansi-black",
  "--terminal-ansi-red",
  "--terminal-ansi-green",
  "--terminal-ansi-yellow",
  "--terminal-ansi-blue",
  "--terminal-ansi-magenta",
  "--terminal-ansi-cyan",
  "--terminal-ansi-white",
  "--terminal-ansi-bright-black",
  "--terminal-ansi-bright-red",
  "--terminal-ansi-bright-green",
  "--terminal-ansi-bright-yellow",
  "--terminal-ansi-bright-blue",
  "--terminal-ansi-bright-magenta",
  "--terminal-ansi-bright-cyan",
  "--terminal-ansi-bright-white",
];

const ALL_VARS: readonly string[] = [
  ...Object.values(COLOR_VAR),
  "--terminal-background",
  "--terminal-foreground",
  "--terminal-cursor",
  "--terminal-cursor-accent",
  "--terminal-selection",
  ...ANSI_VARS,
];

// Default ANSI palettes, matched to the CSS `:root` / `.dark` terminal palette
// in globals.css. Themes that do not declare a `terminal` palette fall back to
// the palette for the active mode so ANSI text stays readable on a light or
// dark background instead of inheriting a dark-only palette.
const DEFAULT_ANSI_LIGHT: readonly string[] = [
  "#1e293b", "#b91c1c", "#15803d", "#a16207",
  "#1d4ed8", "#7e22ce", "#0e7490", "#1f2937",
  "#64748b", "#dc2626", "#16a34a", "#ca8a04",
  "#2563eb", "#9333ea", "#0891b2", "#0f172a",
];
const DEFAULT_ANSI_DARK: readonly string[] = [
  "#141b2e", "#ff6b6b", "#2dd4a7", "#ffd166",
  "#749bff", "#a76bff", "#22d3ee", "#e7e9f2",
  "#4b5570", "#ff8a8a", "#5eead4", "#ffe08a",
  "#9ab6ff", "#c39bff", "#67e8f9", "#f6f7fc",
];

let lastApplied: string | null = null;

export function applyTheme(theme: Theme, mode: ThemeMode): void {
  const root = document.documentElement;
  const variant = theme.variants[mode] ?? theme.variants.dark ?? theme.variants.light;
  if (!variant) {
    clearTheme();
    return;
  }
  const colors = variant.colors;
  const terminal = variant.terminal;
  for (const v of ALL_VARS) root.style.removeProperty(v);
  if (colors) writeColors(root, colors);
  writeTerminal(root, terminal ?? {}, mode);
  lastApplied = theme.id;
}

export function clearTheme(): void {
  if (lastApplied === null) return;
  const root = document.documentElement;
  for (const v of ALL_VARS) root.style.removeProperty(v);
  lastApplied = null;
}

function writeColors(root: HTMLElement, c: ThemeColors): void {
  for (const k of Object.keys(c) as (keyof ThemeColors)[]) {
    const v = c[k];
    if (v) root.style.setProperty(COLOR_VAR[k], v);
  }
}

function writeTerminal(root: HTMLElement, t: TerminalPalette, mode: ThemeMode): void {
  // A field a theme does not declare falls back to the matching UI token, so
  // the terminal always tracks the active background/foreground.
  root.style.setProperty("--terminal-background", t.background ?? "var(--background)");
  root.style.setProperty("--terminal-foreground", t.foreground ?? "var(--foreground)");
  root.style.setProperty("--terminal-cursor", t.cursor ?? "var(--foreground)");
  root.style.setProperty("--terminal-cursor-accent", t.cursorAccent ?? "var(--background)");
  root.style.setProperty("--terminal-selection", t.selection ?? "var(--accent)");
  const ansi = t.ansi?.length === ANSI_VARS.length
    ? t.ansi
    : mode === "light"
      ? DEFAULT_ANSI_LIGHT
      : DEFAULT_ANSI_DARK;
  for (let i = 0; i < ANSI_VARS.length; i++) {
    root.style.setProperty(ANSI_VARS[i], ansi[i]);
  }
}
