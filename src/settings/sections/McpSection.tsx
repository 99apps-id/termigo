import { Button } from "@/components/ui/button";
import {
  mcpListServers,
  mcpListTools,
  mcpPing,
  type McpServer,
  type McpTool,
} from "@/modules/mcp/bridge";
import { mcpToolName } from "@/modules/ai/lib/mcpToolNames";
import {
  CheckmarkCircle02Icon,
  Alert02Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

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
function ServerRow({ server }: { server: McpServer }) {
  const [probe, setProbe] = useState<Probe>({ state: "idle" });

  const test = useCallback(async () => {
    setProbe({ state: "running" });
    try {
      const alive = await mcpPing(server.name, null);
      if (!alive) {
        setProbe({ state: "failed", reason: "the server did not answer a ping" });
        return;
      }
      const listed = await mcpListTools(server.name, null);
      setProbe({ state: "ok", tools: listed.tools });
    } catch (e) {
      setProbe({ state: "failed", reason: String(e) });
    }
  }, [server.name]);

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
          {probe.state === "running" ? "Testing…" : "Test"}
        </Button>
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
                <li
                  key={t.name}
                  className="truncate font-mono text-[10px] text-muted-foreground"
                  title={t.description}
                >
                  {mcpToolName(server.name, t.name)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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
        <Button
          size="sm"
          variant="outline"
          onClick={() => void load()}
          className="h-7 gap-1.5 text-[11px]"
        >
          <HugeiconsIcon icon={RefreshIcon} size={12} strokeWidth={1.75} />
          Reload registry
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
            with the standard <code className="font-mono text-[11px]">mcpServers</code>{" "}
            shape:
          </p>
          <pre className="overflow-x-auto rounded-md border border-border/60 bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
            {EXAMPLE}
          </pre>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {servers.map((s) => (
            <ServerRow key={`${s.scope}:${s.name}`} server={s} />
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
          <em>Auto-approve edits</em> — that mode covers files in your workspace,
          not arbitrary third-party actions.
        </p>
      </div>
    </div>
  );
}
