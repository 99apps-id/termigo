// Smoke test — deliberately shallow and resilient.
//
// It exists to catch INTEGRATION regressions that unit tests cannot see: a boot
// crash, a blank window, a webview that never mounts React, a default terminal
// that never spawns because a Rust command is missing (exactly the class of bug
// where the SSH-backup commands were referenced but never registered). It does
// NOT assert fine-grained UI; keep it stable so a red run means something real.

describe("Termigo smoke", () => {
  it("boots and mounts the app shell into #root", async () => {
    const root = await $("#root");
    await root.waitForExist({ timeout: 30_000 });
    // A blank window would leave #root empty; React must render into it.
    await browser.waitUntil(
      async () => (await root.$$("*")).length > 0,
      {
        timeout: 30_000,
        timeoutMsg: "app shell never rendered into #root",
      },
    );
  });

  it("spawns the default terminal", async () => {
    // The default PTY brings up a terminal surface: either the tab wrapper or
    // xterm's own root. If the backend PTY command were broken, neither appears.
    const terminal = await $("[data-terminal-tab], .xterm");
    await terminal.waitForExist({ timeout: 30_000 });
  });

  it("renders the tab bar", async () => {
    const tab = await $("[data-tab-id]");
    await tab.waitForExist({ timeout: 30_000 });
  });
});
