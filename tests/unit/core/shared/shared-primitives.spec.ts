import { describe, expect, it } from "vitest";

import {
  asRecordClone,
  asRecordLoose,
  asRecordOrNull,
  coerceFiniteNumber,
  coerceNumberInRange,
  coercePositiveInteger,
  isFiniteNumberArray,
  toErrorMessage,
  toNonEmptyString,
  toNonEmptyStringOrUndefined,
  trimTrailingSlashes,
} from "../../../../src/core/shared/primitives.js";

describe("toNonEmptyString", () => {
  it("returns trimmed value for non-empty strings", () => {
    expect(toNonEmptyString("  hello  ")).toBe("hello");
  });

  it("returns null for empty or whitespace-only strings", () => {
    expect(toNonEmptyString("   ")).toBeNull();
    expect(toNonEmptyString("")).toBeNull();
  });

  it("returns null for non-string inputs", () => {
    expect(toNonEmptyString(42)).toBeNull();
    expect(toNonEmptyString(undefined)).toBeNull();
    expect(toNonEmptyString(null)).toBeNull();
  });
});

describe("toNonEmptyStringOrUndefined", () => {
  it("returns trimmed value when present", () => {
    expect(toNonEmptyStringOrUndefined(" x ")).toBe("x");
  });

  it("returns undefined when absent", () => {
    expect(toNonEmptyStringOrUndefined("  ")).toBeUndefined();
    expect(toNonEmptyStringOrUndefined(7)).toBeUndefined();
  });
});

describe("trimTrailingSlashes", () => {
  it("removes trailing slashes", () => {
    expect(trimTrailingSlashes("/a/b///")).toBe("/a/b");
  });

  it("leaves strings without trailing slashes unchanged", () => {
    expect(trimTrailingSlashes("/a/b")).toBe("/a/b");
  });

  it("handles empty, slash-only, and adversarial suffixes in linear time", () => {
    expect(trimTrailingSlashes("")).toBe("");
    expect(trimTrailingSlashes("///")).toBe("");
    expect(
      trimTrailingSlashes(`https://example.test/${"/".repeat(100_000)}`),
    ).toBe("https://example.test");
  });
});

describe("isFiniteNumberArray", () => {
  it("returns true for arrays of finite numbers", () => {
    expect(isFiniteNumberArray([1, 2, 3])).toBe(true);
    expect(isFiniteNumberArray([])).toBe(true);
  });

  it("returns false for non-arrays and arrays with non-finite entries", () => {
    expect(isFiniteNumberArray("nope")).toBe(false);
    expect(isFiniteNumberArray([1, Number.NaN])).toBe(false);
    expect(isFiniteNumberArray([1, "2"])).toBe(false);
  });
});

describe("toErrorMessage", () => {
  it("returns trimmed Error message", () => {
    expect(toErrorMessage(new Error("  boom  "))).toBe("boom");
  });

  it("falls back to Error name when message is empty", () => {
    const error = new Error("");
    error.name = "FallbackError";
    expect(toErrorMessage(error)).toBe("FallbackError");
  });

  it("stringifies non-Error values", () => {
    expect(toErrorMessage("plain")).toBe("plain");
    expect(toErrorMessage(123)).toBe("123");
  });
});

describe("coerceFiniteNumber", () => {
  it("parses numbers and numeric strings", () => {
    expect(coerceFiniteNumber(2.5)).toBe(2.5);
    expect(coerceFiniteNumber(" 42 ")).toBe(42);
  });

  it("returns null for invalid or empty values", () => {
    expect(coerceFiniteNumber("")).toBeNull();
    expect(coerceFiniteNumber("nan")).toBeNull();
    expect(coerceFiniteNumber(Number.NaN)).toBeNull();
    expect(coerceFiniteNumber(undefined)).toBeNull();
  });
});

describe("coercePositiveInteger", () => {
  it("accepts positive integer literals and numeric strings", () => {
    expect(coercePositiveInteger(7)).toBe(7);
    expect(coercePositiveInteger("9")).toBe(9);
  });

  it("rejects zero, negatives, and fractional values", () => {
    expect(coercePositiveInteger(0)).toBeNull();
    expect(coercePositiveInteger(-1)).toBeNull();
    expect(coercePositiveInteger(1.5)).toBeNull();
  });
});

describe("coerceNumberInRange", () => {
  it("returns parsed number when value lies within inclusive bounds", () => {
    expect(coerceNumberInRange("0.4", 0, 1)).toBe(0.4);
    expect(coerceNumberInRange(1, 0, 1)).toBe(1);
  });

  it("returns null when value is out of range or invalid", () => {
    expect(coerceNumberInRange("1.5", 0, 1)).toBeNull();
    expect(coerceNumberInRange("-0.1", 0, 1)).toBeNull();
    expect(coerceNumberInRange("bad", 0, 1)).toBeNull();
  });
});

describe("asRecordOrNull", () => {
  it("returns the same reference for plain objects", () => {
    const value = { a: 1 };
    expect(asRecordOrNull(value)).toBe(value);
  });

  it("returns null for non-objects, null, and arrays", () => {
    expect(asRecordOrNull(null)).toBeNull();
    expect(asRecordOrNull(undefined)).toBeNull();
    expect(asRecordOrNull("x")).toBeNull();
    expect(asRecordOrNull([1, 2])).toBeNull();
  });
});

describe("asRecordLoose", () => {
  it("returns the same reference for plain objects", () => {
    const value = { a: 1 };
    expect(asRecordLoose(value)).toBe(value);
  });

  it("returns the array reference (arrays are objects)", () => {
    const value = [1, 2];
    expect(asRecordLoose(value)).toBe(
      value as unknown as Record<string, unknown>,
    );
  });

  it("returns null for non-objects and null", () => {
    expect(asRecordLoose(null)).toBeNull();
    expect(asRecordLoose(undefined)).toBeNull();
    expect(asRecordLoose("x")).toBeNull();
  });
});

describe("asRecordClone", () => {
  it("returns a shallow clone for plain objects", () => {
    const value = { a: 1 };
    const result = asRecordClone(value);
    expect(result).toEqual(value);
    expect(result).not.toBe(value);
  });

  it("returns an empty object for non-objects, null, and arrays", () => {
    expect(asRecordClone(null)).toEqual({});
    expect(asRecordClone(undefined)).toEqual({});
    expect(asRecordClone("x")).toEqual({});
    expect(asRecordClone([1, 2])).toEqual({});
  });
});
