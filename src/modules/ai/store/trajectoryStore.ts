import { create } from "zustand";
import { saveTrajectoryRun } from "../lib/trajectoryIo";

export type TrajectoryStep = {
  id: string;
  stepIndex: number;
  toolName: string;
  args: Record<string, unknown>;
  status: "pending" | "running" | "success" | "error";
  output?: unknown;
  durationMs?: number;
  tokensUsed?: number;
  timestamp: number;
};

export type TrajectoryRun = {
  runId: string;
  taskId?: string;
  modelId: string;
  startedAt: number;
  finishedAt?: number;
  steps: TrajectoryStep[];
  totalTokens: number;
  totalCostUsd?: number;
  status: "running" | "completed" | "failed" | "aborted";
};

type TrajectoryState = {
  runs: TrajectoryRun[];
  activeRunId: string | null;
  selectedStepId: string | null;

  startRun: (opts: { runId: string; modelId: string; taskId?: string }) => void;
  appendStep: (step: Omit<TrajectoryStep, "timestamp">) => void;
  updateStep: (stepId: string, patch: Partial<TrajectoryStep>) => void;
  finishRun: (opts: { status: TrajectoryRun["status"]; totalTokens?: number; totalCostUsd?: number }) => void;
  selectStep: (stepId: string | null) => void;
  clearRuns: () => void;
};

export const useTrajectoryStore = create<TrajectoryState>((set) => ({
  runs: [],
  activeRunId: null,
  selectedStepId: null,

  startRun: ({ runId, modelId, taskId }) =>
    set((state) => ({
      activeRunId: runId,
      runs: [
        ...state.runs,
        {
          runId,
          taskId,
          modelId,
          startedAt: Date.now(),
          steps: [],
          totalTokens: 0,
          status: "running",
        },
      ],
    })),

  appendStep: (step) =>
    set((state) => {
      const active = state.runs.find((r) => r.runId === state.activeRunId);
      if (!active) return state;

      const newStep: TrajectoryStep = {
        ...step,
        timestamp: Date.now(),
      };

      return {
        runs: state.runs.map((r) =>
          r.runId === state.activeRunId
            ? { ...r, steps: [...r.steps, newStep] }
            : r,
        ),
      };
    }),

  updateStep: (stepId, patch) =>
    set((state) => ({
      runs: state.runs.map((r) => ({
        ...r,
        steps: r.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
      })),
    })),

  finishRun: ({ status, totalTokens, totalCostUsd }) =>
    set((state) => {
      const active = state.runs.find((r) => r.runId === state.activeRunId);
      // A run can only end once. onAbort and onFinish can both fire for the
      // same abort (the SDK reports the abort and then the final partial
      // result), and whichever arrives second must not rewrite the first
      // verdict - an aborted run flipping to "completed" would be a lie.
      if (active?.status !== "running") return state;

      const finished: TrajectoryRun = {
        ...active,
        status,
        finishedAt: Date.now(),
        totalTokens: totalTokens ?? active.totalTokens,
        totalCostUsd: totalCostUsd ?? active.totalCostUsd,
      };
      // Persist for the replay browser after a restart; a failed save only
      // logs and never blocks the run from ending.
      void saveTrajectoryRun(finished).catch(() => {});

      return {
        // The run is no longer open: clear the pointer so a late callback
        // cannot finish something that has already ended.
        activeRunId: null,
        runs: state.runs.map((r) =>
          r.runId === finished.runId ? finished : r,
        ),
      };
    }),

  selectStep: (stepId) => set({ selectedStepId: stepId }),

  clearRuns: () => set({ runs: [], activeRunId: null, selectedStepId: null }),
}));
