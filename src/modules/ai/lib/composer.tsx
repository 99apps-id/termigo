import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useWhisperRecording } from "../hooks/useWhisperRecording";
import { expandSnippetTokens, type Snippet } from "../lib/snippets";
import { useChatStore } from "../store/chatStore";
import { useSnippetsStore } from "../store/snippetsStore";
import { type SlashCommandMeta, tryRunSlashCommand } from "./slashCommands";
import {
  editableTextOf,
  previewOf,
  type SteerMessage,
  type SteerPart,
} from "./steer";

export type FileAttachment = {
  id: string;
  name: string;
  kind: "image" | "text" | "selection" | "file";
  mediaType: string;
  url?: string;
  text?: string;
  size: number;
  /** For kind === "selection": which surface it came from. */
  source?: "terminal" | "editor";
};

type MessagePart =
  | { type: "text"; text: string }
  | { type: "file"; mediaType: string; url: string; filename?: string };

export const MAX_TEXT_INLINE = 200_000;
export const ACCEPTED_FILES =
  "image/*,application/pdf,.pdf,.txt,.md,.markdown,.json,.yaml,.yml,.toml,.sh,.zsh,.bash,.py,.js,.jsx,.ts,.tsx,.rs,.go,.java,.c,.cpp,.h,.hpp,.cs,.php,.rb,.swift,.kt,.html,.css,.scss,.sql,.csv,.tsv,.log,.env,.config,.conf,.ini,.xml,Dockerfile,.dockerfile";

type Voice = ReturnType<typeof useWhisperRecording>;

type ComposerCtx = {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  files: FileAttachment[];
  addFiles: (list: FileList | File[] | readonly File[] | null) => Promise<void>;
  /** Attach a file by absolute path — used by the file explorer's "Attach to Agent". */
  attachFileByPath: (path: string) => Promise<void>;
  removeFile: (id: string) => void;
  pickedSnippets: Snippet[];
  addSnippet: (s: Snippet) => void;
  removeSnippet: (id: string) => void;
  pickedCommands: SlashCommandMeta[];
  addCommand: (c: SlashCommandMeta) => void;
  removeCommand: (name: string) => void;
  isBusy: boolean;
  submit: () => void;
  stop: () => void;
  voice: Voice;
  canSend: boolean;
  /** Messages typed during the current run, waiting for it to settle. */
  queued: readonly SteerMessage[];
  cancelQueued: (index: number) => void;
  /** Pull a queued message's text back into the composer to revise it. */
  editQueued: (index: number) => void;
};

const Ctx = createContext<ComposerCtx | null>(null);

export function useComposer(): ComposerCtx {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error("useComposer must be used inside <AiComposerProvider>");
  return ctx;
}

type ProviderProps = {
  children: React.ReactNode;
};

