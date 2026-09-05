import { describe, expect, it } from "vitest";
import { isSensitiveEnvVar } from "./system";

describe("isSensitiveEnvVar", () => {
  it("identifies secret environment variables", () => {
    expect(isSensitiveEnvVar("OPENAI_API_KEY")).toBe(true);
    expect(isSensitiveEnvVar("ANTHROPIC_API_KEY")).toBe(true);
    expect(isSensitiveEnvVar("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(isSensitiveEnvVar("GITHUB_TOKEN")).toBe(true);
    expect(isSensitiveEnvVar("DATABASE_PASSWORD")).toBe(true);
    expect(isSensitiveEnvVar("SESSION_SECRET")).toBe(true);
    expect(isSensitiveEnvVar("AUTH_BEARER_TOKEN")).toBe(true);
    expect(isSensitiveEnvVar("STRIPE_KEY")).toBe(true);
    expect(isSensitiveEnvVar("PRIVATE_KEY")).toBe(true);
  });

  it("allows non-sensitive environment variables", () => {
    expect(isSensitiveEnvVar("PATH")).toBe(false);
    expect(isSensitiveEnvVar("HOME")).toBe(false);
    expect(isSensitiveEnvVar("USER")).toBe(false);
    expect(isSensitiveEnvVar("NODE_ENV")).toBe(false);
    expect(isSensitiveEnvVar("LANG")).toBe(false);
    expect(isSensitiveEnvVar("SHELL")).toBe(false);
    expect(isSensitiveEnvVar("AUTHOR")).toBe(false);
  });
});
