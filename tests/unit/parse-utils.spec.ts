import { describe, expect, it } from "vitest";
import { parseCsvKv, parseOptionalNumber, parseTags } from "../../src/core/item/parse.js";

describe("core/item/parse", () => {
  it("normalizes tags with none-token and empty-input handling", () => {
    expect(parseTags("BETA, alpha, alpha")).toEqual(["alpha", "beta"]);
    expect(parseTags(" none ")).toEqual([]);
    expect(parseTags("   ")).toEqual([]);
  });

  it("parses csv key-value values with quoted commas and escaped quotes", () => {
    const parsed = parseCsvKv(String.raw`path=README.md,scope=project,note="alpha, \"beta\""`, "--file");
    expect(parsed).toEqual({
      path: "README.md",
      scope: "project",
      note: 'alpha, "beta"',
    });
  });

  it("throws usage errors for empty and malformed csv key-value input", () => {
    expect(() => parseCsvKv("   ", "--file")).toThrow("--file cannot be empty");
    expect(() => parseCsvKv("path=README.md,malformed", "--file")).toThrow(
      'Invalid --file value "path=README.md,malformed". Expected key=value pairs separated by commas.',
    );
  });

  it("accepts trailing commas without creating empty key-value entries", () => {
    expect(parseCsvKv("path=README.md,", "--file")).toEqual({
      path: "README.md",
    });
  });

  it("parses optional numbers including zero", () => {
    expect(parseOptionalNumber("0", "--estimate")).toBe(0);
    expect(parseOptionalNumber("15.5", "--estimate")).toBe(15.5);
  });

  it("rejects non-finite optional numbers", () => {
    expect(() => parseOptionalNumber("Infinity", "--estimate")).toThrow('Invalid --estimate value "Infinity"');
    expect(() => parseOptionalNumber("NaN", "--estimate")).toThrow('Invalid --estimate value "NaN"');
  });
});
