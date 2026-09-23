/**
 * Pending inline comments on AI-generated diffs.
 *
 * The reviewer's half of the annotation flow: comments are collected per file and
 * line here, then handed to `formatDiffFeedbackPrompt` to become one steering
 * message. Keeping the batch in a store rather than in each card means a comment
 * on one card's diff survives the card being collapsed, and several files can be
 * reviewed before anything is sent - which is the point of annotating in the
 * first place.
 *
 * Deliberately NOT persisted. These are review notes attached to a run the user
 * is looking at right now; restoring comments from a previous session against a
 * diff that no longer exists would attach feedback to the wrong lines. Losing
 * them on reload is the safer failure.
 */

import { create } from "zustand";
import {
  addCommentToBatch,
  clearCommentsForFile,
  createDiffComment,
  createEmptyDiffBatch,
  type DiffAnnotationBatch,
  removeCommentFromBatch,
} from "../lib/diffComments";

type DiffCommentState = {
  batch: DiffAnnotationBatch;
  add: (
    filePath: string,
    lineNumber: number,
    comment: string,
    originalLine?: string,
  ) => void;
  remove: (id: string) => void;
  clearFile: (filePath: string) => void;
  clear: () => void;
};

export const useDiffCommentStore = create<DiffCommentState>((set) => ({
  batch: createEmptyDiffBatch(),
  add: (filePath, lineNumber, comment, originalLine) =>
    set((s) => ({
      batch: addCommentToBatch(
        s.batch,
        createDiffComment(filePath, lineNumber, comment, originalLine),
      ),
    })),
  remove: (id) => set((s) => ({ batch: removeCommentFromBatch(s.batch, id) })),
  clearFile: (filePath) =>
    set((s) => ({ batch: clearCommentsForFile(s.batch, filePath) })),
  clear: () => set({ batch: createEmptyDiffBatch() }),
}));
