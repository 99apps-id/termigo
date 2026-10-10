import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useTelegramStore } from "@/modules/telegram/store";
import {
  AiBookIcon,
  AiBrain01Icon,
  AiBrain02Icon,
  AiCloud01Icon,
  AppleIcon,
  ArrowDown01Icon,
  ArrowUpIcon,
  BrainIcon,
  ChatGptIcon,
  ClaudeIcon,
  Clock01Icon,
  CoinsDollarIcon,
  ComputerIcon,
  CpuIcon,
  DeepseekIcon,
  FavouriteIcon,
  FileDiffIcon,
  FlashIcon,
  GlobeIcon,
  GoogleGeminiIcon,
  Grok02Icon,
  InspectCodeIcon,
  Layers02Icon,
  Message01Icon,
  MistralIcon,
  PlugIcon,
  Search01Icon,
  ServerStack01Icon,
  Settings01Icon,
  SparklesIcon,
  StarIcon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  compatModelIdForEndpoint,
  estimateCost,
  getCompatModelInfo,
  getModel,
  isCompatModelId,
  MODELS,
  type ModelCapabilities,
  type ModelId,
  type ModelInfo,
  PROVIDERS,
  type ProviderId,
  providerNeedsKey,
  resolveApiModelId,
} from "../config";
import { useComposer } from "../lib/composer";
import { costToday } from "../lib/costLedger";
import { toggleFavoriteModel } from "../lib/modelPrefs";
import { useChatStore } from "../store/chatStore";
import { AgentDiagnosticsDialog } from "./AgentDiagnosticsDialog";
import { AgentMemoryDialog } from "./AgentMemoryDialog";
import { ApprovalModeControl } from "./ApprovalModeControl";
import { ArtifactsDialog } from "./ArtifactsDialog";
import { ChangeReviewDialog } from "./ChangeReviewDialog";
import { ContextMeter } from "./ContextMeter";
import { RunReplayDialog } from "./RunReplayDialog";

const PROVIDER_ICON = {
  openai: ChatGptIcon,
  anthropic: ClaudeIcon,
  google: GoogleGeminiIcon,
  xai: Grok02Icon,
  cerebras: CpuIcon,
  groq: FlashIcon,
  deepseek: DeepseekIcon,
  stepfun: AiBrain01Icon,
  qwen: AiCloud01Icon,
  zhipu: AiBrain02Icon,
  mistral: MistralIcon,
  openrouter: GlobeIcon,
  "openai-compatible": PlugIcon,
  lmstudio: ComputerIcon,
  mlx: AppleIcon,
  ollama: ServerStack01Icon,
  chatgpt: ChatGptIcon,
  "claude-oauth": ClaudeIcon,
  "xai-oauth": Grok02Icon,
  "github-copilot": ComputerIcon,
  antigravity: GoogleGeminiIcon,
  muse: AiBrain01Icon,
  moonshot: AiBrain02Icon,
  minimax: CpuIcon,
  together: GlobeIcon,
  fireworks: FlashIcon,
  deepinfra: ServerStack01Icon,
  siliconflow: FlashIcon,
  nebius: AiCloud01Icon,
  nvidia: CpuIcon,
  sambanova: FlashIcon,
  novita: AiCloud01Icon,
  hyperbolic: FlashIcon,
  chutes: ServerStack01Icon,
  perplexity: GlobeIcon,
  cohere: AiBrain01Icon,
} as const satisfies Record<ProviderId, typeof ChatGptIcon>;

/**
 * Live Telegram relay status chip. Shows whether the bot is online, or a subtle
 * dot when enabled but not yet polling (e.g. no connection). Hidden when the
 * relay is off or no token is set.
 */
