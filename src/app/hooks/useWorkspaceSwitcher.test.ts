import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEnvHome } from "./useWorkspaceSwitcher";
import { LOCAL_WORKSPACE, type WorkspaceEnv } from "@/modules/workspace";

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn().mockResolvedValue("C:\\Users\\testuser"),
}));

vi.mock("@/modules/workspace", () => ({
  LOCAL_WORKSPACE: { kind: "local" },
  getWslHome: vi.fn().mockResolvedValue("/home/testuser"),
}));

describe("resolveEnvHome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves home for local workspace with forward slashes", async () => {
    const home = await resolveEnvHome(LOCAL_WORKSPACE);
    expect(home).toBe("C:/Users/testuser");
  });

  it("resolves home for WSL workspace via getWslHome", async () => {
    const wslEnv: WorkspaceEnv = { kind: "wsl", distro: "Ubuntu" };
    const home = await resolveEnvHome(wslEnv);
    expect(home).toBe("/home/testuser");
  });
});
