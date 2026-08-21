import { describe, expect, it } from "vitest";
import { _testOnly } from "../../../src/sdk/extension.js";

const activationResult = {
  services: {
    overrides: [
      {
        service: "output_format",
        layer: "project",
        name: "command-owned-output",
      },
    ],
  },
  renderers: { overrides: [] },
} as never;

describe("output service doctor ownership", () => {
  it("warns for an unscoped output_format service", () => {
    expect(
      _testOnly.collectGlobalOutputOverrideDoctorWarnings(activationResult),
    ).toEqual([
      "extension_output_service_override_global:output_format:project:command-owned-output",
    ]);
  });

  it("recognizes manifest command activation as explicit service ownership", () => {
    expect(
      _testOnly.collectGlobalOutputOverrideDoctorWarnings(
        activationResult,
        {
          loaded: [
            {
              layer: "project",
              name: "command-owned-output",
              activation: { commands: ["owned-command"] },
            },
          ],
        } as never,
      ),
    ).toEqual([]);
  });

  it("recognizes a host-enforced pass-through service contract", () => {
    expect(
      _testOnly.collectGlobalOutputOverrideDoctorWarnings({
        services: {
          overrides: [
            {
              service: "output_format",
              layer: "project",
              name: "declining-output",
              passThrough: true,
            },
          ],
        },
        renderers: { overrides: [] },
      } as never),
    ).toEqual([]);
  });
});
