import { Popover, PopoverAnchor } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { usePresence } from "@/lib/usePresence";
import { cn } from "@/lib/utils";
import { Add01Icon, CommandIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceFiles } from "../hooks/useWorkspaceFiles";
import { ACCEPTED_FILES, useComposer } from "../lib/composer";
import type { CustomCommand } from "../lib/customCommands";
import { SLASH_COMMANDS, type SlashCommandMeta } from "../lib/slashCommands";
import { useChatStore } from "../store/chatStore";
import { useCustomCommandsStore } from "../store/customCommandsStore";
import { useSnippetsStore } from "../store/snippetsStore";

/** Present a user-defined command as a picker entry, like a built-in one. */
function customCommandMeta(cmd: CustomCommand): SlashCommandMeta {
  return {
    name: cmd.name,
    invocation: `/${cmd.name}`,
    label: cmd.description || cmd.name,
    icon: CommandIcon,
  };
}

import { AgentSwitcher } from "./AgentSwitcher";
import { FilePickerContent } from "./FilePicker";
import { type PickerItem, SnippetPickerContent } from "./SnippetPicker";

type SnippetTrigger = {
  start: number;
  end: number;
  query: string;
  char: "#" | "/";
};

type FileTrigger = {
  start: number;
  end: number;
  query: string;
};

function detectSnippetTrigger(
  value: string,
  caret: number,
): SnippetTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "#" || ch === "/") {
      const prev = i === 0 ? " " : value[i - 1];
      if (!/\s/.test(prev)) return null;
      const slice = value.slice(i + 1, caret);
      if (!/^[a-z0-9-]*$/i.test(slice)) return null;
      return { start: i, end: caret, query: slice.toLowerCase(), char: ch };
    }
    if (/\s/.test(ch)) return null;
    if (!/[a-z0-9-]/i.test(ch)) return null;
  }
  return null;
}

