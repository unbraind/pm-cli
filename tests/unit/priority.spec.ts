import { describe, expect, it } from "vitest";
import {
  PRIORITY_ACCEPTED_FORMS_HINT,
  PRIORITY_NAME_TO_VALUE,
  resolvePriority,
} from "../../src/core/item/priority.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";

describe("resolvePriority", () => {
  it("maps named levels to their numeric values", () => {
    expect(resolvePriority("critical")).toBe(0);
    expect(resolvePriority("high")).toBe(1);
    expect(resolvePriority("medium")).toBe(2);
    expect(resolvePriority("low")).toBe(3);
    expect(resolvePriority("minimal")).toBe(4);
  });

  it("accepts named levels case-insensitively and trims whitespace", () => {
    expect(resolvePriority("Critical")).toBe(0);
    expect(resolvePriority("HIGH")).toBe(1);
    expect(resolvePriority("MINIMAL")).toBe(4);
    expect(resolvePriority("  high  ")).toBe(1);
  });

  it("keeps numeric 0..4 working unchanged", () => {
    expect(resolvePriority("0")).toBe(0);
    expect(resolvePriority("1")).toBe(1);
    expect(resolvePriority("2")).toBe(2);
    expect(resolvePriority("3")).toBe(3);
    expect(resolvePriority("4")).toBe(4);
  });

  it("trims surrounding whitespace on numeric input", () => {
    expect(resolvePriority(" 2 ")).toBe(2);
  });

  it("rejects empty/whitespace-only input with a USAGE error listing both forms", () => {
    for (const raw of ["", "   "]) {
      let caught: unknown;
      try {
        resolvePriority(raw);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PmCliError);
      const err = caught as PmCliError;
      expect(err.exitCode).toBe(EXIT_CODE.USAGE);
      expect(err.message).toContain("numbers 0..4");
      expect(err.message).toContain("critical, high, medium, low, minimal");
    }
  });

  it("rejects out-of-range numbers and non-priority words", () => {
    for (const raw of ["5", "-1", "10", "bogus", "1.0", "2px", "highish"]) {
      let caught: unknown;
      try {
        resolvePriority(raw);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PmCliError);
      const err = caught as PmCliError;
      expect(err.exitCode).toBe(EXIT_CODE.USAGE);
      expect(err.message).toContain(`Invalid priority "${raw}"`);
      expect(err.message).toContain("numbers 0..4");
      expect(err.message).toContain("names");
    }
  });

  it("exposes the canonical name->value mapping and accepted-forms hint", () => {
    expect(PRIORITY_NAME_TO_VALUE).toEqual({
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
      minimal: 4,
    });
    expect(PRIORITY_ACCEPTED_FORMS_HINT).toContain("numbers 0..4");
    expect(PRIORITY_ACCEPTED_FORMS_HINT).toContain("critical, high, medium, low, minimal");
  });
});
