/**
 * pm-gh1665: the shared extension option normalizer that CLI dispatch,
 * `PmClient.run`, MCP, and the test harness all route through.
 */
import { describe, expect, it } from "vitest";
import {
  coerceLooseCommandOptionsWithFlagDefinitions,
  collectExtensionFlagDefinitionsForCommand,
  normalizeDirectExtensionCommandOptions,
  type ArgvOptionScope,
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
    { long: "--debug", short: "-d", type: "bool" },
    // A declaration without a spelling, and a short spelling a later flag cannot steal.
    { description: "label only" },
    { long: "--silent", short: "-s", value_type: "boolean" },
  ];
  /** Commander registrations matching the declarations, as applyDynamicExtensionFlagOptions makes them. */
  const REGISTERED = new Map<string, { arity: "required" | "optional" | "none"; key: string }>([
    ["--status-filter", { arity: "required", key: "statusFilter" }],
    ["-s", { arity: "required", key: "statusFilter" }],
    ["--count", { arity: "required", key: "count" }],
    ["-c", { arity: "required", key: "count" }],
    ["--verbose", { arity: "none", key: "verbose" }],
    ["-v", { arity: "none", key: "verbose" }],
    ["--level", { arity: "optional", key: "level" }],
    ["-l", { arity: "optional", key: "level" }],
    ["--tags", { arity: "required", key: "tags" }],
    ["-t", { arity: "required", key: "tags" }],
    ["--debug", { arity: "optional", key: "debug" }],
    ["-d", { arity: "optional", key: "debug" }],
  ]);
  /** A leaf scope whose declared flags Commander registered. */
  const commander = (tokens: string[], overrides: Partial<ArgvOptionScope> = {}): ArgvOptionScope => ({
    tokens,
    optionOf: (spelling) => REGISTERED.get(spelling),
    includesLooseFlags: true,
    negativeNumbersAreValues: true,
    ...overrides,
  });
  /** A leaf scope whose declared flags Commander did not register, read by the loose parser. */
  const loose = (tokens: string[]): ArgvOptionScope => commander(tokens, { optionOf: () => undefined });
  const refuse = (...scopes: ArgvOptionScope[]) => () => refuseConflictingArgvOptionSpellings(scopes, definitions, "demo");

  it("refuses two spellings of one scalar flag with different values, in every attached and grouped form", () => {
    for (const tokens of [
      ["--status-filter", "open", "-s", "closed"],
      ["--status-filter=open", "-sclosed"],
      ["-s", "open", "--status-filter", "open", "-s", "closed"],
      ["--count", "1", "-c", "2"],
      // Short groups: switches continue the group and a value-taking letter takes the next token.
      ["--status-filter", "open", "-vs", "closed"],
      // The loose parser delivers --switch=<literal> and --no-<flag> to a declared boolean, optional bool too.
      ["--verbose=false", "-v"],
      ["--no-verbose", "-v"],
      ["--no-debug", "-d", "true"],
    ]) {
      expect(refuse(commander(tokens))).toThrowError(PmCliError);
    }
    expect(refuse(commander(["--status-filter", "open", "-s", "closed"]))).toThrow(
      "Options '--status-filter' and '-s' both set --status-filter for extension command 'demo' with different values.",
    );
    try {
      refuse(commander(["-c", "1", "--count", "2"]))();
    } catch (error) {
      expect((error as PmCliError).context).toMatchObject({ code: "extension_option_spelling_conflict", required: "Pass --count once, under the handler key 'count'." });
    }
  });

  it("accepts equal values after coercion, repeats of one spelling, list flags and Commander's value rules", () => {
    for (const tokens of [
      ["--status-filter", "open", "-s", "open"],
      ["--count", "1", "-c", "1.0"],
      ["--status-filter", "a", "--status-filter", "b"],
      ["--tags", "a", "-t", "b"],
      // A switch keeps presence semantics: the following operand stays positional.
      ["-v", "positional", "--verbose"],
      // An optional value is not read from a following option token, but a negative number is a value.
      ["--level", "-l"],
      ["--level", "high", "-l", "high"],
      ["--level=-1", "-l", "-1"],
      // Tokens after `--` are operands, and unknown spellings are skipped.
      ["--status-filter", "open", "--", "-s", "closed"],
      ["--bogus", "-s", "open", "-x", "--bogus=1", "--no-bogus", "--verbose=1"],
      // A value-taking letter ends its group: `-vt -s` binds -s as the --tags value.
      ["--status-filter", "open", "-vt", "-s"],
      // A grouped value-taking letter takes the rest of the group.
      ["-vsopen", "--status-filter", "open"],
    ]) {
      expect(refuse(commander(tokens))).not.toThrow();
    }
    expect(refuseConflictingArgvOptionSpellings([], [], "demo")).toBeUndefined();
  });

  it("reads unregistered declared flags with the loose grammar", () => {
    for (const tokens of [
      ["--verbose=false", "-v=false"],
      // No short groups and no dash-leading values: `-vs` is one unknown key, and -s takes no `-x` value.
      ["--status-filter", "open", "-vs", "closed"],
      ["-s", "-x", "--status-filter", "-y"],
      ["--count", "1", "-c", "1"],
      // A loose list flag accumulates.
      ["--tags", "a", "-t", "b"],
    ]) {
      expect(refuse(loose(tokens))).not.toThrow();
    }
    for (const tokens of [["--status-filter", "open", "-s=closed"], ["--no-verbose", "-v"], ["--level", "a", "-l", "b"]]) {
      expect(refuse(loose(tokens))).toThrow();
    }
  });

  it("reads a negative number as an option when the path has a numeric short option", () => {
    expect(refuse(commander(["--level=-1", "-l", "-1"], { negativeNumbersAreValues: false }))).toThrow("both set --level");
  });

  it("compares untyped values as typed", () => {
    const untyped = [{ long: "--mode <value>", short: "-m" }];
    expect(() => refuseConflictingArgvOptionSpellings([loose(["--mode", "a", "-m", "b"])], untyped, "demo")).toThrow("both set --mode");
    expect(() => refuseConflictingArgvOptionSpellings([loose(["--mode", "a", "-m", "a"])], untyped, "demo")).not.toThrow();
  });

  it("follows the command's registered options: their arity, and a core owner of a colliding spelling", () => {
    const withTitle = new Map([...REGISTERED, ["--title", { arity: "required" as const, key: "title" }], ["-r", { arity: "required" as const, key: "reason" }]]);
    const titled = (tokens: string[]) => commander(tokens, { optionOf: (spelling) => withTitle.get(spelling) });
    // `--title` takes a value, so `-s` is its value, not a second spelling of --status-filter.
    expect(refuse(titled(["--status-filter", "open", "--title", "-s", "closed"]))).not.toThrow();
    expect(refuse(commander(["--status-filter", "open", "--title", "-s", "closed"]))).toThrow();
    // A core option keeps -r even though the extension declares it for --status-filter.
    const colliding = [{ long: "--status-filter", short: "-r", value_type: "string" }];
    expect(() => refuseConflictingArgvOptionSpellings([titled(["--status-filter", "open", "-r", "done"])], colliding, "close")).not.toThrow();
    // A value-taking option at the end of argv has no value to consume.
    expect(refuse(commander(["--status-filter", "open", "-s"]))).toThrow();
  });

  it("joins occurrences across the scopes on the dispatch path, honoring each command's stop rule", () => {
    const parentOptions = new Map([
      ["--status-filter", { arity: "required" as const, key: "statusFilter" }],
      ["-s", { arity: "required" as const, key: "statusFilter" }],
    ]);
    const parent = (tokens: string[], stop?: ArgvOptionScope["stop"]) =>
      commander(tokens, { optionOf: (spelling) => parentOptions.get(spelling), includesLooseFlags: false, ...(stop ? { stop } : {}) });
    expect(refuse(parent(["child", "--status-filter", "open", "-s", "closed"]), commander([]))).toThrow("both set --status-filter");
    // An ancestor reads only its own registered options, never the leaf's loose declarations.
    expect(refuse(commander(["--status-filter", "open"], { optionOf: () => undefined, includesLooseFlags: false }), commander(["-s", "closed"]))).not.toThrow();
    // Positional options: the parent stops at its subcommand, so `-s done` after it is the child's own token.
    const positional = { atSubcommand: (token: string) => token === "child", atFirstUnrecognized: false };
    expect(refuse(parent(["--status-filter", "why", "child", "-s", "done"], positional), commander([], { optionOf: () => undefined }))).not.toThrow();
    // ...but only before any other unrecognized token.
    expect(refuse(parent(["--bogus", "child", "--status-filter", "a", "-s", "b"], positional))).toThrow();
    // Pass-through options stop at the first unrecognized token.
    expect(refuse(parent(["--status-filter", "a", "--bogus", "-s", "b"], { atSubcommand: () => false, atFirstUnrecognized: true }))).not.toThrow();
  });
});
