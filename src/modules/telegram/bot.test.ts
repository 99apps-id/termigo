import { describe, expect, it, beforeEach } from "vitest";
import { _testOnly } from "./bot";

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
});
