import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  type ModelInfo,
  type ProviderInfo,
  resolveApiModelId,
} from "@/modules/ai/config";
import {
  ArrowDown01Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Edit02Icon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { ProviderIcon } from "./ProviderIcon";

type Props = {
  provider: ProviderInfo;
  currentKey: string | null;
  onSave: (key: string) => Promise<void>;
  onClear: () => Promise<void>;
  onRemove?: () => void;
  /** Registry models this provider offers, so each wire id is editable. */
  models?: readonly ModelInfo[];
  /** Registry model id -> provider-side id. */
  modelIdOverrides?: Readonly<Record<string, string>>;
  onSetModelIdOverride?: (modelId: string, apiModelId: string) => void;
};

function maskKey(key: string): string {
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}${"•".repeat(8)}${key.slice(-4)}`;
}

export function ProviderKeyCard({
  provider,
  currentKey,
  onSave,
  onClear,
  onRemove,
  models,
  modelIdOverrides,
  onSetModelIdOverride,
}: Props) {
  const [editing, setEditing] = useState(!currentKey);
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showModels, setShowModels] = useState(false);

  useEffect(() => {
    setEditing(!currentKey);
  }, [currentKey]);

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Enter your API key.");
      return;
    }
    if (provider.keyPrefix && !trimmed.startsWith(provider.keyPrefix)) {
      setError(`${provider.label} keys start with "${provider.keyPrefix}".`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      setValue("");
      setReveal(false);
    } catch (e) {
      setError(`Failed to save: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderIcon provider={provider.id} size={15} />
        <span className="text-[12.5px] font-medium">{provider.label}</span>
        {currentKey ? (
          <Badge
            variant="outline"
            className="ml-1 h-4 gap-1 border-border/60 bg-muted/40 px-1.5 text-[10px] font-normal text-muted-foreground"
          >
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              size={9}
              strokeWidth={2}
            />
            Connected
          </Badge>
        ) : null}
        <button
          type="button"
          onClick={() => void openUrl(provider.consoleUrl)}
          className="ml-auto inline-flex items-center gap-0.5 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Get key
          <HugeiconsIcon
            icon={ArrowUpRight01Icon}
            size={11}
            strokeWidth={1.75}
          />
        </button>
        {onRemove ? (
          <Button
            size="icon"
            variant="ghost"
            onClick={onRemove}
            title="Remove provider"
            className="size-7 text-muted-foreground hover:text-destructive"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
          </Button>
        ) : null}
      </div>

      {editing ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1.5">
            <div className="relative flex-1">
              <Input
                type={reveal ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  provider.keyPrefix
                    ? `${provider.keyPrefix}…`
                    : "Paste API key"
                }
                value={value}
                disabled={saving}
                onChange={(e) => {
                  setValue(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submit();
                  } else if (e.key === "Escape" && currentKey) {
                    setValue("");
                    setReveal(false);
                    setError(null);
                    setEditing(false);
                  }
                }}
                className="h-8 pr-7 font-mono text-[11.5px]"
              />
              <button
                type="button"
                onClick={() => setReveal((v) => !v)}
                tabIndex={-1}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
                aria-label={reveal ? "Hide key" : "Show key"}
              >
                <HugeiconsIcon
                  icon={reveal ? ViewOffSlashIcon : ViewIcon}
                  size={12}
                  strokeWidth={1.75}
                />
              </button>
            </div>
            <Button
              size="sm"
              onClick={() => void submit()}
              disabled={saving || !value.trim()}
              className="h-8 gap-1 px-3 text-[11px]"
            >
              {saving ? <Spinner className="size-3" /> : null}
              Save
            </Button>
          </div>
          {error ? (
            <p className="text-[10.5px] text-destructive">{error}</p>
          ) : null}
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <code
            className={cn(
              "flex-1 truncate rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground",
            )}
          >
            {maskKey(currentKey ?? "")}
          </code>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setEditing(true)}
            title="Replace"
            className="size-7"
          >
            <HugeiconsIcon icon={Edit02Icon} size={12} strokeWidth={1.75} />
          </Button>
          {!onRemove ? (
            <Button
              size="icon"
              variant="ghost"
              onClick={() => void onClear()}
              title="Remove"
              className="size-7 text-muted-foreground hover:text-destructive"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
            </Button>
          ) : null}
        </div>
      )}

      {models && models.length > 0 && onSetModelIdOverride ? (
        <div className="flex flex-col gap-1.5 border-t border-border/40 pt-1.5">
          <button
            type="button"
            onClick={() => setShowModels((v) => !v)}
            className="flex items-center gap-1 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={11}
              strokeWidth={2}
              className={cn("transition-transform", showModels && "rotate-180")}
            />
            Model IDs
            {hasAnyOverride(models, modelIdOverrides) ? (
              <span className="text-[10px] text-foreground/70">· edited</span>
            ) : null}
          </button>
          {showModels ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-[10.5px] leading-relaxed text-muted-foreground/80">
                {provider.label} renames models over time. The id below is what
                a request actually sends; change it when a model is renamed
                without waiting for an app update. Clear it to use the built-in
                default.
              </p>
              {models.map((m) => (
                <ModelIdRow
                  key={m.id}
                  model={m}
                  override={modelIdOverrides?.[m.id] ?? ""}
                  onChange={(v) => onSetModelIdOverride(m.id, v)}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** True when at least one of this provider's models has an override set. */
function hasAnyOverride(
  models: readonly ModelInfo[],
  overrides?: Readonly<Record<string, string>>,
): boolean {
  if (!overrides) return false;
  return models.some((m) => (overrides[m.id] ?? "").trim().length > 0);
}

function ModelIdRow({
  model,
  override,
  onChange,
}: {
  model: ModelInfo;
  override: string;
  onChange: (value: string) => void;
}) {
  const fallback = resolveApiModelId(model.id);
  const [draft, setDraft] = useState(override);
  useEffect(() => setDraft(override), [override]);

  const commit = () => {
    const v = draft.trim();
    if (v === override) return;
    onChange(v);
  };

  return (
    <div className="flex items-center gap-2">
      <span className="w-32 shrink-0 truncate text-[11px] text-muted-foreground">
        {model.label}
      </span>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setDraft(override);
          }
        }}
        placeholder={fallback}
        spellCheck={false}
        className="h-7 flex-1 font-mono text-[11px]"
      />
      {override && override !== fallback ? (
        <Button
          size="icon"
          variant="ghost"
          onClick={() => onChange("")}
          title="Reset to default"
          className="size-7 text-muted-foreground hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
        </Button>
      ) : (
        <span className="size-7 shrink-0" />
      )}
    </div>
  );
}
