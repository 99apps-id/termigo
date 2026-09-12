// The terminal's view of the app's configuration.
//
// The write allowlist is the security boundary being tested here: the control
// socket accepts `config-set` from any local caller holding the token, so
// "write any key" would be a way to write arbitrary values into
// termigo-settings.json. Every rejection below happens BEFORE the settings store
// is touched, which is why these tests need no IPC mock - and that ordering is
// itself part of the guarantee being asserted.

import { describe, expect, it } from "vitest";
import {
  WRITABLE_CONFIG_KEYS,
  listModels,
  setProviderSecret,
  writeTerminalConfig,
} from "./terminalConfig";

describe("listModels", () => {
  it("returns the real registry, not a copy", () => {
    const catalogue = listModels();
    expect(catalogue.providers.length).toBeGreaterThan(10);
    expect(catalogue.models.length).toBeGreaterThan(30);
    // A terminal that cannot see the models cannot offer them.
    expect(catalogue.models.some((m) => m.id === "deepseek-v4-pro")).toBe(true);
  });

  it("marks which providers need a key, so onboarding knows to ask", () => {
    const catalogue = listModels();
    const deepseek = catalogue.providers.find((p) => p.id === "deepseek");
    expect(deepseek?.needsKey).toBe(true);
    // At least one provider must be keyless (a local server), or the "needs a
    // key" flag carries no information.
    expect(catalogue.providers.some((p) => !p.needsKey)).toBe(true);
  });

  it("carries everything a picker needs per model", () => {
    for (const model of listModels().models) {
      expect(model.id).toBeTruthy();
      expect(model.provider).toBeTruthy();
      expect(model.label).toBeTruthy();
      expect(model.description).toBeTruthy();
    }
  });

  it("exposes the provider-side id when it differs from the registry id", () => {
    // DeepSeek's everyday tier is served as `deepseek-flash`; a terminal that
    // showed only the registry id would mislead about what is on the wire.
    const flash = listModels().models.find((m) => m.id === "deepseek-v4-flash");
    expect(flash?.apiModelId).toBe("deepseek-flash");
  });
});

describe("writeTerminalConfig", () => {
  it("advertises a small, explicit writable set", () => {
    expect(WRITABLE_CONFIG_KEYS).toEqual([
      "defaultModelId",
      "toolSearchEnabled",
      "disabledToolGroups",
      "agentApprovalMode",
    ]);
  });

  it("refuses an unknown key and names what is writable", async () => {
    await expect(writeTerminalConfig("apiKey", "x")).rejects.toThrow(
      /not writable from the terminal/,
    );
    await expect(writeTerminalConfig("foo", 1)).rejects.toThrow(
      /writable keys: defaultModelId/,
    );
  });

  it("refuses to write anything outside the allowlist", async () => {
    // A spread of real settings keys that must NOT be reachable: each one would
    // either widen permissions or change behaviour the operator cannot see.
    for (const key of [
      "agentAlwaysAllowedTools",
      "customEndpoints",
      "pentestScope",
      "enforcePentestScope",
      "theme",
    ]) {
      await expect(writeTerminalConfig(key, true)).rejects.toThrow(
        /not writable from the terminal/,
      );
    }
  });

  it("validates the value for defaultModelId without touching the store", async () => {
    await expect(writeTerminalConfig("defaultModelId", "")).rejects.toThrow(
      /non-empty model id/,
    );
    await expect(writeTerminalConfig("defaultModelId", 42)).rejects.toThrow(
      /non-empty model id/,
    );
    // A bogus id would leave the app with no usable model.
    await expect(
      writeTerminalConfig("defaultModelId", "not-a-real-model"),
    ).rejects.toThrow(/unknown model id/);
  });

  it("validates the value for toolSearchEnabled", async () => {
    await expect(writeTerminalConfig("toolSearchEnabled", "true")).rejects.toThrow(
      /must be true or false/,
    );
  });

  it("validates the value for disabledToolGroups", async () => {
    await expect(writeTerminalConfig("disabledToolGroups", "browser")).rejects.toThrow(
      /list of group names/,
    );
    await expect(
      writeTerminalConfig("disabledToolGroups", ["browser", 7]),
    ).rejects.toThrow(/list of group names/);
  });

  it("validates the value for agentApprovalMode against the app's own list", async () => {
    await expect(
      writeTerminalConfig("agentApprovalMode", "never"),
    ).rejects.toThrow(/must be one of/);
    await expect(writeTerminalConfig("agentApprovalMode", true)).rejects.toThrow(
      /must be one of/,
    );
  });
});

describe("setProviderSecret", () => {
  it("refuses an empty key", async () => {
    await expect(setProviderSecret("deepseek", "   ")).rejects.toThrow(
      /API key is empty/,
    );
  });

  it("refuses an unknown provider", async () => {
    await expect(setProviderSecret("does-not-exist", "sk-x")).rejects.toThrow(
      /unknown provider/,
    );
  });

  it("refuses a provider that does not use a key", async () => {
    const keyless = listModels().providers.find((p) => !p.needsKey);
    expect(keyless, "expected a keyless provider to exist").toBeDefined();
    await expect(
      setProviderSecret(keyless?.id ?? "", "sk-x"),
    ).rejects.toThrow(/does not use an API key/);
  });
});