function TelegramStatusChip() {
  const enabled = useTelegramStore((s) => s.enabled);
  const online = useTelegramStore((s) => s.online);
  const hasToken = useTelegramStore((s) => s.hasToken);
  if (!enabled || !hasToken) return null;
  const dot = online ? "bg-emerald-500" : "bg-amber-500";
  return (
    <span
      className="flex h-6 items-center gap-1 rounded-md border border-border/60 bg-card px-2 text-[11px] text-muted-foreground"
      title={online ? "Telegram relay online" : "Telegram relay: connecting…"}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />
      <span>TG</span>
    </span>
  );
}

function RoundChip() {
  const status = useChatStore((s) => s.agentMeta.status);
  const round = useChatStore((s) => s.agentMeta.round);
  const busy =
    status === "thinking" ||
    status === "streaming" ||
    status === "awaiting-approval";
  if (!busy || round <= 0) return null;
  return (
    <span
      className="flex h-6 items-center gap-1 rounded-md border border-border/60 bg-card px-2 text-[11px] tabular-nums text-muted-foreground"
      title={`Round ${round} — the agent's current model call in this run. A climbing number means it is progressing.`}
    >
      <span className="font-medium text-foreground/80">R{round}</span>
    </span>
  );
}

export function AiOpenButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-md border border-border/60 bg-card px-2 text-xs",
        "text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground",
        "animate-in slide-in-from-top-2 duration-200 ease-out",
      )}
      title="Open AI agent"
    >
      <span>Open AI agent</span>
      <Kbd className="h-4 min-w-4 px-1">{fmtShortcut(MOD_KEY, "I")}</Kbd>
    </button>
  );
}

