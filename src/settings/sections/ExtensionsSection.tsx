import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { useExtensionsStore } from "@/modules/extensions/store";
import type { InstalledExtension } from "@/modules/extensions/loader";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

/** Mirrors the Rust `PeekResult` returned by `ext_peek_zip` / `ext_peek_github`. */
type PeekResult = {
  manifest: {
    id: string;
    name: string;
    version: string;
    description?: string;
    icon?: string;
    permissions?: string[];
  };
  icon_base64?: string | null;
  icon_rel_path?: string | null;
  source: string;
};

type InstallSpec =
  | { kind: "zip"; path: string }
  | { kind: "github"; repo: string };

function sourceLabel(source: string): string {
  if (source.startsWith("github:")) return "GitHub";
  if (source.startsWith("local:")) return "Local zip";
  return source;
}

function PermissionLabel({ permission }: { permission: string }) {
  const [category, ...rest] = permission.split(":");
  const detail = rest.join(":");
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
      <span className="font-medium text-foreground">{category}</span>
      {detail ? `:${detail}` : ""}
    </code>
  );
}

export function ExtensionsSection() {
  const list = useExtensionsStore((s) => s.list);
  const hydrated = useExtensionsStore((s) => s.hydrated);
  const lastError = useExtensionsStore((s) => s.lastError);
  const init = useExtensionsStore((s) => s.init);
  const install = useExtensionsStore((s) => s.install);
  const checkAllUpdates = useExtensionsStore((s) => s.checkAllUpdates);

  const [repoInput, setRepoInput] = useState("");
  const [installing, setInstalling] = useState(false);
  const [peek, setPeek] = useState<{ result: PeekResult; spec: InstallSpec } | null>(null);

  const runPeekInstall = async (spec: InstallSpec, result: PeekResult) => {
    setInstalling(true);
    try {
      await install(spec, result.manifest.id, result.manifest.permissions ?? []);
      setPeek(null);
    } catch (err) {
      // Store surfaces the error via lastError; keep the dialog open so the
      // user can cancel without losing what they typed.
      console.error("[extensions] install failed", err);
    } finally {
      setInstalling(false);
    }
  };

  const installFromZip = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "Extension package", extensions: ["zip"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const result = await invoke<PeekResult>("ext_peek_zip", { zipPath: picked });
      setPeek({ result, spec: { kind: "zip", path: picked } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[extensions] peek zip failed", err);
      toast(`Could not read that package: ${msg}`, { variant: "error" });
    }
  };

  const installFromGithub = async () => {
    const repo = repoInput.trim();
    if (!repo) return;
    try {
      const result = await invoke<PeekResult>("ext_peek_github", { repo });
      setPeek({ result, spec: { kind: "github", repo } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[extensions] peek github failed", err);
      toast(`Could not read that repository: ${msg}`, { variant: "error" });
    }
  };

  const onCheckUpdates = async () => {
    try {
      const { failed } = await checkAllUpdates();
      if (failed > 0) {
        console.warn(`[extensions] ${failed} update check(s) failed`);
      }
    } catch (err) {
      console.error("[extensions] check updates failed", err);
    }
  };

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Extensions"
        description="Install, enable, and manage Termigo extensions. Each package asks for the permissions it needs and they are shown before install."
      />

      <Card>
        <CardHeader>
          <CardTitle>Install from package</CardTitle>
          <CardDescription>
            Install a local .zip you built or downloaded, or a package published on GitHub.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label className="text-[11px] font-medium text-muted-foreground" htmlFor="ext-repo">
              GitHub repository (owner/repo)
            </label>
            <div className="flex gap-2">
              <Input
                id="ext-repo"
                placeholder="99apps-id/pentest-tool-termigo"
                value={repoInput}
                onChange={(e) => setRepoInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void installFromGithub();
                }}
              />
              <Button
                variant="secondary"
                disabled={installing || !repoInput.trim()}
                onClick={() => void installFromGithub()}
              >
                Install from GitHub
              </Button>
            </div>
          </div>
          <Separator />
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted-foreground">
              From a local .zip file
            </p>
            <Button variant="outline" disabled={installing} onClick={() => void installFromZip()}>
              Choose zip…
            </Button>
          </div>
          <Button
            variant="ghost"
            className="w-fit"
            disabled={!hydrated || list.length === 0}
            onClick={() => void onCheckUpdates()}
          >
            Check for updates
          </Button>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-medium text-foreground">
          Installed {list.length > 0 ? `(${list.length})` : ""}
        </h2>
        {lastError ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
            {lastError}
          </p>
        ) : null}
        {!hydrated ? (
          <p className="rounded-md border border-border/50 bg-card/40 px-3 py-2 text-[11px] text-muted-foreground">
            Loading installed extensions…
          </p>
        ) : list.length === 0 ? (
          <p className="rounded-md border border-dashed border-border/60 bg-card/40 px-4 py-6 text-center text-[12px] text-muted-foreground">
            No extensions installed yet.
          </p>
        ) : (
          list.map((ext) => <InstalledCard key={ext.id} ext={ext} />)
        )}
      </div>

      <Dialog open={peek !== null} onOpenChange={(open) => !open && setPeek(null)}>
        <DialogContent className="sm:max-w-[460px]">
          {peek ? (
            <>
              <DialogHeader>
                <DialogTitle>Install "{peek.result.manifest.name}"?</DialogTitle>
                <DialogDescription>
                  Version {peek.result.manifest.version} · from {sourceLabel(peek.result.source)}
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-3">
                {peek.result.manifest.description ? (
                  <p className="text-[12px] text-muted-foreground">
                    {peek.result.manifest.description}
                  </p>
                ) : null}
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    Requested permissions
                  </span>
                  <div className="flex max-h-48 flex-wrap gap-1.5 overflow-auto rounded-md border border-border/50 bg-card/40 p-2">
                    {peek.result.manifest.permissions && peek.result.manifest.permissions.length > 0 ? (
                      peek.result.manifest.permissions.map((p) => (
                        <PermissionLabel key={p} permission={p} />
                      ))
                    ) : (
                      <span className="text-[11px] text-muted-foreground">None</span>
                    )}
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="ghost" disabled={installing} onClick={() => setPeek(null)}>
                  Cancel
                </Button>
                <Button
                  disabled={installing}
                  onClick={() => void runPeekInstall(peek.spec, peek.result)}
                >
                  {installing ? "Installing…" : "Install"}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InstalledCard({ ext }: { ext: InstalledExtension }) {
  const setEnabled = useExtensionsStore((s) => s.setEnabled);
  const uninstall = useExtensionsStore((s) => s.uninstall);
  const updateExtension = useExtensionsStore((s) => s.updateExtension);
  const updatingIds = useExtensionsStore((s) => s.updatingIds);
  const busy = updatingIds.has(ext.id);

  const isGithub = ext.source.startsWith("github:");
  const hasUpdate = ext.latest_version != null && ext.latest_version !== ext.version;

  const onToggle = async (enabled: boolean) => {
    try {
      await setEnabled(ext.id, enabled);
    } catch (err) {
      console.error("[extensions] setEnabled failed", err);
    }
  };

  const onUninstall = async () => {
    if (!confirm(`Uninstall "${ext.manifest?.name ?? ext.id}"?`)) return;
    try {
      await uninstall(ext.id);
    } catch (err) {
      console.error("[extensions] uninstall failed", err);
    }
  };

  const onUpdate = async () => {
    try {
      await updateExtension(ext.id);
    } catch (err) {
      console.error("[extensions] update failed", err);
    }
  };

  const name = ext.manifest?.name ?? ext.id;
  const description = ext.manifest?.description;

  return (
    <Card className="py-0">
      <CardContent className="flex items-center gap-3 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium text-foreground">{name}</span>
            <Badge variant="secondary" className="text-[9.5px]">
              v{ext.version}
            </Badge>
            <Badge variant="outline" className="text-[9.5px]">
              {sourceLabel(ext.source)}
            </Badge>
            {hasUpdate ? (
              <Badge variant="default" className="text-[9.5px]">
                update available
              </Badge>
            ) : null}
          </div>
          {description ? (
            <p className="truncate text-[11px] text-muted-foreground">{description}</p>
          ) : null}
        </div>

        {isGithub && hasUpdate ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void onUpdate()}>
            {busy ? "Updating…" : "Update"}
          </Button>
        ) : null}

        <Switch checked={ext.enabled} disabled={busy} onCheckedChange={(v) => void onToggle(v)} />

        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onUninstall()}>
          Uninstall
        </Button>
      </CardContent>
    </Card>
  );
}
