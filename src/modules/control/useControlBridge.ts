import { DEFAULT_SPACE_ID, type Tab } from "@/modules/tabs/lib/useTabs";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type RefObject, useEffect } from "react";
import { resolveControlContext } from "./lib/context";
import { createReadinessQueue } from "./lib/readiness";

type ControlError = {
  code: string;
  message: string;
};

type ControlRequest = {
  id: string;
  method: string;
  params: unknown;
  caller: {
    pane_id?: number;
  };
};

type FrontendResponse = {
  ok: boolean;
  result?: unknown;
  error?: ControlError;
};

type OpenRequest = {
  path: string;
  line?: number;
  focus: boolean;
};

type FocusRequest = {
  query: string;
};

type PentestRunRequest = {
  target: string;
  category: string;
};

type PentestReportRequest = {
  target: string;
};

type AgentRunRequest = {
  prompt: string;
};

type UseControlBridgeOptions = {
  ready: boolean;
  tabsRef: RefObject<Tab[]>;
  activeTabIdRef: RefObject<number>;
  activeSpaceIdRef: RefObject<string | null>;
  onOpen: (request: OpenRequest & { spaceId: string }) => number | null;
  onFocus: (request: FocusRequest & { spaceId: string }) => {
    ok: boolean;
    label?: string;
  };
  /** Start an approval-gated pentest in the agent. Resolves once the run is
   *  kicked off; rejects (or resolves ok:false) when it can't start. */
  onPentestRun: (
    request: PentestRunRequest,
  ) => Promise<{ ok: boolean; message?: string }>;
  /** Report the latest pentest run and the agent's live state. `result` is
   *  the payload echoed back to the caller. */
  onPentestStatus: () => Promise<{
    ok: boolean;
    result?: unknown;
    message?: string;
  }>;
  /** Generate and open the pentest report. `target` is empty when the caller
   *  wants the last pentest-run target. */
  onPentestReport: (
    request: PentestReportRequest,
  ) => Promise<{ ok: boolean; message?: string }>;
  /** Start a plain agent task (`termigo run "<task>"`). */
  onAgentRun: (
    request: AgentRunRequest,
  ) => Promise<{ ok: boolean; message?: string }>;
  /** Rich app status for `termigo status`: agent/model/workspace/cost. */
  onStatus: () => Promise<{ ok: boolean; result?: unknown; message?: string }>;
};

class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function parseOpenRequest(params: unknown): OpenRequest {
  if (typeof params !== "object" || params === null) {
    throw new RequestError("invalid_params", "open parameters are required");
  }
  const value = params as Record<string, unknown>;
  if (typeof value.path !== "string" || value.path.length === 0) {
    throw new RequestError("invalid_params", "open path is required");
  }
  if (
    value.line !== undefined &&
    (!Number.isSafeInteger(value.line) || (value.line as number) < 1)
  ) {
    throw new RequestError("invalid_params", "line must be a positive integer");
  }
  if (value.column !== undefined) {
    throw new RequestError(
      "unsupported_parameter",
      "column targeting is not supported yet",
    );
  }
  if (value.focus !== undefined && typeof value.focus !== "boolean") {
    throw new RequestError("invalid_params", "focus must be a boolean");
  }
  return {
    path: value.path,
    line: value.line as number | undefined,
    focus: (value.focus as boolean | undefined) ?? true,
  };
}

export function parseFocusRequest(params: unknown): FocusRequest {
  if (typeof params !== "object" || params === null) {
    throw new RequestError("invalid_params", "focus parameters are required");
  }
  const value = params as Record<string, unknown>;
  if (typeof value.query !== "string" || value.query.trim().length === 0) {
    throw new RequestError("invalid_params", "focus query is required");
  }
  return { query: value.query };
}

export function parsePentestRunRequest(params: unknown): PentestRunRequest {
  if (typeof params !== "object" || params === null) {
    throw new RequestError(
      "invalid_params",
      "pentest-run parameters are required",
    );
  }
  const value = params as Record<string, unknown>;
  const target = typeof value.target === "string" ? value.target.trim() : "";
  if (!target) {
    throw new RequestError("invalid_params", "pentest target is required");
  }
  const category =
    typeof value.category === "string" ? value.category.trim() : "";
  return { target, category };
}

export function parsePentestReportRequest(params: unknown): PentestReportRequest {
  if (typeof params !== "object" || params === null) {
    throw new RequestError(
      "invalid_params",
      "pentest-report parameters are required",
    );
  }
  const value = params as Record<string, unknown>;
  const target = typeof value.target === "string" ? value.target.trim() : "";
  return { target };
}

export function parseAgentRunRequest(params: unknown): AgentRunRequest {
  if (typeof params !== "object" || params === null) {
    throw new RequestError("invalid_params", "run parameters are required");
  }
  const value = params as Record<string, unknown>;
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (!prompt) {
    throw new RequestError("invalid_params", "agent prompt is required");
  }
  return { prompt };
}

const setFrontendReady = createReadinessQueue((ready) =>
  invoke("control_frontend_ready", { ready }),
);

async function respond(
  requestId: string,
  response: FrontendResponse,
): Promise<void> {
  const delivered = await invoke<boolean>("control_respond", {
    requestId,
    response,
  });
  if (!delivered) {
    console.warn(`[termigo] control response expired: ${requestId}`);
  }
}

