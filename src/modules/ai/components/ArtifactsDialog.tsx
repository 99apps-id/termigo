import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  EyeIcon,
  File01Icon,
  Layers02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { artifactOpener } from "../lib/artifactOpen";
import { type ArtifactKind, useArtifactsStore } from "../store/artifactsStore";
import { useChatStore } from "../store/chatStore";

const KIND_ICON: Record<ArtifactKind, typeof File01Icon> = {
  canvas: Layers02Icon,
  preview: EyeIcon,
  file: File01Icon,
};

const KIND_LABEL: Record<ArtifactKind, string> = {
  canvas: "canvas",
  preview: "preview",
  file: "file",
};

function relativeTime(at: number): string {
  const s = Math.max(1, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

/**
 * "Artifacts" — things the agent produced this session (canvas renders,
 * previews opened, files written), one click to reopen (BatikCode
 * `chatArtifactsWidget` parity).
 */
export function ArtifactsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const sessionId = useChatStore((s) => s.activeSessionId) ?? "";
  const artifacts =
    useArtifactsStore((s) =>
      sessionId ? s.bySession[sessionId] : undefined,
    ) ?? [];
  const remove = useArtifactsStore((s) => s.remove);

  const openArtifact = (
    kind: ArtifactKind,
    payload: string,
    title?: string,
  ) => {
    const opener = artifactOpener();
    if (!opener) return;
    if (kind === "file") opener.openFile(payload);
    else if (kind === "preview") opener.openPreview(payload);
    else opener.openCanvas(payload, title);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[13px]">
            <HugeiconsIcon icon={Layers02Icon} size={15} strokeWidth={1.75} />
            Artifacts
          </DialogTitle>
        </DialogHeader>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Things the agent produced this session — canvas renders, previews, and
          files it wrote. Reopen any of them with one click.
        </p>

        {artifacts.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">
            No artifacts yet. The next canvas, preview, or file the agent
            creates appears here.
          </div>
        ) : (
          <ScrollArea className="max-h-80">
            <div className="space-y-1 pr-1">
              {artifacts.map((a) => {
                const Icon = KIND_ICON[a.kind];
                return (
                  <div
                    key={a.id}
                    className="group flex items-center gap-2 rounded-md border border-border/50 bg-muted/25 px-2 py-1.5"
                  >
                    <HugeiconsIcon
                      icon={Icon}
                      size={13}
                      strokeWidth={1.75}
                      className="shrink-0 text-muted-foreground"
                    />
                    <span className="shrink-0 rounded bg-foreground/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-muted-foreground">
                      {KIND_LABEL[a.kind]}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                      {a.title}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {relativeTime(a.at)}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className={cn("h-6 px-2 text-[10px]")}
                      onClick={() => openArtifact(a.kind, a.payload, a.title)}
                    >
                      Open
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Remove artifact"
                      onClick={() => remove(sessionId, a.id)}
                    >
                      <HugeiconsIcon
                        icon={Cancel01Icon}
                        size={12}
                        strokeWidth={1.75}
                      />
                    </Button>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
