import { describe, expect, it } from "vitest";
import {
  coerceLooseCommandOptionsWithFlagDefinitions,
  parseLooseCommandOptions,
  validateLooseCommandOptionsWithFlagDefinitions,
} from "../../src/cli/extension-command-options.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";

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
      "-d",
      "--folder",
      ".pm/todos",
      "--estimated-minutes",
      "15",
      "--",
    ]);

    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(parsed).toEqual({
      tag: ["alpha", "beta", "gamma"],
      cache: false,
      dryRun: true,
      d: true,
      folder: ".pm/todos",
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

  it("coerces loose options from extension flag definitions when types are declared", () => {
    const parsed = parseLooseCommandOptions(["--limit", "5", "--strict", "true", "--title", "hello"]);
    const coerced = coerceLooseCommandOptionsWithFlagDefinitions(parsed, [
      { long: "--limit", type: "number" },
      { long: "--strict", type: "boolean" },
      { long: "--title", type: "string" },
    ]);
    expect(coerced).toEqual({
      limit: 5,
      strict: true,
      title: "hello",
    });
  });

  it("rejects unknown and disabled loose options when extension flags are declared", () => {
    const definitions = [
      { long: "--folder", value_type: "string" },
      { long: "--dry-run", short: "-d", value_type: "boolean" },
      { long: "--required-flag", short: "-r", required: true },
      { long: "--disabled", enabled: false },
    ];

    expect(() =>
      validateLooseCommandOptionsWithFlagDefinitions({ folder: ".pm/todos", requiredFlag: "ok" }, definitions, "todos export"),
    )
      .not.toThrow();
    expect(() => validateLooseCommandOptionsWithFlagDefinitions({ r: "ok" }, definitions, "todos export"))
      .not.toThrow();

    expect(() =>
      validateLooseCommandOptionsWithFlagDefinitions({ output: "todos.md", requiredFlag: "ok" }, definitions, "todos export"),
    )
      .toThrowError(PmCliError);
    try {
      validateLooseCommandOptionsWithFlagDefinitions({ output: "todos.md", requiredFlag: "ok" }, definitions, "todos export");
    } catch (error) {
      expect(error).toMatchObject({ exitCode: EXIT_CODE.USAGE });
      expect((error as Error).message).toContain("Unknown option '--output' for extension command 'todos export'");
    }

    expect(() => validateLooseCommandOptionsWithFlagDefinitions({ disabled: true, requiredFlag: "ok" }, definitions, "todos export"))
      .toThrow("Option '--disabled' is disabled for extension command 'todos export'");

    expect(() => validateLooseCommandOptionsWithFlagDefinitions({ folder: ".pm/todos" }, definitions, "todos export"))
      .toThrow("Missing required option '--required-flag' for extension command 'todos export'");
  });

  it("canonicalizes short loose options to their long option key", () => {
    const definitions = [
      { long: "--dry-run", short: "-d", value_type: "boolean" },
      { long: "--folder", short: "-f", value_type: "string" },
    ];

    expect(coerceLooseCommandOptionsWithFlagDefinitions({ d: true, f: "out" }, definitions)).toEqual({
      dryRun: true,
      folder: "out",
    });
    expect(coerceLooseCommandOptionsWithFlagDefinitions({ dryRun: false, d: true }, definitions)).toEqual({
      dryRun: false,
      d: true,
    });
  });
});
