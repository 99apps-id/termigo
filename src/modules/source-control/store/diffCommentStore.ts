import { create } from "zustand";
import type { GitDiffComment } from "@/modules/ai/lib/native";
import { native } from "@/modules/ai/lib/native";

export type { GitDiffComment };

type DiffCommentState = {
  comments: GitDiffComment[];
  load: (repoRoot: string) => Promise<void>;
  add: (
    repoRoot: string,
    filePath: string,
    lineNumber: number,
    body: string,
    opts?: { selectedText?: string; side?: string },
  ) => Promise<GitDiffComment>;
  update: (
    repoRoot: string,
    id: string,
    patch: { body?: string; selectedText?: string },
  ) => Promise<void>;
  remove: (repoRoot: string, id: string) => Promise<void>;
  forFile: (filePath: string) => GitDiffComment[];
};

export const useDiffCommentStore = create<DiffCommentState>((set, get) => ({
  comments: [],
  load: async (repoRoot) => {
    try {
      const comments = await native.gitDiffCommentsList(repoRoot);
      set({ comments });
    } catch {
      // best-effort; diff comments are additive
    }
  },
  add: async (repoRoot, filePath, lineNumber, body, opts) => {
    const comment: GitDiffComment = {
      id: `diff-${Math.random().toString(36).slice(2, 9)}-${Date.now()}`,
      filePath: filePath.replace(/\\/g, "/"),
      lineNumber: Math.max(1, Math.floor(lineNumber)),
      body: body.trim(),
      selectedText: opts?.selectedText?.trim(),
      side: opts?.side === "old" ? "old" : "new",
      createdAt: Date.now(),
    };
    const saved = await native.gitDiffCommentsAdd(repoRoot, comment);
    set((s) => ({ comments: [...s.comments, saved] }));
    return saved;
  },
  update: async (repoRoot, id, patch) => {
    const saved = await native.gitDiffCommentsUpdate(repoRoot, id, patch);
    if (saved) {
      set((s) => ({
        comments: s.comments.map((c) => (c.id === id ? saved : c)),
      }));
    }
  },
  remove: async (repoRoot, id) => {
    const ok = await native.gitDiffCommentsRemove(repoRoot, id);
    if (ok) {
      set((s) => ({ comments: s.comments.filter((c) => c.id !== id) }));
    }
  },
  forFile: (filePath) => {
    const normalized = filePath.replace(/\\/g, "/");
    return get().comments.filter((c) => c.filePath === normalized);
  },
}));
