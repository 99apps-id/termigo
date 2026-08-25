import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Add01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SQL_ENGINES, runSql, type SqlEngine } from "@/modules/ai/sqlexplorer/bridge";
import { useSqlConnectionsStore } from "@/modules/ai/sqlexplorer/connectionsStore";
import type { SqlConnection } from "@/modules/ai/sqlexplorer/bridge";

type Probe = { state: "idle" } | { state: "running" } | { state: "ok" } | { state: "failed"; reason: string };

function ConnectionRow({
  connection,
  onRemoved,
}: {
  connection: SqlConnection;
  onRemoved: () => void;
}) {
  const [probe, setProbe] = useState<Probe>({ state: "idle" });

  const test = async () => {
    setProbe({ state: "running" });
    try {
      await runSql(connection.engine, connection.connection, "SELECT 1;");
      setProbe({ state: "ok" });
    } catch (e) {
      setProbe({ state: "failed", reason: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium">{connection.name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {connection.engine} · {connection.connection}
        </div>
        {probe.state === "failed" && (
          <div className="text-xs text-destructive">{probe.reason}</div>
        )}
        {probe.state === "ok" && (
          <div className="text-xs text-emerald-500">Query OK</div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={test}
          disabled={probe.state === "running"}
        >
          Test
        </Button>
        <Button variant="ghost" size="sm" onClick={onRemoved} aria-label={`Remove ${connection.name}`}>
          <HugeiconsIcon icon={Delete02Icon} size={16} />
        </Button>
      </div>
    </div>
  );
}

export function SqlSection() {
  const connections = useSqlConnectionsStore((s) => s.connections);
  const addConnection = useSqlConnectionsStore((s) => s.addConnection);
  const removeConnection = useSqlConnectionsStore((s) => s.removeConnection);

  const [name, setName] = useState("");
  const [engine, setEngine] = useState<SqlEngine>("sqlite3");
  const [connection, setConnection] = useState("");

  const add = () => {
    const trimmedName = name.trim();
    const trimmedConn = connection.trim();
    if (!trimmedName || !trimmedConn) return;
    addConnection({ name: trimmedName, engine, connection: trimmedConn });
    setName("");
    setConnection("");
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="SQL Explorer"
        description="Save database connections the agent can query with run_sql. The query is piped over stdin to a local CLI (sqlite3, duckdb, psql, mysql); install the CLI for the engine you use."
      />

      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Connection name"
            className="w-48"
          />
          <select
            value={engine}
            onChange={(e) => setEngine(e.target.value as SqlEngine)}
            className="w-36 rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          >
            {SQL_ENGINES.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
          <Input
            value={connection}
            onChange={(e) => setConnection(e.target.value)}
            placeholder="Connection string or file path"
            className="flex-1"
          />
          <Button onClick={add} disabled={!name.trim() || !connection.trim()}>
            <HugeiconsIcon icon={Add01Icon} size={16} />
            Add
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No connections yet. Add one above.
          </p>
        ) : (
          connections.map((c) => (
            <ConnectionRow key={c.id} connection={c} onRemoved={() => removeConnection(c.id)} />
          ))
        )}
      </div>
    </div>
  );
}