function detectFileTrigger(value: string, caret: number): FileTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "@") {
      const prev = i === 0 ? " " : value[i - 1];
      if (!/\s/.test(prev)) return null;
      const slice = value.slice(i + 1, caret);
      return { start: i, end: caret, query: slice };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

export function AiComposerInput() {
  const c = useComposer();
  const snippets = useSnippetsStore((s) => s.snippets);
  const workspaceRoot = useChatStore((s) => s.live.getWorkspaceRoot());

  const [trigger, setTrigger] = useState<SnippetTrigger | null>(null);
  const [fileTrigger, setFileTrigger] = useState<FileTrigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const workspaceFiles = useWorkspaceFiles(workspaceRoot, fileTrigger !== null);

  const [fileQuery, setFileQuery] = useState("");
  useEffect(() => {
    if (!fileTrigger) {
      setFileQuery("");
      return;
    }
    const q = fileTrigger.query;
    const t = window.setTimeout(() => setFileQuery(q), 50);
    return () => window.clearTimeout(t);
  }, [fileTrigger]);

  // biome-ignore lint/correctness/useExhaustiveDependencies(c.value): autoresize must re-run when the text content changes so the textarea grows with input.
  useEffect(() => {
    autoresize(c.textareaRef.current);
  }, [c.value, c.textareaRef]);

  const updateTrigger = () => {
    const el = c.textareaRef.current;
    if (!el) {
      setTrigger(null);
      setFileTrigger(null);
      return;
    }
    const caret = el.selectionStart ?? 0;
    setTrigger(detectSnippetTrigger(c.value, caret));
    setFileTrigger(detectFileTrigger(c.value, caret));
  };

  useEffect(updateTrigger, [c.value, c.textareaRef]);

  const customCommands = useCustomCommandsStore((s) => s.commands);

  const filteredItems = useMemo<PickerItem[]>(() => {
    if (!trigger) return [];
    const q = trigger.query;
    const matches = (name: string, label: string) =>
      !q || name.includes(q) || label.toLowerCase().includes(q);
    const cmdItems: PickerItem[] = [
      ...Object.values(SLASH_COMMANDS),
      // User-defined commands, minus any that shadow a built-in name.
      ...customCommands
        .filter((c) => !SLASH_COMMANDS[c.name])
        .map(customCommandMeta),
    ]
      .filter((c) => matches(c.name, c.label))
      .map((command) => ({ kind: "command", command }));
    if (trigger.char === "/") return cmdItems;
    const snipItems: PickerItem[] = snippets
      .filter(
        (s) =>
          !q ||
          s.handle.includes(q) ||
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      )
      .map((snippet) => ({ kind: "snippet", snippet }));
    return [...cmdItems, ...snipItems];
  }, [trigger, snippets, customCommands]);

  const FILE_PICKER_CAP = 30;
  const filteredFiles = useMemo<string[]>(() => {
    if (!fileTrigger) return [];
    const q = fileQuery.toLowerCase();
    if (!q) return workspaceFiles.files.slice(0, FILE_PICKER_CAP);
    const out: string[] = [];
    for (const f of workspaceFiles.files) {
      if (f.toLowerCase().includes(q)) {
        out.push(f);
        if (out.length >= FILE_PICKER_CAP) break;
      }
    }
    return out;
  }, [fileTrigger, fileQuery, workspaceFiles.files]);

  const fileTriggerOpen = fileTrigger !== null;
  const snippetTriggerOpen = trigger !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the highlight whenever the picker opens/closes or its query changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [snippetTriggerOpen, fileTriggerOpen, fileQuery]);

  // Rescan `.termigo/commands` when the slash picker opens, so a command file
  // the user just added shows up without an app restart. Cheap (readDir + a few
  // small files) and only fires on the `/` trigger.
  const slashPickerOpen = trigger?.char === "/";
  useEffect(() => {
    if (slashPickerOpen) {
      void useCustomCommandsStore.getState().loadFor(workspaceRoot);
    }
  }, [slashPickerOpen, workspaceRoot]);

  const pickerOpen = trigger !== null || fileTrigger !== null;

  const onPickItem = (item: PickerItem) => {
    if (!trigger) return;
    const before = c.value.slice(0, trigger.start);
    const afterRaw = c.value.slice(trigger.end);
    let insert = "";
    if (item.kind === "snippet") {
      const needsSpace = afterRaw.length === 0 || !/^\s/.test(afterRaw);
      insert = `#${item.snippet.handle}${needsSpace ? " " : ""}`;
      c.addSnippet(item.snippet);
    } else {
      c.addCommand(item.command);
    }
    const after =
      item.kind === "command" ? afterRaw.replace(/^\s+/, "") : afterRaw;
    c.setValue(`${before}${insert}${after}`);
    setTrigger(null);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      const el = c.textareaRef.current;
      if (!el) return;
      const caret = before.length + insert.length;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const onPickFile = async (filePath: string) => {
    if (!fileTrigger || !workspaceRoot) return;
    const before = c.value.slice(0, fileTrigger.start);
    const after = c.value.slice(fileTrigger.end);
    c.setValue(`${before}${after}`);
    setFileTrigger(null);
    setActiveIndex(0);
    const fullPath = workspaceRoot.endsWith("/")
      ? `${workspaceRoot}${filePath}`
      : `${workspaceRoot}/${filePath}`;
    await c.attachFileByPath(fullPath);
    requestAnimationFrame(() => {
      const el = c.textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };

  const pickActive = () => {
    if (fileTrigger) {
      const file = filteredFiles[activeIndex];
      if (file) void onPickFile(file);
      return;
    }
    const it = filteredItems[activeIndex];
    if (it) onPickItem(it);
  };

  const voiceLabel = c.voice.recording
    ? "Listening…"
    : c.voice.transcribing
      ? "Transcribing…"
      : null;
  const voiceRow = usePresence(Boolean(voiceLabel), 180);
  const lastVoiceLabel = useRef("");
  if (voiceLabel) lastVoiceLabel.current = voiceLabel;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleAttachClick = async () => {
    if (c.isBusy) return;
    try {
      const { open: openFileDialog } = await import(
        "@tauri-apps/plugin-dialog"
      );
      const selected = await openFileDialog({
        multiple: true,
        title: "Attach Image or Document",
        filters: [
          {
            name: "Supported Files",
            extensions: [
              "png",
              "jpg",
              "jpeg",
              "gif",
              "webp",
              "svg",
              "bmp",
              "ico",
              "pdf",
              "txt",
              "md",
              "markdown",
              "json",
              "yaml",
              "yml",
              "toml",
              "py",
              "js",
              "ts",
              "tsx",
              "jsx",
              "rs",
              "go",
              "java",
              "c",
              "cpp",
              "h",
              "hpp",
              "cs",
              "php",
              "rb",
              "swift",
              "kt",
              "html",
              "css",
              "scss",
              "sql",
              "csv",
              "tsv",
              "log",
              "env",
              "config",
              "conf",
              "ini",
              "xml",
            ],
          },
          {
            name: "Images",
            extensions: [
              "png",
              "jpg",
              "jpeg",
              "gif",
              "webp",
              "svg",
              "bmp",
              "ico",
            ],
          },
          {
            name: "Documents",
            extensions: [
              "pdf",
              "txt",
              "md",
              "markdown",
              "json",
              "yaml",
              "yml",
              "toml",
              "csv",
              "tsv",
              "log",
            ],
          },
          {
            name: "All Files",
            extensions: ["*"],
          },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      for (const p of paths) {
        if (typeof p === "string" && p.length > 0) {
          await c.attachFileByPath(p);
        }
      }
    } catch {
      fileInputRef.current?.click();
    }
  };

  return (
    <>
      <Popover open={pickerOpen}>
        <PopoverAnchor asChild>
          <div
            role="presentation"
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDragging(false);
              const files = e.dataTransfer?.files;
              if (files && files.length > 0) {
                void c.addFiles(files);
              }
            }}
            className={cn(
              "flex items-start gap-2 rounded-lg transition-colors",
              isDragging && "ring-1 ring-primary/40 bg-primary/5",
            )}
          >
            <textarea
              ref={c.textareaRef}
              value={c.value}
              onChange={(e) => c.setValue(e.target.value)}
              onPaste={(e) => {
                // Pasting a screenshot, image, or document attaches it to the composer.
                // Text paste falls through to the default textarea behaviour.
                const fileList: File[] = [];
                const items = e.clipboardData?.items;
                if (items && items.length > 0) {
                  for (const item of Array.from(items)) {
                    if (item.kind === "file") {
                      const f = item.getAsFile();
                      if (f) fileList.push(f);
                    }
                  }
                }
                if (
                  fileList.length === 0 &&
                  e.clipboardData?.files &&
                  e.clipboardData.files.length > 0
                ) {
                  for (const f of Array.from(e.clipboardData.files)) {
                    fileList.push(f);
                  }
                }
                if (fileList.length > 0) {
                  e.preventDefault();
                  void c.addFiles(fileList);
                }
              }}
              onKeyUp={updateTrigger}
              onClick={updateTrigger}
              onSelect={updateTrigger}
              onKeyDown={(e) => {
                if (pickerOpen) {
                  const items = fileTrigger ? filteredFiles : filteredItems;
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActiveIndex((i) =>
                      Math.min(i + 1, Math.max(0, items.length - 1)),
                    );
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActiveIndex((i) => Math.max(0, i - 1));
                    return;
                  }
                  if (e.key === "Tab" || e.key === "Enter") {
                    if (items.length > 0) {
                      e.preventDefault();
                      pickActive();
                      return;
                    }
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    if (fileTrigger) {
                      const before = c.value.slice(0, fileTrigger.start);
                      const after = c.value.slice(fileTrigger.end);
                      c.setValue(`${before}${after}`);
                      setFileTrigger(null);
                    } else {
                      setTrigger(null);
                    }
                    return;
                  }
                }
                // Stopping a run had no keyboard path at all: the only way was
                // to reach the far corner of the bar with the mouse. Inside the
                // picker Escape already means "dismiss", handled above, so this
                // only fires once that is closed. The mini window's global
                // Escape ignores textareas, so nothing else claims this key.
                if (e.key === "Escape" && c.isBusy) {
                  e.preventDefault();
                  c.stop();
                  return;
                }
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  c.submit();
                }
              }}
              placeholder="Ask Termigo anything   -   # for snippets and commands, @ for files"
              rows={1}
              className={cn(
                "max-h-40 flex-1 resize-none bg-transparent text-[13px] leading-relaxed outline-none",
                "placeholder:text-muted-foreground/60",
              )}
            />
            <div className="flex shrink-0 items-center gap-0.5">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPTED_FILES}
                className="hidden"
                onChange={(e) => {
                  void c.addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => void handleAttachClick()}
                disabled={c.isBusy}
                title="Attach image or document"
                aria-label="Attach image or document"
                className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={2} />
              </button>
              <AgentSwitcher />
            </div>
          </div>
        </PopoverAnchor>
        {fileTrigger ? (
          <FilePickerContent
            files={filteredFiles}
            activeIndex={activeIndex}
            indexing={workspaceFiles.indexing}
            truncated={workspaceFiles.truncated}
            hasWorkspace={workspaceRoot !== null}
            onPick={(f) => void onPickFile(f)}
            onHover={setActiveIndex}
          />
        ) : (
          <SnippetPickerContent
            items={filteredItems}
            activeIndex={activeIndex}
            onPick={onPickItem}
            onHover={setActiveIndex}
          />
        )}
      </Popover>

      {voiceRow.mounted && (
        <div data-state={voiceRow.state} className="termigo-reveal">
          <div className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
            {c.voice.recording ? (
              <span className="size-1.5 animate-pulse rounded-full bg-destructive" />
            ) : (
              <Spinner className="size-3" />
            )}
            <span className="truncate">
              {voiceLabel || lastVoiceLabel.current}
            </span>
          </div>
        </div>
      )}
    </>
  );
}

function autoresize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}
