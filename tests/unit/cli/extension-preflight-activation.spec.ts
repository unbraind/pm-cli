/**
 * @module tests/unit/cli/extension-preflight-activation
 */
import { describe, expect, it } from "vitest";
import { _testOnly } from "../../../src/cli/main.js";

function extensionWithPreflightOwnership(commands: string[]) {
  return {
    layer: "project",
    name: `preflight-${commands.join("-")}`,
    root: "/tmp/preflight-extension",
    manifest_path: "/tmp/preflight-extension/pm-package.json",
    manifest: { name: "preflight-extension", version: "1.0.0" },
    commands: [],
    capabilities: ["preflight"],
    contributions: {
      schema_version: 1,
      preflight_overrides: 1,
      preflight_ownership: [{ commands }],
    },
  };
}

describe("preflight ownership activation parity", () => {
  it("activates scoped preflights only for an owned command", () => {
    const scoped = extensionWithPreflightOwnership(["claim", "claim-next"]);

    expect(_testOnly.extensionActivationCommands(scoped as never)).toEqual([
      "claim",
      "claim-next",
    ]);
    expect(
      _testOnly.extensionNeedsActivationForProbe(scoped as never, {
        commandPath: "claim",
      }),
    ).toBe(true);
    expect(
      _testOnly.extensionNeedsActivationForProbe(scoped as never, {
        commandPath: "health",
      }),
    ).toBe(false);
  });

  it("keeps unscoped preflights global while subtracting scoped ownership", () => {
    expect(
      _testOnly.hasGlobalExtensionContributions({
        schema_version: 1,
        preflight_overrides: 1,
        preflight_ownership: [{ commands: ["claim"] }],
      }),
    ).toBe(false);
    expect(
      _testOnly.hasGlobalExtensionContributions({
        schema_version: 1,
        preflight_overrides: 2,
        preflight_ownership: [{ commands: ["claim"] }],
      }),
    ).toBe(true);
  });
});
