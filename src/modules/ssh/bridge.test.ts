import { describe, expect, it, vi } from "vitest";

import { dispatchSshEvent, type SshEvent, type SshHandlers } from "./bridge";

function b64(s: string): string {
  return btoa(s);
}

describe("dispatchSshEvent", () => {
  it("routes each event to its handler", () => {
    const handlers = {
      onData: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
      onConnected: vi.fn(),
      onJumpConnected: vi.fn(),
      onHostKeyPrompt: vi.fn(),
    } satisfies SshHandlers;

    dispatchSshEvent({ type: "connected", fingerprint: "SHA256:aa" }, handlers);
    dispatchSshEvent({ type: "data", data: b64("hi") }, handlers);
    dispatchSshEvent({ type: "exit", code: 0 }, handlers);
    dispatchSshEvent({ type: "error", message: "boom" }, handlers);

    expect(handlers.onConnected).toHaveBeenCalledWith("SHA256:aa");
    expect(handlers.onData).toHaveBeenCalledWith(new TextEncoder().encode("hi"));
    expect(handlers.onExit).toHaveBeenCalledWith(0);
    expect(handlers.onError).toHaveBeenCalledWith("boom");
  });

  // The server PTY usually merges the streams, but a server that does not must
  // still show its errors rather than dropping them.
  it("surfaces stderr through the data handler", () => {
    const onData = vi.fn();
    dispatchSshEvent({ type: "stderr", data: b64("warn") }, { onData });
    expect(onData).toHaveBeenCalledWith(new TextEncoder().encode("warn"));
  });

  it("ignores events the caller did not subscribe to", () => {
    expect(() =>
      dispatchSshEvent({ type: "connected", fingerprint: "x" }, { onData: vi.fn() }),
    ).not.toThrow();
  });
});

// Tauri only advances its ordered-delivery cursor after onmessage returns, so a
// handler that throws parks the cursor and every later event is filed as
// out-of-order and never delivered. That turned one bad callback into a
// terminal that connected and then stayed blank, so the boundary that keeps a
// throw from escaping is worth pinning down.
describe("channel error boundary", () => {
  function guarded(handlers: SshHandlers) {
    return (event: SshEvent) => {
      try {
        dispatchSshEvent(event, handlers);
      } catch {
        /* swallowed, exactly as openSsh does */
      }
    };
  }

  it("keeps delivering data after a handler throws", () => {
    const onData = vi.fn();
    const onmessage = guarded({
      onData,
      onConnected: () => {
        throw new Error("handler blew up");
      },
    });

    expect(() => onmessage({ type: "connected", fingerprint: "x" })).not.toThrow();
    onmessage({ type: "data", data: b64("prompt$ ") });

    expect(onData).toHaveBeenCalledWith(new TextEncoder().encode("prompt$ "));
  });
});
