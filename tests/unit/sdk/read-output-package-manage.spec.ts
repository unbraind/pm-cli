import { describe, expect, it } from "vitest";
import {
  resolveReadOutputEncoding,
  resolveReadOutputSurface,
  validateReadOutputOptions,
} from "../../../src/sdk/read-output-contracts.js";

describe("package read-output contracts", () => {
  it("recognizes CLI and SDK action spellings as the same read surface", () => {
    expect(resolveReadOutputSurface("package manage")).toBe("package-manage");
    expect(resolveReadOutputSurface("package-manage")).toBe("package-manage");
    expect(() =>
      validateReadOutputOptions("package manage", { outputFormat: "json" }),
    ).not.toThrow();
    expect(
      resolveReadOutputEncoding("package-manage", { outputFormat: "json" }),
    ).toBe("json");
  });

  it("declares catalog as a mode-sensitive read surface", () => {
    expect(resolveReadOutputSurface("package catalog")).toBe(
      "package-catalog",
    );
    expect(resolveReadOutputSurface("package-catalog")).toBe(
      "package-catalog",
    );
    expect(resolveReadOutputSurface("packages catalog")).toBe(
      "package-catalog",
    );
    expect(resolveReadOutputSurface("packages", { target: "catalog" })).toBe(
      "package-catalog",
    );
    expect(resolveReadOutputSurface("extension", { action: "catalog" })).toBe(
      "package-catalog",
    );
    expect(() =>
      validateReadOutputOptions("package", {
        catalog: true,
        outputBudget: "unbounded",
      }),
    ).not.toThrow();
    expect(() =>
      validateReadOutputOptions("package", {
        catalog: true,
        install: true,
        outputBudget: "unbounded",
      }),
    ).toThrow("cannot be combined with a package-catalog mutation");
    expect(() =>
      validateReadOutputOptions("package", {
        install: true,
        outputBudget: "unbounded",
      }),
    ).toThrow("package is not a read surface");
  });
});
