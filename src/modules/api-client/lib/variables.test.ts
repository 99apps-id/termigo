import { describe, expect, it } from "vitest";
import { substituteVariables, variableMap } from "./variables";

describe("variableMap", () => {
  it("maps enabled variables by trimmed key", () => {
    const vars = variableMap({
      id: "e",
      name: "dev",
      variables: [
        { id: "1", key: "baseUrl", value: "https://dev", enabled: true },
        { id: "2", key: "skipped", value: "x", enabled: false },
        { id: "3", key: " padded ", value: "y", enabled: true },
      ],
    });
    expect(vars).toEqual({ baseUrl: "https://dev", padded: "y" });
  });

  it("returns empty object when no environment", () => {
    expect(variableMap(null)).toEqual({});
    expect(variableMap(undefined)).toEqual({});
  });
});

describe("substituteVariables", () => {
  it("substitutes known variables", () => {
    expect(
      substituteVariables("https://{{baseUrl}}/users/{{id}}", {
        baseUrl: "api.example.com",
        id: "42",
      }),
    ).toBe("https://api.example.com/users/42");
  });

  it("leaves unknown variables unchanged", () => {
    expect(substituteVariables("{{missing}}", {})).toBe("{{missing}}");
  });

  it("trims inner whitespace in a placeholder", () => {
    expect(substituteVariables("{{ baseUrl }}", { baseUrl: "x" })).toBe("x");
  });

  it("handles a variable used more than once", () => {
    expect(substituteVariables("{{a}}-{{a}}", { a: "v" })).toBe("v-v");
  });
});