export function AiStatusBarControls() {
  const c = useComposer();
  const [diagOpen, setDiagOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const toggleMini = useChatStore((s) => s.toggleMini);
  const miniOpen = useChatStore((s) => s.mini.open);
  const closePanel = useChatStore((s) => s.closePanel);

  return (
    <div className="flex items-center gap-1">
      <ApprovalModeControl className="mr-0.5" />

      {/* Live context / token meter against the model's window. */}
      <ContextMeter />

      {/* Live round counter during active agent execution. */}
      <RoundChip />

      {/* Telegram relay status. */}
      <TelegramStatusChip />

      {/* Model picker dropdown. */}
      <ModelDropdown />

      {/* Consolidated Telemetry Pill (Today Spend, Current Run, Tokens). */}
      <AgentTelemetryPill onOpenDiag={() => setDiagOpen(true)} />

      {/* Consolidated Agent Tools Popover (Review, Memory, Artifacts, Replay, Diagnostics). */}
      <AgentToolsMenu
        onOpenDiag={() => setDiagOpen(true)}
        onOpenReplay={() => setReplayOpen(true)}
        onOpenReview={() => setReviewOpen(true)}
        onOpenMemory={() => setMemoryOpen(true)}
        onOpenArtifacts={() => setArtifactsOpen(true)}
      />

      <AgentDiagnosticsDialog open={diagOpen} onOpenChange={setDiagOpen} />
      <RunReplayDialog open={replayOpen} onOpenChange={setReplayOpen} />
      <ChangeReviewDialog open={reviewOpen} onOpenChange={setReviewOpen} />
      <AgentMemoryDialog open={memoryOpen} onOpenChange={setMemoryOpen} />
      <ArtifactsDialog open={artifactsOpen} onOpenChange={setArtifactsOpen} />

      <span className="mx-1 h-4 w-px bg-border/60" aria-hidden />
      <Button
        onClick={closePanel}
        title="Close AI panel"
        size="xs"
        variant="ghost"
        aria-label="Close AI panel"
        className="h-6 px-1 text-[11px] text-foreground/85"
      >
        <Kbd className="h-4 gap-px px-1.5 font-mono text-[10.5px]">
          {fmtShortcut(MOD_KEY, "I")}
        </Kbd>
      </Button>
      <IconBtn
        title={`${miniOpen ? "Close" : "Open"} AI chat window (${fmtShortcut("⇧", MOD_KEY, "I")})`}
        onClick={toggleMini}
      >
        <HugeiconsIcon icon={Message01Icon} size={13} strokeWidth={1.75} />
      </IconBtn>

      {/* One button, like VSCode / the Claude extension: it sends while idle and
          becomes a stop while the agent runs - same accent, size and position,
          only the glyph swaps (arrow -> filled square). */}
      <Button
        type="button"
        size="icon"
        onClick={c.isBusy ? c.stop : c.submit}
        disabled={!c.isBusy && !c.canSend}
        className="ml-0.5 size-6 rounded-md border-0 shadow-none hover:brightness-110 disabled:opacity-50"
        style={{
          backgroundColor: "var(--composer-accent)",
          color: "var(--composer-accent-foreground)",
        }}
        aria-label={c.isBusy ? "Stop" : "Send"}
        title={c.isBusy ? "Stop (Esc)" : "Send (Enter)"}
      >
        {c.isBusy ? (
          <span className="size-2 rounded-[2px] bg-current" />
        ) : (
          <HugeiconsIcon icon={ArrowUpIcon} size={13} strokeWidth={2.2} />
        )}
      </Button>
    </div>
  );
}

type Tab = "all" | "favorites" | "recent";

function ModelDropdown() {
  const selected = useChatStore((s) => s.selectedModelId);
  const apiKeys = useChatStore((s) => s.apiKeys);
  const setSelected = useChatStore((s) => s.setSelectedModelId);
  const favoriteIds = usePreferencesStore((s) => s.favoriteModelIds);
  const recentIds = usePreferencesStore((s) => s.recentModelIds);
  const customEndpoints = usePreferencesStore((s) => s.customEndpoints);
  const modelIdOverrides = usePreferencesStore((s) => s.modelIdOverrides);
  // The id the request will actually carry, so a vendor rename or an override
  // is visible where the model is picked instead of only in Settings.
  const apiModelIdFor = useCallback(
    (id: string) => resolveApiModelId(id, modelIdOverrides),
    [modelIdOverrides],
  );
  const current = isCompatModelId(selected)
    ? getCompatModelInfo(selected, customEndpoints)
    : getModel(selected as ModelId);
  const [search, setSearch] = useState("");
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const inputRef = useRef<HTMLInputElement>(null);
  const hasCredentialFor = useCallback(
    (id: ProviderId) => (providerNeedsKey(id) ? !!apiKeys[id] : true),
    [apiKeys],
  );

  const currentProviderHasKey = isCompatModelId(selected)
    ? true
    : hasCredentialFor(current.provider);

  const hasKeyFor = hasCredentialFor;

  const epModelInfos = useMemo(() => {
    return customEndpoints.map((ep) =>
      getCompatModelInfo(compatModelIdForEndpoint(ep.id), customEndpoints),
    );
  }, [customEndpoints]);

  const sortedProviders = useMemo(() => {
    const configured: (typeof PROVIDERS)[number][] = [];
    const unconfigured: (typeof PROVIDERS)[number][] = [];
    for (const p of PROVIDERS) {
      if (p.id === "openai-compatible") continue;
      (hasKeyFor(p.id) ? configured : unconfigured).push(p);
    }
    return { configured, unconfigured };
    // hasKeyFor is a stable useCallback that only changes when apiKeys do, so
    // it is the correct trigger for this memo.
  }, [hasKeyFor]);

  const allModels = useMemo(() => [...MODELS, ...epModelInfos], [epModelInfos]);

  const COMPAT_PROVIDER_ID = "__compat__";

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let pool: readonly ModelInfo[] = allModels;
    if (tab === "favorites") {
      pool = pool.filter((m) => favoriteIds.includes(m.id));
    } else if (tab === "recent") {
      const order = new Map(recentIds.map((id, i) => [id, i]));
      pool = pool
        .filter((m) => order.has(m.id))
        .slice()
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    }
    if (activeProvider === COMPAT_PROVIDER_ID) {
      pool = pool.filter((m) => isCompatModelId(m.id));
    } else if (activeProvider !== null) {
      pool = pool.filter((m) => m.provider === activeProvider);
    }
    if (q) {
      pool = pool.filter(
        (m) =>
          m.label.toLowerCase().includes(q) ||
          m.hint.toLowerCase().includes(q) ||
          m.description.toLowerCase().includes(q) ||
          m.provider.includes(q) ||
          (m.tags?.some((t) => t.includes(q)) ?? false),
      );
    }
    return pool;
  }, [activeProvider, allModels, favoriteIds, recentIds, search, tab]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-5.5 gap-1 rounded-md px-1.5 my-1 text-xs hover:bg-accent hover:text-foreground",
            currentProviderHasKey
              ? "text-muted-foreground"
              : "text-amber-600 dark:text-amber-400",
          )}
          title={
            currentProviderHasKey
              ? `Model: ${current.label}`
              : `${current.label} — no key configured`
          }
        >
          {current.label}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={11}
            strokeWidth={2}
            className="opacity-70"
          />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="w-[28rem] p-0 overflow-hidden rounded-xl border border-border/70 shadow-xl"
        onFocusCapture={(e) => {
          if (e.target !== inputRef.current) inputRef.current?.focus();
        }}
      >
        {/* Search */}
        <div className="flex items-center gap-2.5 border-b border-border/70 px-3 py-2.5">
          <HugeiconsIcon
            icon={Search01Icon}
            size={16}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground/70"
          />
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Search models, providers, capabilities…"
            className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
          />
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-0.5 border-b border-border/70 px-2 py-1.5">
          <TabButton
            label="All"
            icon={AiBookIcon}
            active={tab === "all"}
            onClick={() => setTab("all")}
          />
          <TabButton
            label="Favorites"
            icon={FavouriteIcon}
            active={tab === "favorites"}
            onClick={() => setTab("favorites")}
            count={favoriteIds.length || undefined}
          />
          <TabButton
            label="Recent"
            icon={Clock01Icon}
            active={tab === "recent"}
            onClick={() => setTab("recent")}
            count={recentIds.length || undefined}
          />
        </div>

        <div className="flex max-h-104 min-h-0">
          {/* Provider sidebar — configured first, unconfigured muted, no dividers. */}
          <div className="flex w-11 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border/70 bg-muted/20 py-1.5">
            <ProviderPill
              icon={AiBookIcon}
              title="All providers"
              active={activeProvider === null}
              onClick={() => setActiveProvider(null)}
            />
            {[
              ...sortedProviders.configured,
              ...sortedProviders.unconfigured,
            ].map((p) => (
              <ProviderPill
                key={p.id}
                icon={PROVIDER_ICON[p.id]}
                title={
                  hasKeyFor(p.id) ? p.label : `${p.label} — not configured`
                }
                active={activeProvider === p.id}
                muted={!hasKeyFor(p.id)}
                onClick={() => setActiveProvider(p.id)}
              />
            ))}
            {customEndpoints.length > 0 && (
              <ProviderPill
                icon={PlugIcon}
                title="OpenAI Compatible"
                active={activeProvider === COMPAT_PROVIDER_ID}
                onClick={() => setActiveProvider(COMPAT_PROVIDER_ID)}
              />
            )}
          </div>

          {/* Models list */}
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {activeProvider === COMPAT_PROVIDER_ID && (
              <div className="flex items-center gap-1.5 px-3 pt-1 pb-1.5 text-[11px] font-medium tracking-tight text-muted-foreground/90">
                <HugeiconsIcon icon={PlugIcon} size={13} strokeWidth={1.75} />
                <span>OpenAI Compatible</span>
              </div>
            )}
            {activeProvider !== null &&
            activeProvider !== COMPAT_PROVIDER_ID ? (
              <ProviderHeader providerId={activeProvider as ProviderId} />
            ) : null}
            {activeProvider !== null &&
            activeProvider !== COMPAT_PROVIDER_ID &&
            !hasKeyFor(activeProvider as ProviderId) ? (
              <ProviderConfigureCTA providerId={activeProvider as ProviderId} />
            ) : null}
            {filtered.length === 0 ? (
              <div className="flex items-center justify-center px-4 py-10 text-xs text-muted-foreground/70">
                {tab === "favorites"
                  ? "No favorites yet — star a model to pin it here."
                  : tab === "recent"
                    ? "No recently-used models."
                    : "No models match."}
              </div>
            ) : (
              filtered.map((m) => (
                <ModelRow
                  key={m.id}
                  model={m}
                  wireId={apiModelIdFor(m.id)}
                  selected={m.id === selected}
                  hasKey={isCompatModelId(m.id) || hasKeyFor(m.provider)}
                  favorite={favoriteIds.includes(m.id)}
                  showProviderIcon={activeProvider === null}
                  onPick={() => {
                    if (!isCompatModelId(m.id) && !hasKeyFor(m.provider)) {
                      void openSettingsWindow("models");
                      return;
                    }
                    setSelected(m.id);
                  }}
                  onToggleFavorite={() => void toggleFavoriteModel(m.id)}
                />
              ))
            )}
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TabButton({
  label,
  icon,
  active,
  count,
  onClick,
}: {
  label: string;
  icon: typeof AiBookIcon;
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
      )}
    >
      <HugeiconsIcon icon={icon} size={12} strokeWidth={1.75} />
      {label}
      {count != null ? (
        <span className="rounded-full bg-muted/60 px-1.5 text-[9.5px] tabular-nums text-muted-foreground">
          {count}
        </span>
      ) : null}
    </button>
  );
}

