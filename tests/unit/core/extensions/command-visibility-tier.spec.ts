import { describe, expect, it } from "vitest";

import { assertCommandDefinitionMetadataStrings } from "../../../../src/core/extensions/command-visibility-tier.js";
import { EXTENSION_COMMAND_CAPABILITY_FAMILIES } from "../../../../src/core/extensions/command-metadata-contract.js";
import type { ExtensionCommandCapabilityFamily } from "../../../../src/core/extensions/extension-types.js";
import type { PmCommandCapabilityFamily } from "../../../../src/sdk/agent-capability-contracts.js";

type SameDomain<Left, Right> =
  Exclude<Left, Right> extends never
    ? Exclude<Right, Left> extends never
      ? true
      : false
    : false;

describe("extension command visibility metadata", () => {
  it("accepts declared tiers and capability families", () => {
    const extensionTypeParity: SameDomain<
      ExtensionCommandCapabilityFamily,
      (typeof EXTENSION_COMMAND_CAPABILITY_FAMILIES)[number]
    > = true;
    const sdkTypeParity: SameDomain<
      PmCommandCapabilityFamily,
      (typeof EXTENSION_COMMAND_CAPABILITY_FAMILIES)[number]
    > = true;
    expect({ extensionTypeParity, sdkTypeParity }).toEqual({
      extensionTypeParity: true,
      sdkTypeParity: true,
    });
    for (const tier of ["core", "standard", "full", "internal"] as const) {
      for (const family of EXTENSION_COMMAND_CAPABILITY_FAMILIES) {
        expect(() =>
          assertCommandDefinitionMetadataStrings({
            command: "inspect",
            handler: () => undefined,
            tier,
            family,
          }),
        ).not.toThrow();
      }
    }
  });

  it("rejects values outside the closed tier and family contracts", () => {
    expect(() =>
      assertCommandDefinitionMetadataStrings({
        command: "inspect",
        handler: () => undefined,
        tier: "private" as never,
      }),
    ).toThrow("definition.tier must be core, standard, full, or internal");
    expect(() =>
      assertCommandDefinitionMetadataStrings({
        command: "inspect",
        handler: () => undefined,
        family: "miscellaneous" as never,
      }),
    ).toThrow("definition.family must be workspace");
  });
});