export function AiComposerProvider({ children }: ProviderProps) {
  const sessionId = useChatStore((s) => s.activeSessionId);
  const status = useChatStore((s) => s.agentMeta.status);
  const isBusy =
    status === "thinking" ||
    status === "streaming" ||
    status === "awaiting-approval";

  const [value, setValue] = useState("");
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [pickedSnippets, setPickedSnippets] = useState<Snippet[]>([]);
  const [pickedCommands, setPickedCommands] = useState<SlashCommandMeta[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const focusSignal = useChatStore((s) => s.focusSignal);
  const pendingPrefill = useChatStore((s) => s.pendingPrefill);
  const consumePrefill = useChatStore((s) => s.consumePrefill);
  const pendingSelections = useChatStore((s) => s.pendingSelections);
  const consumeSelections = useChatStore((s) => s.consumeSelections);

  useEffect(() => {
    if (focusSignal === 0) return;
    textareaRef.current?.focus();
    if (pendingPrefill != null) {
      const text = consumePrefill();
      if (text) setValue((v) => (v ? `${text}${v}` : text));
    }
  }, [focusSignal, pendingPrefill, consumePrefill]);

  // Re-focus the textarea whenever the agent finishes a response, and deliver
  // anything the user typed while it was working. The flush is idempotent, so
  // a second composer (the mini window) observing the same transition is safe.
  const prevIsBusyRef = useRef(false);
  useEffect(() => {
    if (prevIsBusyRef.current && !isBusy) {
      requestAnimationFrame(() => textareaRef.current?.focus());
      void (async () => {
        const { flushSteer } = await import("../store/chatRuntime");
        await flushSteer();
      })();
    }
    prevIsBusyRef.current = isBusy;
  }, [isBusy]);

  // Listen for explorer's "Attach to Agent" event.
  // biome-ignore lint/correctness/useExhaustiveDependencies(attachFileByPath): the listener is registered once, and attachFileByPath only closes over stable setFiles/share, so the mount-time closure stays correct.
  useEffect(() => {
    const onAttach = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      if (typeof path === "string" && path.length > 0) {
        void attachFileByPath(path);
      }
    };
    window.addEventListener("termigo:ai-attach-file", onAttach);
    return () => window.removeEventListener("termigo:ai-attach-file", onAttach);
    // attachFileByPath is stable for our purposes (closes over setFiles only)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (pendingSelections.length === 0) return;
    const drained = consumeSelections();
    if (drained.length === 0) return;
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.id));
      const next: FileAttachment[] = [];
      for (const sel of drained) {
        if (existing.has(sel.id)) continue;
        next.push({
          id: sel.id,
          name:
            sel.source === "editor" ? "Editor selection" : "Terminal selection",
          kind: "selection",
          mediaType: "text/plain",
          text: sel.text,
          size: sel.text.length,
          source: sel.source,
        });
      }
      return next.length ? [...prev, ...next] : prev;
    });
  }, [pendingSelections, consumeSelections]);

  const voice = useWhisperRecording({
    onResult: (transcript: string) => {
      setValue((v) => (v ? `${v} ${transcript}` : transcript));
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
  });

  const addFiles = async (list: FileList | File[] | readonly File[] | null) => {
    if (!list) return;
    const next: FileAttachment[] = [];
    for (const f of Array.from(list)) {
      const att = await readAttachment(f);
      if (att) next.push(att);
    }
    if (next.length) setFiles((prev) => [...prev, ...next]);
  };

  const removeFile = (id: string) =>
    setFiles((prev) => prev.filter((f) => f.id !== id));

  const addSnippet = (s: Snippet) =>
    setPickedSnippets((prev) =>
      prev.some((p) => p.id === s.id) ? prev : [...prev, s],
    );
  const removeSnippet = (id: string) =>
    setPickedSnippets((prev) => prev.filter((s) => s.id !== id));

  const addCommand = (cmd: SlashCommandMeta) =>
    setPickedCommands((prev) =>
      prev.some((p) => p.name === cmd.name) ? prev : [...prev, cmd],
    );
  const removeCommand = (name: string) =>
    setPickedCommands((prev) => prev.filter((c) => c.name !== name));

  const attachImageByPath = async (path: string) => {
    try {
      const img = await invoke<{
        media_type: string;
        data: string;
        size: number;
      }>("fs_read_image_base64", { path, workspace: currentWorkspaceEnv() });
      const name = path.split(/[/\\]/).pop() || path;
      const id = `path-${path}`;
      setFiles((prev) => {
        if (prev.some((f) => f.id === id)) return prev;
        const att: FileAttachment = {
          id,
          name,
          kind: "image",
          mediaType: img.media_type,
          url: `data:${img.media_type};base64,${img.data}`,
          size: img.size,
        };
        return [...prev, att];
      });
      useChatStore.getState().focusInput();
    } catch (e) {
      console.error("attachImageByPath failed:", e);
      toast.error(
        `Could not attach image "${path.split(/[/\\]/).pop() || path}"`,
      );
    }
  };

  const attachPdfByPath = async (path: string) => {
    try {
      type ReadResult = {
        media_type: string;
        data: string;
        size: number;
        file_name: string;
      };
      const doc = await invoke<ReadResult>("fs_read_file_base64", {
        path,
        workspace: currentWorkspaceEnv(),
      });
      const name = path.split(/[/\\]/).pop() || path;
      const id = `path-${path}`;
      setFiles((prev) => {
        if (prev.some((f) => f.id === id)) return prev;
        const att: FileAttachment = {
          id,
          name,
          kind: "file",
          mediaType: doc.media_type || "application/pdf",
          url: `data:${doc.media_type || "application/pdf"};base64,${doc.data}`,
          size: Number(doc.size),
        };
        return [...prev, att];
      });
      useChatStore.getState().focusInput();
    } catch (e) {
      console.error("attachPdfByPath failed:", e);
      toast.error(
        `Could not attach PDF "${path.split(/[/\\]/).pop() || path}"`,
      );
    }
  };

  const attachFileByPath = async (path: string) => {
    try {
      if (isImageAttachmentPath(path)) {
        await attachImageByPath(path);
        return;
      }
      if (isPdfPath(path)) {
        await attachPdfByPath(path);
        return;
      }
      type ReadResult =
        | { kind: "text"; content: string; size: number }
        | { kind: "binary"; size: number }
        | { kind: "toolarge"; size: number; limit: number };
      const result = await invoke<ReadResult>("fs_read_file", {
        path,
        workspace: currentWorkspaceEnv(),
      });
      const name = path.split(/[/\\]/).pop() || path;
      if (result.kind === "toolarge") {
        toast.error(
          `File "${name}" is too large to attach (limit ${result.limit} bytes)`,
        );
        return;
      }
      if (result.kind !== "text") {
        toast.error(`Binary file "${name}" cannot be attached as text`);
        return;
      }
      const id = `path-${path}`;
      setFiles((prev) => {
        if (prev.some((f) => f.id === id)) return prev;
        const att: FileAttachment = {
          id,
          name,
          kind: "text",
          mediaType: "text/plain",
          text: result.content,
          size: result.size,
        };
        return [...prev, att];
      });
      // Open the AI panel & focus the input so the user sees the chip.
      useChatStore.getState().focusInput();
    } catch (e) {
      console.error("attachFileByPath failed:", e);
      toast.error(
        `Could not attach file "${path.split(/[/\\]/).pop() || path}"`,
      );
    }
  };

  const submit = () => {
    // No early return on `isBusy`. Typing during a run used to vanish without a
    // trace; it is now queued by sendParts and delivered when the run settles.
    const trimmed = value.trim();
    if (
      !trimmed &&
      files.length === 0 &&
      pickedSnippets.length === 0 &&
      pickedCommands.length === 0
    )
      return;

    // Slash-command interception. `/plan` toggles plan mode; `/init` rewrites
    // the prompt to the TERMIGO.md scan template before sending.
    let effectiveText = trimmed;
    let commandMarker: string | null = null;
    let commandSource = trimmed;
    if (
      pickedCommands.length > 0 &&
      !trimmed.startsWith("/") &&
      !trimmed.startsWith("#")
    ) {
      commandSource = `#${pickedCommands[0].name} ${trimmed}`.trim();
    }
    if (commandSource.startsWith("/") || commandSource.startsWith("#")) {
      const outcome = tryRunSlashCommand(commandSource);
      if (outcome.kind === "handled") {
        setValue("");
        if (outcome.toast) toast.info(outcome.toast);
        return;
      }
      if (outcome.kind === "send-prompt") {
        effectiveText = outcome.prompt;
        if (outcome.commandName) {
          commandMarker = `<termigo-command name="${outcome.commandName}" />`;
        }
      }
    }

    const parts: MessagePart[] = [];
    const fileBlocks = files
      .filter((f) => f.kind === "text")
      .map(
        (f) =>
          `<file name="${f.name}" mediaType="${f.mediaType}">\n${f.text ?? ""}\n</file>`,
      );
    const selectionBlocks = files
      .filter((f) => f.kind === "selection")
      .map(
        (f) =>
          `<selection source="${f.source ?? "terminal"}">\n${f.text ?? ""}\n</selection>`,
      );
    const { body: bodyAfterTokens, blocks: snippetBlocks } =
      expandSnippetTokens(effectiveText, useSnippetsStore.getState().snippets);
    const seenHandles = new Set<string>();
    const allSnippetBlocks: string[] = [];
    for (const s of pickedSnippets) {
      if (seenHandles.has(s.handle)) continue;
      seenHandles.add(s.handle);
      allSnippetBlocks.push(
        `<snippet name="${s.handle}">\n${s.content}\n</snippet>`,
      );
    }
    for (const block of snippetBlocks) {
      const m = block.match(/^<snippet name="([^"]+)"/);
      if (m && seenHandles.has(m[1])) continue;
      if (m) seenHandles.add(m[1]);
      allSnippetBlocks.push(block);
    }
    const composed = [
      commandMarker ?? "",
      allSnippetBlocks.join("\n\n"),
      selectionBlocks.join("\n\n"),
      fileBlocks.join("\n\n"),
      bodyAfterTokens,
    ]
      .filter(Boolean)
      .join("\n\n");
    if (composed) parts.push({ type: "text", text: composed });

    for (const f of files) {
      if ((f.kind === "image" || f.kind === "file") && f.url) {
        parts.push({
          type: "file",
          mediaType: f.mediaType,
          url: f.url,
          filename: f.name,
        });
      }
    }

    if (parts.length > 0 && !parts.some((p) => p.type === "text")) {
      parts.unshift({
        type: "text",
        text: "Please inspect the attached file(s).",
      });
    }

    let targetSessionId = sessionId;
    if (!targetSessionId) {
      targetSessionId = useChatStore.getState().newSession();
    }
    const store = useChatStore.getState();
    // A typed message starts a new task, so the escalation ladder resets to
    // its first rung. Continue is the only thing that climbs it.
    store.patchAgentMeta({
      stopReason: null,
      runRound: 0,
      stoppedByUser: false,
      compactionNotice: null,
      pruneNotice: null,
      memoryNotice: null,
    });
    // A fresh task has nothing to resume, so drop the persisted run marker.
    store.syncRunMeta();
    if (!store.mini.open) store.openMini();
    void (async () => {
      try {
        const { sendParts } = await import("../store/chatRuntime");
        await sendParts(targetSessionId, parts as unknown as SteerPart[]);
      } catch (e) {
        // A silent failure here is why a typed message "doesn't show up": make
        // it visible so it is never a mystery again.
        console.error("[composer] send failed", e);
        toast.error(
          `Could not send your message${e instanceof Error ? `: ${e.message}` : ""}`,
          { id: "composer-send-failed" },
        );
      }
    })();
    setValue("");
    setFiles([]);
    setPickedSnippets([]);
    setPickedCommands([]);
    // Re-focus immediately after submit so the user can type a follow-up
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const stop = () => {
    if (!sessionId) return;
    void (async () => {
      const { stopRun } = await import("../store/chatRuntime");
      await stopRun();
    })();
  };

  // Enabled while busy too: submitting then means "queue this", not "race the
  // run". The stop button remains the way to interrupt.
  const canSend =
    value.trim().length > 0 ||
    files.length > 0 ||
    pickedSnippets.length > 0 ||
    pickedCommands.length > 0;

  const queued = useChatStore((st) => st.steerQueue.pending);
  const cancelQueued = useChatStore((st) => st.cancelSteer);

  // Pull a queued message back into the composer so it can be revised before
  // it sends (Hermes' queue-edit, adapted: Hermes edits in place inside the
  // strip; here the composer IS the editor, so the text moves back into it).
  // Attachments cannot be edited as text — they stay queued at the same
  // position so nothing is silently dropped and the send order is unchanged.
  const editQueued = (index: number) => {
    const store = useChatStore.getState();
    const msg = store.steerQueue.pending[index];
    if (!msg) return;
    const text = editableTextOf(msg.parts);
    const rest = msg.parts.filter((p) => p.type !== "text");
    store.replaceSteer(
      index,
      rest.length > 0 ? { preview: previewOf(rest), parts: rest } : null,
    );
    setValue((v) => (v.trim() ? `${text}\n${v}` : text));
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const ctx: ComposerCtx = {
    textareaRef,
    value,
    setValue,
    files,
    addFiles,
    attachFileByPath,
    removeFile,
    pickedSnippets,
    addSnippet,
    removeSnippet,
    pickedCommands,
    addCommand,
    removeCommand,
    queued,
    cancelQueued,
    editQueued,
    isBusy,
    submit,
    stop,
    voice,
    canSend,
  };

  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

export const IMAGE_ATTACH_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
]);