function ProviderPill({
  icon,
  title,
  active,
  muted,
  onClick,
}: {
  icon: typeof AiBookIcon;
  title: string;
  active: boolean;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "relative mx-auto flex size-8 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-accent text-foreground after:absolute after:right-0 after:top-1.5 after:bottom-1.5 after:w-[2px] after:rounded-full after:bg-primary after:content-['']"
          : muted
            ? "text-muted-foreground/50 hover:bg-accent/40 hover:text-foreground"
            : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
      )}
    >
      <HugeiconsIcon icon={icon} size={16} strokeWidth={1.5} />
    </button>
  );
}

function ProviderHeader({ providerId }: { providerId: ProviderId }) {
  const p = PROVIDERS.find((x) => x.id === providerId);
  if (!p) return null;
  return (
    <div className="flex items-center gap-1.5 px-3 pt-1 pb-1.5 text-[11px] font-medium tracking-tight text-muted-foreground/90">
      <HugeiconsIcon icon={PROVIDER_ICON[p.id]} size={13} strokeWidth={1.75} />
      <span>{p.label}</span>
    </div>
  );
}

function ProviderConfigureCTA({ providerId }: { providerId: ProviderId }) {
  const p = PROVIDERS.find((x) => x.id === providerId);
  if (!p) return null;
  return (
    <button
      type="button"
      onClick={() => void openSettingsWindow("models")}
      className="group mx-2 mb-1 flex w-[calc(100%-1rem)] items-center gap-2 rounded-md border border-dashed border-border/70 bg-muted/20 px-3 py-2 text-left text-[11px] text-muted-foreground transition-colors hover:border-border hover:bg-accent/40 hover:text-foreground"
    >
      <HugeiconsIcon icon={Settings01Icon} size={13} strokeWidth={1.75} />
      <span className="flex-1 truncate">
        Configure {p.label} to use these models.
      </span>
      <span className="shrink-0 text-[10px] underline-offset-2 group-hover:underline">
        Open
      </span>
    </button>
  );
}

