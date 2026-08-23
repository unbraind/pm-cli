import { describe, expect, it } from "vitest";

import { assertCommandDefinitionMetadataStrings } from "../../../../src/core/extensions/command-visibility-tier.js";

describe("extension command visibility metadata", () => {
  it("accepts declared tiers and capability families", () => {
    expect(() =>
      assertCommandDefinitionMetadataStrings({
        command: "inspect",
        handler: () => undefined,
        tier: "full",
        family: "extensions",
      }),
    ).not.toThrow();
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
