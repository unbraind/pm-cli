import { describe, expect, it } from "vitest";
import {
  coerceLooseCommandOptionsWithFlagDefinitions,
  collectLoosePositionalArgs,
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
    });
    // The permissive loose parser retains a usable short alias when a legacy
    // descriptor has no valid long spelling; registration validates separately.
    expect(coerceLooseCommandOptionsWithFlagDefinitions({ r: "4" }, [
      { long: " invalid ", short: "-r", value_type: "number" },
    ])).toEqual({ r: 4 });
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
    // The malformed entry contributes no keys/labels, so validation still runs
    // and an unknown option is rejected without an "Expected one of" suffix.
    expect(() =>
      validateLooseCommandOptionsWithFlagDefinitions({ ghost: true }, [{ long: "bad", short: "--oops" } as never], "todos export"),
    ).toThrowError(/^Unknown option '--ghost' for extension command 'todos export'\.$/);

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
    // A non-string short is dropped entirely: no keys, no labels, no suffix.
    expect(() =>
      validateLooseCommandOptionsWithFlagDefinitions({ ghost: true }, [{ long: "invalid", short: 1 as never } as never], "todos export"),
    ).toThrowError(/^Unknown option '--ghost' for extension command 'todos export'\.$/);
    expect(() =>
      validateLooseCommandOptionsWithFlagDefinitions({}, [{ short: "-__proto__" } as never], "todos export"),
    ).not.toThrow();
    // The unsafe short key is never allowed as an option key, but its literal
    // short flag still surfaces as the expected label in the guidance suffix.
    expect(() =>
      validateLooseCommandOptionsWithFlagDefinitions({ ghost: true }, [{ short: "-__proto__" } as never], "todos export"),
    ).toThrowError("Unknown option '--ghost' for extension command 'todos export'. Expected one of: -__proto__.");
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

  it("collects only positional operands, skipping option tokens and their values", () => {
    // A bare operand with no flags is a positional.
    expect(collectLoosePositionalArgs(["todos.md"])).toEqual(["todos.md"]);
    // `--flag value`, `--flag=value`, and `-f value` consume their value; the
    // trailing operand remains positional.
    expect(collectLoosePositionalArgs(["--file", "path", "extra"])).toEqual(["extra"]);
    expect(collectLoosePositionalArgs(["--file=path", "extra"])).toEqual(["extra"]);
    expect(collectLoosePositionalArgs(["-f", "path", "extra"])).toEqual(["extra"]);
    // A flag with no following value is a boolean option (consumes nothing else).
    expect(collectLoosePositionalArgs(["--dry-run"])).toEqual([]);
    // Everything after a bare `--` separator is positional.
    expect(collectLoosePositionalArgs(["--file", "path", "--", "--looks-like-flag", "x"])).toEqual(["--looks-like-flag", "x"]);
    // No operands at all.
    expect(collectLoosePositionalArgs(["--file", "path"])).toEqual([]);
  });

  describe("strict scalar value validation (pm-extension-scalar-validation)", () => {
    const definitions = [
      { long: "--limit", short: "-l", value_type: "number", value_validation: "strict" },
      { long: "--enabled", type: "bool", value_validation: "strict" },
      { long: "--verbose", value_type: "boolean", value_validation: "strict" },
      { long: "--ratio", value_type: "number" },
      { long: "--ids", value_type: "number", list: true, value_validation: "strict" },
      { long: "--ports", value_type: "number", list: true, repeatable: true, value_validation: "strict" },
    ];

    function coerce(args: string[]): Record<string, unknown> {
      const parsed = parseLooseCommandOptions(args);
      return coerceLooseCommandOptionsWithFlagDefinitions(parsed, definitions, parsed, "acme echo");
    }

    it("keeps valid coercions, defaults, switch presence, and the legacy bool grammar", () => {
      expect(coerce(["--limit", "5", "--enabled", "true", "--verbose", "--ratio", "abc", "--ids", "1,2"])).toEqual({
        limit: 5,
        enabled: true,
        verbose: true,
        ratio: "abc",
        ids: [1, 2],
      });
      expect(coerce(["--enabled"])).toEqual({ enabled: true });
      expect(coerce(["--no-verbose"])).toEqual({ verbose: false });
      // A boolean switch followed by a positional keeps its presence semantics.
      expect(coerce(["--verbose", "artifact-A"])).toEqual({ verbose: true });
      expect(coerce(["--ids", "7"])).toEqual({ ids: [7] });
      // A valid alias value still yields to the canonical spelling.
      expect(coerce(["--limit", "5", "-l", "7"])).toEqual({ limit: 5 });
      // An attached boolean literal on a switch is accepted; repeatable entries keep their order.
      expect(coerce(["--verbose=false", "--ports", "8080", "--ports=9090"])).toEqual({ verbose: false, ports: [8080, 9090] });
    });

    it("refuses malformed number and boolean tokens before dispatch with a typed usage error", () => {
      for (const [args, fragment] of [
        [["--limit", "abc"], "Option '--limit' for extension command 'acme echo' expects a finite number; received \"abc\"."],
        [["--limit"], "received no value"],
        [["--enabled", "not-a-boolean"], "expects true, false, 1, or 0; received \"not-a-boolean\""],
        [["--ids", "1,x"], "expects a finite number; received \"x\""],
        // A malformed alias value is refused even though the canonical value would win the merge.
        [["--limit", "5", "-l", "junk"], "expects a finite number; received \"junk\""],
        // An attached non-boolean token on a switch is malformed, unlike a following positional.
        [["--verbose=maybe"], "expects true, false, 1, or 0; received \"maybe\""],
        // An explicitly empty list entry is refused before normalization drops it.
        [["--ids="], "expects a finite number; received \"\""],
        [["--ports", "1", "--ports="], "expects a finite number; received \"\""],
      ] as const) {
        try {
          coerce([...args]);
          throw new Error("Expected a strict scalar refusal for " + args.join(" "));
        } catch (error) {
          expect(error).toBeInstanceOf(PmCliError);
          expect(error).toMatchObject({
            exitCode: EXIT_CODE.USAGE,
            context: { code: "extension_flag_value_invalid" },
            message: expect.stringContaining(fragment),
          });
        }
      }
      // Without strict validation the historical passthrough is unchanged.
      const parsed = parseLooseCommandOptions(["--ratio", "abc", "--limit", "abc"]);
      expect(coerceLooseCommandOptionsWithFlagDefinitions(parsed, [{ long: "--ratio", value_type: "number" }, { long: "--limit", value_type: "number", value_validation: "coerce" }])).toEqual({ ratio: "abc", limit: "abc" });
      // Without a command path the message still names the flag.
      const bare = parseLooseCommandOptions(["--limit", "abc"]);
      expect(() => coerceLooseCommandOptionsWithFlagDefinitions(bare, definitions)).toThrow("Option '--limit' expects a finite number");
    });

    it("treats a legacy type:boolean switch as presence and never validates string kinds", () => {
      const legacy = parseLooseCommandOptions(["--legacy-switch", "artifact-B"]);
      expect(
        coerceLooseCommandOptionsWithFlagDefinitions(legacy, [{ long: "--legacy-switch", type: "boolean", value_validation: "strict" }]),
      ).toEqual({ legacySwitch: true });
      const text = parseLooseCommandOptions(["--name", "anything"]);
      expect(
        coerceLooseCommandOptionsWithFlagDefinitions(text, [{ long: "--name", value_type: "string", value_validation: "strict" }]),
      ).toEqual({ name: "anything" });
    });
  });
});
