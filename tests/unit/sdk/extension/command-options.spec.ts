/**
 * pm-gh1665: the shared extension option normalizer that CLI dispatch,
 * `PmClient.run`, MCP, and the test harness all route through.
 */
import { describe, expect, it } from "vitest";
import {
  coerceLooseCommandOptionsWithFlagDefinitions,
  collectExtensionFlagDefinitionsForCommand,
  normalizeDirectExtensionCommandOptions,
  refuseConflictingArgvOptionSpellings,
  resolveExtensionFlagOptionKey,
} from "../../../../src/sdk/extension/command-options.js";
import { PmCliError } from "../../../../src/sdk/runtime-primitives.js";

describe("direct extension command options", () => {
  it("returns the handler key every caller passes for a declaration", () => {
    expect(resolveExtensionFlagOptionKey({ long: "--status-filter" })).toBe("statusFilter");
    expect(resolveExtensionFlagOptionKey({ long: "--include_history" })).toBe("include_history");
    expect(resolveExtensionFlagOptionKey({ short: "-s" })).toBe("s");
    expect(resolveExtensionFlagOptionKey({})).toBeNull();
  });

  it("folds declared spellings into the handler key, applies defaults and coercion, and passes undeclared keys through", () => {
    const definitions = [
      { long: "--status-filter", short: "-s", value_type: "string", default: "open" },
      { long: "--limit", value_type: "number" },
      // A declaration without a long or short spelling names no handler key and is skipped.
      { description: "label only" },
      // A later declaration reusing a short spelling cannot steal it from the first owner.
      { long: "--silent", short: "-s", value_type: "boolean" },
    ];
    expect(
      normalizeDirectExtensionCommandOptions(
        { "status-filter": "closed", "--limit": "5", extra: true, ignored: undefined },
        definitions,
        "demo brief",
      ),
    ).toEqual({ statusFilter: "closed", limit: 5, extra: true, ignored: undefined });
    expect(normalizeDirectExtensionCommandOptions({ s: "done" }, definitions, "demo brief")).toEqual({ statusFilter: "done" });
    // An explicit undefined counts as omitted, so the declared default applies.
    expect(normalizeDirectExtensionCommandOptions({ statusFilter: undefined }, definitions, "demo brief")).toEqual({ statusFilter: "open" });
    // Equal values under two spellings fold silently.
    expect(
      normalizeDirectExtensionCommandOptions({ statusFilter: ["a"], "status-filter": ["a"] }, definitions, "demo brief"),
    ).toEqual({ statusFilter: ["a"] });
    const options = { statusFilter: "closed" };
    expect(normalizeDirectExtensionCommandOptions(options, [], "demo brief")).toBe(options);
  });

  it("keeps short aliases case-sensitive, like Commander on the CLI (Codex review round 3)", () => {
    const definitions = [
      { long: "--small", short: "-s", value_type: "string" },
      { long: "--sort-order", short: "-S", value_type: "string" },
    ];
    expect(normalizeDirectExtensionCommandOptions({ S: "descending" }, definitions, "demo brief")).toEqual({ sortOrder: "descending" });
    expect(normalizeDirectExtensionCommandOptions({ s: "x", "-S": "y" }, definitions, "demo brief")).toEqual({ small: "x", sortOrder: "y" });
    // A lower-cased short alias never absorbs an independent flag whose own key it matches (Codex review round 4).
    const independent = [
      { long: "--sort-order", short: "-S", value_type: "string" },
      { long: "--s", value_type: "string" },
    ];
    expect(normalizeDirectExtensionCommandOptions({ s: "lower", sortOrder: "upper" }, independent, "demo brief")).toEqual({
      s: "lower",
      sortOrder: "upper",
    });
    expect(coerceLooseCommandOptionsWithFlagDefinitions({ s: "lower", sortOrder: "upper" }, independent)).toEqual({
      s: "lower",
      sortOrder: "upper",
    });
    // An undeclared key equal to a lower-cased short alias passes through untouched (Greptile review).
    const onlyUpper = [{ long: "--sort-order", short: "-S", value_type: "string" }];
    expect(normalizeDirectExtensionCommandOptions({ s: "keep", sortOrder: "descending" }, onlyUpper, "demo brief")).toEqual({
      s: "keep",
      sortOrder: "descending",
    });
    expect(normalizeDirectExtensionCommandOptions({ s: "keep" }, onlyUpper, "demo brief")).toEqual({ s: "keep" });
  });

  it("binds required and disabled declarations and reads negated boolean spellings on direct calls (CodeRabbit review)", () => {
    const definitions = [
      { long: "--target", value_type: "string", required: true },
      { long: "--legacy", value_type: "string", enabled: false },
      { long: "--verbose", value_type: "boolean", default: true },
    ];
    expect(() => normalizeDirectExtensionCommandOptions({}, definitions, "demo brief")).toThrow(
      "Missing required option '--target' for extension command 'demo brief'",
    );
    expect(() => normalizeDirectExtensionCommandOptions({ target: "a", legacy: "x" }, definitions, "demo brief")).toThrow(
      "Option '--legacy' is disabled for extension command 'demo brief'",
    );
    expect(normalizeDirectExtensionCommandOptions({ target: "a", "--no-verbose": true }, definitions, "demo brief")).toEqual({
      target: "a",
      verbose: false,
    });
    expect(normalizeDirectExtensionCommandOptions({ target: "a", "no-verbose": "false" }, definitions, "demo brief")).toEqual({
      target: "a",
      verbose: true,
    });
    // A disabled flag's short alias never refuses an independent enabled flag's key (Greptile review).
    const shadowed = [
      { long: "--sort-order", short: "-S", value_type: "string", enabled: false },
      { long: "--s", value_type: "string" },
      { long: "--optional-off", value_type: "string", required: true, enabled: false },
    ];
    expect(normalizeDirectExtensionCommandOptions({ s: "keep" }, shadowed, "demo brief")).toEqual({ s: "keep" });
    // A negated spelling of a non-boolean, or of nothing declared, passes through unchanged.
    expect(normalizeDirectExtensionCommandOptions({ target: "a", "no-target": true, "no-such": 1 }, definitions, "demo brief")).toEqual({
      target: "a",
      verbose: true,
      "no-target": true,
      "no-such": 1,
    });
    // A flag that is itself declared with a no- prefix keeps its own key.
    expect(
      normalizeDirectExtensionCommandOptions({ "--no-cache": true }, [{ long: "--no-cache", value_type: "boolean" }], "demo brief"),
    ).toEqual({ noCache: true });
  });

  it("refuses two spellings of one flag that carry different values", () => {
    let refusal: unknown;
    try {
      normalizeDirectExtensionCommandOptions(
        { statusFilter: "closed", "status-filter": "open" },
        [{ long: "--status-filter", value_type: "string" }],
        "demo brief",
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(PmCliError);
    expect(refusal).toMatchObject({
      exitCode: 2,
      message: "Options 'statusFilter' and 'status-filter' both set --status-filter for extension command 'demo brief' with different values.",
      context: expect.objectContaining({
        code: "extension_option_spelling_conflict",
        required: "Pass --status-filter once, under the handler key 'statusFilter'.",
      }),
    });
  });

  it("refuses a malformed strict boolean from a direct caller instead of reading it as a switch (Codex review)", () => {
    const definitions = [
      { long: "--commit", value_type: "boolean", value_validation: "strict" },
      { long: "--toggles", value_type: "boolean", list: true, repeatable: true, value_validation: "strict" },
    ];
    // A direct value is explicit, like --commit=value, so no positional fallback applies.
    expect(() => normalizeDirectExtensionCommandOptions({ commit: "nonsense" }, definitions, "demo brief")).toThrow(
      "Option '--commit' for extension command 'demo brief' expects true, false, 1, or 0",
    );
    expect(() => normalizeDirectExtensionCommandOptions({ toggles: [true, "maybe"] }, definitions, "demo brief")).toThrow(
      'received "maybe"',
    );
    expect(normalizeDirectExtensionCommandOptions({ commit: "true", toggles: [true, "false"] }, definitions, "demo brief")).toEqual({
      commit: true,
      toggles: [true, false],
    });
    // Nested list values flatten like the list coercer before each entry is validated (Codex review round 2).
    expect(normalizeDirectExtensionCommandOptions({ toggles: [[true, "false"]] }, definitions, "demo brief")).toEqual({
      toggles: [true, false],
    });
    // The compatible coerce policy still forwards an unrecognized token for the handler to judge.
    expect(
      normalizeDirectExtensionCommandOptions({ commit: "nonsense" }, [{ long: "--commit", value_type: "boolean" }], "demo brief"),
    ).toEqual({ commit: "nonsense" });
  });

  it("joins flag registrations by command operation", () => {
    const registrations = {
      flags: [
        { target_command: "  Demo   Brief ", flags: [{ long: "--a" }] },
        { target_command: "demo other", flags: [{ long: "--b" }] },
        { target_command: "demo brief", flags: [{ long: "--c" }] },
      ],
    };
    expect(collectExtensionFlagDefinitionsForCommand(registrations, "demo brief")).toEqual([{ long: "--a" }, { long: "--c" }]);
    expect(collectExtensionFlagDefinitionsForCommand(registrations, "   ")).toEqual([]);
  });
});

describe("pm-wlxf8f argv spelling conflicts", () => {
  const definitions = [
    { long: "--status-filter", short: "-s", value_type: "string" },
    { long: "--count", short: "-c", value_type: "number" },
    { long: "--verbose", short: "-v", value_type: "boolean" },
    { long: "--level [value]", short: "-l", value_type: "string" },
    { long: "--tags", short: "-t", value_type: "string", list: true },
    // A declaration without a spelling, and a short spelling a later flag cannot steal.
    { description: "label only" },
    { long: "--silent", short: "-s", value_type: "boolean" },
  ];
  const refuse = (tokens: string[], arityOf?: (spelling: string) => "required" | "optional" | "none" | undefined) =>
    () => refuseConflictingArgvOptionSpellings(tokens, definitions, "demo", arityOf);

  it("refuses two spellings of one scalar flag with different values, in every attached form", () => {
    for (const tokens of [
      ["--status-filter", "open", "-s", "closed"],
      ["--status-filter=open", "-sclosed"],
      ["-s", "open", "--status-filter", "open", "-s", "closed"],
      ["--count", "1", "-c", "2"],
    ]) {
      expect(refuse(tokens)).toThrowError(PmCliError);
    }
    expect(refuse(["--status-filter", "open", "-s", "closed"])).toThrow(
      "Options '--status-filter' and '-s' both set --status-filter for extension command 'demo' with different values.",
    );
    try {
      refuse(["-c", "1", "--count", "2"])();
    } catch (error) {
      expect((error as PmCliError).context).toMatchObject({ code: "extension_option_spelling_conflict", required: "Pass --count once, under the handler key 'count'." });
    }
  });

  it("accepts equal values after coercion, repeats of one spelling, list flags and switch presence", () => {
    for (const tokens of [
      ["--status-filter", "open", "-s", "open"],
      ["--count", "1", "-c", "1.0"],
      ["--status-filter", "a", "--status-filter", "b"],
      ["--tags", "a", "-t", "b"],
      // A switch keeps presence semantics: the following operand stays positional.
      ["-v", "positional", "--verbose"],
      // An optional value is not read from a following option token.
      ["--level", "-l"],
      ["--level", "high", "-l", "high"],
      // Tokens after `--` are operands, and unknown spellings are skipped.
      ["--status-filter", "open", "--", "-s", "closed"],
      ["--bogus", "-s", "open", "-x"],
      // A switch with an attached suffix is not a recognized option.
      ["--verbose=yes", "-vx", "--verbose"],
    ]) {
      expect(refuse(tokens)).not.toThrow();
    }
    expect(refuseConflictingArgvOptionSpellings([], [], "demo")).toBeUndefined();
  });

  it("reads another option's value through the command's arity table instead of as a flag", () => {
    // `--title` takes a value, so `-s` is its value, not a second spelling of --status-filter.
    const arity = (spelling: string) => (spelling === "--title" ? "required" : undefined);
    expect(refuse(["--status-filter", "open", "--title", "-s", "closed"], arity)).not.toThrow();
    expect(refuse(["--status-filter", "open", "--title", "-s", "closed"])).toThrow();
    // A value-taking option at the end of argv has no value to consume.
    expect(refuse(["--status-filter", "open", "-s"])).toThrow();
  });
});
