import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  setApprovalRespondedHandler,
  useChatStore,
} from "./chatStore";

describe("respondToApproval dispatch", () => {
  beforeEach(() => {
    setApprovalRespondedHandler(null);
    useChatStore.setState({
      activeSessionId: "session-test-approval",
      approvalResponder: null,
    });
  });

  it("notifies approval responded handler when an approval is responded to", () => {
    const handler = vi.fn();
    setApprovalRespondedHandler(handler);

    useChatStore.getState().respondToApproval("approval-123", true);

    expect(handler).toHaveBeenCalledWith(
      "session-test-approval",
      "approval-123",
      true,
    );
  });

  it("delegates to registered approvalResponder if present", () => {
    const responder = vi.fn();
    useChatStore.getState().setApprovalResponder(responder);

    useChatStore.getState().respondToApproval("approval-456", false);

    expect(responder).toHaveBeenCalledWith("approval-456", false);
  });
});
