import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createPr,
  getPr,
  listPrs,
  reviewPr,
  commentPr,
  mergePr,
} from "../lib/github";

const shellSessionRun = vi.fn();
vi.mock("../lib/native", () => ({
  native: {
    shellSessionRun: (...a: unknown[]) => shellSessionRun(...a),
  },
}));

describe("github helpers", () => {
  beforeEach(() => {
    shellSessionRun.mockReset();
  });

  it("createPr builds the expected gh command", async () => {
    shellSessionRun.mockResolvedValue({
      stdout: JSON.stringify({
        number: 1,
        title: "Test PR",
        body: "Body",
        state: "OPEN",
        author: { login: "test" },
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        url: "https://github.com/99apps-id/termigo/pull/1",
        baseRefName: "main",
        headRefName: "feature",
      }),
      stderr: "",
      exit_code: 0,
    });
    const result = await createPr("Test PR", "Body", "main", "feature", "/tmp");
    expect(result.ok).toBe(true);
    expect(result.pr?.number).toBe(1);
  });

  it("getPr returns error when gh fails", async () => {
    shellSessionRun.mockResolvedValue({
      stdout: "",
      stderr: "gh: not logged in",
      exit_code: 1,
    });
    const result = await getPr(123, "/tmp");
    expect(result.ok).toBe(false);
  });

  it("listPrs returns error when gh fails", async () => {
    shellSessionRun.mockResolvedValue({
      stdout: "",
      stderr: "gh: not logged in",
      exit_code: 1,
    });
    const result = await listPrs("/tmp", "open");
    expect(result.ok).toBe(false);
  });

  it("reviewPr returns error for invalid state", async () => {
    const result = await reviewPr(1, "APPROVED", "LGTM", "/tmp");
    expect(result.ok).toBe(false);
  });

  it("commentPr returns error when gh fails", async () => {
    shellSessionRun.mockResolvedValue({
      stdout: "",
      stderr: "gh: not logged in",
      exit_code: 1,
    });
    const result = await commentPr(1, "Nice work", "/tmp");
    expect(result.ok).toBe(false);
  });

  it("mergePr returns error when gh fails", async () => {
    shellSessionRun.mockResolvedValue({
      stdout: "",
      stderr: "gh: not logged in",
      exit_code: 1,
    });
    const result = await mergePr(1, "/tmp", "merge");
    expect(result.ok).toBe(false);
  });
});
