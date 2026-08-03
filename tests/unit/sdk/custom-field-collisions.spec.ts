import { describe, expect, it } from "vitest";
import { resolvePmToolCustomFieldCollision } from "../../../src/sdk/index.js";

describe("MCP custom-field collision normalization", () => {
  it.each([
    ["pm-executable", "pmExecutable"],
    ["pm_executable", "pmExecutable"],
    ["token-accounting", "tokenAccounting"],
    ["no_extensions", "noExtensions"],
    [" output-format ", "outputFormat"],
  ])("maps %s to the reserved %s property", (field, property) => {
    expect(resolvePmToolCustomFieldCollision(field)).toEqual({
      field,
      property,
      owner: "mcp_tool_input",
      nested_path: `options.${property}`,
    });
  });

  it("normalizes adversarial separator runs in linear time", () => {
    const field = `pm${"-".repeat(200_000)}executable`;
    expect(resolvePmToolCustomFieldCollision(field)).toMatchObject({
      property: "pmExecutable",
      nested_path: "options.pmExecutable",
    });
  });

  it.each([
    "custom-field",
    "pm-executable-",
    "pm-!executable",
    "pm-2executable",
    "__cwd",
  ])("does not report non-reserved field %s", (field) => {
    expect(resolvePmToolCustomFieldCollision(field)).toBeUndefined();
  });
});