function ModelRow({
  model,
  wireId,
  selected,
  hasKey,
  favorite,
  showProviderIcon,
  onPick,
  onToggleFavorite,
}: {
  model: ModelInfo;
  /** The id sent to the provider, when it differs from the registry id. */
  wireId?: string;
  selected: boolean;
  hasKey: boolean;
  favorite: boolean;
  showProviderIcon: boolean;
  onPick: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={(e) => {
        e.preventDefault();
        onPick();
      }}
      className={cn(
        "group mx-1 my-0.5 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5",
        selected ? "bg-accent/60 text-foreground" : "text-foreground/85",
        !hasKey && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggleFavorite();
        }}
        title={favorite ? "Unfavorite" : "Favorite"}
        className={cn(
          "shrink-0 rounded p-0.5 transition-colors",
          favorite
            ? "text-amber-500"
            : "text-muted-foreground/40 hover:text-amber-500",
        )}
      >
        <HugeiconsIcon
          icon={StarIcon}
          size={12}
          strokeWidth={favorite ? 2 : 1.75}
          className={favorite ? "fill-amber-500" : ""}
        />
      </button>

      {showProviderIcon ? (
        <HugeiconsIcon
          icon={PROVIDER_ICON[model.provider]}
          size={13}
          strokeWidth={1.5}
          className="shrink-0 text-muted-foreground/70"
        />
      ) : null}

      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="shrink-0 text-[12px] font-medium leading-none">
          {model.label}
        </span>
        {/* The wire id, when a vendor rename or an override moved it: the one
            string that has to be right for the request to work. */}
        {wireId && wireId !== model.id ? (
          <span className="shrink-0 truncate font-mono text-[10px] leading-none text-muted-foreground/70">
            {wireId}
          </span>
        ) : null}
        <span className="truncate text-[10.5px] leading-none text-muted-foreground">
          {model.description}
        </span>
      </div>

      <CapabilityBars caps={model.capabilities} />

      {selected ? (
        <HugeiconsIcon
          icon={Tick01Icon}
          size={13}
          strokeWidth={2}
          className="shrink-0 text-foreground"
        />
      ) : null}
    </DropdownMenuItem>
  );
}

