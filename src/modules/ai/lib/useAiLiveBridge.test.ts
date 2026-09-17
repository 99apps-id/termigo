import type { Tab } from "@/modules/tabs";
import { describe, expect, it, vi } from "vitest";
import type { Live } from "../store/chatStore";

vi.mock("react", () => ({
  useRef: <T>(initial: T) => ({ current: initial }),
  useEffect: (fn: () => void) => fn(),
}));

import { useAiLiveBridge } from "./useAiLiveBridge";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/modules/terminal", () => ({
  findLeafCwd: vi.fn(),
  findLeafRemoteCwd: (_paneTree: unknown, leafId: number) =>
    leafId === 10 ? "/remote/dir" : null,
  isSshLeaf: (_paneTree: unknown, leafId: number) => leafId === 10,
  leafSessionId: (leafId: number) => (leafId === 10 ? 42 : null),
  whenSessionReady: vi.fn().mockResolvedValue(undefined),
  writeToSession: vi.fn(),
}));

vi.mock("@/modules/agents/lib/launcher", () => ({
  findAgentLauncherWithCustom: vi.fn(),
}));

vi.mock("@/modules/agents/store/managedAgentsStore", () => ({
  useManagedAgentsStore: { getState: () => ({ customLaunchers: [] }) },
}));

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: { getState: () => ({}) },
}));

vi.mock("./scheduler", () => ({
  startScheduler: vi.fn(),
}));

describe("useAiLiveBridge getRemoteSession", () => {
  it("returns remote session when active tab is an SSH terminal leaf", () => {
    let capturedLive: Live | null = null;
    const terminalRefs = { current: new Map() };
    const tabs: Tab[] = [
      {
        id: 1,
        kind: "terminal",
        spaceId: "s1",
        title: "ssh",
        paneTree: {
          kind: "leaf",
          id: 10,
          ssh: true,
        } as unknown as Tab["paneTree"],
        activeLeafId: 10,
      } as Tab,
    ];

    useAiLiveBridge({
      activeId: 1,
      tabs,
      terminalRefs,
      setLive: (live) => {
        capturedLive = live;
      },
    });

    expect(capturedLive).not.toBeNull();
    const remote = capturedLive?.getRemoteSession();
    expect(remote).toEqual({ sessionId: 42, cwd: "/remote/dir" });
  });

  it("returns null when active tab is a local terminal", () => {
    let capturedLive: Live | null = null;
    const terminalRefs = { current: new Map() };
    const tabs: Tab[] = [
      {
        id: 2,
        kind: "terminal",
        spaceId: "s1",
        title: "local shell",
        paneTree: { kind: "leaf", id: 20 } as unknown as Tab["paneTree"],
        activeLeafId: 20,
      } as Tab,
    ];

    useAiLiveBridge({
      activeId: 2,
      tabs,
      terminalRefs,
      setLive: (live) => {
        capturedLive = live;
      },
    });

    expect(capturedLive).not.toBeNull();
    const remote = capturedLive?.getRemoteSession();
    expect(remote).toBeNull();
  });

  it("returns null when active tab is a local terminal even if a background tab is SSH", () => {
    let capturedLive: Live | null = null;
    const terminalRefs = { current: new Map() };
    const tabs: Tab[] = [
      {
        id: 1,
        kind: "terminal",
        spaceId: "s1",
        title: "ssh background",
        paneTree: {
          kind: "leaf",
          id: 10,
          ssh: true,
        } as unknown as Tab["paneTree"],
        activeLeafId: 10,
      } as Tab,
      {
        id: 2,
        kind: "terminal",
        spaceId: "s1",
        title: "kali-linux foreground",
        paneTree: { kind: "leaf", id: 20 } as unknown as Tab["paneTree"],
        activeLeafId: 20,
      } as Tab,
    ];

    useAiLiveBridge({
      activeId: 2,
      tabs,
      terminalRefs,
      setLive: (live) => {
        capturedLive = live;
      },
    });

    expect(capturedLive).not.toBeNull();
    // Foreground tab is 2 (local/WSL), so remote session MUST be null
    const remote = capturedLive?.getRemoteSession();
    expect(remote).toBeNull();
  });

  it("returns null when active tab is an editor tab", () => {
    let capturedLive: Live | null = null;
    const terminalRefs = { current: new Map() };
    const tabs: Tab[] = [
      {
        id: 1,
        kind: "terminal",
        spaceId: "s1",
        title: "ssh background",
        paneTree: {
          kind: "leaf",
          id: 10,
          ssh: true,
        } as unknown as Tab["paneTree"],
        activeLeafId: 10,
      } as Tab,
      {
        id: 3,
        kind: "editor",
        spaceId: "s1",
        title: "file.ts",
      } as unknown as Tab,
    ];

    useAiLiveBridge({
      activeId: 3,
      tabs,
      terminalRefs,
      setLive: (live) => {
        capturedLive = live;
      },
    });

    expect(capturedLive).not.toBeNull();
    const remote = capturedLive?.getRemoteSession();
    expect(remote).toBeNull();
  });
});
