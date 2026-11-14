import { describe, expect, it } from "vitest";
import {
  BASELINE_ITEM_FORMAT_VERSION,
  CURRENT_ITEM_FORMAT_VERSION,
  classifyItemFormatVersion,
  effectiveItemFormatVersion,
  normalizeItemFormatVersion,
  requiredItemFormatVersion,
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
    expect(classifyItemFormatVersion(1, 2, 1)).toBe("current");
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
        { ref: "y-ahead", version: 5 },
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
    ], BASELINE_ITEM_FORMAT_VERSION);
    expect(result.outdated).toEqual([]);
    expect(result.ahead).toEqual(["ahead"]);
  });

  it("keeps every readable format current while refusing future formats", () => {
    expect(scanItemFormatVersions([{ ref: "legacy", version: 1 }, { ref: "editor", version: 2 }, { ref: "setup", version: 3 }, { ref: "deferral", version: 4 }, { ref: "future", version: 5 }], CURRENT_ITEM_FORMAT_VERSION, BASELINE_ITEM_FORMAT_VERSION)).toEqual({ outdated: [], ahead: ["future"] });
  });
});


describe("requiredItemFormatVersion", () => {
  it("uses the baseline until editor fields exist and never lowers a stored requirement", () => {
    expect(requiredItemFormatVersion({})).toBe(1);
    expect(requiredItemFormatVersion({ tests: [] })).toBe(1);
    expect(requiredItemFormatVersion({ tests: [{ command: "node --version", scope: "project" }] })).toBe(1);
    for (const stamp of [{ updated_by: "editor" }, { updated_at: "2026-10-14T00:00:00.000Z" }]) {
      expect(requiredItemFormatVersion({ tests: [{ command: "node --version", scope: "project", ...stamp }] })).toBe(2);
    }
    expect(requiredItemFormatVersion({ pm_format_version: 3 })).toBe(3);
    // GH-1671: a setup entry needs format 3, which outranks editor stamps and never lowers a stored requirement.
    const setup = { command: "npm run build", scope: "project" as const, phase: "setup" as const };
    expect(requiredItemFormatVersion({ tests: [setup] })).toBe(3);
    expect(requiredItemFormatVersion({ tests: [{ command: "node --version", scope: "project", updated_by: "editor" }, setup] })).toBe(3);
    expect(requiredItemFormatVersion({ tests: [setup], pm_format_version: 4 })).toBe(4);
    // GH-1713: a field deferral needs format 4, an empty deferral list does not, and a stored 5 is never lowered.
    const deferral = { field: "deadline", reason: "Imported" };
    expect(requiredItemFormatVersion({ deferred_fields: [deferral] })).toBe(4);
    expect(requiredItemFormatVersion({ deferred_fields: [], tests: [setup] })).toBe(3);
    expect(requiredItemFormatVersion({ deferred_fields: [deferral], pm_format_version: 5 })).toBe(5);
  });
});
