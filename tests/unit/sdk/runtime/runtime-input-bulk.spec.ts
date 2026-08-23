import { describe, expect, it } from "vitest";

import {
  mutationListOptions,
  normalizeMcpOptionsArrays,
  updateManyOptionsFromFlat,
} from "../../../../src/sdk/runtime-input.js";

describe("bulk runtime input normalization", () => {
  it("accepts transport-native ID arrays and preserves scalar compatibility", () => {
    expect(normalizeMcpOptionsArrays({ ids: ["pm-a", "pm-b"] })).toEqual({
      ids: "pm-a,pm-b",
    });
    expect(mutationListOptions({ ids: ["pm-a", "pm-b\npm-c"] })).toMatchObject({
      ids: "pm-a,pm-b,pm-c",
    });
    expect(
      updateManyOptionsFromFlat({
        ids: ["pm-a", "pm-b"],
        dryRun: true,
      }),
    ).toMatchObject({
      list: expect.objectContaining({ ids: "pm-a,pm-b" }),
      update: {},
      dryRun: true,
    });
  });
});
