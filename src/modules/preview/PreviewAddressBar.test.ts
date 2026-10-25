import { describe, expect, it } from "vitest";
import {
  isLoopback,
  isPrivateHost,
  isPrivateIPv4,
  normalizeUrl,
} from "./PreviewAddressBar";

describe("PreviewAddressBar normalizeUrl", () => {
  it("leaves explicit http/https schemes untouched", () => {
    expect(normalizeUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeUrl("https://github.com")).toBe("https://github.com");
  });

  it("prepends http to localhost", () => {
    expect(normalizeUrl("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeUrl("localhost")).toBe("http://localhost");
    expect(normalizeUrl("localhost/api")).toBe("http://localhost/api");
  });

  it("prepends http to IPv4 addresses including loopback and ports", () => {
    expect(normalizeUrl("127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(normalizeUrl("127.0.0.1")).toBe("http://127.0.0.1");
    expect(normalizeUrl("127.0.0.2:8080/foo")).toBe(
      "http://127.0.0.2:8080/foo",
    );
    expect(normalizeUrl("192.168.1.50:8000")).toBe("http://192.168.1.50:8000");
  });

  it("prepends http to bracketed IPv6 addresses", () => {
    expect(normalizeUrl("[::1]:3000")).toBe("http://[::1]:3000");
    expect(normalizeUrl("[::1]")).toBe("http://[::1]");
  });

  it("prepends https to standard web domain names", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(normalizeUrl("test.dev/path")).toBe("https://test.dev/path");
    expect(normalizeUrl("sub.domain.co.uk:8443")).toBe(
      "https://sub.domain.co.uk:8443",
    );
  });
});

describe("PreviewAddressBar isLoopback", () => {
  it("identifies localhost and subdomains as loopback", () => {
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("app.localhost")).toBe(true);
  });

  it("identifies 127.0.0.0/8 IPv4 addresses as loopback", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("127.0.0.2")).toBe(true);
    expect(isLoopback("127.128.0.1")).toBe(true);
  });

  it("identifies IPv6 ::1 as loopback", () => {
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("[::1]")).toBe(true);
  });

  it("returns false for non-loopback addresses and domains", () => {
    expect(isLoopback("192.168.1.1")).toBe(false);
    expect(isLoopback("10.0.0.1")).toBe(false);
    expect(isLoopback("example.com")).toBe(false);
  });
});

describe("PreviewAddressBar isPrivateHost and isPrivateIPv4", () => {
  it("recognizes RFC 1918 private IPv4 ranges", () => {
    expect(isPrivateIPv4("10.0.0.1")).toBe(true);
    expect(isPrivateIPv4("172.16.0.1")).toBe(true);
    expect(isPrivateIPv4("172.31.255.254")).toBe(true);
    expect(isPrivateIPv4("192.168.0.1")).toBe(true);
    expect(isPrivateIPv4("169.254.169.254")).toBe(true);

    expect(isPrivateIPv4("8.8.8.8")).toBe(false);
    expect(isPrivateIPv4("1.1.1.1")).toBe(false);
  });

  it("allows loopback hosts in isPrivateHost so local dev preview works", () => {
    expect(isPrivateHost("localhost")).toBe(false);
    expect(isPrivateHost("127.0.0.1")).toBe(false);
    expect(isPrivateHost("127.0.0.2")).toBe(false);
    expect(isPrivateHost("::1")).toBe(false);
    expect(isPrivateHost("[::1]")).toBe(false);
    expect(isPrivateHost("sub.localhost")).toBe(false);
  });

  it("blocks private network and link-local addresses in isPrivateHost", () => {
    expect(isPrivateHost("10.0.0.1")).toBe(true);
    expect(isPrivateHost("192.168.1.1")).toBe(true);
    expect(isPrivateHost("172.20.0.1")).toBe(true);
    expect(isPrivateHost("169.254.169.254")).toBe(true);
    expect(isPrivateHost("fe80::1")).toBe(true);
  });

  it("permits public domain names", () => {
    expect(isPrivateHost("google.com")).toBe(false);
    expect(isPrivateHost("github.com")).toBe(false);
  });
});
