import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { parseCommandLine, parseEnvLines } from "@/modules/ai/lib/mcpArgs";
import { mcpToolName } from "@/modules/ai/lib/mcpToolNames";
import { getMcpUsageForServer } from "@/modules/ai/lib/mcpUsage";
import {
  type McpServer,
  type McpTool,
  mcpAddServer,
  mcpListServers,
  mcpListTools,
  mcpPing,
  mcpRemoveServer,
  mcpSetToolEnabled,
} from "@/modules/mcp/bridge";
import {
  Add01Icon,
  Alert02Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  RefreshIcon,
  ToggleOnIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useId, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

function invalidateMcpTools(): void {
  void import("@/modules/ai/lib/mcpTools").then((m) => m.invalidateMcpTools());
}

const EXAMPLE = `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "..." }
    }
  }
}`;

type Probe =
  | { state: "idle" }
  | { state: "running" }
  | { state: "ok"; tools: McpTool[] }
  | { state: "failed"; reason: string };

/**
 * One configured server, with a way to check it actually starts.
 *
 * A registry entry is only a claim that a command exists; whether it runs and
 * answers is the thing users actually need to know, and finding out otherwise
 * means waiting for the agent to fail mid-task.
 */
function ServerRow({
  server,
  onRemoved,
  onChanged,
}: {
  server: McpServer;
  onRemoved: () => void;
  onChanged: () => void;
}) {
  const [probe, setProbe] = useState<Probe>({ state: "idle" });

  const test = useCallback(async () => {
    setProbe({ state: "running" });
    try {
      // Null workspace: the settings window has no active project, so the
      // probe reads the user-level registry only.
      const alive = await mcpPing(server.name, null);
      if (!alive) {
        setProbe({
          state: "failed",
          reason: "the server did not answer a ping",
        });
        return;
      }
      const listed = await mcpListTools(server.name, null);
      const disabled = server.disabled_tools ?? [];
      const disabledEntries: McpTool[] = disabled
        .filter((name) => !listed.tools.some((t) => t.name === name))
        .map((name) => ({
          name,
          description: "",
          inputSchema: {},
          enabled: false,
        }));
      setProbe({
        state: "ok",
        tools: [
          ...listed.tools.map((t) => ({ ...t, enabled: true })),
          ...disabledEntries,
        ],
      });
    } catch (e) {
      setProbe({ state: "failed", reason: String(e) });
    }
  }, [server.name, server.disabled_tools]);

  return (
    <div className="rounded-md border border-border/60 p-3">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium">{server.name}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {server.scope}
        </span>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          onClick={() => void test()}
          disabled={probe.state === "running"}
          className="h-7 gap-1.5 text-[11px]"
        >
          <HugeiconsIcon icon={RefreshIcon} size={12} strokeWidth={1.75} />
          {probe.state === "running" ? "Testing..." : "Test"}
        </Button>
        {/* Only user-scope entries: a project entry lives in the workspace
            file, which this panel does not manage. */}
        {server.scope === "user" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void mcpRemoveServer(server.name).then(() => {
                invalidateMcpTools();
                onRemoved();
              })
            }
            title={`Remove ${server.name}`}
            aria-label={`Remove ${server.name}`}
            className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive"
          >
            <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />
          </Button>
        )}
      </div>

      <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
        {server.command} {server.args.join(" ")}
      </p>

      {probe.state === "failed" && (
        <div className="mt-2 flex items-start gap-1.5 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
          <HugeiconsIcon
            icon={Alert02Icon}
            size={12}
            strokeWidth={1.75}
            className="mt-0.5 shrink-0"
          />
          <span className="min-w-0 break-words">{probe.reason}</span>
        </div>
      )}

      {probe.state === "ok" && (
        <div className="mt-2">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              size={12}
              strokeWidth={1.75}
              className="text-emerald-500"
            />
            {probe.tools.length === 0
              ? "Started, but exposes no tools."
              : `${probe.tools.length} tool(s), offered to the agent as:`}
          </div>
          {probe.tools.length > 0 && (
            <ul className="mt-1 flex flex-col gap-0.5">
              {probe.tools.map((t) => (
                <ToolRow
                  key={t.name}
                  server={server}
                  tool={t}
                  onChanged={onChanged}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Run the enable/disable toggle for one tool: persist, invalidate the agent
 * toolset, then refresh. Extracted so the wiring is testable without DOM.
 */
export async function toggleMcpTool(
  serverName: string,
  toolName: string,
  enabled: boolean,
  deps: {
    setToolEnabled: typeof mcpSetToolEnabled;
    invalidate: typeof invalidateMcpTools;
    onChanged: () => void;
  },
): Promise<void> {
  await deps.setToolEnabled(serverName, toolName, !enabled);
  deps.invalidate();
  deps.onChanged();
}

/**
 * One tool with a per-tool enable/disable toggle.
 *
 * Disabled tools are filtered out of the agent's toolset and rejected at the
 * execute layer, so a noisy or dangerous tool can stay installed but silent.
 * Toggling re-probes the server so the list reflects the new state.
 */
function ToolRow({
  server,
  tool,
  onChanged,
}: {
  server: McpServer;
  tool: McpTool;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const enabled = tool.enabled ?? true;
  const used = getMcpUsageForServer(server.name).find(
    (u) => u.tool === tool.name,
  );
  return (
    <li className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void toggleMcpTool(server.name, tool.name, enabled, {
            setToolEnabled: mcpSetToolEnabled,
            invalidate: invalidateMcpTools,
            onChanged,
          }).finally(() => setBusy(false));
        }}
        title={`${enabled ? "Disable" : "Enable"} ${tool.name}`}
        aria-label={`${enabled ? "Disable" : "Enable"} ${tool.name}`}
        className="shrink-0 rounded p-0.5 hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        <HugeiconsIcon
          icon={ToggleOnIcon}
          size={11}
          strokeWidth={1.75}
          className={
            enabled ? "text-foreground/80" : "text-muted-foreground/50"
          }
        />
      </button>
      <span
        className={`truncate ${enabled ? "" : "line-through opacity-60"}`}
        title={
          tool.description +
          (used
            ? ` Used ${used.calls}x${used.errors ? `, ${used.errors} failed` : ""} this session.`
            : "")
        }
      >
        {mcpToolName(server.name, tool.name)}
        {used && used.calls > 0 && (
          <span className="ml-1 text-muted-foreground/70 no-underline">
            {used.calls}x{used.errors > 0 ? `!${used.errors}` : ""}
          </span>
        )}
      </span>
    </li>
  );
}

/**
 * Add a server without hand-editing JSON.
 *
 * The command is one free-text line because that is how every server is
 * documented - `npx -y @scope/server`. A structured array field would make the
 * common case harder than the file editing this replaces.
 */
function AddServerForm({ onAdded }: { onAdded: () => void }) {
  const fid = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [commandLine, setCommandLine] = useState("");
  const [envText, setEnvText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setName("");
    setCommandLine("");
    setEnvText("");
    setError(null);
  };

  const save = async () => {
    setError(null);
    const { command, args } = parseCommandLine(commandLine);
    if (!name.trim()) return setError("Give the server a name.");
    if (!command) return setError("Enter the command that starts the server.");
    setSaving(true);
    try {
      await mcpAddServer({
        name: name.trim(),
        command,
        args,
        env: parseEnvLines(envText),
      });
      invalidateMcpTools();
      reset();
      setOpen(false);
      onAdded();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        className="h-7 w-fit gap-1.5 text-[11px]"
      >
        <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
        Add a server
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/60 p-3">
      <label htmlFor={`${fid}-name`} className="text-[11px] font-medium">
        Name
      </label>
      <Input
        id={`${fid}-name`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="github"
        className="h-8 text-[12px]"
      />

      <label htmlFor={`${fid}-command`} className="text-[11px] font-medium">
        Command
      </label>
      <Input
        id={`${fid}-command`}
        value={commandLine}
        onChange={(e) => setCommandLine(e.target.value)}
        placeholder="npx -y @modelcontextprotocol/server-github"
        className="h-8 font-mono text-[11px]"
      />

      <label htmlFor={`${fid}-env`} className="text-[11px] font-medium">
        Environment{" "}
        <span className="text-muted-foreground">
          (optional, one KEY=value per line)
        </span>
      </label>
      <Textarea
        id={`${fid}-env`}
        value={envText}
        onChange={(e) => setEnvText(e.target.value)}
        placeholder="GITHUB_TOKEN=..."
        rows={3}
        className="font-mono text-[11px]"
      />

      {error && <p className="text-[11px] text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={saving}
          className="h-7 text-[11px]"
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          className="h-7 text-[11px]"
        >
          Cancel
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Saved to ~/.termigo/mcp.json, so it applies to every project. Test it
        below once saved.
      </p>
    </div>
  );
}

export function McpSection() {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      // Null workspace: this window has no active project, so only the
      // user-level registry is readable here. Project servers still work at
      // runtime; see the note below.
      setServers(await mcpListServers(null));
    } catch (e) {
      setServers([]);
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="MCP servers"
        description="Model Context Protocol servers whose tools are offered to the agent."
      />

      <div className="flex items-center gap-2">
        <AddServerForm onAdded={() => void load()} />
        <Button
          size="sm"
          variant="outline"
          onClick={() => void load()}
          className="h-7 gap-1.5 text-[11px]"
        >
          <HugeiconsIcon icon={RefreshIcon} size={12} strokeWidth={1.75} />
          Reload
        </Button>
      </div>

      {error && (
        <p className="text-[11px] text-destructive">
          Could not read the registry: {error}
        </p>
      )}

      {servers === null ? (
        <p className="text-[12px] text-muted-foreground">Loading…</p>
      ) : servers.length === 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-[12px] text-muted-foreground">
            No servers configured yet. Create{" "}
            <code className="font-mono text-[11px]">~/.termigo/mcp.json</code>{" "}
            with the standard{" "}
            <code className="font-mono text-[11px]">mcpServers</code> shape:
          </p>
          <pre className="overflow-x-auto rounded-md border border-border/60 bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
            {EXAMPLE}
          </pre>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {servers.map((s) => (
            <ServerRow
              key={`${s.scope}:${s.name}`}
              server={s}
              onRemoved={() => void load()}
              onChanged={() => void load()}
            />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-muted/20 p-3 text-[11px] text-muted-foreground">
        <p>
          This window has no active project, so only{" "}
          <code className="font-mono">~/.termigo/mcp.json</code> is listed here.
          Per-project servers in{" "}
          <code className="font-mono">&lt;workspace&gt;/.termigo/mcp.json</code>{" "}
          are still picked up when the agent runs, and override a user entry of
          the same name.
        </p>
        <p>
          MCP tools always ask for approval, including under{" "}
          <em>Auto-approve edits</em> - that mode covers files in your
          workspace, not arbitrary third-party actions.
        </p>
      </div>
    </div>
  );
}
