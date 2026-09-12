// Relay observability.
//
// The Telegram path produced no log lines at all. `grep -ci telegram` on a
// running headless install's 238-line log returned 0, which meant that from
// outside the app a healthy relay, a stalled poller and a run that never
// answered were indistinguishable - telling them apart required reading the
// session store off disk with a throwaway script, and the operator had no way
// to diagnose it at all. These are the events that answer "what is it doing
// right now", with the wording kept in pure functions so a test can assert it.
//
// What is deliberately NOT logged: message bodies, prompts and model output.
// The file sits next to the session store, but it is also the thing people
// paste into a bug report, and a prompt routinely carries a path, a client
// name or a credential. Lengths and ids identify an event without exporting it.

import { info as logInfo, warn as logWarn } from "@tauri-apps/plugin-log";

/** The subset of a Telegram update this module needs. Structural on purpose. */
export type UpdateLike = {
  update_id: number;
  message?: {
    chat?: { id?: number };
    text?: string;
  };
  callback_query?: {
    data?: string;
    message?: { chat?: { id?: number } };
  };
};

/** Prefix every line, so one grep separates the relay from the agent. */
const TAG = "[telegram]";

/** Milliseconds as a compact human duration: `4s`, `1m30s`, `2h5m`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const seconds = total % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

/**
 * One line for an inbound update.
 *
 * The command name is logged because `/model` and `/status` are cheap and
 * repeatable while a task prompt is expensive, and the difference explains an
 * idle-looking relay. The prompt itself is reduced to a character count.
 */
export function updateLine(u: UpdateLike): string {
  const id = `update ${u.update_id}`;
  const msg = u.message;
  if (msg) {
    const chat = msg.chat?.id ?? "?";
    const text = msg.text ?? "";
    if (text.length === 0) return `${id} message chat=${chat} (no text)`;
    if (text.startsWith("/")) {
      const command = text.split(/\s+/)[0];
      return `${id} command ${command} chat=${chat} (${text.length}ch)`;
    }
    return `${id} message chat=${chat} (${text.length}ch)`;
  }
  const cb = u.callback_query;
  if (cb) {
    const chat = cb.message?.chat?.id ?? "?";
    return `${id} callback "${cb.data ?? "(none)"}" chat=${chat}`;
  }
  return `${id} (unsupported type)`;
}

/** What a dispatched run produced. */
export type RunOutcome = {
  sessionId: string;
  chatId: number | string;
  elapsedMs: number;
  /** How many replies were sent back to the chat. */
  replies: number;
  /** Total characters sent. Zero with a non-zero elapsed time is the hang. */
  sentChars: number;
  /** True when the reply was a canned status line rather than an answer. */
  fallback: boolean;
  stopReason: string | null;
  status: string;
  /** Approvals still unanswered when the handler ended. */
  pendingApprovals: number;
};

/**
 * One line per relayed run.
 *
 * This is the line whose absence made "the agent hangs without producing
 * output" impossible to confirm: `steps 1/25` in the agent log says a request
 * was made, not whether the chat ever received anything. `replies` and
 * `sentChars` say exactly that, and `BLOCKED` names the third cause, a run
 * parked on an approval nobody answered.
 */
export function runOutcomeLine(o: RunOutcome): string {
  const kind = o.fallback ? "fallback" : "answer";
  const blocked =
    o.pendingApprovals > 0
      ? ` | BLOCKED on ${o.pendingApprovals} unanswered approval(s)`
      : "";
  return (
    `run ${o.sessionId} chat=${o.chatId} ${formatDuration(o.elapsedMs)} | ` +
    `${o.replies} ${kind}(s), ${o.sentChars}ch sent | ` +
    `stop ${o.stopReason ?? "done"} | status ${o.status}${blocked}`
  );
}

/**
 * The relay is waiting on a human.
 *
 * Worth a line of its own because it is the one state where nothing will ever
 * change on its own, and the agent log is silent throughout: the request
 * completed and the next step is an approval that only exists inside Telegram.
 * Deduplicated by the caller so a long wait logs once, not every tick.
 */
export function approvalWaitLine(
  count: number,
  toolNames: readonly string[],
): string {
  const names = [...new Set(toolNames)].slice(0, 5).join(", ");
  return (
    `waiting on ${count} unanswered approval(s)${names ? `: ${names}` : ""}` +
    " - the run cannot proceed until it is answered in Telegram or the app"
  );
}

/** A failure, with the place it happened. Errors used to be swallowed. */
export function relayErrorLine(where: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${where} failed: ${message}`;
}

/**
 * Emit a relay line.
 *
 * The rejection is swallowed deliberately, and this is not cosmetic: `info`
 * reaches Tauri's `invoke`, which rejects outside the app (a test process, or
 * a webview that has not finished booting), and `void` on that promise leaves
 * an unhandled rejection - which vitest reports as a failed run even when every
 * test passed. Diagnostics must never be able to fail the thing they describe.
 */
function emit(
  write: (message: string) => Promise<void>,
  line: string,
): void {
  write(`${TAG} ${line}`).catch(() => {});
}

export function logRelayInfo(line: string): void {
  emit(logInfo, line);
}

export function logRelayWarn(line: string): void {
  emit(logWarn, line);
}
