import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { loadFrontier, resetFrontier } from "@/modules/ai/lib/harnessFrontier";
import {
  BUILTIN_PROFILES,
  DEFAULT_PROFILE_ID,
  getProfile,
  type HarnessProfile,
} from "@/modules/ai/lib/harnessProfile";
import { useHarnessProfileStore } from "@/modules/ai/lib/harnessProfileStore";
import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

type FrontierGroup = {
  id: string;
  runs: number;
  successes: number;
  totalSteps: number;
  rate: number;
};

type FrontierSummary = {
  groups: FrontierGroup[];
  best: FrontierGroup | null;
};

function summarizeFrontier(
  record: Awaited<ReturnType<typeof loadFrontier>>,
): FrontierSummary {
  const map = new Map<string, FrontierGroup>();
  for (const [key, stats] of Object.entries(record)) {
    const id = key.includes("::") ? key.slice(key.indexOf("::") + 2) : key;
    const prev = map.get(id) ?? {
      id,
      runs: 0,
      successes: 0,
      totalSteps: 0,
      rate: 0,
    };
    prev.runs += stats.runs;
    prev.successes += stats.successes;
    prev.totalSteps += stats.totalSteps;
    map.set(id, prev);
  }
  const groups = [...map.values()].map((g) => ({
    ...g,
    rate: g.runs ? g.successes / g.runs : 0,
  }));
  groups.sort((a, b) => b.rate - a.rate || b.runs - a.runs);
  return { groups, best: groups[0] ?? null };
}

export function HarnessSection() {
  const byWorkspace = useHarnessProfileStore((s) => s.byWorkspace);
  const setActiveProfile = useHarnessProfileStore((s) => s.setActiveProfile);
  const defaultId = byWorkspace.__default ?? DEFAULT_PROFILE_ID;
  const active = getProfile(defaultId);

  const [frontier, setFrontier] = useState<FrontierSummary>({
    groups: [],
    best: null,
  });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const record = await loadFrontier();
      setFrontier(summarizeFrontier(record));
    } catch {
      setFrontier({ groups: [], best: null });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const profileList = useMemo(() => Object.values(BUILTIN_PROFILES), []);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Agent harness"
        description="Harness profiles tune how the agent is driven: the system prompt prelude, which tools are exposed and in what order, and the loop budget. Pick a default for all workspaces here; the active profile for a specific workspace can be chosen at runtime."
      />

      <div className="space-y-3">
        <span className="block text-[12.5px] font-medium">Default profile</span>
        <Select
          value={defaultId}
          onValueChange={(v) => setActiveProfile(null, v)}
        >
          <SelectTrigger className="h-8 w-full text-[11.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {profileList.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11.5px] text-muted-foreground">
          {active.description}
        </p>
      </div>

      <div className="space-y-2">
        {profileList.map((p) => (
          <ProfileCard
            key={p.id}
            profile={p}
            active={p.id === defaultId}
            onSelect={() => setActiveProfile(null, p.id)}
          />
        ))}
      </div>

      <div className="rounded-lg border border-border/60 p-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-semibold">Frontier</h3>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px]"
            disabled={loading || frontier.groups.length === 0}
            onClick={() => void resetFrontier().then(refresh)}
          >
            Reset
          </Button>
        </div>
        <p className="mt-1 text-[11.5px] text-muted-foreground">
          Records how each harness profile performed on verifiable runs. The
          best default for aggregate runs is shown below.
        </p>
        {loading ? (
          <p className="mt-2 text-[11.5px] text-muted-foreground">Loading…</p>
        ) : frontier.groups.length === 0 ? (
          <p className="mt-2 text-[11.5px] text-muted-foreground">
            No runs recorded yet — the frontier fills in as the agent completes
            tasks.
          </p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {frontier.groups.map((g) => (
              <div
                key={g.id}
                className="flex items-center justify-between rounded border border-border/50 px-2.5 py-1.5 text-[11.5px]"
              >
                <span className="font-medium">{getProfile(g.id).label}</span>
                <span className="text-muted-foreground">
                  {g.runs} run{g.runs === 1 ? "" : "s"} ·{" "}
                  {Math.round(g.rate * 100)}% clean
                </span>
              </div>
            ))}
            {frontier.best && (
              <p className="pt-0.5 text-[11px] text-muted-foreground">
                Suggested:{" "}
                <span className="font-medium text-foreground">
                  {getProfile(frontier.best.id).label}
                </span>
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ProfileCard({
  profile,
  active,
  onSelect,
}: {
  profile: HarnessProfile;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
        active
          ? "border-primary/60 bg-accent/40"
          : "border-border/60 hover:bg-accent",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          active
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/40",
        )}
      >
        {active && (
          <HugeiconsIcon
            icon={CheckmarkCircle02Icon}
            size={12}
            strokeWidth={2}
          />
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">{profile.label}</span>
        <span className="block text-[11.5px] text-muted-foreground">
          {profile.description}
        </span>
      </span>
    </button>
  );
}
