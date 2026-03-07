import { describe, expect, it } from "vitest";
import { parseLooseCommandOptions } from "../../src/cli/extension-command-options.js";

describe("cli extension loose option parser", () => {
  it("parses deterministic loose options across supported token shapes", () => {
    const parsed = parseLooseCommandOptions([
      "positional",
      "--tag=alpha",
      "--tag",
      "beta",
      "--tag",
      "gamma",
      "--no-cache",
      "--dry-run",
      "--folder",
      ".pi/todos",
      "--estimated-minutes",
      "15",
      "--",
    ]);

    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(parsed).toEqual({
      tag: ["alpha", "beta", "gamma"],
      cache: false,
      dryRun: true,
      folder: ".pi/todos",
      estimatedMinutes: "15",
    });
  });

  it("ignores unsafe prototype-related option keys", () => {
    const parsed = parseLooseCommandOptions([
      "--__proto__",
      "polluted",
      "--constructor",
      "ctor",
      "--prototype",
      "proto",
      "--safe",
      "ok",
      "--CONSTRUCTOR=still-unsafe",
      "--",
      "--=empty-key",
    ]);

    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(parsed).toEqual({
      safe: "ok",
    });
    expect(Object.hasOwn(parsed, "__proto__")).toBe(false);
    expect(Object.hasOwn(parsed, "constructor")).toBe(false);
    expect(Object.hasOwn(parsed, "prototype")).toBe(false);
  });
});
