// Telegram slash-command and callback handlers.
//
// Extracted from bot.ts so the polling layer only has to fetch updates and
// route them here, and command logic can evolve without the long-poll loop
// getting bigger.

import {
  sendTelegram,
  answerCallback,
  editKeyboard,
  sendKeyboard,
  deleteTelegramMessage,
  type InlineButton,
} from "./telegramApi";
import { getPendingApprovals } from "./telegramHelpers";
import {
  startTelegramDispatch,
  startTelegramResume,
} from "./telegramDispatch";
import { useTelegramStore } from "./store";
import { ensureChatSession } from "../ai/store/chatStore";
import type { ModelChoice, ProviderGroup } from "./modelGroups";

export type Update = {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { id: number };
    text?: string;
    message_thread_id?: number | null;
  };
  callback_query?: {
    id: string;
    from?: { id: number };
    message?: {
      chat: { id: number };
      message_id?: number;
      message_thread_id?: number | null;
    };
    data?: string;
  };
};

async function modelLabel(modelId: string): Promise<string> {
  const { resolveModelLabel } = await import("./progressFormat");
  return resolveModelLabel(modelId);
}

/**
 * Whether a message may act as the paired owner.
 *
 * A chat id is shared by every member of a group, so the chat-level check is
 * not enough: any member could otherwise send /run, drive the default prompt
 * path, or /stop and /new the owner's session. `ownerUserId` is pinned at
 * /pair; when it is unset, a private chat id IS the user id (group ids are
 * negative), which covers bots paired from Settings - that path writes the chat
 * id but never a user id. When neither is known the bot is open, matching the
 * documented "open to all chats" state.
 */
function isOwnerUser(from?: { id: number }): boolean {
  const store = useTelegramStore.getState();
  const ownerUserId = store.ownerUserId;
  if (ownerUserId) return !!from && String(from.id) === String(ownerUserId);
  const chatId = store.chatId;
  if (!chatId || chatId.startsWith("-")) return true;
  return !!from && String(from.id) === chatId;
}

