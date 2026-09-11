// Command and callback handlers for Telegram bot updates.

import {
  answerCallback,
  deleteTelegramMessage,
  editKeyboard,
  sendKeyboard,
  sendTelegram,
} from "./api";
import { useTelegramStore } from "./store";
import {
  buildProviderGroups,
  buildStatus,
  getPendingApprovals,
  resolveModelInput,
  startTelegramDispatch,
  startTelegramResume,
} from "./bot";

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

const HELP = [
  "/status - bot + agent status",
  "/pair - lock bot to this chat ID (only you can access)",
  "/unpair - unlock bot from this chat ID",
  "/query <question> - read-only question (or just type the question)",
  "/run <task> - run a task in the agent",
  "/continue - continue to next step (50/100 steps)",
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
  const ownerUserId = useTelegramStore.getState().ownerUserId;
  if (
    ownerUserId &&
    (data.startsWith("ap:") ||
      data.startsWith("aq:") ||
      data.startsWith("el:")) &&
    (!cb.from || String(cb.from.id) !== String(ownerUserId))
  ) {
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
    const { useChatStore } = await import("../ai/store/chatStore");
    const current = useChatStore.getState().selectedModelId;
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
    const { useChatStore } = await import("../ai/store/chatStore");
    useChatStore.getState().setSelectedModelId(resolved);
    const { setDefaultModel } = await import("@/modules/settings/store");
    void setDefaultModel(resolved);
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
    const [, action, id] = data.split(":");
    const approved =
      action === "approve" || action === "session" || action === "always";
    const { useChatStore } = await import("../ai/store/chatStore");
    useChatStore.getState().respondToApproval(id, approved);
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
    const [, action, id] = data.split(":");
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
    const [, id, idxStr] = data.split(":");
    const idx = parseInt(idxStr, 10);
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
    await startTelegramResume(chatId, signal);
    return;
  }

  await answerCallback(cb.id, null, signal);
}

export async function handleUpdate(u: Update, signal: AbortSignal): Promise<void> {
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
      if (!tail)
        return void (await sendTelegram(
          chatId,
          "Usage: /query <question>",
          signal,
        ));
      await startTelegramDispatch(
        tail,
        chatId,
        signal,
        "Question received, answering directly without progress.",
        "question",
      );
      return;
    }
    case "/run": {
      if (!tail)
        return void (await sendTelegram(chatId, "Usage: /run <task>", signal));
      await startTelegramDispatch(
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
      await startTelegramResume(chatId, signal);
      return;
    }
    case "/stop": {
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
      const state = await import("../ai/store/chatStore");
      state.useChatStore
        .getState()
        .newSession(chatId, msg.message_thread_id ?? null);
      await sendTelegram(chatId, "New agent session started.", signal);
      return;
    }
    case "/model": {
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
      void setDefaultModel(resolved);
      await sendTelegram(chatId, `Model set to ${resolved}.`, signal);
      return;
    }
    case "/cost": {
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
      const { usePreferencesStore } = await import(
        "@/modules/settings/preferences"
      );
      const { setAgentApprovalMode } = await import("@/modules/settings/store");
      const current = usePreferencesStore.getState().agentApprovalMode;
      if (!tail) {
        await sendTelegram(
          chatId,
          `Current approval mode: ${current}\n\nTo change: /mode all (autonomous), /mode edits (auto edits), /mode ask (always ask)`,
          signal,
        );
        return;
      }
      if (tail === "all" || tail === "auto") {
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
        "Usage: /mode [all|edits|ask]",
        signal,
      );
      return;
    }
  }

  await startTelegramDispatch(
    text,
    chatId,
    signal,
    "Task submitted - I'll post progress here.",
    "task",
  );
}

function markModelButtons(
  models: Array<{ id: string; label: string }>,
  current: string,
): Array<Array<{ text: string; callback_data?: string }>> {
  return models.map((m) => [
    {
      text: `${m.label}${m.id === current ? " ✓" : ""}`,
      callback_data: `ms:${m.id}`,
    },
  ]);
}