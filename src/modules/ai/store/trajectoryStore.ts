import { create } from "zustand";

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
    set((state) => ({
      runs: state.runs.map((r) =>
        r.runId === state.activeRunId
          ? {
              ...r,
              status,
              finishedAt: Date.now(),
              totalTokens: totalTokens ?? r.totalTokens,
              totalCostUsd,
            }
          : r,
      ),
    })),

  selectStep: (stepId) => set({ selectedStepId: stepId }),

  clearRuns: () => set({ runs: [], activeRunId: null, selectedStepId: null }),
}));
