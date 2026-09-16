import { openExternalUrl } from "@/lib/external-link";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownLink } from "./MarkdownLink";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

describe("MarkdownLink", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    "https://chatgpt.com/codex/settings/usage",
    "mailto:support@example.com",
    "tel:+16045550123",
  ])("opens supported links natively: %s", async (href) => {
    openUrl.mockResolvedValue(undefined);
    const onSettled = vi.fn();

    await openExternalUrl(href, onSettled);

    expect(openUrl).toHaveBeenCalledWith(href);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("still settles when opening fails", async () => {
    openUrl.mockRejectedValue(new Error("browser unavailable"));
    const onSettled = vi.fn();

    await openExternalUrl("https://example.com", onSettled);

    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("does not invoke the native opener for unsupported schemes", async () => {
    const onSettled = vi.fn();

    await openExternalUrl("javascript:alert(1)", onSettled);

    expect(openUrl).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("sanitizes unsafe schemes and prevents default without opening native url", () => {
    const el = MarkdownLink({
      href: "javascript:alert(1)",
      children: "Malicious link",
    });

    expect(el.props.href).toBeUndefined();
    expect(el.props.target).toBeUndefined();
    expect(el.props.rel).toBeUndefined();

    const preventDefault = vi.fn();
    el.props.onClick({
      defaultPrevented: false,
      preventDefault,
    } as unknown as React.MouseEvent<HTMLAnchorElement>);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("renders valid external links and triggers openExternalUrl on click", () => {
    openUrl.mockResolvedValue(undefined);
    const el = MarkdownLink({
      href: "https://example.com/docs",
      children: "Documentation",
    });

    expect(el.props.href).toBe("https://example.com/docs");
    expect(el.props.target).toBe("_blank");
    expect(el.props.rel).toBe("noreferrer");

    const preventDefault = vi.fn();
    el.props.onClick({
      defaultPrevented: false,
      preventDefault,
    } as unknown as React.MouseEvent<HTMLAnchorElement>);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("respects defaultPrevented from custom onClick", () => {
    const onCustomClick = vi.fn((e: { defaultPrevented: boolean }) => {
      e.defaultPrevented = true;
    });
    const el = MarkdownLink({
      href: "https://example.com/docs",
      children: "Documentation",
      onClick: onCustomClick as unknown as React.MouseEventHandler<HTMLAnchorElement>,
    });

    const preventDefault = vi.fn();
    const event = {
      defaultPrevented: false,
      preventDefault,
    };
    el.props.onClick(event as unknown as React.MouseEvent<HTMLAnchorElement>);

    expect(onCustomClick).toHaveBeenCalledWith(event);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });
});
