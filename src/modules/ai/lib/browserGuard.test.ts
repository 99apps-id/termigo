import { describe, expect, it } from "vitest";
import {
  isSafePreviewUrl,
  normalizeIpv4,
  unsafeBrowserUrl,
} from "./browserGuard";

describe("normalizeIpv4", () => {
  it("normalizes dotted, decimal, hex and octal forms", () => {
    expect(normalizeIpv4("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeIpv4("2130706433")).toBe("127.0.0.1");
    expect(normalizeIpv4("0x7f000001")).not.toBeNull(); // hex, parses as int
    expect(normalizeIpv4("017700000001")).toBe("127.0.0.1");
  });

  it("returns null for non-IPv4 hosts", () => {
    expect(normalizeIpv4("localhost")).toBeNull();
    expect(normalizeIpv4("127.0.0")).toBeNull();
    expect(normalizeIpv4("999.0.0.1")).toBeNull();
  });
});

describe("unsafeBrowserUrl", () => {
  it("allows public web URLs", () => {
    expect(unsafeBrowserUrl("https://example.com")).toBeNull();
    expect(unsafeBrowserUrl("http://example.com/a?b=c")).toBeNull();
  });

  it("rejects non-http(s) schemes", () => {
    expect(unsafeBrowserUrl("file:///etc/passwd")).toMatch(/only http/);
    expect(unsafeBrowserUrl("ftp://example.com")).toMatch(/only http/);
    expect(unsafeBrowserUrl("not a url")).toMatch(/invalid/);
  });

  it("rejects cloud-metadata endpoints", () => {
    expect(unsafeBrowserUrl("http://169.254.169.254/latest/meta-data")).toMatch(
      /metadata/,
    );
    expect(
      unsafeBrowserUrl("http://metadata.google.internal/computeMetadata"),
    ).toMatch(/metadata/);
  });

  it("rejects loopback / link-local IP tricks", () => {
    expect(unsafeBrowserUrl("http://2130706433:5173")).toMatch(/loopback/);
    expect(unsafeBrowserUrl("http://127.0.0.1")).toMatch(/loopback/);
    expect(unsafeBrowserUrl("http://169.254.169.254")).toMatch(
      /metadata|link-local/,
    );
    expect(unsafeBrowserUrl("http://[fe80::1]/")).toMatch(/IPv6/);
  });
});

describe("isSafePreviewUrl", () => {
  it("allows loopback dev-server URLs", () => {
    expect(isSafePreviewUrl("http://localhost:5173")).toBe(true);
    expect(isSafePreviewUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isSafePreviewUrl("http://localhost:5173/x")).toBe(true);
  });

  it("rejects external and metadata URLs", () => {
    expect(isSafePreviewUrl("https://example.com")).toBe(false);
    expect(isSafePreviewUrl("http://169.254.169.254/")).toBe(false);
    expect(isSafePreviewUrl("file:///etc/passwd")).toBe(false);
  });
});
