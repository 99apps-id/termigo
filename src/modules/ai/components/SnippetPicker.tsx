import { PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Star02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SlashCommandMeta } from "../lib/slashCommands";
import type { Snippet } from "../lib/snippets";
import { useCustomCommandStatsStore } from "../store/customCommandStatsStore";

export type PickerItem =
  | {
      kind: "snippet";
      snippet: Snippet;
    }
  | {
      kind: "command";
      command: SlashCommandMeta & {
        tags?: string[];
        favorite?: boolean;
        usageCount?: number;
      };
      onToggleFavorite?: (name: string) => void;
    };

type Props = {
  items: readonly PickerItem[];
  activeIndex: number;
  onPick: (item: PickerItem) => void;
  onHover: (index: number) => void;
};

export function SnippetPickerContent({
  items,
  activeIndex,
  onPick,
  onHover,
}: Props) {
  const commands = items.filter((it) => it.kind === "command");
  const snippets = items.filter((it) => it.kind === "snippet");
  let cursor = -1;

  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={6}
      onOpenAutoFocus={(e) => e.preventDefault()}
      onCloseAutoFocus={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      className="w-72 overflow-hidden rounded-lg border border-border/60 bg-popover/95 p-0 shadow-xl backdrop-blur-xl"
    >
      {items.length === 0 ? (
        <div className="px-3 py-2.5 text-[11px] text-muted-foreground">
          No matches. Add snippets in Settings → Agents.
        </div>
      ) : (
        <div className="max-h-64 overflow-y-auto py-1">
          {commands.length > 0 && (
            <>
              <SectionHeader label="Pre-built snippets" />
              <ul>
                {commands.map((it) => {
                  cursor += 1;
                  const i = cursor;
                  if (it.kind !== "command") return null;
                  const c = it.command;
                  const stats = useCustomCommandStatsStore.getState().get(c.name);
                  const isFav = c.favorite ?? stats?.favorite ?? false;
                  const count = c.usageCount ?? stats?.count ?? 0;
                  return (
                    <li key={`cmd-${c.name}`}>
                      <button
                        type="button"
                        onMouseEnter={() => onHover(i)}
                        onClick={() => onPick(it)}
                        className={cn(
                          "flex w-full items-start gap-2 px-2 py-1.5 text-left text-[12px]",
                          i === activeIndex
                            ? "bg-accent"
                            : "hover:bg-accent/60",
                        )}
                      >
                        <HugeiconsIcon
                          icon={c.icon}
                          size={13}
                          strokeWidth={1.75}
                          className="text-muted-foreground mt-0.5"
                        />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex items-center gap-1.5">
                            <span className="font-mono text-muted-foreground">
                              #{c.name}
                            </span>
                            {c.tags?.length ? (
                              <span className="flex gap-1">
                                {c.tags.slice(0, 3).map((tag) => (
                                  <span
                                    key={tag}
                                    className="rounded-[3px] bg-muted px-1 py-px text-[9px] text-muted-foreground"
                                  >
                                    {tag}
                                  </span>
                                ))}
                              </span>
                            ) : null}
                          </span>
                          <span className="font-medium">{c.label}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1 pt-0.5">
                          {count > 0 ? (
                            <span className="text-[10px] text-muted-foreground/70">
                              {count}
                            </span>
                          ) : null}
                          {it.onToggleFavorite ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                it.onToggleFavorite?.(c.name);
                              }}
                              className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                              aria-label={
                                isFav ? "Remove from favorites" : "Add to favorites"
                              }
                            >
                              <HugeiconsIcon
                                icon={Star02Icon}
                                size={12}
                                strokeWidth={2}
                                className={isFav ? "fill-amber-500 text-amber-500" : ""}
                              />
                            </button>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {snippets.length > 0 && (
            <>
              <SectionHeader label="Snippets" />
              <ul>
                {snippets.map((it) => {
                  cursor += 1;
                  const i = cursor;
                  if (it.kind !== "snippet") return null;
                  const s = it.snippet;
                  return (
                    <li key={`sn-${s.id}`}>
                      <button
                        type="button"
                        onMouseEnter={() => onHover(i)}
                        onClick={() => onPick(it)}
                        className={cn(
                          "flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left text-[12px]",
                          i === activeIndex
                            ? "bg-accent"
                            : "hover:bg-accent/60",
                        )}
                      >
                        <span className="flex w-full items-center gap-1.5">
                          <span className="font-mono text-muted-foreground">
                            #{s.handle}
                          </span>
                          <span className="font-medium">{s.name}</span>
                        </span>
                        {s.description ? (
                          <span className="line-clamp-1 text-[10.5px] text-muted-foreground">
                            {s.description}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </PopoverContent>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
      {label}
    </div>
  );
}
