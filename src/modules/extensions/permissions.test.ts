import { describe, expect, it } from "vitest";
import {
  checkPermission,
  PermissionDeniedError,
  permissionRiskTier,
  requirePermission,
} from "./permissions";

describe("aiTools:register gate", () => {
  it("is granted by exact declaration", () => {
    expect(checkPermission(["aiTools:register"], "aiTools:register")).toBe(
      true,
    );
    expect(() =>
      requirePermission("ext", ["aiTools:register"], "aiTools:register"),
    ).not.toThrow();
  });

  it("is denied when undeclared", () => {
    expect(checkPermission(["panels:register"], "aiTools:register")).toBe(
      false,
    );
    expect(() =>
      requirePermission("ext", ["panels:register"], "aiTools:register"),
    ).toThrow(PermissionDeniedError);
  });

  it("is covered by a wildcard grant", () => {
    expect(checkPermission(["*"], "aiTools:register")).toBe(true);
    expect(checkPermission(["aiTools:*"], "aiTools:register")).toBe(true);
  });

  it("is tiered high for the install review", () => {
    expect(permissionRiskTier("aiTools:register")).toBe("high");
  });
});