function CapabilityBars({ caps }: { caps: ModelCapabilities }) {
  return (
    <div className="ml-auto flex items-center gap-1.5">
      <CapBar icon={BrainIcon} value={caps.intelligence} label="Intelligence" />
      <CapBar icon={FlashIcon} value={caps.speed} label="Speed" />
      <CapBar icon={CoinsDollarIcon} value={caps.cost} label="Affordability" />
    </div>
  );
}

function CapBar({
  icon,
  value,
  label,
}: {
  icon: typeof AiBookIcon;
  value: number;
  label: string;
}) {
  return (
    <span className="flex items-center gap-0.5" title={`${label}: ${value}/5`}>
      <HugeiconsIcon
        icon={icon}
        size={10}
        strokeWidth={1.75}
        className="text-muted-foreground/60"
      />
      <span className="flex items-center gap-px">
        {[1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            className={cn(
              "h-2 w-[2px] rounded-full",
              i <= value ? "bg-foreground/70" : "bg-foreground/15",
            )}
          />
        ))}
      </span>
    </span>
  );
}

function IconBtn({
  title,
  onClick,
  disabled,
  className,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "size-6 rounded-md text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      {children}
    </Button>
  );
}

function fmtK(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

/**
 * Consolidated Agent Tools popover menu.
 * Collapses the 5 separate status-bar dialog buttons (Review, Memory, Artifacts,
 * Replay, Diagnostics) into a single unified entry point.
 */
function AgentToolsMenu({
  onOpenDiag,
  onOpenReplay,
  onOpenReview,
  onOpenMemory,
  onOpenArtifacts,
}: {
  onOpenDiag: () => void;
  onOpenReplay: () => void;
  onOpenReview: () => void;
  onOpenMemory: () => void;
  onOpenArtifacts: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            open && "bg-accent text-foreground",
          )}
          title="Agent tools & insights (Review, Memory, Artifacts, Replay, Diagnostics)"
          aria-label="Agent tools and insights"
        >
          <HugeiconsIcon icon={SparklesIcon} size={13} strokeWidth={2} />
          <span className="text-[11px] font-medium">Tools</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={6}
        className="z-50 w-64 rounded-xl border border-border/80 bg-popover/95 p-1 text-[12px] shadow-xl backdrop-blur-md"
      >
        <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Agent Tools & Insights
        </div>
        <div className="flex flex-col gap-0.5">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenReview();
            }}
            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-foreground/90 transition-colors hover:bg-accent hover:text-foreground"
          >
            <div className="grid size-6 place-items-center rounded-md bg-muted text-muted-foreground">
              <HugeiconsIcon icon={FileDiffIcon} size={13} strokeWidth={2} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium leading-none">
                Review Changes
              </div>
              <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
                Working tree diffs and staged edits
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenMemory();
            }}
            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-foreground/90 transition-colors hover:bg-accent hover:text-foreground"
          >
            <div className="grid size-6 place-items-center rounded-md bg-muted text-muted-foreground">
              <HugeiconsIcon icon={BrainIcon} size={13} strokeWidth={2} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium leading-none">
                Agent Memory
              </div>
              <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
                Learned project facts and conventions
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenArtifacts();
            }}
            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-foreground/90 transition-colors hover:bg-accent hover:text-foreground"
          >
            <div className="grid size-6 place-items-center rounded-md bg-muted text-muted-foreground">
              <HugeiconsIcon icon={Layers02Icon} size={13} strokeWidth={2} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium leading-none">
                Artifacts
              </div>
              <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
                Canvases, previews, and generated files
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenReplay();
            }}
            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-foreground/90 transition-colors hover:bg-accent hover:text-foreground"
          >
            <div className="grid size-6 place-items-center rounded-md bg-muted text-muted-foreground">
              <HugeiconsIcon icon={Clock01Icon} size={13} strokeWidth={2} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium leading-none">
                Run Replay
              </div>
              <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
                Step-by-step agent turn history
              </div>
            </div>
          </button>

          <div className="my-1 h-px bg-border/60" />

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenDiag();
            }}
            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-foreground/90 transition-colors hover:bg-accent hover:text-foreground"
          >
            <div className="grid size-6 place-items-center rounded-md bg-muted text-muted-foreground">
              <HugeiconsIcon icon={InspectCodeIcon} size={13} strokeWidth={2} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium leading-none">
                Diagnostics & Traces
              </div>
              <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
                Raw run telemetry, checkpoints, and context
              </div>
            </div>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Consolidated telemetry pill.
 * Unifies Today's Spend, live in-flight cost, and token usage into a single
 * quiet status-bar indicator with a detailed breakdown popover.
 */
