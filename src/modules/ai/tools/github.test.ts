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
const writeFile = vi.fn().mockResolvedValue(undefined);
const deletePath = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/native", () => ({
  native: {
    shellSessionOpen: vi.fn().mockResolvedValue(7),
    shellSessionRun: (...a: unknown[]) => shellSessionRun(...a),
    shellSessionClose: vi.fn().mockResolvedValue(undefined),
    writeFile: (...a: unknown[]) => writeFile(...a),
    deletePath: (...a: unknown[]) => deletePath(...a),
  },
}));

describe("github helpers", () => {
  beforeEach(() => {
    shellSessionRun.mockReset();
    writeFile.mockReset();
    deletePath.mockReset();
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
    const cmd = shellSessionRun.mock.calls[0][1] as string;
    expect(cmd).toContain("--base 'main'");
  });

  it("createPr omits --base flag when base is empty", async () => {
    shellSessionRun.mockResolvedValue({
      stdout: JSON.stringify({
        number: 2,
        title: "PR Without Base",
        body: "",
        state: "OPEN",
        author: { login: "test" },
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        url: "https://github.com/99apps-id/termigo/pull/2",
        baseRefName: "main",
        headRefName: "feature",
      }),
      stderr: "",
      exit_code: 0,
    });
    const result = await createPr("PR Without Base", "", "", "feature", "/tmp");
    expect(result.ok).toBe(true);
    const cmd = shellSessionRun.mock.calls[0][1] as string;
    expect(cmd).not.toContain("--base");
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

  it("createPr with multiline body writes to temp file and passes --body-file", async () => {
    shellSessionRun.mockResolvedValue({
      stdout: JSON.stringify({
        number: 42,
        title: "Multiline PR",
        body: "Line 1\n\nLine 2\n- Item 1\n- Item 2",
        state: "OPEN",
        author: { login: "test" },
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        url: "https://github.com/99apps-id/termigo/pull/42",
        baseRefName: "main",
        headRefName: "feat",
      }),
      stderr: "",
      exit_code: 0,
    });
    const multiline = "Line 1\n\nLine 2\n- Item 1\n- Item 2";
    const result = await createPr("Multiline PR", multiline, "main", "feat", "/repo");
    expect(result.ok).toBe(true);
    expect(writeFile).toHaveBeenCalled();
    const writtenPath = writeFile.mock.calls[0][0] as string;
    const writtenContent = writeFile.mock.calls[0][1] as string;
    expect(writtenPath).toContain(".termigo/tmp_gh_");
    expect(writtenContent).toBe(multiline);

    const cmd = shellSessionRun.mock.calls[0][1] as string;
    expect(cmd).toContain("--body-file");
    expect(cmd).not.toContain("\n");
    expect(deletePath).toHaveBeenCalledWith(writtenPath);
  });

  it("commentPr with multiline body uses --body-file and cleans up", async () => {
    shellSessionRun.mockResolvedValue({
      stdout: JSON.stringify({
        id: 101,
        body: "First line\nSecond line",
        author: { login: "reviewer" },
        createdAt: "2026-01-01T00:00:00Z",
      }),
      stderr: "",
      exit_code: 0,
    });
    const commentBody = "First line\nSecond line";
    const result = await commentPr(42, commentBody, "/repo");
    expect(result.ok).toBe(true);
    expect(writeFile).toHaveBeenCalled();
    const cmd = shellSessionRun.mock.calls[0][1] as string;
    expect(cmd).toContain("--body-file");
    expect(deletePath).toHaveBeenCalled();
  });
});
