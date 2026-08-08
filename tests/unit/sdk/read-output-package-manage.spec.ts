import { describe, expect, it } from "vitest";
import {
  resolveReadOutputEncoding,
  resolveReadOutputSurface,
  validateReadOutputOptions,
} from "../../../src/sdk/read-output-contracts.js";

describe("package manage read-output contract", () => {
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
});
