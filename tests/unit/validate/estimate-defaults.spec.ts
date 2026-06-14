import { describe, expect, it } from "vitest";

import {
  DEFAULT_ESTIMATE_MINUTES_BY_TYPE,
  FALLBACK_ESTIMATE_MINUTES,
  normalizeEstimateDefaultOverrides,
  resolveEstimateDefaultMinutes,
} from "../../../src/core/validate/estimate-defaults.js";

describe("DEFAULT_ESTIMATE_MINUTES_BY_TYPE", () => {
  it("ships the canonical built-in per-type defaults", () => {
    expect(DEFAULT_ESTIMATE_MINUTES_BY_TYPE).toEqual({
      Epic: 2880,
      Feature: 480,
      Story: 480,
      Milestone: 2880,
      Task: 120,
      Issue: 60,
      Bug: 60,
      Chore: 30,
      Decision: 15,
      Plan: 120,
    });
  });

  it("exposes FALLBACK_ESTIMATE_MINUTES as 120", () => {
    expect(FALLBACK_ESTIMATE_MINUTES).toBe(120);
  });
});

describe("resolveEstimateDefaultMinutes", () => {
  it("returns FALLBACK for undefined type", () => {
    expect(resolveEstimateDefaultMinutes(undefined)).toBe(FALLBACK_ESTIMATE_MINUTES);
  });

  it("returns FALLBACK for empty / whitespace-only type", () => {
    expect(resolveEstimateDefaultMinutes("")).toBe(FALLBACK_ESTIMATE_MINUTES);
    expect(resolveEstimateDefaultMinutes("   ")).toBe(FALLBACK_ESTIMATE_MINUTES);
  });

  it("resolves a built-in type (exact case)", () => {
    expect(resolveEstimateDefaultMinutes("Epic")).toBe(2880);
  });

  it("resolves a built-in type case-insensitively", () => {
    expect(resolveEstimateDefaultMinutes("bug")).toBe(60);
    expect(resolveEstimateDefaultMinutes("  STORY  ")).toBe(480);
  });

  it("returns FALLBACK for an unknown type with no overrides", () => {
    expect(resolveEstimateDefaultMinutes("Spike")).toBe(FALLBACK_ESTIMATE_MINUTES);
  });

  it("prefers an override over the built-in default (case-insensitive)", () => {
    expect(resolveEstimateDefaultMinutes("Bug", { bug: 90 })).toBe(90);
  });

  it("uses an override for a type absent from the built-in map", () => {
    expect(resolveEstimateDefaultMinutes("Spike", { Spike: 240 })).toBe(240);
  });

  it("ignores a non-positive override and falls through to the built-in", () => {
    expect(resolveEstimateDefaultMinutes("Bug", { Bug: 0 })).toBe(60);
    expect(resolveEstimateDefaultMinutes("Bug", { Bug: -5 })).toBe(60);
  });

  it("ignores a non-finite override and falls through to the built-in", () => {
    expect(resolveEstimateDefaultMinutes("Bug", { Bug: Number.POSITIVE_INFINITY })).toBe(60);
    expect(resolveEstimateDefaultMinutes("Bug", { Bug: Number.NaN })).toBe(60);
  });

  it("ignores an invalid override for an unknown type and returns FALLBACK", () => {
    expect(resolveEstimateDefaultMinutes("Spike", { Spike: -1 })).toBe(FALLBACK_ESTIMATE_MINUTES);
  });

  it("floors a fractional override value to a positive integer", () => {
    expect(resolveEstimateDefaultMinutes("Bug", { Bug: 90.9 })).toBe(90);
  });

  it("does not consult overrides for an empty type", () => {
    expect(resolveEstimateDefaultMinutes("", { "": 999 })).toBe(FALLBACK_ESTIMATE_MINUTES);
  });
});

describe("normalizeEstimateDefaultOverrides", () => {
  it("returns {} for undefined", () => {
    expect(normalizeEstimateDefaultOverrides(undefined)).toEqual({});
  });

  it("returns {} for null", () => {
    expect(normalizeEstimateDefaultOverrides(null)).toEqual({});
  });

  it("returns {} for a string", () => {
    expect(normalizeEstimateDefaultOverrides("nope")).toEqual({});
  });

  it("returns {} for a number", () => {
    expect(normalizeEstimateDefaultOverrides(42)).toEqual({});
  });

  it("returns {} for an array", () => {
    expect(normalizeEstimateDefaultOverrides([1, 2, 3])).toEqual({});
  });

  it("keeps valid positive-integer entries", () => {
    expect(normalizeEstimateDefaultOverrides({ Bug: 60, Task: 120 })).toEqual({
      Bug: 60,
      Task: 120,
    });
  });

  it("drops invalid entries while keeping valid ones", () => {
    expect(
      normalizeEstimateDefaultOverrides({
        Bug: 60,
        Zero: 0,
        Negative: -5,
        Infinite: Number.POSITIVE_INFINITY,
        NaNVal: Number.NaN,
        NotANumber: "120",
      }),
    ).toEqual({ Bug: 60 });
  });

  it("ignores empty and whitespace-only keys", () => {
    expect(normalizeEstimateDefaultOverrides({ "": 30, "   ": 30 })).toEqual({});
  });

  it("trims surrounding whitespace from keys", () => {
    expect(normalizeEstimateDefaultOverrides({ "  Bug  ": 60 })).toEqual({ Bug: 60 });
  });

  it("floors fractional values to integers", () => {
    expect(normalizeEstimateDefaultOverrides({ Bug: 60.7 })).toEqual({ Bug: 60 });
  });
});
