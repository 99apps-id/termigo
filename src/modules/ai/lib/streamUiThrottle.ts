// Cadence for streamed chat UI updates, and the one place the `useChat`
// options that apply it are built.
//
// Why this exists at all. The AI SDK notifies its subscribers on every streamed
// token, and `ReactChatState.replaceMessage` (see `@ai-sdk/react`) hands React a
// `structuredClone` of the WHOLE assistant message as the new value. React
// renders that synchronously through `useSyncExternalStore`, so each token costs
// a full transcript render for the message being streamed: the answer markdown
// is re-lexed end to end (Streamdown runs `remend` plus a `marked` lexer over
// the full text, so this is quadratic in answer length), and every tool card in
// the message is re-rendered because the clone gives each part a brand new
// object identity - which also defeats the identity guards written into
// `Tool` and `ToolDiffCard` (JSON.stringify of object outputs, the ANSI walk,
// and an LCS line diff).
//
// Measured on the packaged app. One streamed step grew from roughly five
// seconds to five minutes as the run accumulated tool output, with the provider
// answering in about two seconds per step, and for the whole of such a step the
// Telegram long-poll watchdog logged
//
//   [telegram] polling stalled: no getUpdates progress for 141s, recycling poller
//
// once every couple of minutes, with no network failure and no 409 in the log.
// The poll loop and that watchdog share the main thread with this rendering, so
// what the watchdog measured was not a hung poll but a starved one: its own
// `setInterval` tick was 60s late, which only happens when the thread cannot
// run anything. The recycle could not help (the replacement is starved with it)
// and risked the duplicate-poller 409 the recycle path exists to avoid.
//
// 100ms is deliberately just past the point where a stream stops reading as
// continuous text for a human, and it cuts the per-token clone, markdown re-lex
// and tool-card re-render by one to two orders of magnitude on a fast provider.
// `experimental_throttle` is the SDK's own hook for this: it wraps the message
// subscriber in `throttleit(fn, waitMs)`, which is leading AND trailing, so the
// final token of a step still lands and no partial answer is left on screen.

import type { Chat, UIMessage } from "@ai-sdk/react";

/** Update cadence for the streamed transcript, in milliseconds. */
export const STREAM_UI_THROTTLE_MS = 100;

/**
 * The `useChat` options every subscription in the app must pass.
 *
 * Built here rather than written out at each call site because the two
 * subscribers - the headless bridge and the surface that draws the transcript -
 * watch the same `Chat` instance, and one of them without the throttle is
 * enough to restore the per-token render described in this module's header.
 * Nothing functional depends on the arrival rate: the runtime reads the answer
 * from `chat.messages`, which is never throttled, so only rendering is slowed.
 */
export function chatStreamOptions(chat: Chat<UIMessage>): {
  chat: Chat<UIMessage>;
  experimental_throttle: number;
} {
  return { chat, experimental_throttle: STREAM_UI_THROTTLE_MS };
}
