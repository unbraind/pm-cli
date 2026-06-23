import { describe, expect, it } from "vitest";
import {
  compareComparableVersions,
  evaluatePmMaxVersionBound,
  evaluatePmMinVersionBound,
  parseComparableVersion,
} from "../../../src/core/extensions/version-compat.js";

describe("parseComparableVersion", () => {
  it("parses a dotted-numeric release into segments", () => {
    expect(parseComparableVersion("2026.6.23")).toEqual([2026, 6, 23]);
  });

  it("strips a leading inclusive-minimum >= and a v prefix", () => {
    expect(parseComparableVersion(">= 1.2.3")).toEqual([1, 2, 3]);
    expect(parseComparableVersion("v4.5")).toEqual([4, 5]);
  });

  it("drops a build/pre-release suffix and keeps the leading release", () => {
    expect(parseComparableVersion("1.2.3+build.7")).toEqual([1, 2, 3]);
  });

  it("returns null for an uninterpretable version", () => {
    expect(parseComparableVersion("nightly")).toBeNull();
  });
});

describe("compareComparableVersions", () => {
  it("orders greater, lesser, and equal versions", () => {
    expect(compareComparableVersions("1.2.1", "1.2.0")).toBe(1);
    expect(compareComparableVersions("1.2.0", "1.2.1")).toBe(-1);
    expect(compareComparableVersions("1.2", "1.2.0")).toBe(0);
  });

  it("returns null when either side is uninterpretable", () => {
    expect(compareComparableVersions("nightly", "1.0.0")).toBeNull();
    expect(compareComparableVersions("1.0.0", "nightly")).toBeNull();
  });
});

describe("evaluatePmMinVersionBound", () => {
  it("is absent for an undefined or null bound", () => {
    expect(evaluatePmMinVersionBound(undefined, "2026.6.23").status).toBe("absent");
    expect(evaluatePmMinVersionBound(null, "2026.6.23").status).toBe("absent");
  });

  it("is invalid for a blank or non-string bound and blocks", () => {
    expect(evaluatePmMinVersionBound("   ", "2026.6.23")).toMatchObject({
      status: "invalid",
      allowed: false,
      required: "   ",
    });
    expect(evaluatePmMinVersionBound(7, "2026.6.23")).toMatchObject({
      status: "invalid",
      allowed: false,
      required: "7",
    });
  });

  it("is invalid for an unparseable bound and blocks", () => {
    expect(evaluatePmMinVersionBound("nightly", "2026.6.23")).toMatchObject({
      status: "invalid",
      allowed: false,
      required: "nightly",
    });
  });

  it("is unchecked when the current version is unknown (null)", () => {
    expect(evaluatePmMinVersionBound("2026.1.0", null)).toMatchObject({
      status: "unchecked",
      allowed: true,
      current: null,
    });
  });

  it("is unchecked when the current version is uninterpretable", () => {
    expect(evaluatePmMinVersionBound("2026.1.0", "nightly")).toMatchObject({
      status: "unchecked",
      allowed: true,
      current: "nightly",
    });
  });

  it("is unmet and blocks when the current version is below the bound", () => {
    expect(evaluatePmMinVersionBound("2026.9.0", "2026.6.23")).toMatchObject({
      status: "unmet",
      allowed: false,
    });
  });

  it("is ok when the current version satisfies the bound", () => {
    expect(evaluatePmMinVersionBound("2026.1.0", "2026.6.23")).toMatchObject({ status: "ok", allowed: true });
  });
});

describe("evaluatePmMaxVersionBound", () => {
  it("is absent for an undefined or null bound", () => {
    expect(evaluatePmMaxVersionBound(undefined, "2026.6.23", "block").status).toBe("absent");
    expect(evaluatePmMaxVersionBound(null, "2026.6.23", "block").status).toBe("absent");
  });

  it("is invalid for a blank or non-string bound and blocks", () => {
    expect(evaluatePmMaxVersionBound("", "2026.6.23", "block")).toMatchObject({
      status: "invalid",
      allowed: false,
      required: "",
    });
    expect(evaluatePmMaxVersionBound(false, "2026.6.23", "block")).toMatchObject({
      status: "invalid",
      allowed: false,
      required: "false",
    });
  });

  it("is invalid for a range-prefixed bound and blocks", () => {
    expect(evaluatePmMaxVersionBound(">=2026.6.1", "2026.6.23", "block")).toMatchObject({
      status: "invalid",
      allowed: false,
    });
  });

  it("is invalid for an unparseable (non-range) bound and blocks", () => {
    expect(evaluatePmMaxVersionBound("nightly", "2026.6.23", "block")).toMatchObject({
      status: "invalid",
      allowed: false,
    });
  });

  it("is unchecked when the current version is unknown (null)", () => {
    expect(evaluatePmMaxVersionBound("2026.9.0", null, "block")).toMatchObject({
      status: "unchecked",
      allowed: true,
      current: null,
    });
  });

  it("is unchecked when the current version is uninterpretable", () => {
    expect(evaluatePmMaxVersionBound("2026.9.0", "nightly", "block")).toMatchObject({
      status: "unchecked",
      allowed: true,
      current: "nightly",
    });
  });

  it("is exceeded and blocks in block mode when the current version is above the bound", () => {
    expect(evaluatePmMaxVersionBound("2026.1.0", "2026.6.23", "block")).toMatchObject({
      status: "exceeded",
      allowed: false,
    });
  });

  it("is exceeded_warn and allows in warn mode when the current version is above the bound", () => {
    expect(evaluatePmMaxVersionBound("2026.1.0", "2026.6.23", "warn")).toMatchObject({
      status: "exceeded_warn",
      allowed: true,
    });
  });

  it("is ok when the current version is within the bound", () => {
    expect(evaluatePmMaxVersionBound("2026.9.0", "2026.6.23", "block")).toMatchObject({ status: "ok", allowed: true });
  });
});
