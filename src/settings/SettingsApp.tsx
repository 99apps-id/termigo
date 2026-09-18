import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WindowControls } from "@/components/WindowControls";
import { IS_MAC } from "@/lib/platform";
import type { SettingsTab } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AiScanIcon,
  DatabaseIcon,
  InformationCircleIcon,
  KeyboardIcon,
  PaintBoardIcon,
  PlugSocketIcon,
  PuzzleIcon,
  Settings01Icon,
  SlidersHorizontalIcon,
  SourceCodeIcon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type ComponentType, lazy, Suspense, useEffect, useRef, useState } from "react";
import { AboutSection } from "./sections/AboutSection";
import { AgentsSection } from "./sections/AgentsSection";
import { EditorSection } from "./sections/EditorSection";
import { GeneralSection } from "./sections/GeneralSection";
import { HarnessSection } from "./sections/HarnessSection";
import { McpSection } from "./sections/McpSection";
import { ModelsSection } from "./sections/ModelsSection";
import { ShortcutsSection } from "./sections/ShortcutsSection";
import { SqlSection } from "./sections/SqlSection";
import { ThemesSection } from "./sections/ThemesSection";

// Lazy so the extension store (which bridges to the AI chat store) stays out
// of the settings window's eager bundle; it loads only when the tab is opened.
const ExtensionsSection = lazy(async () => ({
  default: (await import("./sections/ExtensionsSection")).ExtensionsSection,
}));

const TABS: {
  id: SettingsTab;
  label: string;
  icon: typeof Settings01Icon;
  component: ComponentType;
}[] = [
  {
    id: "general",
    label: "General",
    icon: Settings01Icon,
    component: GeneralSection,
  },
  {
    id: "editor",
    label: "Editor",
    icon: SourceCodeIcon,
    component: EditorSection,
  },
  {
    id: "themes",
    label: "Themes",
    icon: PaintBoardIcon,
    component: ThemesSection,
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    icon: KeyboardIcon,
    component: ShortcutsSection,
  },
  { id: "models", label: "Models", icon: AiScanIcon, component: ModelsSection },
  {
    id: "agents",
    label: "Agents",
    icon: UserMultiple02Icon,
    component: AgentsSection,
  },
  {
    id: "harness",
    label: "Harness",
    icon: SlidersHorizontalIcon,
    component: HarnessSection,
  },
  {
    id: "mcp",
    label: "MCP",
    icon: PlugSocketIcon,
    component: McpSection,
  },
  {
    id: "extensions",
    label: "Extensions",
    icon: PuzzleIcon,
    component: ExtensionsSection,
  },
  {
    id: "sql",
    label: "SQL",
    icon: DatabaseIcon,
    component: SqlSection,
  },
  {
    id: "about",
    label: "About",
    icon: InformationCircleIcon,
    component: AboutSection,
  },
];

const VALID_TABS: SettingsTab[] = [
  "general",
  "editor",
  "themes",
  "shortcuts",
  "models",
  "agents",
  "harness",
  "mcp",
  "extensions",
  "sql",
  "about",
];

function readInitialTab(): SettingsTab {
  if (typeof window === "undefined") return "general";
  const url = new URL(window.location.href);
  const t = url.searchParams.get("tab");
  // Back-compat: legacy "ai" / "connections" → "models".
  if (t === "ai" || t === "connections") return "models";
  if (t && (VALID_TABS as string[]).includes(t)) return t as SettingsTab;
  return "general";
}

export function SettingsApp() {
  const [active, setActive] = useState<SettingsTab>(readInitialTab);
  const init = usePreferencesStore((s) => s.init);
  const ActiveSection = TABS.find((t) => t.id === active)?.component;
  const tabsListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void init();
  }, [init]);

  // Press Escape to cleanly close the settings modal on all platforms.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void getCurrentWebviewWindow().close();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Ensure the selected tab is always scrolled into view if viewport is narrowed.
  useEffect(() => {
    if (!tabsListRef.current) return;
    const activeEl = tabsListRef.current.querySelector<HTMLElement>(
      `[data-state="active"], [value="${active}"]`,
    );
    if (activeEl) {
      activeEl.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    }
  }, [active]);

  useEffect(() => {
    const apply = (detail: string) => {
      if (detail === "ai" || detail === "connections") {
        setActive("models");
        return;
      }
      if ((VALID_TABS as string[]).includes(detail)) {
        setActive(detail as SettingsTab);
      }
    };
    const unlistenPromise = getCurrentWebviewWindow().listen<string>(
      "termigo:settings-tab",
      (e) => apply(e.payload),
    );
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground select-none">
      <header
        data-tauri-drag-region
        className={`flex h-11 shrink-0 items-center justify-between border-b border-border/60 bg-card/60 ${
          IS_MAC ? "pr-2 pl-20" : "pr-2 pl-3"
        }`}
      >
        <Tabs
          value={active}
          onValueChange={(v) => setActive(v as SettingsTab)}
          orientation="horizontal"
          className="min-w-0 flex-1 overflow-hidden"
          data-tauri-drag-region
        >
          <div
            ref={tabsListRef}
            className="flex w-full items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            onWheel={(e) => {
              if (e.deltaY !== 0 && e.deltaX === 0) {
                e.currentTarget.scrollLeft += e.deltaY;
              }
            }}
          >
            <TabsList className="mx-auto flex h-7 shrink-0 items-center gap-0.5 bg-muted/40 px-1.5">
              {TABS.map((t) => (
                <TabsTrigger
                  key={t.id}
                  value={t.id}
                  className="h-6 shrink-0 gap-1 px-2 text-[11px] font-medium transition-all sm:gap-1.5 sm:px-2.5 sm:text-[11.5px]"
                >
                  <HugeiconsIcon icon={t.icon} size={12} strokeWidth={1.75} />
                  <span>{t.label}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </Tabs>
        <div className="shrink-0 pl-1">
          <WindowControls closeOnly />
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-6 pt-6 pb-7 sm:px-8 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="mx-auto w-full max-w-160">
          {ActiveSection ? (
            <Suspense
              fallback={
                <p className="text-[12px] text-muted-foreground">Loading…</p>
              }
            >
              <ActiveSection />
            </Suspense>
          ) : null}
        </div>
      </main>
    </div>
  );
}
