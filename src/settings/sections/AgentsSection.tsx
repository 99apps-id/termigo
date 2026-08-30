import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { AGENT_ICONS } from "@/modules/ai/components/AgentSwitcher";
import {
  compatModelIdForEndpoint,
  isCompatModelId,
  MODELS,
} from "@/modules/ai/config";
import {
  type Agent,
  type AgentIconId,
  BUILTIN_AGENTS,
} from "@/modules/ai/lib/agents";
import {
  clearCostLedger,
  costToday,
  loadCostLedger,
  sumCost,
} from "@/modules/ai/lib/costLedger";
import {
  isValidHandle,
  normalizeHandle,
  type Snippet,
} from "@/modules/ai/lib/snippets";
import { newAgentId, useAgentsStore } from "@/modules/ai/store/agentsStore";
import {
  newSnippetId,
  useSnippetsStore,
} from "@/modules/ai/store/snippetsStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setAgentReviewAfterApply,
  setAutoApproveInScopeScans,
  setAutoCheckpoint,
  setCostBudgetUsd,
  setCostDailyBudgetUsd,
  setCustomInstructions,
  setDebugCaptureEnabled,
  setEnforcePentestScope,
  setPentestScope,
  setSubagentModelId,
} from "@/modules/settings/store";
import {
  Add01Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  Edit02Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";
import { TelegramBlock } from "./TelegramBlock";

const ICON_OPTIONS: AgentIconId[] = [
  "coder",
  "architect",
  "reviewer",
  "security",
  "designer",
  "spark",
];

export function AgentsSection() {
  const customInstructions = usePreferencesStore((s) => s.customInstructions);
  const debugCaptureEnabled = usePreferencesStore((s) => s.debugCaptureEnabled);
  const agentReviewAfterApply = usePreferencesStore(
    (s) => s.agentReviewAfterApply,
  );
  const autoCheckpoint = usePreferencesStore((s) => s.autoCheckpoint);
  const costBudgetUsd = usePreferencesStore((s) => s.costBudgetUsd);
  const costDailyBudgetUsd = usePreferencesStore((s) => s.costDailyBudgetUsd);
  const subagentModelId = usePreferencesStore((s) => s.subagentModelId);
  const customEndpoints = usePreferencesStore((s) => s.customEndpoints);

  // Fall back to "auto" if the stored id no longer resolves (a deleted custom
  // endpoint), so the select never renders with a value it has no item for.
  const subagentModelValue =
    subagentModelId &&
    (MODELS.some((m) => m.id === subagentModelId) ||
      (isCompatModelId(subagentModelId) &&
        customEndpoints.some(
          (ep) => compatModelIdForEndpoint(ep.id) === subagentModelId,
        )))
      ? subagentModelId
      : "auto";
  const customAgents = useAgentsStore((s) => s.customAgents);
  const activeAgentId = useAgentsStore((s) => s.activeId);
  const setActiveAgentId = useAgentsStore((s) => s.setActiveId);
  const upsertAgent = useAgentsStore((s) => s.upsert);
  const removeAgent = useAgentsStore((s) => s.remove);
  const hydrateAgents = useAgentsStore((s) => s.hydrate);

  const snippets = useSnippetsStore((s) => s.snippets);
  const upsertSnippet = useSnippetsStore((s) => s.upsert);
  const removeSnippet = useSnippetsStore((s) => s.remove);
  const hydrateSnippets = useSnippetsStore((s) => s.hydrate);

  useEffect(() => {
    void hydrateAgents();
    void hydrateSnippets();
  }, [hydrateAgents, hydrateSnippets]);

  const [todayUsd, setTodayUsd] = useState<number | null>(null);
  const [totalUsd, setTotalUsd] = useState<number | null>(null);

  const refreshCost = () => {
    void costToday()
      .then(setTodayUsd)
      .catch(() => setTodayUsd(null));
    void loadCostLedger()
      .then((entries) => setTotalUsd(sumCost(entries)))
      .catch(() => setTotalUsd(null));
  };

  useEffect(refreshCost, []);

  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title="Agents"
        description="Personas and snippets the AI uses. Switch agents from the input bar."
      />

      <CustomInstructionsBlock value={customInstructions} />

      <PentestScopeBlock />

      <TelegramBlock />

      <section className="flex flex-col gap-2">
        <Label>Diagnostics</Label>
        <SettingRow
          title="Capture requests"
          description="Record each request the agent assembles — system prompt, message history, attached tools — so a failure can be read rather than guessed at. Kept in memory only, never written to disk, and cleared when Termigo closes. Open the inspector from the icon in the AI bar."
        >
          <Switch
            checked={debugCaptureEnabled}
            onCheckedChange={(v) => void setDebugCaptureEnabled(v)}
          />
        </SettingRow>
        <SettingRow
          title="Review edits after applying"
          description="Keep the AI diff tab open after a file edit is applied so you can review what changed, and close it when the run finishes. Turn off for the previous behavior (the tab closes once you approve)."
        >
          <Switch
            checked={agentReviewAfterApply}
            onCheckedChange={(v) => void setAgentReviewAfterApply(v)}
          />
        </SettingRow>
        <SettingRow
          title="Auto-checkpoint before runs"
          description="Snapshot the working tree as a checkpoint commit before every agent run, so a bad run can be rolled back from the Checkpoints timeline in Source Control. Requires a Git repository."
        >
          <Switch
            checked={autoCheckpoint}
            onCheckedChange={(v) => void setAutoCheckpoint(v)}
          />
        </SettingRow>
        <SettingRow
          title="Cost budget (USD)"
          description="Maximum cost per agent session. 0 = unlimited. Enforced after each step."
        >
          <Input
            type="number"
            value={costBudgetUsd}
            onChange={(e) => void setCostBudgetUsd(Number(e.target.value) || 0)}
            className="w-full"
            min={0}
            step={0.01}
          />
        </SettingRow>
        <SettingRow
          title="Daily cost budget (USD)"
          description="Maximum cost per calendar day across all sessions. 0 = unlimited. New runs are refused once today's recorded spend reaches this."
        >
          <Input
            type="number"
            value={costDailyBudgetUsd}
            onChange={(e) =>
              void setCostDailyBudgetUsd(Number(e.target.value) || 0)
            }
            className="w-full"
            min={0}
            step={0.01}
          />
        </SettingRow>
        <SettingRow
          title="Recorded cost"
          description={
            todayUsd == null || totalUsd == null
              ? "Cost of finished agent runs, kept for 92 days."
              : `$${todayUsd.toFixed(4)} today, $${totalUsd.toFixed(4)} all time. Kept for 92 days.`
          }
        >
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => {
              void clearCostLedger().then(refreshCost);
            }}
          >
            Clear
          </Button>
        </SettingRow>
        <SettingRow
          title="Subagent model"
          description="Model spawned sub-agents run on. Pick a cheap or local model to do the fan-out while the main run keeps the frontier model. 'Same as main run' inherits the orchestrator's model."
        >
          <Select
            value={subagentModelValue}
            onValueChange={(v) =>
              void setSubagentModelId(v === "auto" ? "" : v)
            }
          >
            <SelectTrigger size="sm" className="h-8 w-56 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto" className="text-[12px]">
                Same as main run
              </SelectItem>
              {MODELS.map((m) => (
                <SelectItem key={m.id} value={m.id} className="text-[12px]">
                  {m.label}
                </SelectItem>
              ))}
              {customEndpoints.map((ep) => (
                <SelectItem
                  key={ep.id}
                  value={compatModelIdForEndpoint(ep.id)}
                  className="text-[12px]"
                >
                  {ep.modelId || ep.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label>Agents</Label>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-[11px]"
            onClick={() =>
              setEditingAgent({
                id: newAgentId(),
                name: "New agent",
                description: "",
                instructions: "",
                icon: "spark",
                builtIn: false,
              })
            }
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
            New agent
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {[...BUILTIN_AGENTS, ...customAgents].map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              active={a.id === activeAgentId}
              onActivate={() => setActiveAgentId(a.id)}
              onEdit={a.builtIn ? null : () => setEditingAgent(a)}
              onDelete={a.builtIn ? null : () => removeAgent(a.id)}
            />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <Label>Snippets</Label>
            <span className="text-[10.5px] text-muted-foreground">
              Reusable instructions you can drop into any prompt with{" "}
              <code className="rounded bg-muted/50 px-1 font-mono">
                #handle
              </code>
              .
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-[11px]"
            onClick={() =>
              setEditingSnippet({
                id: newSnippetId(),
                handle: "",
                name: "",
                description: "",
                content: "",
              })
            }
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
            New snippet
          </Button>
        </div>

        {snippets.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-6 text-center text-[11px] text-muted-foreground">
            No snippets yet. Create one and insert it with{" "}
            <code className="font-mono">#handle</code> in the AI input.
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {snippets.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2"
              >
                <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                  #{s.handle}
                </code>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12px] font-medium">
                    {s.name}
                  </span>
                  {s.description ? (
                    <span className="truncate text-[10.5px] text-muted-foreground">
                      {s.description}
                    </span>
                  ) : null}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={() => setEditingSnippet(s)}
                  title="Edit"
                >
                  <HugeiconsIcon
                    icon={Edit02Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 text-muted-foreground hover:text-destructive"
                  onClick={() => removeSnippet(s.id)}
                  title="Delete"
                >
                  <HugeiconsIcon
                    icon={Delete02Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AgentEditorDialog
        agent={editingAgent}
        existing={customAgents}
        onClose={() => setEditingAgent(null)}
        onSave={(a) => {
          upsertAgent(a);
          setEditingAgent(null);
        }}
      />
      <SnippetEditorDialog
        snippet={editingSnippet}
        existing={snippets}
        onClose={() => setEditingSnippet(null)}
        onSave={(s) => {
          upsertSnippet(s);
          setEditingSnippet(null);
        }}
      />
    </div>
  );
}

function AgentCard({
  agent,
  active,
  onActivate,
  onEdit,
  onDelete,
}: {
  agent: Agent;
  active: boolean;
  onActivate: () => void;
  onEdit: (() => void) | null;
  onDelete: (() => void) | null;
}) {
  const Icon = AGENT_ICONS[agent.icon] ?? SparklesIcon;
  return (
    <div
      className={cn(
        "group relative flex flex-col gap-1.5 rounded-lg border bg-card/60 px-3 py-2.5 transition-colors",
        active
          ? "border-foreground/30 ring-1 ring-foreground/10"
          : "border-border/60 hover:border-border",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/40">
          <HugeiconsIcon icon={Icon} size={14} strokeWidth={1.5} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
            {agent.name}
            {agent.builtIn ? (
              <span className="rounded bg-muted/50 px-1 py-0.5 text-[9px] tracking-wide text-muted-foreground uppercase">
                Built-in
              </span>
            ) : null}
          </span>
          <span className="line-clamp-2 text-[10.5px] leading-relaxed text-muted-foreground">
            {agent.description}
          </span>
        </div>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-1">
        <Button
          size="sm"
          variant={active ? "default" : "outline"}
          onClick={onActivate}
          className="h-6 gap-1 px-2 text-[10.5px]"
        >
          {active ? (
            <>
              <HugeiconsIcon
                icon={CheckmarkCircle02Icon}
                size={10}
                strokeWidth={2}
              />
              Active
            </>
          ) : (
            "Use agent"
          )}
        </Button>
        <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {onEdit ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              onClick={onEdit}
              title="Edit"
            >
              <HugeiconsIcon icon={Edit02Icon} size={11} strokeWidth={1.75} />
            </Button>
          ) : null}
          {onDelete ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-6 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
              title="Delete"
            >
              <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.75} />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AgentEditorDialog({
  agent,
  existing,
  onClose,
  onSave,
}: {
  agent: Agent | null;
  existing: Agent[];
  onClose: () => void;
  onSave: (a: Agent) => void;
}) {
  const [draft, setDraft] = useState<Agent | null>(agent);
  useEffect(() => setDraft(agent), [agent]);
  if (!draft) return null;

  const isNew = !existing.some((a) => a.id === draft.id);
  const canSave =
    draft.name.trim().length > 0 && draft.instructions.trim().length > 0;

  return (
    <Dialog open={!!agent} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {isNew ? "New agent" : "Edit agent"}
          </DialogTitle>
        </DialogHeader>
        <div className="-mx-2 max-h-[calc(100vh-14rem)] overflow-y-auto px-2 flex flex-col gap-3">
          <div className="flex gap-2">
            <div className="flex flex-col gap-1">
              <Label>Icon</Label>
              <div className="flex flex-wrap gap-1">
                {ICON_OPTIONS.map((id) => {
                  const Icon = AGENT_ICONS[id] ?? SparklesIcon;
                  const active = draft.icon === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setDraft({ ...draft, icon: id })}
                      className={cn(
                        "flex size-7 items-center justify-center rounded-md border transition-colors",
                        active
                          ? "border-foreground/40 bg-accent"
                          : "border-border/60 hover:bg-accent/40",
                      )}
                    >
                      <HugeiconsIcon icon={Icon} size={13} strokeWidth={1.75} />
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <Label>Name</Label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="h-8 text-[12px]"
                placeholder="e.g. Test Engineer"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label>Description</Label>
            <Input
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
              placeholder="One line — shown in the agent picker"
              className="h-8 text-[12px]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Instructions</Label>
            <Textarea
              value={draft.instructions}
              onChange={(e) =>
                setDraft({ ...draft, instructions: e.target.value })
              }
              placeholder="Persona & rules. Appended to Termigo's core system prompt."
              className="min-h-40 resize-y text-[12px] leading-relaxed"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canSave}
            onClick={() => onSave({ ...draft, builtIn: false })}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SnippetEditorDialog({
  snippet,
  existing,
  onClose,
  onSave,
}: {
  snippet: Snippet | null;
  existing: Snippet[];
  onClose: () => void;
  onSave: (s: Snippet) => void;
}) {
  const [draft, setDraft] = useState<Snippet | null>(snippet);
  useEffect(() => setDraft(snippet), [snippet]);
  if (!draft) return null;

  const handleErr = !draft.handle
    ? "Required."
    : !isValidHandle(draft.handle)
      ? "Lowercase letters, digits, and dashes only."
      : existing.some((s) => s.id !== draft.id && s.handle === draft.handle)
        ? "Already in use."
        : null;
  const canSave =
    !handleErr &&
    draft.name.trim().length > 0 &&
    draft.content.trim().length > 0;

  return (
    <Dialog open={!!snippet} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {existing.some((s) => s.id === draft.id)
              ? "Edit snippet"
              : "New snippet"}
          </DialogTitle>
        </DialogHeader>
        <div className="-mx-2 max-h-[calc(100vh-14rem)] overflow-y-auto px-2 flex flex-col gap-3">
          <div className="flex gap-2">
            <div className="flex w-32 flex-col gap-1">
              <Label>Handle</Label>
              <div className="relative">
                <span className="absolute top-1/2 left-2 -translate-y-1/2 font-mono text-[11.5px] text-muted-foreground">
                  #
                </span>
                <Input
                  value={draft.handle}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      handle: normalizeHandle(e.target.value),
                    })
                  }
                  placeholder="review"
                  className="h-8 pl-5 font-mono text-[11.5px]"
                />
              </div>
              {handleErr ? (
                <span className="text-[10px] text-destructive">
                  {handleErr}
                </span>
              ) : null}
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <Label>Name</Label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="e.g. Pre-merge review checklist"
                className="h-8 text-[12px]"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label>Description</Label>
            <Input
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
              placeholder="One line — shown in the # picker"
              className="h-8 text-[12px]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Content</Label>
            <Textarea
              value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
              placeholder="Inserted into the prompt as a <snippet> block when you use #handle."
              className="min-h-40 resize-y font-mono text-[11.5px] leading-relaxed"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSave} onClick={() => onSave(draft)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PentestScopeBlock() {
  const scope = usePreferencesStore((s) => s.pentestScope);
  const enforce = usePreferencesStore((s) => s.enforcePentestScope);
  const autoApprove = usePreferencesStore((s) => s.autoApproveInScopeScans);
  const [draft, setDraft] = useState("");

  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (!scope.includes(v)) void setPentestScope([...scope, v]);
    setDraft("");
  };
  const remove = (entry: string) =>
    void setPentestScope(scope.filter((e) => e !== entry));

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col">
        <Label>Pentest scope</Label>
        <span className="text-[10.5px] text-muted-foreground">
          Off by default: the agent may run scanners against any target, so
          auditing your own domains needs no setup. Denial-of-service tooling is
          always refused. Turn on enforcement to restrict offensive tools to the
          list below (shared with the Pentest panel).
        </span>
      </div>
      <SettingRow
        title="Enforce scope"
        description="When on, offensive commands (nmap, ffuf, sqlmap, …) aimed outside the list are refused at the shell, and the Pentest panel's tools follow the same list."
      >
        <Switch
          checked={enforce}
          onCheckedChange={(v) => void setEnforcePentestScope(v)}
        />
      </SettingRow>
      {!enforce ? null : (
        <>
          <div className="flex gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder="example.com, 10.0.0.0, https://app.example.com"
              className="h-8 flex-1 text-[12px]"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-3 text-[11px]"
              onClick={add}
            >
              Add
            </Button>
          </div>
          {scope.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {scope.map((entry) => (
                <li
                  key={entry}
                  className="flex items-center gap-1.5 rounded-full border border-border/60 bg-card/60 py-1 pr-1 pl-2.5 text-[11px]"
                >
                  <span className="font-mono">{entry}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-5 text-muted-foreground hover:text-destructive"
                    onClick={() => remove(entry)}
                    title={`Remove ${entry}`}
                  >
                    <HugeiconsIcon
                      icon={Delete02Icon}
                      size={10}
                      strokeWidth={1.75}
                    />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-4 text-center text-[11px] text-muted-foreground">
              No authorized targets. Add at least one, or offensive tools are
              refused while enforcement is on.
            </div>
          )}
          <SettingRow
            title="Auto-approve in-scope scans"
            description="Let a read-tier scan (nmap -sV, ffuf, dig, …) against an in-scope target run without an approval prompt. Exploit-grade tools (sqlmap, hydra, msfconsole, …) always ask. Off by default."
          >
            <Switch
              checked={autoApprove}
              onCheckedChange={(v) => void setAutoApproveInScopeScans(v)}
            />
          </SettingRow>
        </>
      )}
    </section>
  );
}

function CustomInstructionsBlock({ value }: { value: string }) {
  const [draft, setDraft] = useState(value);
  const hadFirstSync = useRef(false);

  useEffect(() => {
    if (!hadFirstSync.current) {
      hadFirstSync.current = true;
      setDraft(value);
    }
  }, [value]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>Custom instructions</Label>
        {/* {savedTick > 0 ? (
          <span className="text-[10px] text-muted-foreground">Saved</span>
        ) : null} */}
        {draft && (
          <Button size="xs" onClick={() => void setCustomInstructions(draft)}>
            Save
          </Button>
        )}
      </div>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="e.g. Always reply in concise bullet points. Prefer pnpm over npm. My machine is an M-series Mac."
        className="min-h-[100px] resize-y bg-card/60 font-sans text-[12px] leading-relaxed border border-border"
      />
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}
