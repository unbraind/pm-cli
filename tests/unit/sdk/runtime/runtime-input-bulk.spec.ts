import { describe, expect, it } from "vitest";

import {
  closeManyOptionsFromFlat,
  mutationListOptions,
  normalizeMcpOptionsArrays,
  updateManyOptionsFromFlat,
} from "../../../../src/sdk/runtime-input.js";
import {
  preserveMutationStdinTokenLiterals,
  shouldResolveMutationStdinTokens,
} from "../../../../src/core/item/parse.js";

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
    expect(
      mutationListOptions({ ids: Number.POSITIVE_INFINITY }),
    ).toMatchObject({
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

  it.each([updateManyOptionsFromFlat, closeManyOptionsFromFlat])(
    "normalizes nested bulk selectors without erasing explicit invalid IDs",
    (normalize) => {
      expect(
        normalize({ list: { ids: [123], type: "Task" }, dryRun: true }),
      ).toMatchObject({ list: { ids: "123", type: "Task" } });
      expect(
        normalize({ list: { ids: Number.NaN, type: "Task" }, dryRun: true }),
      ).toMatchObject({ list: { ids: "", type: "Task" } });
      expect(
        normalize({ list: { ids: { invalid: true }, type: "Task" } }),
      ).toMatchObject({ list: { ids: "", type: "Task" } });
      expect(
        normalize({
          list: { ids: ["pm-a", Number.POSITIVE_INFINITY], type: "Task" },
          dryRun: true,
        }),
      ).toMatchObject({ list: { ids: "", type: "Task" } });
    },
  );

  it("preserves a nested direct-SDK update stdin policy during normalization", () => {
    const update = preserveMutationStdinTokenLiterals({ body: "-" });
    const normalized = updateManyOptionsFromFlat({
      list: { ids: ["pm-a"] },
      update,
    });

    expect(normalized.update).toMatchObject({ body: "-" });
    expect(shouldResolveMutationStdinTokens(normalized.update)).toBe(false);
  });
});
