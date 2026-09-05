import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceSwitcher } from "./useWorkspaceSwitcher";
import { LOCAL_WORKSPACE, type WorkspaceEnv } from "@/modules/workspace";

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn().mockResolvedValue("C:\\Users\\testuser"),
}));

vi.mock("@/modules/ai/lib/native", () => ({
  native: {
    workspaceAuthorize: vi.fn().mockResolvedValue(undefined),
    workspaceCurrentDir: vi.fn().mockResolvedValue("C:/Users/testuser"),
  },
}));

vi.mock("@/modules/workspace", () => ({
  LOCAL_WORKSPACE: { kind: "local" },
  getWslHome: vi.fn().mockResolvedValue("/home/testuser"),
}));

describe("useWorkspaceSwitcher", () => {
  const tabsRef = { current: [{ id: 1, kind: "terminal" as const, dirty: false }] } as never;
  const setWorkspaceEnv = vi.fn();
  const resetWorkspace = vi.fn();
  const clearWorkspaceState = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets isSwitchingWorkspaceRef during switch from WSL to local", async () => {
    const wslEnv: WorkspaceEnv = { kind: "wsl", distro: "Ubuntu" };
    const { result } = renderHook(() =>
      useWorkspaceSwitcher({
        tabsRef,
        workspaceEnv: wslEnv,
        setWorkspaceEnv,
        resetWorkspace,
        clearWorkspaceState,
      }),
    );

    expect(result.current.isSwitchingWorkspaceRef.current).toBe(false);

    let switched = false;
    await act(async () => {
      switched = await result.current.switchWorkspace(LOCAL_WORKSPACE);
    });

    expect(switched).toBe(true);
    expect(clearWorkspaceState).toHaveBeenCalled();
    expect(setWorkspaceEnv).toHaveBeenCalledWith(LOCAL_WORKSPACE);
    expect(resetWorkspace).toHaveBeenCalledWith("C:/Users/testuser");
    // isSwitchingWorkspaceRef remains true during the grace timeout to protect against trailing exit events
    expect(result.current.isSwitchingWorkspaceRef.current).toBe(true);
  });
});
