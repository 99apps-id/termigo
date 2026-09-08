import { describe, expect, it, beforeEach, vi } from "vitest";
import { _testOnly, TelegramApiError } from "./bot";
import { useTelegramStore } from "./store";

vi.mock("./keyring", () => ({
  getTelegramToken: vi.fn().mockResolvedValue("mock_token_123"),
  getTelegramOwner: vi.fn().mockResolvedValue(null),
  setTelegramToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return null;
    }
    async set() {}
    async save() {}
  },
}));

vi.mock("../ai/store/chatRuntime", () => ({
  sendMessage: vi.fn().mockResolvedValue(true),
  flushSteer: vi.fn().mockResolvedValue(true),
  resumeRun: vi.fn().mockResolvedValue(true),
  stopRun: vi.fn().mockResolvedValue(undefined),
}));

describe("Telegram bot relay message tracking and echo suppression", () => {
  const {
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
  } = _testOnly;

  beforeEach(() => {
    seenMessageIds.clear();
    seenFingerprints.clear();
    telegramOriginMessageIds.clear();
    recentTelegramPrompts.clear();
  });

  describe("prompt tracking", () => {
    it("records telegram prompts and recognizes them", () => {
      expect(isTelegramOriginText("hello bot")).toBe(false);
      recordTelegramText("hello bot");
      expect(isTelegramOriginText("hello bot")).toBe(true);
      expect(isTelegramOriginText("  hello bot  ")).toBe(true);
      expect(isTelegramOriginText("different prompt")).toBe(false);
    });

    it("handles empty or whitespace strings gracefully", () => {
      recordTelegramText("   ");
      expect(recentTelegramPrompts.size).toBe(0);
      expect(isTelegramOriginText("   ")).toBe(false);
    });
  });

  describe("seen message tracking", () => {
    it("marks and detects messages by id", () => {
      expect(isMessageSeen("msg-1", "s-1", "user", "run a test")).toBe(false);
      markMessageSeen("msg-1", "s-1", "user", "run a test");
      expect(isMessageSeen("msg-1", "s-1", "user", "run a test")).toBe(true);
      expect(seenMessageIds.has("msg-1")).toBe(true);
    });

    it("falls back to fingerprint when id is missing", () => {
      expect(isMessageSeen(undefined, "s-1", "user", "test fallback")).toBe(false);
      markMessageSeen(undefined, "s-1", "user", "test fallback");
      expect(isMessageSeen(undefined, "s-1", "user", "test fallback")).toBe(true);
      expect(isMessageSeen(undefined, "s-2", "user", "test fallback")).toBe(false);
    });
  });

  describe("mirror pause counter", () => {
    it("increments and decrements cleanly without going below zero", () => {
      const initial = getMirrorPauseCount();
      pauseMirror();
      expect(getMirrorPauseCount()).toBe(initial + 1);
      pauseMirror();
      expect(getMirrorPauseCount()).toBe(initial + 2);
      resumeMirror();
      expect(getMirrorPauseCount()).toBe(initial + 1);
      resumeMirror();
      expect(getMirrorPauseCount()).toBe(initial);
      resumeMirror();
      expect(getMirrorPauseCount()).toBe(Math.max(0, initial - 1));
    });
  });

  describe("message chunking", () => {
    it("leaves messages under 4000 characters in a single chunk", () => {
      const short = "Short message";
      expect(splitTelegramText(short)).toEqual([short]);
    });

    it("splits long messages at line breaks when available", () => {
      const line1 = "a".repeat(2500);
      const line2 = "b".repeat(2000);
      const combined = `${line1}\n${line2}`;
      const chunks = splitTelegramText(combined);
      expect(chunks.length).toBe(2);
      expect(chunks[0]).toBe(line1);
      expect(chunks[1]).toBe(line2);
    });

    it("clamps without throwing", () => {
      const longText = "x".repeat(5000);
      expect(clampTelegramText(longText).length).toBe(4003);
      expect(clampTelegramText(longText).endsWith("...")).toBe(true);
    });
  });

  describe("runBusy detection", () => {
    it("recognizes in-flight chat statuses as busy", () => {
      expect(runBusy("submitted", "idle")).toBe(true);
      expect(runBusy("streaming", "idle")).toBe(true);
      expect(runBusy("ready", "idle")).toBe(false);
      expect(runBusy("", "idle")).toBe(false);
    });

    it("recognizes in-flight app statuses as busy", () => {
      expect(runBusy("ready", "thinking")).toBe(true);
      expect(runBusy("ready", "streaming")).toBe(true);
      expect(runBusy("ready", "awaiting-approval")).toBe(true);
      expect(runBusy("ready", "error")).toBe(false);
      expect(runBusy("ready", "idle")).toBe(false);
    });
  });

  describe("startTelegramDispatch steer & busy handling", () => {
    it("notifies user and queues request when agent is busy", async () => {
      const chatStore = await import("../ai/store/chatStore");
      chatStore.useChatStore.setState({ activeSessionId: "session-test" });
      chatStore.useChatStore.getState().patchAgentMeta({ status: "thinking" });

      const sentBodies: Array<{ text?: string }> = [];
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (_url, init) => {
        if (init?.body) {
          try {
            sentBodies.push(JSON.parse(String(init.body)));
          } catch {}
        }
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 1 } }),
          text: async () => JSON.stringify({ ok: true }),
        } as unknown as Response;
      });

      const controller = new AbortController();
      await _testOnly.startTelegramDispatch(
        "Audit port 8080",
        12345,
        controller.signal,
        "Started working on your request.\nProgress updates will appear here.",
      );

      expect(_testOnly.isTelegramOriginText("Audit port 8080")).toBe(true);
      expect(
        sentBodies.some((b) =>
          b.text?.includes("The agent is busy. Your request will be processed shortly."),
        ),
      ).toBe(true);
      expect(
        sentBodies.some((b) =>
          b.text?.includes("Started working on your request"),
        ),
      ).toBe(false);

      globalThis.fetch = origFetch;
      chatStore.useChatStore.getState().patchAgentMeta({ status: "idle" });
    });

    it("sends started ack text when agent is not busy", async () => {
      const chatStore = await import("../ai/store/chatStore");
      chatStore.useChatStore.getState().patchAgentMeta({ status: "idle" });

      const sentBodies: Array<{ text?: string }> = [];
      const origFetch = globalThis.fetch;
      const controller = new AbortController();
      globalThis.fetch = vi.fn(async (url, init) => {
        if (init?.body) {
          try {
            sentBodies.push(JSON.parse(String(init.body)));
          } catch {}
        }
        if (String(url).includes("sendMessage")) {
          controller.abort();
        }
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 1 } }),
          text: async () => JSON.stringify({ ok: true }),
        } as unknown as Response;
      });

      await _testOnly.startTelegramDispatch(
        "Run quick check",
        12345,
        controller.signal,
        "Started working on your request.\nProgress updates will appear here.",
      );

      await new Promise((r) => setTimeout(r, 100));

      expect(
        sentBodies.some((b) =>
          b.text?.includes("Started working on your request"),
        ),
      ).toBe(true);

      globalThis.fetch = origFetch;
    });

    it("deletes previous finished progress message when a new task starts", async () => {
      const chatStore = await import("../ai/store/chatStore");
      chatStore.useChatStore.getState().patchAgentMeta({ status: "idle" });

      _testOnly.lastFinishedProgressMessageIds.set(12345, 999);

      const deletedIds: number[] = [];
      const origFetch = globalThis.fetch;
      const controller = new AbortController();
      globalThis.fetch = vi.fn(async (url, init) => {
        if (String(url).includes("deleteMessage")) {
          try {
            const body = JSON.parse(String(init?.body));
            deletedIds.push(body.message_id);
          } catch {}
        }
        if (String(url).includes("sendMessage")) {
          controller.abort();
        }
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 1 } }),
          text: async () => JSON.stringify({ ok: true }),
        } as unknown as Response;
      });

      await _testOnly.startTelegramDispatch(
        "Run another task",
        12345,
        controller.signal,
        "Started working on your request.\nProgress updates will appear here.",
      );

      await new Promise((r) => setTimeout(r, 100));

      expect(deletedIds).toContain(999);
      expect(_testOnly.lastFinishedProgressMessageIds.get(12345)).not.toBe(999);

      globalThis.fetch = origFetch;
    });
  });

  describe("Hermes stability patterns", () => {
    it("parses TelegramApiError with retry_after correctly", () => {
      const err = new TelegramApiError(
        429,
        "Too Many Requests: retry after 6",
        6,
      );
      expect(err.status).toBe(429);
      expect(err.description).toContain("retry after 6");
      expect(err.retryAfter).toBe(6);
      expect(err.message).toContain("Telegram API 429: Too Many Requests");
    });

    it("treats 'message is not modified' as a successful edit (Hermes pattern)", async () => {
      const origFetch = globalThis.fetch;
      const controller = new AbortController();
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            ok: false,
            error_code: 400,
            description:
              "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
          }),
      } as unknown as Response);

      const res = await _testOnly.editProgressMessage(
        12345,
        100,
        "Exact same progress message",
        controller.signal,
      );

      expect(res).toBe(true);
      globalThis.fetch = origFetch;
    });

    it("handles 429 flood control by backing off when retry_after is small", async () => {
      const origFetch = globalThis.fetch;
      const controller = new AbortController();
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false,
            status: 429,
            text: async () =>
              JSON.stringify({
                ok: false,
                error_code: 429,
                description: "Too Many Requests: retry after 1",
                parameters: { retry_after: 1 },
              }),
          } as unknown as Response;
        }
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 100 } }),
          text: async () => JSON.stringify({ ok: true }),
        } as unknown as Response;
      });

      const res = await _testOnly.editProgressMessage(
        12345,
        100,
        "Progress with backoff",
        controller.signal,
      );

      expect(res).toBe(true);
      expect(callCount).toBe(2);
      globalThis.fetch = origFetch;
    });

    it("retains update offset across poll iterations and stall restarts", () => {
      _testOnly.setCurrentUpdateOffset(500);
      expect(_testOnly.getCurrentUpdateOffset()).toBe(500);
    });

    it("stall watchdog detects elapsed time exceeding threshold", () => {
      const now = Date.now();
      _testOnly.setLastPollProgressTime(
        now - (_testOnly.POLLING_STALL_TIMEOUT_MS + 10_000),
      );
      expect(now - _testOnly.getLastPollProgressTime()).toBeGreaterThan(
        _testOnly.POLLING_STALL_TIMEOUT_MS,
      );
    });
  });

  describe("owner user gating for sensitive callbacks and commands", () => {
    function captureAnswerCallbacks() {
      const texts: Array<string | null> = [];
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (url, init) => {
        if (String(url).includes("answerCallbackQuery") && init?.body) {
          try {
            const body = JSON.parse(String(init.body));
            if (typeof body.callback_query_id === "string") {
              texts.push(body.text ?? null);
            }
          } catch {}
        }
        return {
          ok: true,
          json: async () => ({ ok: true, result: {} }),
          text: async () => JSON.stringify({ ok: true }),
        } as unknown as Response;
      });
      return {
        texts,
        restore: () => {
          globalThis.fetch = origFetch;
        },
      };
    }

    beforeEach(() => {
      useTelegramStore.getState().setChatId("111");
      useTelegramStore.getState().setOwnerUserId("222");
    });

    afterEach(() => {
      useTelegramStore.getState().setChatId(null);
      useTelegramStore.getState().setOwnerUserId(null);
    });

    it("rejects an aq: approval callback from a non-owner user in the paired chat", async () => {
      const cap = captureAnswerCallbacks();
      const controller = new AbortController();
      try {
        await _testOnly.handleCallback(
          {
            id: "cb-1",
            from: { id: 333 },
            message: { chat: { id: 111 }, message_id: 7 },
            data: "aq:approve:q-abc",
          },
          controller.signal,
        );
        expect(cap.texts).toContain("Unauthorized.");
      } finally {
        cap.restore();
      }
    });

    it("allows an aq: approval callback from the owner user", async () => {
      const cap = captureAnswerCallbacks();
      const controller = new AbortController();
      try {
        await _testOnly.handleCallback(
          {
            id: "cb-2",
            from: { id: 222 },
            message: { chat: { id: 111 }, message_id: 8 },
            data: "aq:approve:q-def",
          },
          controller.signal,
        );
        expect(cap.texts).toContain("Approved.");
      } finally {
        cap.restore();
      }
    });

    it("ignores an /approve text command from a non-owner user", async () => {
      const sentBodies: Array<{ text?: string }> = [];
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (_url, init) => {
        if (init?.body) {
          try {
            sentBodies.push(JSON.parse(String(init.body)));
          } catch {}
        }
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 1 } }),
          text: async () => JSON.stringify({ ok: true }),
        } as unknown as Response;
      });
      const controller = new AbortController();
      try {
        await _testOnly.handleUpdate(
          {
            update_id: 1,
            message: { chat: { id: 111 }, from: { id: 333 }, text: "/approve" },
          },
          controller.signal,
        );
        expect(sentBodies).toEqual([]);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("lets the owner run /approve via text", async () => {
      const sentBodies: Array<{ text?: string }> = [];
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (_url, init) => {
        if (init?.body) {
          try {
            sentBodies.push(JSON.parse(String(init.body)));
          } catch {}
        }
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 1 } }),
          text: async () => JSON.stringify({ ok: true }),
        } as unknown as Response;
      });
      const controller = new AbortController();
      try {
        await _testOnly.handleUpdate(
          {
            update_id: 1,
            message: { chat: { id: 111 }, from: { id: 222 }, text: "/approve" },
          },
          controller.signal,
        );
        expect(sentBodies.some((b) => b.text?.includes("Approved"))).toBe(true);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("/pair records the pairing user id", async () => {
      useTelegramStore.getState().setChatId(null);
      useTelegramStore.getState().setOwnerUserId(null);
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 1 } }),
        text: async () => JSON.stringify({ ok: true }),
      } as unknown as Response);
      const controller = new AbortController();
      try {
        await _testOnly.handleUpdate(
          {
            update_id: 1,
            message: { chat: { id: 999 }, from: { id: 555 }, text: "/pair" },
          },
          controller.signal,
        );
        expect(useTelegramStore.getState().chatId).toBe("999");
        expect(useTelegramStore.getState().ownerUserId).toBe("555");
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });
});

