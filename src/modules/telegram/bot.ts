// Thin barrel re-export for the Telegram bot relay.
//
// All implementation lives in the extracted modules below. This file exists
// so existing imports like `import { startTelegramBot } from "./bot"` keep
// working during the modularisation, and so tests can reach internal state
// through `_testOnly`.

// Re-import test-visible state/setters at the top level so `_testOnly` can
// expose them synchronously.
import {
  seenMessageIds,
  seenFingerprints,
  telegramOriginMessageIds,
  recentTelegramPrompts,
  recordTelegramText,
  isTelegramOriginText,
  markMessageSeen,
  isMessageSeen,
  pauseMirror,
  resumeMirror,
  getMirrorPauseCount,
} from "./telegramDedup";
import {
  splitTelegramText,
  sendTelegram,
  deleteTelegramMessage,
  editProgressMessage,
  apiGet,
  apiPost,
} from "./telegramApi";
import {
  getPendingApprovals,
  runBusy,
  clampTelegramText,
} from "./telegramHelpers";
import {
  lastFinishedProgressMessageIds,
} from "./telegramProgress";
import {
  startTelegramDispatch,
} from "./telegramDispatch";
import {
  handleCallback,
  handleUpdate,
} from "./telegramCommands";
import {
  checkPollingStall,
} from "./telegramPolling";

// --- Core ---
export { startTelegramBot, stopTelegramBot } from "./telegramPolling";

// --- Dispatch ---
export {
  runMirror,
  startTelegramResume,
  startTelegramDispatch,
  dispatchAndStream,
} from "./telegramDispatch";

// --- Commands ---
export { handleCallback, handleUpdate, buildProviderGroups, resolveModelInput, HELP } from "./telegramCommands";

// --- Progress ---
export {
  publishProgress,
  progressCtrls,
  lastFinishedProgressMessageIds,
  sentApprovalIds,
} from "./telegramProgress";

// --- API ---
export { TelegramApiError, sendProgressMessage, editProgressMessage, sendKeyboard, splitTelegramText } from "./telegramApi";
export { apiGet, apiPost } from "./telegramApi";

// --- Helpers ---
export {
  getPendingApprovals,
  runBusy,
  countAssistantMessages,
  lastAssistantText,
  messageText,
  clampTelegramText,
} from "./telegramHelpers";

// --- Dedup (internal, exported for tests) ---
export {
  seenMessageIds,
  seenFingerprints,
  telegramOriginMessageIds,
  recentTelegramPrompts,
  recordTelegramText,
  isTelegramOriginText,
  markMessageSeen,
  isMessageSeen,
  pauseMirror,
  resumeMirror,
} from "./telegramDedup";

// Re-import polling state that tests historically reach through bot.ts.
import {
  currentUpdateOffset,
  lastPollProgressTime,
  setCurrentUpdateOffset,
  setLastPollProgressTime,
  POLLING_STALL_TIMEOUT_MS,
} from "./telegramPolling";

// Test-only surface.
export const _testOnly = {
  seenMessageIds,
  seenFingerprints,
  telegramOriginMessageIds,
  recentTelegramPrompts,
  recordTelegramText,
  isTelegramOriginText,
  markMessageSeen,
  isMessageSeen,
  pauseMirror,
  resumeMirror,
  getMirrorPauseCount,
  splitTelegramText,
  clampTelegramText,
  runBusy,
  getPendingApprovals,
  startTelegramDispatch,
  sendTelegram,
  deleteTelegramMessage,
  lastFinishedProgressMessageIds,
  checkPollingStall,
  getLastPollProgressTime: () => lastPollProgressTime,
  setLastPollProgressTime,
  getCurrentUpdateOffset: () => currentUpdateOffset,
  setCurrentUpdateOffset,
  POLLING_STALL_TIMEOUT_MS,
  editProgressMessage,
  apiGet,
  apiPost,
  handleCallback,
  handleUpdate,
} as const;