function AgentTelemetryPill({ onOpenDiag }: { onOpenDiag: () => void }) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [today, setToday] = useState<number | null>(null);
  const lastRun = useChatStore((s) => s.lastRun);
  const status = useChatStore((s) => s.agentMeta.status);
  const tokens = useChatStore((s) => s.agentMeta.tokens);
  const lastInput = useChatStore((s) => s.agentMeta.lastInputTokens);
  const lastCached = useChatStore((s) => s.agentMeta.lastCachedTokens);
  const modelId = useChatStore((s) => s.selectedModelId);

  // biome-ignore lint/correctness/useExhaustiveDependencies(lastRun): refresh the pill when a run finishes; the body reads no dep, but a new run must re-fetch spend.
  useEffect(() => {
    let alive = true;
    const load = () => {
      void costToday()
        .then((v) => {
          if (alive) setToday(v > 0 ? v : null);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [lastRun]);

  const inFlight =
    status === "thinking" ||
    status === "streaming" ||
    status === "awaiting-approval";

  const runCost = useMemo(
    () =>
      estimateCost(modelId, {
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cachedInputTokens: tokens.cachedInputTokens,
      }),
    [modelId, tokens],
  );

  const hasTokens = lastInput > 0 || tokens.inputTokens > 0;
  if (today == null && !hasTokens && (!inFlight || runCost == null)) {
    return null;
  }

  let summaryText = "";
  if (inFlight && runCost != null && runCost > 0) {
    summaryText = `~$${runCost.toFixed(2)}`;
    if (hasTokens) {
      summaryText += ` · ${fmtK(lastInput || tokens.inputTokens)} tok`;
    }
  } else if (today != null && today > 0) {
    summaryText = `$${today.toFixed(2)}`;
  } else if (hasTokens) {
    summaryText = `${fmtK(lastInput || tokens.inputTokens)} tok`;
  }

  if (!summaryText) return null;

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-6 items-center gap-1 rounded-md px-1.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            popoverOpen && "bg-accent text-foreground",
          )}
          title="Telemetry breakdown: cost and token usage"
          aria-label="Telemetry breakdown"
        >
          <HugeiconsIcon
            icon={CoinsDollarIcon}
            size={11.5}
            strokeWidth={1.75}
            className={cn(
              "text-muted-foreground/80",
              inFlight && "animate-pulse text-amber-500 dark:text-amber-400",
            )}
          />
          <span className="font-mono tabular-nums">{summaryText}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={6}
        className="z-50 w-72 rounded-xl border border-border/80 bg-popover/95 p-3 text-xs shadow-xl backdrop-blur-md"
      >
        <div className="flex items-center justify-between border-b border-border/60 pb-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground/90">
            Agent Spend & Tokens
          </span>
          {inFlight && (
            <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
              In flight
            </span>
          )}
        </div>

        <div className="mt-2.5 flex flex-col gap-2">
          {today != null && (
            <div className="flex items-center justify-between rounded-lg bg-muted/40 px-2.5 py-1.5">
              <span className="text-[11px] text-muted-foreground">
                Today's Recorded Spend
              </span>
              <span className="font-mono text-[12px] font-medium text-foreground">
                ${today.toFixed(4)}
              </span>
            </div>
          )}

          {inFlight && runCost != null && (
            <div className="flex items-center justify-between rounded-lg bg-muted/40 px-2.5 py-1.5">
              <span className="text-[11px] text-muted-foreground">
                Current Run Estimate
              </span>
              <span className="font-mono text-[12px] font-medium text-foreground">
                ~${runCost.toFixed(4)}
              </span>
            </div>
          )}

          {hasTokens && (
            <div className="rounded-lg bg-muted/40 p-2.5">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Token Utilization
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div>
                  <div className="text-[10.5px] text-muted-foreground">
                    Last Input
                  </div>
                  <div className="font-mono font-medium text-foreground">
                    {fmtK(lastInput || tokens.inputTokens)} tokens
                  </div>
                </div>
                <div>
                  <div className="text-[10.5px] text-muted-foreground">
                    Run Output
                  </div>
                  <div className="font-mono font-medium text-foreground">
                    {fmtK(tokens.outputTokens)} tokens
                  </div>
                </div>
                {lastCached > 0 && (
                  <div className="col-span-2">
                    <div className="text-[10.5px] text-muted-foreground">
                      Cached Prompt Tokens
                    </div>
                    <div className="font-mono font-medium text-emerald-600 dark:text-emerald-400">
                      {fmtK(lastCached)} tokens saved
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              setPopoverOpen(false);
              onOpenDiag();
            }}
            className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg border border-border/60 bg-card py-1.5 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon
              icon={InspectCodeIcon}
              size={12}
              strokeWidth={1.75}
            />
            <span>Open Detailed Diagnostics</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