export async function buildStatus(): Promise<string> {
  const store = useTelegramStore.getState();
  const chat = await import("../ai/store/chatStore");
  const meta = chat.getAgentMeta();
  const model = chat.useChatStore.getState().selectedModelId;
  return [
    `Termigo bot ${store.online ? "online" : "offline"}`,
    `Model: ${await modelLabel(model)}`,
    `Agent: ${meta.status}`,
    `Enabled: ${store.enabled ? "yes" : "no"}`,
    `Paired: ${store.chatId ? `yes (ID: ${store.chatId})` : "no (open to all chats)"}`,
    store.lastError ? `Error: ${store.lastError}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function buildProviderGroups(): Promise<ProviderGroup[]> {
  const { MODELS, PROVIDERS, isCompatModelId, compatModelIdForEndpoint } =
    await import("../ai/config");
  const { usePreferencesStore } = await import(
    "@/modules/settings/preferences"
  );
  const chat = await import("../ai/store/chatStore");
  const state = chat.useChatStore.getState();
  const { buildModelGroups } = await import("./modelGroups");

  const providerLabel = (id: string): string => {
    if (id === "openai-compatible") return "OpenAI Compatible";
    return PROVIDERS.find((p) => p.id === id)?.label ?? id;
  };

  return buildModelGroups({
    models: MODELS,
    providerLabel,
    current: state.selectedModelId,
    apiKeys: state.apiKeys as Record<string, string | undefined>,
    customEndpointKeys: state.customEndpointKeys,
    customEndpoints: usePreferencesStore.getState().customEndpoints,
    isCompatModelId,
    compatModelIdForEndpoint,
  });
}

export const HELP = [
  "Termigo Telegram relay commands:",
  "/status - bot + agent status",
  "/pair - lock bot to this chat ID (only you can access)",
  "/unpair - unlock bot from this chat ID",
  "/query <text> - run query without live progress updates",
  "/run <text> - run instruction with live progress",
  "/continue - continue the current run if it stopped",
  "/approve - approve all pending actions",
  "/deny - deny all pending actions",
  "/mode [all|edits|ask] - view or set autonomy approval mode",
  "/scope [list|add <host>|clear] - view or manage pentest scope",
  "/stop - stop the current run",
  "/new - start a new agent session",
  "/model - pick a model (opens a provider -> model menu)",
  "/model <id> - set the model directly",
  "/cost - today's & total spend",
].join("\n");

export async function resolveModelInput(id: string): Promise<string | null> {
  const { MODELS, isCompatModelId, compatModelIdForEndpoint } = await import(
    "../ai/config"
  );
  const { usePreferencesStore } = await import(
    "@/modules/settings/preferences"
  );
  const trimmed = id.trim();
  const lower = trimmed.toLowerCase();
  const direct = MODELS.find((m) => m.id.toLowerCase() === lower);
  if (direct) return direct.id;

  const eps = usePreferencesStore.getState().customEndpoints;
  if (isCompatModelId(trimmed)) {
    const match = eps.find((ep) => compatModelIdForEndpoint(ep.id) === trimmed);
    if (match) return trimmed;
  }
  const epMatch = eps.find(
    (ep) =>
      ep.modelId.toLowerCase() === lower ||
      ep.name.toLowerCase() === lower ||
      ep.id.toLowerCase() === lower,
  );
  if (epMatch) return compatModelIdForEndpoint(epMatch.id);
  return null;
}

/** Mark the currently-selected model in the model keyboard with a check. */
function markModelButtons(
  models: ModelChoice[],
  current: string,
): InlineButton[][] {
  return models.map((m) => [
    {
      text: m.id === current ? `✓ ${m.label}` : m.label,
      callback_data: `ms:${m.id}`,
    },
  ]);
}

/** Answer an inline-keyboard callback from the /model menu. */
export async function handleCallback(
  cb: NonNullable<Update["callback_query"]>,
  signal: AbortSignal,
): Promise<void> {
  const data = cb.data ?? "";
  const msg = cb.message;
  if (!msg?.message_id) {
    await answerCallback(cb.id, null, signal);
    return;
  }
  const chatId = msg.chat.id;
  const owner = useTelegramStore.getState().chatId;
  if (owner && String(owner) !== String(chatId)) {
    await answerCallback(cb.id, "Unauthorized.", signal);
    return;
  }
  // Sensitive callbacks must come from the pairing *user*: a group chat shares
  // one chatId with all members, so the chat-level check above would let any
  // member take an owner action. `resume:run` starts a real agent round, and
  // `mp:`/`ms:` change the model every later run uses, so they are included.
  const sensitiveCallback =
    data.startsWith("ap:") ||
    data.startsWith("aq:") ||
    data.startsWith("el:") ||
    data.startsWith("resume:") ||
    data.startsWith("mp:") ||
    data.startsWith("ms:");
  if (sensitiveCallback && !isOwnerUser(cb.from)) {
    await answerCallback(cb.id, "Unauthorized.", signal);
    return;
  }
  const messageId = msg.message_id;

  if (data.startsWith("mp:")) {
    const key = data.slice(3);
    const groups = await buildProviderGroups();
    const group = groups.find((g) => g.key === key);
    if (!group) {
      await answerCallback(
        cb.id,
        "That provider is no longer available.",
        signal,
      );
      return;
    }
    await answerCallback(cb.id, null, signal);
    const state = await import("../ai/store/chatStore");
    const current = state.useChatStore.getState().selectedModelId;
    await editKeyboard(
      chatId,
      messageId,
      `Pick a model for ${group.label}:`,
      markModelButtons(group.models, current),
      signal,
    );
    return;
  }

  if (data.startsWith("ms:")) {
    const rawModel = data.slice(3);
    const resolved = await resolveModelInput(rawModel);
    if (!resolved) {
      await answerCallback(cb.id, "Unknown model.", signal);
      return;
    }
    const state = await import("../ai/store/chatStore");
    state.useChatStore.getState().setSelectedModelId(resolved);
    const { setDefaultModel } = await import("@/modules/settings/store");
    await setDefaultModel(resolved).catch(() => {});
    await answerCallback(cb.id, `Model set to ${resolved}`, signal);
    await editKeyboard(
      chatId,
      messageId,
      `Model set to ${resolved}.`,
      [],
      signal,
    );
    return;
  }

  if (data.startsWith("ap:")) {
    const [, action, ...rest] = data.split(":");
    // Rejoin so an approval id containing a colon is not silently truncated
    // (which reported "Approved." while answering nothing).
    const id = rest.join(":");
    const approved =
      action === "approve" || action === "session" || action === "always";
    const state = await import("../ai/store/chatStore");
    state.useChatStore.getState().respondToApproval(id, approved);
    if (action === "session" || action === "always") {
      const aqStore = await import("../ai/store/approvalQueueStore");
      const tool = (await import("../ai/store/chatStore")).useChatStore
        .getState()
        .agentMeta.pendingApprovals?.find((p) => p.id === id)?.toolName;
      if (tool) {
        if (action === "session") {
          aqStore.rememberSessionAllowed(tool);
        } else {
          aqStore.rememberSessionAllowed(tool);
          const settingsStore = await import("../settings/store");
          const prefs = await import("../settings/preferences");
          const list =
            prefs.usePreferencesStore.getState().agentAlwaysAllowedTools;
          if (!list.includes(tool)) {
            settingsStore.setAgentAlwaysAllowedTools([...list, tool]);
          }
        }
      }
    }
    await answerCallback(
      cb.id,
      approved
        ? action === "session"
          ? "Allowed for this session."
          : action === "always"
            ? "Always allowed."
            : "Approved."
        : "Denied.",
      signal,
    );
    await deleteTelegramMessage(chatId, messageId, signal);
    return;
  }

  if (data.startsWith("aq:")) {
    const [, action, ...rest] = data.split(":");
    const id = rest.join(":");
    const aq = await import("../ai/store/approvalQueueStore");
    const approved =
      action === "approve" || action === "session" || action === "always";
    if (action === "session") {
      aq.useApprovalQueue.getState().respondWith([id], "allow-session");
    } else if (action === "always") {
      aq.useApprovalQueue.getState().respondWith([id], "allow-always");
    } else {
      aq.useApprovalQueue.getState().respond([id], approved);
    }
    await answerCallback(
      cb.id,
      action === "session"
        ? "Allowed for this session."
        : action === "always"
          ? "Always allowed."
          : approved
            ? "Approved."
            : "Denied.",
      signal,
    );
    await deleteTelegramMessage(chatId, messageId, signal);
    return;
  }

  if (data.startsWith("el:")) {
    // The index is the LAST colon-separated field, so an id that contains a
    // colon (opaque, third-party supplied) is preserved.
    const rest = data.slice(3);
    const sep = rest.lastIndexOf(":");
    const id = sep === -1 ? rest : rest.slice(0, sep);
    const idx = parseInt(sep === -1 ? "" : rest.slice(sep + 1), 10);
    const el = await import("../ai/store/elicitationStore");
    const item = el.useElicitationStore
      .getState()
      .pending.find((p) => p.id === id);
    if (item?.options[idx]) {
      const choice = item.options[idx];
      el.useElicitationStore.getState().answer(id, choice);
      await answerCallback(cb.id, `Selected: ${choice}`, signal);
      await editKeyboard(chatId, messageId, `Selected: ${choice}`, [], signal);
      return;
    }
    await answerCallback(cb.id, "Question no longer pending.", signal);
    return;
  }

  if (data === "resume:run") {
    await answerCallback(cb.id, "Continuing to next round...", signal);
    if (messageId) {
      await editKeyboard(
        chatId,
        messageId,
        "Continuing to next round...",
        [],
        signal,
      ).catch(() => {});
    }
    startTelegramResume(chatId, signal);
    return;
  }

  await answerCallback(cb.id, null, signal);
}

export async function handleUpdate(u: Update, signal: AbortSignal): Promise<void> {
  // Inline-keyboard taps from the /model menu come through as callback_query.
  if (u.callback_query) {
    await handleCallback(u.callback_query, signal);
    return;
  }
  const msg = u.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const owner = useTelegramStore.getState().chatId;
  if (owner && String(owner) !== String(chatId)) return;

  const text = msg.text.trim();
  const [head, ...rest] = text.split(/\s+/);
  const tail = rest.join(" ").trim();

  switch (head) {
    case "/status":
      await sendTelegram(chatId, await buildStatus(), signal);
      return;
    case "/pair": {
      const curOwner = useTelegramStore.getState().chatId;
      if (curOwner && String(curOwner) !== String(chatId)) {
        return;
      }
      useTelegramStore.getState().setChatId(String(chatId));
      if (msg.from?.id != null) {
        useTelegramStore.getState().setOwnerUserId(String(msg.from.id));
      }
      await sendTelegram(
        chatId,
        `Paired successfully. This bot is now locked to your chat ID (${chatId}). Messages from other chats will be ignored.`,
        signal,
      );
      return;
    }
    case "/unpair": {
      const curOwner = useTelegramStore.getState().chatId;
      if (curOwner && String(curOwner) !== String(chatId)) {
        return;
      }
      const ownerUserId = useTelegramStore.getState().ownerUserId;
      if (
        ownerUserId &&
        (!msg.from || String(msg.from.id) !== String(ownerUserId))
      ) {
        return;
      }
      useTelegramStore.getState().setChatId(null);
      useTelegramStore.getState().setOwnerUserId(null);
      await sendTelegram(
        chatId,
        "Bot has been unpaired. Any chat can now interact with this bot.",
        signal,
      );
      return;
    }
    case "/help":
      await sendTelegram(chatId, HELP, signal);
      return;
    case "/query": {
      if (!isOwnerUser(msg.from)) return;
      if (!tail)
        return void (await sendTelegram(
          chatId,
          "Usage: /query <question>",
          signal,
        ));
      await ensureChatSession(chatId, msg.message_thread_id ?? null);
      startTelegramDispatch(
        tail,
        chatId,
        signal,
        "Question received, answering directly without progress.",
        "question",
      );
      return;
    }
    case "/run": {
      if (!isOwnerUser(msg.from)) return;
      if (!tail)
        return void (await sendTelegram(chatId, "Usage: /run <task>", signal));
      await ensureChatSession(chatId, msg.message_thread_id ?? null);
      startTelegramDispatch(
        tail,
        chatId,
        signal,
        "Task submitted - I'll post progress here.",
        "task",
      );
      return;
    }
    case "/continue":
    case "/resume":
    case "/next": {
      if (!isOwnerUser(msg.from)) return;
      await ensureChatSession(chatId, msg.message_thread_id ?? null);
      startTelegramResume(chatId, signal);
      return;
    }
    case "/stop": {
      if (!isOwnerUser(msg.from)) return;
      await ensureChatSession(chatId, msg.message_thread_id ?? null);
      const runtime = await import("../ai/store/chatRuntime");
      await runtime.stopRun();
      await sendTelegram(
        chatId,
        "Stop requested - the current run will settle.",
        signal,
      );
      return;
    }
    case "/new": {
      if (!isOwnerUser(msg.from)) return;
      const state = await import("../ai/store/chatStore");
      state.useChatStore
        .getState()
        .newSession(chatId, msg.message_thread_id ?? null);
      await sendTelegram(chatId, "New agent session started.", signal);
      return;
    }
    case "/model": {
      if (!isOwnerUser(msg.from)) return;
      const state = await import("../ai/store/chatStore");
      if (!tail) {
        const current = state.useChatStore.getState().selectedModelId;
        const groups = await buildProviderGroups();
        const keyboard = groups.map((g) => [
          { text: g.label, callback_data: `mp:${g.key}` },
        ]);
        if (keyboard.length === 0) {
          await sendTelegram(
            chatId,
            `Current model: ${current}\n\nNo other providers are configured.`,
            signal,
          );
          return;
        }
        await sendKeyboard(
          chatId,
          `Current model: ${current}\n\nChoose a provider:`,
          keyboard,
          signal,
        );
        return;
      }
      const resolved = await resolveModelInput(tail);
      if (!resolved) {
        await sendTelegram(
          chatId,
          `Unknown model '${tail}'. Send /model for the picker.`,
          signal,
        );
        return;
      }
      state.useChatStore.getState().setSelectedModelId(resolved);
      const { setDefaultModel } = await import("@/modules/settings/store");
      await setDefaultModel(resolved).catch(() => {});
      await sendTelegram(chatId, `Model set to ${resolved}.`, signal);
      return;
    }
    case "/cost": {
      if (!isOwnerUser(msg.from)) return;
      const { costToday, loadCostLedger, sumCost } = await import(
        "../ai/lib/costLedger"
      );
      const today = await costToday();
      const total = sumCost(await loadCostLedger());
      await sendTelegram(
        chatId,
        `Cost today: $${today.toFixed(4)}\nTotal recorded: $${total.toFixed(4)}`,
        signal,
      );
      return;
    }
    case "/approve": {
      const ownerUserId = useTelegramStore.getState().ownerUserId;
      if (
        ownerUserId &&
        (!msg.from || String(msg.from.id) !== String(ownerUserId))
      ) {
        return;
      }
      const state = await import("../ai/store/chatStore");
      const aq = await import("../ai/store/approvalQueueStore");
      const sessionId = state.useChatStore.getState().activeSessionId;
      const pending = sessionId
        ? getPendingApprovals(sessionId, state, aq.useApprovalQueue)
        : [];
      let count = 0;
      for (const p of pending) {
        state.useChatStore.getState().respondToApproval(p.id, true);
        aq.useApprovalQueue.getState().respond([p.id], true);
        count++;
      }
      await sendTelegram(
        chatId,
        `Approved ${count} pending action(s).`,
        signal,
      );
      return;
    }
    case "/deny": {
      const ownerUserId = useTelegramStore.getState().ownerUserId;
      if (
        ownerUserId &&
        (!msg.from || String(msg.from.id) !== String(ownerUserId))
      ) {
        return;
      }
      const state = await import("../ai/store/chatStore");
      const aq = await import("../ai/store/approvalQueueStore");
      const sessionId = state.useChatStore.getState().activeSessionId;
      const pending = sessionId
        ? getPendingApprovals(sessionId, state, aq.useApprovalQueue)
        : [];
      let count = 0;
      for (const p of pending) {
        state.useChatStore.getState().respondToApproval(p.id, false);
        aq.useApprovalQueue.getState().respond([p.id], false);
        count++;
      }
      await sendTelegram(chatId, `Denied ${count} pending action(s).`, signal);
      return;
    }
    case "/mode": {
      const ownerUserId = useTelegramStore.getState().ownerUserId;
      if (
        ownerUserId &&
        (!msg.from || String(msg.from.id) !== String(ownerUserId))
      ) {
        return;
      }
      const { setAgentApprovalMode } = await import(
        "@/modules/settings/store"
      );
      const { usePreferencesStore } = await import(
        "@/modules/settings/preferences"
      );
      const cur = usePreferencesStore.getState().agentApprovalMode;
      if (!tail) {
        await sendTelegram(
          chatId,
          `Current autonomy approval mode: ${cur}\n\nOptions:\n- /mode all - execute all tools autonomously without prompting\n- /mode edits - auto-approve file edits, prompt for terminal commands\n- /mode ask - prompt for every action`,
          signal,
        );
        return;
      }
      if (tail === "all") {
        await setAgentApprovalMode("all");
        await sendTelegram(
          chatId,
          "Approval mode set to: all (autonomous execution).",
          signal,
        );
        return;
      }
      if (tail === "edits") {
        await setAgentApprovalMode("edits");
        await sendTelegram(
          chatId,
          "Approval mode set to: edits (auto file edits).",
          signal,
        );
        return;
      }
      if (tail === "ask") {
        await setAgentApprovalMode("ask");
        await sendTelegram(
          chatId,
          "Approval mode set to: ask (prompt every time).",
          signal,
        );
        return;
      }
      await sendTelegram(
        chatId,
        "Unknown mode. Use: /mode all, /mode edits, or /mode ask",
        signal,
      );
      return;
    }
    case "/scope": {
      const ownerUserId = useTelegramStore.getState().ownerUserId;
      if (
        ownerUserId &&
        (!msg.from || String(msg.from.id) !== String(ownerUserId))
      ) {
        return;
      }
      const { setPentestScope, setEnforcePentestScope } = await import(
        "@/modules/settings/store"
      );
      const { usePreferencesStore } = await import(
        "@/modules/settings/preferences"
      );
      const prefs = usePreferencesStore.getState();
      const scope = prefs.pentestScope ?? [];
      const [sub, ...args] = tail.split(/\s+/);
      if (!sub || sub === "list") {
        const statusStr = prefs.enforcePentestScope ? "enforced" : "disabled";
        const scopeStr =
          scope.length > 0
            ? scope.map((h) => `  - ${h}`).join("\n")
            : "  (no targets configured - pentest tools are blocked when enforcement is on)";
        await sendTelegram(
          chatId,
          `Pentest scope (${statusStr}):\n${scopeStr}\n\nCommands:\n/scope add <host>\n/scope clear\n/scope toggle`,
          signal,
        );
        return;
      }
      if (sub === "add") {
        const host = args.join(" ").trim();
        if (!host) {
          await sendTelegram(chatId, "Usage: /scope add <ip-or-host>", signal);
          return;
        }
        await setPentestScope([...new Set([...scope, host])]);
        await sendTelegram(
          chatId,
          `Added '${host}' to authorized pentest scope.`,
          signal,
        );
        return;
      }
      if (sub === "clear") {
        await setPentestScope([]);
        await sendTelegram(chatId, "Authorized pentest scope cleared.", signal);
        return;
      }
      if (sub === "toggle") {
        const next = !prefs.enforcePentestScope;
        await setEnforcePentestScope(next);
        await sendTelegram(
          chatId,
          `Pentest scope enforcement: ${next ? "enabled" : "disabled"}.`,
          signal,
        );
        return;
      }
      await sendTelegram(
        chatId,
        "Usage: /scope [list | add <host> | clear | toggle]",
        signal,
      );
      return;
    }
    default:
      if (text.startsWith("/")) {
        await sendTelegram(chatId, HELP, signal);
        return;
      }
      if (!isOwnerUser(msg.from)) return;
      startTelegramDispatch(
        text,
        chatId,
        signal,
        "Started working on your request.\nProgress updates will appear here.",
      );
      return;
  }
}
