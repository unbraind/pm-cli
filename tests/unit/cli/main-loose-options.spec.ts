import { describe, expect, it } from "vitest";
import {
  coerceLooseCommandOptionsWithFlagDefinitions,
  parseLooseCommandOptions,
  stripLooseCommandOptionTokens,
  validateLooseCommandOptionsWithFlagDefinitions,
} from "../../../src/cli/extension-command-options.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";

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

  it("accumulates list-flag values across comma-joined and repeated occurrences (pm-ltbr)", () => {
    const parsed = parseLooseCommandOptions(["--tag", "a,b", "--tag", "c", "--tag", "d,e"]);
    const coerced = coerceLooseCommandOptionsWithFlagDefinitions(parsed, [
      { long: "--tag", value_type: "string", list: true },
    ]);
    expect(coerced).toEqual({ tag: ["a", "b", "c", "d", "e"] });
  });

  it("wraps a single list-flag occurrence into an array even without a declared kind (pm-ltbr)", () => {
    const parsed = parseLooseCommandOptions(["--id", "only", "--empty", ",, ,"]);
    const coerced = coerceLooseCommandOptionsWithFlagDefinitions(parsed, [
      { long: "--id", list: true },
      { long: "--empty", list: true },
    ]);
    expect(coerced).toEqual({ id: ["only"], empty: [] });
  });

  it("coerces list-flag elements by declared value_type (pm-ltbr)", () => {
    const parsed = parseLooseCommandOptions(["--n", "1,2", "--n", "3"]);
    const coerced = coerceLooseCommandOptionsWithFlagDefinitions(parsed, [
      { long: "--n", value_type: "number", list: true },
    ]);
    expect(coerced).toEqual({ n: [1, 2, 3] });
  });

  it("applies declared scalar and list defaults when a flag is omitted (pm-ltbr)", () => {
    const coerced = coerceLooseCommandOptionsWithFlagDefinitions({}, [
      { long: "--mode", value_type: "string", default: "auto" },
      { long: "--limit", value_type: "number", default: 10 },
      { long: "--strict", value_type: "boolean", default: true },
      { long: "--raw", default: "kept" },
      { long: "--tags", value_type: "string", list: true, default: "x,y" },
      { long: "--absent", value_type: "string" },
    ]);
    expect(coerced).toEqual({ mode: "auto", limit: 10, strict: true, raw: "kept", tags: ["x", "y"] });
    expect(Object.hasOwn(coerced, "absent")).toBe(false);
  });

  it("keeps a provided value over the declared default (pm-ltbr)", () => {
    const parsed = parseLooseCommandOptions(["--mode", "manual"]);
    const coerced = coerceLooseCommandOptionsWithFlagDefinitions(parsed, [
      { long: "--mode", value_type: "string", default: "auto" },
    ]);
    expect(coerced).toEqual({ mode: "manual" });
  });

  it("prefers value_type over the deprecated type alias (pm-l0jd)", () => {
    const parsed = parseLooseCommandOptions(["--count", "7"]);
    const coerced = coerceLooseCommandOptionsWithFlagDefinitions(parsed, [
      { long: "--count", type: "string", value_type: "number" },
    ]);
    expect(coerced).toEqual({ count: 7 });
  });

  it("accepts an array default for a list flag and flattens it (pm-ltbr)", () => {
    const coerced = coerceLooseCommandOptionsWithFlagDefinitions({}, [
      { long: "--scope", value_type: "string", list: true, default: ["a", "b,c"] },
    ]);
    expect(coerced).toEqual({ scope: ["a", "b", "c"] });
  });

  it("strips known extension option tokens from dynamic command positional args", () => {
    const stripped = stripLooseCommandOptionTokens(
      ["--upper", "hello", "--repeat", "2", "--decorations=star,spark", "--", "--upper", "--unknown", "kept"],
      [
        { long: "--upper", value_type: "boolean" },
        { long: "--repeat", value_type: "number" },
        { long: "--decorations", value_type: "string", list: true },
      ],
    );
    expect(stripped).toEqual(["hello", "--upper", "--unknown", "kept"]);
  });

  it("covers fallback validation labels and array/null boolean coercion branches", () => {
    expect(() => validateLooseCommandOptionsWithFlagDefinitions({}, [], "todos export")).not.toThrow();
    expect(() =>
      validateLooseCommandOptionsWithFlagDefinitions({}, [{ long: "bad", short: "--oops" } as never], "todos export"),
    ).not.toThrow();

    const coercedStrings = coerceLooseCommandOptionsWithFlagDefinitions(
      { tag: [1, null, "ok"] },
      [{ long: "--tag", value_type: "string" }],
    );
    expect(coercedStrings).toEqual({ tag: ["1", null, "ok"] });

    const coercedBoolean = coerceLooseCommandOptionsWithFlagDefinitions(
      { maybe: "perhaps" },
      [{ long: "--maybe", value_type: "boolean" }],
    );
    expect(coercedBoolean).toEqual({ maybe: "perhaps" });
    expect(coerceLooseCommandOptionsWithFlagDefinitions({ maybe: 1 }, [{ long: "--maybe", value_type: "boolean" }])).toEqual({
      maybe: 1,
    });

    expect(
      coerceLooseCommandOptionsWithFlagDefinitions({ count: "not-a-number" }, [{ long: "--count", value_type: "number" }]),
    ).toEqual({ count: "not-a-number" });

    expect(() =>
      validateLooseCommandOptionsWithFlagDefinitions({}, [{ long: "invalid", short: 1 as never } as never], "todos export"),
    ).not.toThrow();
    expect(() =>
      validateLooseCommandOptionsWithFlagDefinitions({}, [{ short: "-__proto__" } as never], "todos export"),
    ).not.toThrow();
    try {
      validateLooseCommandOptionsWithFlagDefinitions(
        { ghost: true },
        [{ long: "invalid", short: "--oops" } as never],
        "todos export",
      );
    } catch (error) {
      expect((error as Error).message).toContain("Unknown option '--ghost' for extension command 'todos export'.");
      expect((error as Error).message).not.toContain("Expected one of:");
    }

    expect(stripLooseCommandOptionTokens(["--unknown", "value", "positional"], [{ long: "--known", value_type: "string" }])).toEqual([
      "--unknown",
      "value",
      "positional",
    ]);
  });
});
