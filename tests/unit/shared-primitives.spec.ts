import { describe, expect, it } from "vitest";

import {
  asRecordClone,
  asRecordLoose,
  asRecordOrNull,
  isFiniteNumberArray,
  toErrorMessage,
  toNonEmptyString,
  toNonEmptyStringOrUndefined,
  trimTrailingSlashes,
} from "../../src/core/shared/primitives.js";

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
    expect(asRecordLoose(value)).toBe(value as unknown as Record<string, unknown>);
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
