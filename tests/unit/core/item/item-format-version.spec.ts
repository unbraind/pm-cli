import { describe, expect, it } from "vitest";
import {
  BASELINE_ITEM_FORMAT_VERSION,
  CURRENT_ITEM_FORMAT_VERSION,
  classifyItemFormatVersion,
  effectiveItemFormatVersion,
  normalizeItemFormatVersion,
  scanItemFormatVersions,
} from "../../../../src/core/item/item-format-version.js";

describe("item-format-version constants", () => {
  it("keeps the current version at or above the baseline", () => {
    expect(BASELINE_ITEM_FORMAT_VERSION).toBe(1);
    expect(CURRENT_ITEM_FORMAT_VERSION).toBeGreaterThanOrEqual(BASELINE_ITEM_FORMAT_VERSION);
  });
});

describe("effectiveItemFormatVersion", () => {
  it("treats an absent version as the baseline", () => {
    expect(effectiveItemFormatVersion({})).toBe(BASELINE_ITEM_FORMAT_VERSION);
    expect(effectiveItemFormatVersion({ pm_format_version: undefined })).toBe(BASELINE_ITEM_FORMAT_VERSION);
  });

  it("returns a present, in-range integer verbatim including versions ahead of the runtime", () => {
    expect(effectiveItemFormatVersion({ pm_format_version: 1 })).toBe(1);
    expect(effectiveItemFormatVersion({ pm_format_version: 7 })).toBe(7);
  });

  it("falls back to the baseline for malformed or sub-baseline values", () => {
    expect(effectiveItemFormatVersion({ pm_format_version: 0 })).toBe(BASELINE_ITEM_FORMAT_VERSION);
    expect(effectiveItemFormatVersion({ pm_format_version: -3 })).toBe(BASELINE_ITEM_FORMAT_VERSION);
    expect(effectiveItemFormatVersion({ pm_format_version: 1.5 })).toBe(BASELINE_ITEM_FORMAT_VERSION);
    expect(effectiveItemFormatVersion({ pm_format_version: "2" as unknown as number })).toBe(
      BASELINE_ITEM_FORMAT_VERSION,
    );
  });
});

describe("normalizeItemFormatVersion", () => {
  it("drops the baseline, malformed, and sub-baseline values so they are never serialized", () => {
    expect(normalizeItemFormatVersion(undefined)).toBeUndefined();
    expect(normalizeItemFormatVersion(1)).toBeUndefined();
    expect(normalizeItemFormatVersion(0)).toBeUndefined();
    expect(normalizeItemFormatVersion(-2)).toBeUndefined();
    expect(normalizeItemFormatVersion(2.5)).toBeUndefined();
    expect(normalizeItemFormatVersion("3")).toBeUndefined();
  });

  it("preserves versions above the baseline verbatim", () => {
    expect(normalizeItemFormatVersion(2)).toBe(2);
    expect(normalizeItemFormatVersion(10)).toBe(10);
  });
});

describe("classifyItemFormatVersion", () => {
  it("classifies against the runtime current version by default", () => {
    expect(classifyItemFormatVersion(CURRENT_ITEM_FORMAT_VERSION)).toBe("current");
    expect(classifyItemFormatVersion(CURRENT_ITEM_FORMAT_VERSION + 1)).toBe("ahead");
  });

  it("classifies against an explicit hypothetical current version", () => {
    expect(classifyItemFormatVersion(1, 2)).toBe("outdated");
    expect(classifyItemFormatVersion(2, 2)).toBe("current");
    expect(classifyItemFormatVersion(3, 2)).toBe("ahead");
  });
});

describe("scanItemFormatVersions", () => {
  it("returns empty partitions for an empty input", () => {
    expect(scanItemFormatVersions([])).toEqual({ outdated: [], ahead: [] });
  });

  it("partitions and sorts references against an explicit current version", () => {
    const result = scanItemFormatVersions(
      [
        { ref: "z-current", version: 2 },
        { ref: "b-outdated", version: 1 },
        { ref: "a-outdated", version: 1 },
        { ref: "y-ahead", version: 4 },
        { ref: "x-ahead", version: 3 },
      ],
      2,
    );
    expect(result.outdated).toEqual(["a-outdated", "b-outdated"]);
    expect(result.ahead).toEqual(["x-ahead", "y-ahead"]);
  });

  it("treats nothing as outdated at the baseline current version", () => {
    const result = scanItemFormatVersions([
      { ref: "baseline", version: 1 },
      { ref: "ahead", version: 2 },
    ]);
    expect(result.outdated).toEqual([]);
    expect(result.ahead).toEqual(["ahead"]);
  });
});