export function isImageAttachmentPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_ATTACH_EXTS.has(path.slice(dot + 1).toLowerCase());
}

export function isPdfPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return path.slice(dot + 1).toLowerCase() === "pdf";
}

export function imageMediaTypeFromName(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    default:
      return "image/png";
  }
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;

async function readAttachment(file: File): Promise<FileAttachment | null> {
  const id = `${file.name}-${file.size}-${file.lastModified}`;
  const isImage =
    file.type.startsWith("image/") || isImageAttachmentPath(file.name);
  if (isImage) {
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error(`Image "${file.name}" is too large (max 20 MB)`);
      return null;
    }
    const mediaType = file.type || imageMediaTypeFromName(file.name);
    const url = await readAsDataURL(file);
    return {
      id,
      name: file.name,
      kind: "image",
      mediaType,
      url,
      size: file.size,
    };
  }

  const isPdf = file.type === "application/pdf" || isPdfPath(file.name);
  if (isPdf) {
    if (file.size > MAX_PDF_BYTES) {
      toast.error(`PDF "${file.name}" is too large (max 20 MB)`);
      return null;
    }
    const url = await readAsDataURL(file);
    return {
      id,
      name: file.name,
      kind: "file",
      mediaType: "application/pdf",
      url,
      size: file.size,
    };
  }

  if (file.size > MAX_TEXT_INLINE) {
    toast.error(
      `File "${file.name}" is too large (max ${Math.round(MAX_TEXT_INLINE / 1000)} KB for text)`,
    );
    return null;
  }

  try {
    const text = await file.text();
    return {
      id,
      name: file.name,
      kind: "text",
      mediaType: file.type || "text/plain",
      text,
      size: file.size,
    };
  } catch {
    toast.error(`Could not read "${file.name}" as text`);
    return null;
  }
}

function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
