// The queue's whole job is to make a call wait and then let it go. The pure
// helpers are tested next door; this covers the part that actually blocks,
// because "the sub-agent hangs forever" is the failure mode that matters and
// no amount of target-parsing coverage would catch it.
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSessionAllowed,
  isApprovedDecision,
  isSessionAllowed,
  rememberSessionAllowed,
  useApprovalQueue,
} from "./approvalQueueStore";

const req = (requester = "builder #1") => ({
  requester,
  toolName: "write_file",
  summary: "src/a.ts",
});

/** Let pending promise callbacks run without waiting on real time. */
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  useApprovalQueue.getState().cancelAll();
  useApprovalQueue.setState({ pending: [] });
  clearSessionAllowed();
});

describe("a request waits until it is answered", () => {
  it("does not settle on its own", async () => {
    let settled = false;
    void useApprovalQueue
      .getState()
      .request(req())
      .then(() => {
        settled = true;
      });
    await tick();
    expect(settled).toBe(false);
    expect(useApprovalQueue.getState().pending).toHaveLength(1);
  });

  it("resolves approve when approved", async () => {
    const p = useApprovalQueue.getState().request(req());
    await tick();
    const [entry] = useApprovalQueue.getState().pending;
    useApprovalQueue.getState().respond([entry.id], true);
    await expect(p).resolves.toBe("approve");
  });

  it("resolves deny when denied, which is an answer and not an error", async () => {
    const p = useApprovalQueue.getState().request(req());
    await tick();
    const [entry] = useApprovalQueue.getState().pending;
    useApprovalQueue.getState().respond([entry.id], false);
    await expect(p).resolves.toBe("deny");
  });

  it("leaves the queue empty once answered", async () => {
    const p = useApprovalQueue.getState().request(req());
    await tick();
    useApprovalQueue
      .getState()
      .respond([useApprovalQueue.getState().pending[0].id], true);
    await p;
    expect(useApprovalQueue.getState().pending).toHaveLength(0);
  });
});

describe("the answer is a decision, not a yes/no", () => {
  it("respondWith passes a session allowance through", async () => {
    const p = useApprovalQueue.getState().request(req());
    await tick();
    const [entry] = useApprovalQueue.getState().pending;
    useApprovalQueue.getState().respondWith([entry.id], "allow-session");
    await expect(p).resolves.toBe("allow-session");
  });

  it("respondWith passes a permanent allowance through", async () => {
    const p = useApprovalQueue.getState().request(req());
    await tick();
    const [entry] = useApprovalQueue.getState().pending;
    useApprovalQueue.getState().respondWith([entry.id], "allow-always");
    await expect(p).resolves.toBe("allow-always");
  });

  it("treats every allowance as an approval", () => {
    expect(isApprovedDecision("approve")).toBe(true);
    expect(isApprovedDecision("allow-session")).toBe(true);
    expect(isApprovedDecision("allow-always")).toBe(true);
    expect(isApprovedDecision("deny")).toBe(false);
  });
});

describe("session memory remembers what the user allowed", () => {
  it("starts empty", () => {
    expect(isSessionAllowed("write_file")).toBe(false);
  });

  it("remembers a tool once allowed", () => {
    rememberSessionAllowed("write_file");
    expect(isSessionAllowed("write_file")).toBe(true);
    expect(isSessionAllowed("edit")).toBe(false);
  });

  it("clears everything on demand", () => {
    rememberSessionAllowed("write_file");
    rememberSessionAllowed("edit");
    clearSessionAllowed();
    expect(isSessionAllowed("write_file")).toBe(false);
    expect(isSessionAllowed("edit")).toBe(false);
  });
});

describe("several agents wait at once", () => {
  it("keeps them in the order they asked, which is how they are numbered", async () => {
    void useApprovalQueue.getState().request(req("builder #1"));
    void useApprovalQueue.getState().request(req("builder #2"));
    await tick();
    expect(
      useApprovalQueue.getState().pending.map((p) => p.requester),
    ).toEqual(["builder #1", "builder #2"]);
  });

  it("answers only the one addressed", async () => {
    const a = useApprovalQueue.getState().request(req("builder #1"));
    let bSettled = false;
    void useApprovalQueue
      .getState()
      .request(req("builder #2"))
      .then(() => {
        bSettled = true;
      });
    await tick();
    const [first] = useApprovalQueue.getState().pending;
    useApprovalQueue.getState().respond([first.id], true);
    await expect(a).resolves.toBe("approve");
    expect(bSettled).toBe(false);
    expect(useApprovalQueue.getState().pending).toHaveLength(1);
  });

  it("reports how many it actually answered", async () => {
    void useApprovalQueue.getState().request(req("builder #1"));
    void useApprovalQueue.getState().request(req("builder #2"));
    await tick();
    const ids = useApprovalQueue.getState().pending.map((p) => p.id);
    expect(useApprovalQueue.getState().respond([...ids, "gone"], true)).toBe(2);
  });
});

// Stop has to answer the question, not just abandon it. A blocked sub-agent is
// not reached by aborting the chat stream - it is waiting on this promise.
describe("stopping ends work that is blocked", () => {
  it("denies everything outstanding", async () => {
    const a = useApprovalQueue.getState().request(req("builder #1"));
    const b = useApprovalQueue.getState().request(req("builder #2"));
    await tick();
    expect(useApprovalQueue.getState().cancelAll()).toBe(2);
    await expect(a).resolves.toBe("deny");
    await expect(b).resolves.toBe("deny");
    expect(useApprovalQueue.getState().pending).toHaveLength(0);
  });

  it("releases a request when its own signal aborts", async () => {
    const ac = new AbortController();
    const p = useApprovalQueue.getState().request(req(), ac.signal);
    await tick();
    ac.abort();
    await expect(p).resolves.toBe("deny");
    expect(useApprovalQueue.getState().pending).toHaveLength(0);
  });

  it("never queues a request that was already stopped", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      useApprovalQueue.getState().request(req(), ac.signal),
    ).resolves.toBe("deny");
    expect(useApprovalQueue.getState().pending).toHaveLength(0);
  });

  // Approve then Stop must not resolve the same call twice.
  it("ignores a second answer to the same request", async () => {
    const p = useApprovalQueue.getState().request(req());
    await tick();
    const [entry] = useApprovalQueue.getState().pending;
    useApprovalQueue.getState().respond([entry.id], true);
    expect(useApprovalQueue.getState().respond([entry.id], false)).toBe(0);
    await expect(p).resolves.toBe("approve");
  });
});
