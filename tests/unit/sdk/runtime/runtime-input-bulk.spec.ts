import { describe, expect, it } from "vitest";

import {
  mutationListOptions,
  normalizeMcpOptionsArrays,
  updateManyOptionsFromFlat,
} from "../../../../src/sdk/runtime-input.js";

describe("bulk runtime input normalization", () => {
  it("accepts transport-native ID arrays and preserves scalar compatibility", () => {
    expect(
      normalizeMcpOptionsArrays(
        { ids: ["extension-a", "extension-b"] },
        "extension-action",
      ),
    ).toEqual({
      ids: ["extension-a", "extension-b"],
    });
    expect(mutationListOptions({ ids: ["pm-a", "pm-b\npm-c"] })).toMatchObject({
      ids: "pm-a,pm-b,pm-c",
    });
    expect(mutationListOptions({ ids: 123 })).toMatchObject({ ids: "123" });
    expect(mutationListOptions({ ids: Number.NaN })).toMatchObject({
      ids: "",
    });
    expect(mutationListOptions({ ids: Number.POSITIVE_INFINITY })).toMatchObject({
      ids: "",
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
    expect(
      updateManyOptionsFromFlat({
        ids: 123,
        dryRun: true,
      }),
    ).toMatchObject({
      list: expect.objectContaining({ ids: "123" }),
      update: {},
      dryRun: true,
    });
  });
});
