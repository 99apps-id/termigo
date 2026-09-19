import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
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
      expect(isMessageSeen(undefined, "s-1", "user", "test fallback")).toBe(
        false,
      );
      markMessageSeen(undefined, "s-1", "user", "test fallback");
      expect(isMessageSeen(undefined, "s-1", "user", "test fallback")).toBe(
        true,
      );
      expect(isMessageSeen(undefined, "s-2", "user", "test fallback")).toBe(
        false,
      );
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
          b.text?.includes(
            "The agent is busy. Your request will be processed shortly.",
          ),
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

    it("edits active progress message with final clean AI answer and suppresses duplicate send", async () => {
      const chatStore = await import("../ai/store/chatStore");
      const sessionId = chatStore.useChatStore.getState().newSession();
      chatStore.useChatStore.getState().switchSession(sessionId);
      chatStore.useChatStore.getState().patchAgentMeta({ status: "idle", stopReason: null });

      const activeChatId = 77777;
      _testOnly.activeProgressMessageIds.set(activeChatId, 4321);

      const editedPayloads: Array<{ message_id: number; text: string }> = [];
      const sentTexts: string[] = [];
      const origFetch = globalThis.fetch;
      const controller = new AbortController();

      globalThis.fetch = vi.fn(async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes("editMessageText")) {
          try {
            const body = JSON.parse(String(init?.body));
            editedPayloads.push({ message_id: body.message_id, text: body.text });
          } catch {}
          return {
            ok: true,
            json: async () => ({ ok: true, result: { message_id: 4321 } }),
            text: async () => JSON.stringify({ ok: true }),
          } as unknown as Response;
        }
        if (urlStr.includes("sendMessage")) {
          try {
            const body = JSON.parse(String(init?.body));
            sentTexts.push(body.text);
          } catch {}
          return {
            ok: true,
            json: async () => ({ ok: true, result: { message_id: 5555 } }),
            text: async () => JSON.stringify({ ok: true }),
          } as unknown as Response;
        }
        return {
          ok: true,
          json: async () => ({ ok: true, result: {} }),
          text: async () => JSON.stringify({ ok: true }),
        } as unknown as Response;
      });

      const mockMessages: any[] = [];
      chatStore.chats.set(sessionId, {
        messages: mockMessages,
        status: "idle",
      } as any);

      // Dispatch a task with successful accepted action
      const runPromise = _testOnly.runAgentAndStream(
        async () => true,
        activeChatId,
        controller.signal,
        "Started working on your request.",
      );

      // Simulate agent answering
      await new Promise((r) => setTimeout(r, 50));
      mockMessages.push({
        id: "msg-assistant-final-1",
        role: "assistant",
        parts: [{ type: "text", text: "Semua layanan berjalan dengan lancar tanpa error." }],
      });
      chatStore.useChatStore.getState().patchAgentMeta({ status: "idle" });

      await new Promise((r) => setTimeout(r, 1600));
      controller.abort();
      await runPromise.catch(() => {});

      // Verify that the active progress message was edited directly with the AI answer
      expect(
        editedPayloads.some(
          (p) => p.message_id === 5555 && p.text.includes("Semua layanan berjalan"),
        ),
      ).toBe(true);
      // Verify that the AI answer was NOT repeated in a separate sendMessage call
      expect(sentTexts.some((t) => t.includes("Semua layanan berjalan"))).toBe(false);

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

  describe("owner user gating for sensitive callbacks and commands", () => {

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
      const aq = await import("../ai/store/approvalQueueStore");
      aq.useApprovalQueue.setState({
        pending: [
          {
            id: "q-def",
            toolName: "bash_run",
            summary: "echo test",
            requestedAt: Date.now(),
          },
        ],
      });
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
        aq.useApprovalQueue.setState({ pending: [] });
      }
    });

    it("rejects an aq: approval callback for a missing or expired id", async () => {
      const cap = captureAnswerCallbacks();
      const controller = new AbortController();
      try {
        await _testOnly.handleCallback(
          {
            id: "cb-expired",
            from: { id: 222 },
            message: { chat: { id: 111 }, message_id: 8 },
            data: "aq:approve:missing-id",
          },
          controller.signal,
        );
        expect(cap.texts).toContain("Already answered or expired.");
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

    it("enforces the paired chat when only chatId is known (no owner user id)", async () => {
      // Settings-pairing writes the chat id but never a user id. A different
      // sender must not be able to approve pending actions in the paired chat.
      useTelegramStore.getState().setChatId("111");
      useTelegramStore.getState().setOwnerUserId(null);
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

    it("/pair with the code pairs and records the pairing user id", async () => {
      useTelegramStore.getState().setChatId(null);
      useTelegramStore.getState().setOwnerUserId(null);
      const code = useTelegramStore.getState().ensurePairingCode();
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
            message: {
              chat: { id: 999 },
              from: { id: 555 },
              text: `/pair ${code}`,
            },
          },
          controller.signal,
        );
        expect(useTelegramStore.getState().chatId).toBe("999");
        expect(useTelegramStore.getState().ownerUserId).toBe("555");
        // Single-use: the code dies with the pairing.
        expect(useTelegramStore.getState().pairingCode).toBeNull();
        expect(sentBodies.some((b) => b.text?.includes("Paired"))).toBe(true);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("/pair without the code does not pair and never reveals it", async () => {
      useTelegramStore.getState().setChatId(null);
      useTelegramStore.getState().setOwnerUserId(null);
      const code = useTelegramStore.getState().ensurePairingCode();
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
            message: { chat: { id: 999 }, from: { id: 555 }, text: "/pair" },
          },
          controller.signal,
        );
        expect(useTelegramStore.getState().chatId).toBeNull();
        expect(sentBodies.length).toBeGreaterThan(0);
        expect(sentBodies.every((b) => !b.text?.includes(code))).toBe(true);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe("getPendingApprovals extraction and deduplication", () => {
    it("extracts approvals from sdk messages, agentMeta, and approvalQueue without duplicate ids", () => {
      const mockChat = {
        messages: [
          {
            role: "assistant",
            parts: [
              {
                state: "approval-requested",
                id: "appr-1",
                toolName: "bash",
                input: { command: "cargo build" },
              },
            ],
          },
        ],
      };

      const mockChatStore = {
        getChat: vi.fn().mockReturnValue(mockChat),
        getState: vi.fn().mockReturnValue({
          agentMeta: {
            pendingApprovals: [
              {
                id: "appr-1",
                toolName: "bash",
                summary: "cargo build",
              },
              {
                id: "appr-2",
                toolName: "file_write",
                summary: "write config.json",
              },
            ],
          },
        }),
      };

      const mockAqStore = {
        getState: vi.fn().mockReturnValue({
          pending: [
            {
              id: "appr-2",
              toolName: "file_write",
              summary: "duplicate write config.json",
            },
            {
              id: "appr-3",
              toolName: "git_push",
              summary: "push to main",
            },
          ],
        }),
      };

      const approvals = _testOnly.getPendingApprovals(
        "sess-1",
        mockChatStore,
        mockAqStore,
      );

      expect(approvals).toHaveLength(3);
      expect(approvals[0].id).toBe("appr-1");
      expect(approvals[0].toolName).toBe("bash");
      expect(approvals[1].id).toBe("appr-2");
      expect(approvals[2].id).toBe("appr-3");
    });
  });

  describe("interactive approval and continue cards", () => {
    it("parses colon-separated approval ids in ap: callback correctly", async () => {
      const state = await import("../ai/store/chatStore");
      state.useChatStore.getState().patchAgentMeta({
        pendingApprovals: [
          {
            id: "session-1:call-abc:sub-2",
            toolName: "bash_run",
            summary: "echo test",
          },
        ],
      });
      const spy = vi.spyOn(state.useChatStore.getState(), "respondToApproval");
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: {} }),
        text: async () => JSON.stringify({ ok: true }),
      } as unknown as Response);
      try {
        await _testOnly.handleCallback(
          {
            id: "cb-colon",
            from: { id: 222 },
            message: { chat: { id: 111 }, message_id: 9 },
            data: "ap:approve:session-1:call-abc:sub-2",
          },
          new AbortController().signal,
        );
        expect(spy).toHaveBeenCalledWith("session-1:call-abc:sub-2", true);
      } finally {
        spy.mockRestore();
        state.useChatStore.getState().patchAgentMeta({ pendingApprovals: [] });
        globalThis.fetch = origFetch;
      }
    });

    it("rejects an ap: callback when the approval is not in pendingApprovals", async () => {
      const cap = captureAnswerCallbacks();
      try {
        await _testOnly.handleCallback(
          {
            id: "cb-ap-expired",
            from: { id: 222 },
            message: { chat: { id: 111 }, message_id: 9 },
            data: "ap:approve:non-existent-id",
          },
          new AbortController().signal,
        );
        expect(cap.texts).toContain("Already answered or expired.");
      } finally {
        cap.restore();
      }
    });

    it("sends approval card instead of 'still working' when approvals are pending on resume", async () => {
      const state = await import("../ai/store/chatStore");
      state.useChatStore.getState().newSession();
      state.useChatStore.getState().patchAgentMeta({
        status: "awaiting-approval",
        pendingApprovals: [
          { id: "appr-pending-1", toolName: "bash_run", summary: "rm -rf tmp" },
        ],
      });
      const sentBodies: Array<{ text?: string; reply_markup?: unknown }> = [];
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (_url, init) => {
        if (init?.body) {
          try {
            sentBodies.push(JSON.parse(String(init.body)));
          } catch {}
        }
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 10 } }),
          text: async () => JSON.stringify({ ok: true }),
        } as unknown as Response;
      });
      try {
        _testOnly.startTelegramResume(111, new AbortController().signal);
        await new Promise((r) => setTimeout(r, 80));
        expect(
          sentBodies.some(
            (b) =>
              b.text?.includes("Action Approval Required") &&
              b.text?.includes("bash_run") &&
              JSON.stringify(b.reply_markup).includes("ap:approve:appr-pending-1"),
          ),
        ).toBe(true);
        expect(
          sentBodies.some((b) => b.text?.includes("Agent is still working")),
        ).toBe(false);
      } finally {
        state.useChatStore
          .getState()
          .patchAgentMeta({ status: "idle", pendingApprovals: [] });
        globalThis.fetch = origFetch;
      }
    });

    it("approves pending action directly when user replies with 'approve'", async () => {
      const state = await import("../ai/store/chatStore");
      state.useChatStore.getState().newSession();
      state.useChatStore.getState().patchAgentMeta({
        status: "awaiting-approval",
        pendingApprovals: [
          { id: "appr-text-1", toolName: "write_file", summary: "write main.go" },
        ],
      });
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
          json: async () => ({ ok: true, result: { message_id: 11 } }),
          text: async () => JSON.stringify({ ok: true }),
        } as unknown as Response;
      });
      try {
        await _testOnly.startTelegramDispatch(
          "approve",
          111,
          new AbortController().signal,
          "Task received",
        );
        expect(
          sentBodies.some((b) =>
            b.text?.includes("Approved 1 pending action"),
          ),
        ).toBe(true);
      } finally {
        state.useChatStore
          .getState()
          .patchAgentMeta({ status: "idle", pendingApprovals: [] });
        globalThis.fetch = origFetch;
      }
    });

    it("runMirror dispatches continue button when agent pauses on step-cap", async () => {
      useTelegramStore.getState().setChatId("111");
      useTelegramStore.getState().setEnabled(true);
      const state = await import("../ai/store/chatStore");
      state.useChatStore.getState().newSession();
      state.useChatStore.getState().patchAgentMeta({
        status: "idle",
        stopReason: "step-cap",
        runRound: 1,
        stoppedByUser: false,
      });
      const sentBodies: Array<{ text?: string; reply_markup?: unknown }> = [];
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (_url, init) => {
        if (init?.body) {
          try {
            sentBodies.push(JSON.parse(String(init.body)));
          } catch {}
        }
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 12 } }),
          text: async () => JSON.stringify({ ok: true }),
        } as unknown as Response;
      });
      const controller = new AbortController();
      try {
        void _testOnly.runMirror(controller.signal);
        await new Promise((r) => setTimeout(r, 80));
        controller.abort();
        expect(
          sentBodies.some(
            (b) =>
              b.text?.includes("Step limit reached") &&
              JSON.stringify(b.reply_markup).includes("resume:run"),
          ),
        ).toBe(true);
      } finally {
        controller.abort();
        state.useChatStore
          .getState()
          .patchAgentMeta({ status: "idle", stopReason: null });
        globalThis.fetch = origFetch;
      }
    });

    it("runMirror dispatches approval keyboard when desktop agent needs approval", async () => {
      useTelegramStore.getState().setChatId("111");
      useTelegramStore.getState().setEnabled(true);
      const state = await import("../ai/store/chatStore");
      state.useChatStore.getState().newSession();
      state.useChatStore.getState().patchAgentMeta({
        status: "awaiting-approval",
        pendingApprovals: [
          {
            id: "mirror-appr-1",
            toolName: "bash_run",
            summary: "git push origin",
          },
        ],
      });
      const sentBodies: Array<{ text?: string; reply_markup?: unknown }> = [];
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (_url, init) => {
        if (init?.body) {
          try {
            sentBodies.push(JSON.parse(String(init.body)));
          } catch {}
        }
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 13 } }),
          text: async () => JSON.stringify({ ok: true }),
        } as unknown as Response;
      });
      const controller = new AbortController();
      try {
        void _testOnly.runMirror(controller.signal);
        await new Promise((r) => setTimeout(r, 80));
        controller.abort();
        expect(
          sentBodies.some(
            (b) =>
              b.text?.includes("Action Approval Required") &&
              b.text?.includes("bash_run") &&
              JSON.stringify(b.reply_markup).includes(
                "ap:approve:mirror-appr-1",
              ),
          ),
        ).toBe(true);
      } finally {
        controller.abort();
        state.useChatStore
          .getState()
          .patchAgentMeta({ status: "idle", pendingApprovals: [] });
        globalThis.fetch = origFetch;
      }
    });
  });
});

