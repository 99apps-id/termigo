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
});

