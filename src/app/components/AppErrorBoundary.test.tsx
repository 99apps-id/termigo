// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

// React's test-only `act` refuses to run unless the environment says it is a
// test renderer. Scoped to this file, which is the only one that mounts React.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Boom(): never {
  throw new Error("render blew up");
}

let mounted: Root | null = null;

async function mount(node: ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => {
    root.render(<AppErrorBoundary>{node}</AppErrorBoundary>);
  });
  return host;
}

afterEach(async () => {
  const root = mounted;
  mounted = null;
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = "";
});

describe("AppErrorBoundary", () => {
  it("shows the recovery screen instead of letting the error reach the root", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    const host = await mount(<Boom />);
    reported.mockRestore();

    expect(host.textContent).toContain("render blew up");
    expect(host.textContent).toContain("Reload the window");
  });

  it("renders its children when nothing throws", async () => {
    const host = await mount(<p>healthy subtree</p>);

    expect(host.textContent).toContain("healthy subtree");
    expect(host.textContent).not.toContain("Reload the window");
  });
});