export function useControlBridge({
  ready,
  tabsRef,
  activeTabIdRef,
  activeSpaceIdRef,
  onOpen,
  onFocus,
  onPentestRun,
  onPentestStatus,
  onPentestReport,
  onAgentRun,
  onStatus,
}: UseControlBridgeOptions): void {
  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const handleRequest = async (request: ControlRequest) => {
      try {
        const context = resolveControlContext(
          tabsRef.current ?? [],
          activeTabIdRef.current ?? 0,
          activeSpaceIdRef.current ?? DEFAULT_SPACE_ID,
          request.caller.pane_id,
        );
        if (request.method === "identify") {
          await respond(request.id, { ok: true, result: context });
          return;
        }
        if (request.method === "status") {
          const status = await onStatus();
          if (!status.ok) {
            throw new RequestError(
              "status_failed",
              status.message ?? "could not read the app status",
            );
          }
          await respond(request.id, { ok: true, result: status.result });
          return;
        }
        if (request.method === "run") {
          const run = parseAgentRunRequest(request.params);
          try {
            const window = getCurrentWindow();
            await window.show();
            await window.setFocus();
          } catch (error) {
            console.warn("[termigo] could not focus for run:", error);
          }
          const started = await onAgentRun(run);
          if (!started.ok) {
            throw new RequestError(
              "agent_run_failed",
              started.message ?? "could not start the agent run",
            );
          }
          await respond(request.id, {
            ok: true,
            result: { prompt: run.prompt },
          });
          return;
        }
        if (request.method === "focus") {
          const focus = parseFocusRequest(request.params);
          const focused = onFocus({ query: focus.query, spaceId: context.space_id });
          if (!focused.ok) {
            throw new RequestError(
              "focus_failed",
              `no tab matched the query '${focus.query}'`,
            );
          }
          await respond(request.id, {
            ok: true,
            result: {
              query: focus.query,
              space_id: context.space_id,
              label: focused.label ?? null,
            },
          });
          return;
        }
        if (request.method === "pentest-run") {
          const run = parsePentestRunRequest(request.params);
          // Bring the window forward so the user sees the approvals it will ask.
          try {
            const window = getCurrentWindow();
            await window.show();
            await window.setFocus();
          } catch (error) {
            console.warn("[termigo] could not focus for pentest-run:", error);
          }
          const started = await onPentestRun(run);
          if (!started.ok) {
            throw new RequestError(
              "pentest_run_failed",
              started.message ?? "could not start the pentest run",
            );
          }
          await respond(request.id, {
            ok: true,
            result: { target: run.target, category: run.category },
          });
          return;
        }
        if (request.method === "pentest-status") {
          const status = await onPentestStatus();
          if (!status.ok) {
            throw new RequestError(
              "pentest_status_failed",
              status.message ?? "could not read the pentest status",
            );
          }
          await respond(request.id, { ok: true, result: status.result });
          return;
        }
        if (request.method === "pentest-report") {
          const report = parsePentestReportRequest(request.params);
          const started = await onPentestReport(report);
          if (!started.ok) {
            throw new RequestError(
              "pentest_report_failed",
              started.message ?? "could not request the pentest report",
            );
          }
          await respond(request.id, {
            ok: true,
            result: { target: report.target },
          });
          return;
        }
        if (request.method === "open") {
          const open = parseOpenRequest(request.params);
          let focused = false;
          if (open.focus) {
            const window = getCurrentWindow();
            try {
              await window.show();
              await window.setFocus();
              focused = true;
            } catch (error) {
              console.warn("[termigo] could not focus control target:", error);
            }
          }
          const tabId = onOpen({ ...open, spaceId: context.space_id });
          if (tabId === null) {
            throw new RequestError(
              "open_failed",
              "Termigo could not create an editor tab",
            );
          }
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          await respond(request.id, {
            ok: true,
            result: {
              path: open.path,
              line: open.line ?? null,
              tab_id: tabId,
              space_id: context.space_id,
              focus_requested: open.focus,
              focused,
            },
          });
          return;
        }
        throw new RequestError(
          "unknown_method",
          `unsupported frontend method '${request.method}'`,
        );
      } catch (error) {
        const responseError =
          error instanceof RequestError
            ? { code: error.code, message: error.message }
            : { code: "frontend_error", message: String(error) };
        await respond(request.id, { ok: false, error: responseError }).catch(
          (responseError) => {
            console.error("[termigo] control response failed:", responseError);
          },
        );
      }
    };

    void listen<ControlRequest>("termigo:control-request", (event) => {
      void handleRequest(event.payload);
    })
      .then((stop) => {
        if (disposed) {
          stop();
          return;
        }
        unlisten = stop;
        return setFrontendReady(true);
      })
      .catch((error) => {
        console.error("[termigo] control bridge setup failed:", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
      void setFrontendReady(false).catch((error) => {
        console.error("[termigo] control bridge cleanup failed:", error);
      });
    };
  }, [
    ready,
    tabsRef,
    activeTabIdRef,
    activeSpaceIdRef,
    onOpen,
    onFocus,
    onPentestRun,
    onPentestStatus,
    onPentestReport,
    onAgentRun,
    onStatus,
  ]);
}
