import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PROFILE_ID } from "./harnessProfile";
import {
  activeProfileIdFor,
  useHarnessProfileStore,
} from "./harnessProfileStore";

describe("activeProfileIdFor", () => {
  beforeEach(() => {
    // In node (no localStorage) the read-persist helper falls back to the
    // in-memory store, so reset it between tests.
    useHarnessProfileStore.setState({ byWorkspace: {} });
  });

  it("falls back to the default profile when nothing is set", () => {
    expect(activeProfileIdFor("/ws")).toBe(DEFAULT_PROFILE_ID);
    expect(activeProfileIdFor(null)).toBe(DEFAULT_PROFILE_ID);
  });

  it("uses the global default override", () => {
    useHarnessProfileStore.getState().setActiveProfile(null, "plan_briefly");
    expect(activeProfileIdFor("/ws")).toBe("plan_briefly");
  });

  it("prefers a workspace override over the global default", () => {
    useHarnessProfileStore.getState().setActiveProfile(null, "plan_briefly");
    useHarnessProfileStore.getState().setActiveProfile("/a", "no_todo");
    expect(activeProfileIdFor("/a")).toBe("no_todo");
    expect(activeProfileIdFor("/b")).toBe("plan_briefly");
  });
});
