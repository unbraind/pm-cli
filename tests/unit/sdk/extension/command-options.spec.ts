/**
 * pm-gh1665: the shared extension option normalizer that CLI dispatch,
 * `PmClient.run`, MCP, and the test harness all route through.
 */
import { describe, expect, it } from "vitest";
import {
  coerceLooseCommandOptionsWithFlagDefinitions,
  collectExtensionFlagDefinitionsForCommand,
  normalizeDirectExtensionCommandOptions,
  orderArgvRepeatableSwitchOccurrences,
  parseLooseCommandOptions,
  type ArgvOptionScope,
  refuseConflictingArgvOptionSpellings,
  resolveExtensionFlagOptionKey,
  validateLooseCommandOptionsWithFlagDefinitions,
} from "../../../../src/sdk/extension/command-options.js";
import { PmCliError } from "../../../../src/sdk/runtime-primitives.js";

describe("direct extension command options", () => {
  it("returns the handler key every caller passes for a declaration", () => {
    expect(resolveExtensionFlagOptionKey({ long: "--status-filter" })).toBe("statusFilter");
    expect(resolveExtensionFlagOptionKey({ long: "--include_history" })).toBe("include_history");
    expect(resolveExtensionFlagOptionKey({ short: "-s" })).toBe("s");
    expect(resolveExtensionFlagOptionKey({})).toBeNull();
  });

  it("folds declared spellings into the handler key, applies defaults and coercion, and passes host-owned keys through", () => {
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
        { "status-filter": "closed", "--limit": "5", json: true, output_budget: "400", force: false, ignored: undefined },
        definitions,
        "demo brief",
      ),
    ).toEqual({ statusFilter: "closed", limit: 5, json: true, output_budget: "400", force: false, ignored: undefined });
    expect(normalizeDirectExtensionCommandOptions({ s: "done" }, definitions, "demo brief")).toEqual({ statusFilter: "done" });
    // An explicit undefined counts as omitted, so the declared default applies.
    expect(normalizeDirectExtensionCommandOptions({ statusFilter: undefined }, definitions, "demo brief")).toEqual({ statusFilter: "open" });
    // Equal values under two spellings fold silently.
    expect(
      normalizeDirectExtensionCommandOptions({ statusFilter: "a", "status-filter": "a" }, definitions, "demo brief"),
    ).toEqual({ statusFilter: "a" });
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
    // An undeclared key equal to a lower-cased short alias is never folded into that flag (Greptile review);
    // like `-s` on the CLI, it is an unknown option (pm-gh1727).
    const onlyUpper = [{ long: "--sort-order", short: "-S", value_type: "string" }];
    for (const options of [{ s: "keep", sortOrder: "descending" }, { s: "keep" }]) {
      expect(() => normalizeDirectExtensionCommandOptions(options, onlyUpper, "demo brief")).toThrow(
        "Unknown option 's' for extension command 'demo brief'. Expected one of: --sort-order.",
      );
    }
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
    // A negated spelling of a non-boolean, or of nothing declared, is not folded; it is an unknown option.
    for (const [spelling, flag] of [["no-target", "--no-target"], ["no-such", "--no-such"]]) {
      expect(() => normalizeDirectExtensionCommandOptions({ target: "a", [spelling]: 1 }, definitions, "demo brief")).toThrow(
        expect.objectContaining({ context: expect.objectContaining({ code: "unknown_option", flag }) }),
      );
    }
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
      // The loose parser takes a following non-dash token even for a switch.
      ["--verbose", "false", "-v=false"],
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

  it("records unparsed boolean forms only in the leaf, and keeps a variadic option's operands from stopping the scan", () => {
    const parentOptions = new Map([
      ["--verbose", { arity: "none" as const, key: "verbose" }],
      ["-v", { arity: "none" as const, key: "verbose" }],
    ]);
    const childOptions = new Map([...parentOptions, ["--title", { arity: "required" as const, key: "title" }]]);
    // The parent consumes -v and forwards `--title --verbose=false`; the child reads --verbose=false as the title.
    const parent = commander(["child", "--title", "--verbose=false", "-v"], { optionOf: (spelling) => parentOptions.get(spelling), includesLooseFlags: false });
    const child = commander(["--title", "--verbose=false"], { optionOf: (spelling) => childOptions.get(spelling) });
    expect(refuse(parent, child)).not.toThrow();

    const sectioned = new Map([...REGISTERED, ["--section", { arity: "required" as const, key: "section", variadic: true }]]);
    const stop = { atSubcommand: (token: string) => token === "tests", atFirstUnrecognized: false };
    const context = (tokens: string[]) => commander(tokens, { optionOf: (spelling) => sectioned.get(spelling), stop });
    expect(refuse(context(["--section", "hierarchy", "tests", "--status-filter", "open", "-s", "closed"]))).toThrow("both set --status-filter");
    expect(refuse(context(["--section", "hierarchy", "-1", "--status-filter", "open", "-s", "open"]))).not.toThrow();
    // Without the variadic option, `tests` is the subcommand that ends the scope.
    expect(refuse(context(["tests", "--status-filter", "open", "-s", "closed"]))).not.toThrow();
  });

  it("reads a registered --no-<flag> as false for the declared boolean on the same attribute", () => {
    const negatable = new Map([...REGISTERED, ["--no-verbose", { arity: "none" as const, key: "verbose" }], ["--no-count", { arity: "none" as const, key: "count" }], ["--no-color", { arity: "none" as const, key: "color" }]]);
    const scope = (tokens: string[]) => commander(tokens, { optionOf: (spelling) => negatable.get(spelling) });
    expect(refuse(scope(["-v", "--no-verbose"]))).toThrow("Options '-v' and '--no-verbose' both set --verbose");
    expect(refuse(scope(["--no-verbose", "--verbose=false"]))).not.toThrow();
    // A negation of a non-boolean, or of an undeclared flag, sets nothing declared.
    expect(refuse(scope(["--count", "1", "--no-count", "--no-color"]))).not.toThrow();
  });

  it("joins occurrences across the scopes on the dispatch path, honoring each command's stop rule", () => {
    const parentOptions = new Map([
      ["--status-filter", { arity: "required" as const, key: "statusFilter" }],
      ["-s", { arity: "required" as const, key: "statusFilter" }],
    ]);
    const parent = (tokens: string[], stop?: ArgvOptionScope["stop"]) =>
      commander(tokens, { optionOf: (spelling) => parentOptions.get(spelling), includesLooseFlags: false, ...(stop ? { stop } : {}) });
    expect(refuse(parent(["child", "--status-filter", "open", "-s", "closed"]), commander([]))).toThrow("both set --status-filter");
    // A registered `--long=value` the parent consumed is recorded too (Greptile review): only unparsed forms are leaf-only.
    expect(refuse(parent(["--status-filter=open", "child"]), commander(["-s", "closed"]))).toThrow("both set --status-filter");
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

describe("pm-gh1726 / pm-gh1727 direct-caller refusals carry the CLI codes", () => {
  const definitions = [
    { long: "--target", value_type: "string", required: true },
    { long: "--confirm", value_type: "boolean", required: true },
    { long: "--legacy", value_type: "string", enabled: false },
    { long: "--ids", value_type: "string", list: true },
    { long: "--labels", value_type: "string", list: true, required: true },
  ];
  const refusal = (run: () => unknown): Record<string, unknown> => {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(PmCliError);
      return { message: (error as PmCliError).message, exitCode: (error as PmCliError).exitCode, ...(error as PmCliError).context };
    }
    throw new Error("Expected a refusal");
  };
  const direct = (options: Record<string, unknown>) => () => normalizeDirectExtensionCommandOptions(options, definitions, "demo brief");
  const valid = { target: "a", confirm: true, labels: ["x"] };

  it("names the missing flag, its handler key and a retry; a required switch has no value placeholder", () => {
    expect(refusal(direct({ confirm: true, labels: ["x"] }))).toMatchObject({
      exitCode: 2,
      code: "missing_required_option",
      flag: "--target",
      field: "target",
      required: "Pass --target <value>.",
      examples: ["pm demo brief --target <value>"],
      recovery: { missing: ["--target"] },
    });
    expect(refusal(direct({ target: "a", labels: ["x"] }))).toMatchObject({ code: "missing_required_option", required: "Pass --confirm.", examples: ["pm demo brief --confirm"] });
    // A required list given no entries is zero occurrences, exactly as omitting the flag on the CLI,
    // including entries that normalization drops (Greptile review).
    for (const labels of [[], [""], [[]], ["", [""]]]) {
      expect(refusal(direct({ ...valid, labels }))).toMatchObject({ code: "missing_required_option", field: "labels" });
    }
    expect(refusal(() => validateLooseCommandOptionsWithFlagDefinitions({ target: "a", confirm: true, labels: "" }, definitions, "demo brief"))).toMatchObject({
      code: "missing_required_option",
      field: "labels",
    });
    // The CLI validator reports the same code for argv.
    expect(refusal(() => validateLooseCommandOptionsWithFlagDefinitions({ confirm: true, labels: "x" }, definitions, "demo brief"))).toMatchObject({
      code: "missing_required_option",
      field: "target",
    });
  });

  it("refuses a disabled flag and an undeclared key before the handler, on both validators", () => {
    expect(refusal(direct({ ...valid, legacy: "v" }))).toMatchObject({ code: "extension_option_disabled", flag: "--legacy", examples: ["pm demo brief --help"] });
    expect(refusal(() => validateLooseCommandOptionsWithFlagDefinitions({ ...valid, legacy: "v" }, definitions, "demo brief"))).toMatchObject({
      code: "extension_option_disabled",
    });
    expect(refusal(direct({ ...valid, Typo_Key: 1 }))).toMatchObject({
      code: "unknown_option",
      flag: "--typo-key",
      message: "Unknown option 'Typo_Key' for extension command 'demo brief'. Expected one of: --target, --confirm, --legacy, --ids, --labels.",
    });
    expect(refusal(direct({ ...valid, "--typo": 1 }))).toMatchObject({ code: "unknown_option", flag: "--typo" });
    // An explicit undefined under any key is an omission, never an unknown option.
    expect(normalizeDirectExtensionCommandOptions({ ...valid, typo: undefined }, definitions, "demo brief")).toEqual({ ...valid, typo: undefined });
  });

  it("refuses an array for a single-value flag and keeps list arrays, including an empty optional list", () => {
    for (const target of [[], ["a"], ["a", "b"]]) {
      expect(refusal(direct({ ...valid, target }))).toMatchObject({
        code: "extension_flag_value_invalid",
        flag: "--target",
        message: "Option '--target' for extension command 'demo brief' takes one value; received an array.",
      });
    }
    expect(normalizeDirectExtensionCommandOptions({ ...valid, ids: [] }, definitions, "demo brief")).toMatchObject({ ids: [] });
    expect(normalizeDirectExtensionCommandOptions({ ...valid, ids: ["a", "b"] }, definitions, "demo brief")).toMatchObject({ ids: ["a", "b"] });
    // A negated spelling of a declared boolean that carries a value it cannot invert is a value error (CodeRabbit review).
    const on = [{ long: "--on", value_type: "boolean", value_validation: "strict" }];
    for (const [spelling, value] of [["no-on", []], ["--no-on", "bogus"], ["no-on", [true]]] as const) {
      expect(refusal(() => normalizeDirectExtensionCommandOptions({ [spelling]: value }, on, "demo brief"))).toMatchObject({
        code: "extension_flag_value_invalid",
        flag: "--on",
      });
    }
    expect(normalizeDirectExtensionCommandOptions({ "no-on": undefined }, on, "demo brief")).toEqual({});
    expect(normalizeDirectExtensionCommandOptions({ "no-on": true }, on, "demo brief")).toEqual({ on: false });
    // A repeatable boolean inverts entry by entry, like --no-many --no-many on the CLI (Codex review round 10).
    const many = [{ long: "--many", value_type: "boolean", value_validation: "strict", repeatable: true }];
    expect(normalizeDirectExtensionCommandOptions({ "no-many": [true, "true"] }, many, "demo brief")).toEqual({ many: [false, false] });
    expect(normalizeDirectExtensionCommandOptions({ "no-many": [] }, many, "demo brief")).toEqual({ many: [] });
    expect(normalizeDirectExtensionCommandOptions({ "no-many": true }, many, "demo brief")).toEqual({ many: [false] });
    expect(refusal(() => normalizeDirectExtensionCommandOptions({ "no-many": [true, "bogus"] }, many, "demo brief"))).toMatchObject({
      code: "extension_flag_value_invalid",
      flag: "--many",
    });
    // A CSV list inverts a comma-delimited value segment by segment, as its canonical spelling splits it (CodeRabbit
    // review), while keeping the raw shape so the canonical pipeline still judges it (Codex review round 13).
    const listed = [{ long: "--many", value_type: "boolean", value_validation: "strict", list: true }];
    const loose = [{ long: "--many", value_type: "boolean", list: true }];
    expect(normalizeDirectExtensionCommandOptions({ many: "true,false" }, listed, "demo brief")).toEqual({ many: [true, false] });
    expect(normalizeDirectExtensionCommandOptions({ "no-many": "true,false" }, listed, "demo brief")).toEqual({ many: [false, true] });
    expect(normalizeDirectExtensionCommandOptions({ "no-many": " true , false" }, listed, "demo brief")).toEqual({ many: [false, true] });
    expect(normalizeDirectExtensionCommandOptions({ "no-many": ["true,false", true] }, listed, "demo brief")).toEqual({ many: [false, true, false] });
    expect(normalizeDirectExtensionCommandOptions({ "no-many": "true" }, listed, "demo brief")).toEqual({ many: [false] });
    expect(normalizeDirectExtensionCommandOptions({ "no-many": undefined }, listed, "demo brief")).toEqual({});
    // A blank strict segment is refused under either spelling; a coerce list drops it under either spelling.
    for (const options of [{ many: "true,,false" }, { "no-many": "true,,false" }, { "no-many": ["true, ,false"] }, { "no-many": "" }, { "no-many": [""] }]) {
      expect(refusal(() => normalizeDirectExtensionCommandOptions(options, listed, "demo brief"))).toMatchObject({
        code: "extension_flag_value_invalid",
        flag: "--many",
      });
    }
    expect(normalizeDirectExtensionCommandOptions({ many: "true,,false" }, loose, "demo brief")).toEqual({ many: [true, false] });
    expect(normalizeDirectExtensionCommandOptions({ "no-many": "true,,false" }, loose, "demo brief")).toEqual({ many: [false, true] });
    for (const blank of ["", [""], ",", null, [null, undefined]]) {
      expect(normalizeDirectExtensionCommandOptions({ "no-many": blank }, loose, "demo brief")).toEqual({ many: [] });
      expect(normalizeDirectExtensionCommandOptions({ many: blank }, loose, "demo brief")).toEqual({ many: [] });
    }
    // Nullish entries are dropped under either spelling, and an all-nullish required list is missing (Codex review round 14).
    expect(normalizeDirectExtensionCommandOptions({ many: [false, null] }, listed, "demo brief")).toEqual({ many: [false] });
    expect(normalizeDirectExtensionCommandOptions({ "no-many": [true, null, undefined] }, listed, "demo brief")).toEqual({ many: [false] });
    const requiredListed = [{ ...listed[0], required: true }];
    for (const options of [{ many: [null] }, { "no-many": [null] }, { "no-many": null }]) {
      expect(refusal(() => normalizeDirectExtensionCommandOptions(options, requiredListed, "demo brief"))).toMatchObject({
        code: "missing_required_option",
        flag: "--many",
      });
    }
    // Equivalent scalar spellings of one list or repeatable flag stay equivalent, not a spelling conflict.
    for (const definitions of [listed, many]) {
      expect(normalizeDirectExtensionCommandOptions({ many: false, "no-many": true }, definitions, "demo brief")).toEqual({ many: [false] });
      expect(normalizeDirectExtensionCommandOptions({ many: true, "no-many": false }, definitions, "demo brief")).toEqual({ many: [true] });
    }
    // Spellings compare by the value each would deliver alone (Greptile review), so equivalent shapes are one value...
    for (const [options, expected] of [
      [{ many: [false], "no-many": true }, [false]],
      [{ many: [false], "--many": false }, [false]],
      [{ many: [false, true], "no-many": "true,false" }, [false, true]],
      [{ many: ["false", " true"], "--many": [false, true, null] }, [false, true]],
    ] as const) {
      expect(normalizeDirectExtensionCommandOptions(options, listed, "demo brief")).toEqual({ many: expected });
    }
    expect(normalizeDirectExtensionCommandOptions({ many: [false], "no-many": [true] }, many, "demo brief")).toEqual({ many: [false] });
    // ...while different delivered values still conflict.
    for (const options of [{ many: [false], "no-many": false }, { many: [false, true], "--many": [true, false] }]) {
      expect(refusal(() => normalizeDirectExtensionCommandOptions(options, listed, "demo brief"))).toMatchObject({
        code: "extension_option_spelling_conflict",
      });
    }
    // Each spelling is validated before either is discarded, in either order, so a second spelling never masks the
    // refusal it would get alone (Codex review round 16).
    const strictMany = [{ long: "--many", value_type: "boolean", value_validation: "strict", repeatable: true }];
    for (const [options, definitions] of [
      [{ many: [true], "--many": ["bogus"] }, listed],
      [{ "--many": ["bogus"], many: [true] }, listed],
      [{ many: [true, false], "--many": "true,,false" }, listed],
      [{ many: [true], "--many": [true, null] }, strictMany],
      [{ "--many": [true, null], many: [true] }, strictMany],
    ] as const) {
      expect(refusal(() => normalizeDirectExtensionCommandOptions(options, definitions, "demo brief"))).toMatchObject({
        code: "extension_flag_value_invalid",
        flag: "--many",
      });
    }
    // A typed scalar compares as its kind delivers it.
    for (const definitions of [on, [{ long: "--on", value_type: "boolean" }]]) {
      expect(normalizeDirectExtensionCommandOptions({ on: "true", "no-on": "false" }, definitions, "demo brief")).toEqual({ on: true });
      expect(normalizeDirectExtensionCommandOptions({ on: "false", "--on": false }, definitions, "demo brief")).toEqual({ on: false });
    }
    expect(normalizeDirectExtensionCommandOptions({ count: "3", "--count": 3 }, [{ long: "--count", value_type: "number" }], "demo brief")).toEqual({ count: 3 });
    expect(normalizeDirectExtensionCommandOptions({ on: " true", "--on": true }, [{ long: "--on", value_type: "boolean" }], "demo brief")).toEqual({ on: true });
    // A coerce boolean forwards "bogus", which delivers a different value; an array on a scalar flag is refused as it is alone.
    expect(refusal(() => normalizeDirectExtensionCommandOptions({ on: true, "--on": "bogus" }, [{ long: "--on", value_type: "boolean" }], "demo brief"))).toMatchObject({
      code: "extension_option_spelling_conflict",
    });
    expect(refusal(() => normalizeDirectExtensionCommandOptions({ on: true, "--on": [true] }, [{ long: "--on", value_type: "boolean" }], "demo brief"))).toMatchObject({
      code: "extension_flag_value_invalid",
      flag: "--on",
    });
    const note = [{ long: "--note", value_type: "string" }];
    expect(refusal(() => normalizeDirectExtensionCommandOptions({ note: " a", "--note": "a" }, note, "demo brief"))).toMatchObject({
      code: "extension_option_spelling_conflict",
    });
    // A repeatable keeps each occurrence whole, so padding is part of the value there.
    expect(refusal(() => normalizeDirectExtensionCommandOptions({ tag: [" a"], "--tag": ["a"] }, [{ long: "--tag", value_type: "string", repeatable: true }], "demo brief"))).toMatchObject({
      code: "extension_option_spelling_conflict",
    });
    // A string or untyped list delivers its trimmed CSV tokens without coercion.
    expect(normalizeDirectExtensionCommandOptions({ ids: "a,b", "--ids": ["a", "b"] }, [{ long: "--ids", list: true }], "demo brief")).toEqual({ ids: ["a", "b"] });
    const labels = [{ long: "--label", value_type: "string", list: true }];
    expect(normalizeDirectExtensionCommandOptions({ label: "a,b", "--label": ["a", " b"] }, labels, "demo brief")).toEqual({ label: ["a", "b"] });
    expect(refusal(() => normalizeDirectExtensionCommandOptions({ label: "a,b", "--label": ["a"] }, labels, "demo brief"))).toMatchObject({
      code: "extension_option_spelling_conflict",
    });
    // A repeatable keeps each occurrence atomic, so "true,false" stays one malformed token under either spelling.
    for (const options of [{ many: "true,false" }, { "no-many": "true,false" }]) {
      expect(refusal(() => normalizeDirectExtensionCommandOptions(options, many, "demo brief"))).toMatchObject({
        code: "extension_flag_value_invalid",
        flag: "--many",
      });
    }
    // A strict scalar refusal names its flag too.
    expect(
      refusal(() => normalizeDirectExtensionCommandOptions({ on: 1 }, [{ long: "--on", value_type: "boolean", value_validation: "strict" }], "demo brief")),
    ).toMatchObject({ code: "extension_flag_value_invalid", flag: "--on" });
  });

  it("treats every reserved host flag spelling and the action transport keys as host-owned", () => {
    for (const key of ["json", "quiet", "outputBudget", "output_budget", "outputInclude", "pmPath", "pm_path", "path", "noExtensions", "extensions", "noPager", "pager", "changedFields", "idOnly", "id_only", "expectHash", "author", "help", "force", "subcommand", "inputResponses", "requestState", "--json", "output-budget", "no-extensions"]) {
      expect(normalizeDirectExtensionCommandOptions({ ...valid, [key]: "v" }, definitions, "demo brief"), key).toMatchObject({ [key]: "v" });
    }
    for (const key of ["typo", "limit", "strictRead", "includeBody", "--strict-read"]) {
      expect(refusal(direct({ ...valid, [key]: "v" })), key).toMatchObject({ code: "unknown_option" });
    }
  });

  it("reads a raw repeatable declaration as a list, as the loader expands it (Codex review round 3)", () => {
    const raw = [{ long: "--many", value_type: "boolean", repeatable: true }, { long: "--ids", value_type: "string", repeatable: true, required: true }];
    expect(normalizeDirectExtensionCommandOptions({ many: [true, "false"], ids: ["a,b", "c"] }, raw, "demo brief")).toEqual({ many: [true, false], ids: ["a,b", "c"] });
    expect(refusal(() => normalizeDirectExtensionCommandOptions({ ids: [] }, raw, "demo brief"))).toMatchObject({ code: "missing_required_option", field: "ids" });
  });

  it("passes undeclared keys through under the native-path policy", () => {
    expect(normalizeDirectExtensionCommandOptions({ ...valid, storyPoints: 3 }, definitions, "demo brief", { undeclaredKeys: "pass" })).toMatchObject({ storyPoints: 3 });
  });
});


describe("argv order of repeatable switch occurrences (pm-g2zzus)", () => {
  // The loader expands repeatable into list, as CLI dispatch receives the declarations.
  const definitions = [
    { long: "--many", short: "-m", value_type: "boolean", repeatable: true, list: true },
    { long: "--from-tracker", value_type: "string" },
    { long: "--label", value_type: "string", list: true },
  ];
  const REGISTERED = new Map<string, { arity: "required" | "optional" | "none"; key: string }>([
    ["--many", { arity: "none", key: "many" }],
    ["-m", { arity: "none", key: "many" }],
    ["--from-tracker", { arity: "required", key: "fromTracker" }],
    ["--label", { arity: "required", key: "label" }],
  ]);
  const leaf = (tokens: string[], overrides: Partial<ArgvOptionScope> = {}): ArgvOptionScope => ({
    tokens,
    optionOf: (spelling) => REGISTERED.get(spelling),
    includesLooseFlags: true,
    negativeNumbersAreValues: true,
    ...overrides,
  });
  /** What the handler receives: Commander's bare accumulator in `scoped`, the loose parser's attached occurrences in `loose`. */
  const deliver = (tokens: string[], scopes: ArgvOptionScope[] = [leaf(tokens)]) => {
    const loose = parseLooseCommandOptions(tokens.filter((token) => token.includes("=")));
    const bare = tokens.filter((token) => token === "--many" || token === "-m").map(() => true);
    const scoped = { ...(bare.length > 0 ? { many: bare } : {}), ...Object.fromEntries(Object.entries(loose).filter(([key]) => key !== "many" || bare.length === 0)) };
    const withOrder = coerceLooseCommandOptionsWithFlagDefinitions(scoped, definitions, orderArgvRepeatableSwitchOccurrences(loose, scopes, definitions), "demo");
    const withoutOrder = coerceLooseCommandOptionsWithFlagDefinitions(scoped, definitions, loose, "demo");
    return { many: withOrder.many, unordered: withoutOrder.many };
  };

  it("delivers bare and attached occurrences in argv order, where the loose occurrences alone dropped the bare ones", () => {
    expect(deliver(["--many=false", "--many"])).toEqual({ many: [false, true], unordered: [false] });
    expect(deliver(["--many", "--many=false"])).toEqual({ many: [true, false], unordered: [false] });
    expect(deliver(["-m", "--many=false", "--many"])).toEqual({ many: [true, false, true], unordered: [false] });
    // Bare-only and attached-only forms were already right, and stay so.
    expect(deliver(["--many", "-m"])).toEqual({ many: [true, true], unordered: [true, true] });
    expect(deliver(["--many=true", "--many=0"])).toEqual({ many: [true, false], unordered: [true, false] });
  });

  it("never counts a token another option consumed, and reads ancestors' scopes as Commander does", () => {
    // --from-tracker takes "--many" as its value, so only the first --many is a switch occurrence.
    expect(orderedValues(["--many", "--from-tracker", "--many"])).toEqual([true]);
    // An ancestor's own tokens count; its unparsed `--many=false` belongs to the leaf, which records it.
    const parent = leaf(["child", "--many"], { includesLooseFlags: false });
    expect(orderedValues(["--many=false"], [parent, leaf(["--many=false"])])).toEqual([true, false]);
    // `--no-many` reaches a registered switch as false.
    expect(orderedValues(["--many", "--no-many"])).toEqual([true, false]);
  });

  it("returns the occurrence source unchanged when nothing needs reordering", () => {
    const loose = parseLooseCommandOptions(["--label=a"]);
    expect(orderArgvRepeatableSwitchOccurrences(loose, [leaf(["--label=a"])], definitions)).toBe(loose);
    expect(orderArgvRepeatableSwitchOccurrences(loose, [leaf(["--many"])], [{ long: "--label", value_type: "string", list: true }])).toBe(loose);
    // Loose values come only from the loose parser: when it recorded none for a slot the scan saw, every value it has is kept.
    expect(coerceLooseCommandOptionsWithFlagDefinitions({ many: [true] }, definitions, orderArgvRepeatableSwitchOccurrences({}, [leaf(["--many=0", "--many"])], definitions), "demo")).toMatchObject({ many: [true] });
    // Other recorded occurrences survive the reordering.
    const mixed = parseLooseCommandOptions(["--label=a", "--many=false"]);
    const ordered = orderArgvRepeatableSwitchOccurrences(mixed, [leaf(["--label=a", "--many=false", "--many"])], definitions);
    expect(coerceLooseCommandOptionsWithFlagDefinitions({ label: ["a"], many: [true] }, definitions, ordered, "demo")).toMatchObject({ label: ["a"], many: [false, true] });
  });

  it("keeps another declaration's key and folds an unregistered spelling as the loose parser does (Codex review)", () => {
    // -S aliases --many, but --s is its own strict boolean: its loose occurrence keeps strict validation.
    const owned = [
      { long: "--many", short: "-S", value_type: "boolean", repeatable: true, list: true },
      { long: "--s", value_type: "boolean", value_validation: "strict" },
    ];
    const ownedLeaf = (tokens: string[]) => leaf(tokens, { optionOf: (spelling) => (spelling === "--many" || spelling === "-S" ? { arity: "none", key: "many" } : undefined) });
    const tokens = ["--many", "--s=invalid"];
    const loose = parseLooseCommandOptions(["--s=invalid"]);
    expect(() => coerceLooseCommandOptionsWithFlagDefinitions({ many: [true], s: "invalid" }, owned, orderArgvRepeatableSwitchOccurrences(loose, [ownedLeaf(tokens)], owned), "demo")).toThrow(PmCliError);
    // --Many=false reaches the loose parser as many; it keeps its place, and a strict switch still judges its value.
    expect(orderedValues(["--many", "--Many=false"])).toEqual([true, false]);
    const strict = [{ long: "--many", value_type: "boolean", value_validation: "strict", repeatable: true, list: true }];
    expect(() => coerceLooseCommandOptionsWithFlagDefinitions({ many: [true] }, strict, orderArgvRepeatableSwitchOccurrences(parseLooseCommandOptions(["--Many=invalid"]), [leaf(["--many", "--Many=invalid"])], strict), "demo")).toThrow(PmCliError);
  });

  it("keeps the loose parser's value, which reads the tokens Commander left (Codex review round 2)", () => {
    // Commander consumes --from-tracker x, so the loose parser reads --Many false from the leftovers.
    const tokens = ["--many", "--Many", "--from-tracker", "x", "false"];
    const loose = parseLooseCommandOptions(["--Many", "false"]);
    expect(coerceLooseCommandOptionsWithFlagDefinitions({ many: [true], fromTracker: "x" }, definitions, orderArgvRepeatableSwitchOccurrences(loose, [leaf(tokens)], definitions), "demo").many).toEqual([true, false]);
    // An ancestor never folds a spelling it did not register: only the leaf's loose parser reads it.
    const parent = leaf(["child", "--Many=false"], { includesLooseFlags: false, optionOf: () => undefined });
    expect(orderedValues(["--many", "--Many=false"], [parent, leaf(["--many", "--Many=false"])])).toEqual([true, false]);
  });

  it("leaves a registered short group to Commander instead of folding it (Greptile and CodeRabbit review)", () => {
    const grouped = [
      { long: "--many", short: "-m", value_type: "boolean", repeatable: true, list: true },
      { long: "--mm", value_type: "boolean", repeatable: true, list: true },
    ];
    const registered = new Map<string, { arity: "none"; key: string }>([["--many", { arity: "none", key: "many" }], ["-m", { arity: "none", key: "many" }], ["--mm", { arity: "none", key: "mm" }]]);
    const tokens = ["-mm", "--many=false"];
    const source = orderArgvRepeatableSwitchOccurrences(parseLooseCommandOptions(["--many=false"]), [leaf(tokens, { optionOf: (spelling) => registered.get(spelling) })], grouped);
    expect(coerceLooseCommandOptionsWithFlagDefinitions({ many: [true, true] }, grouped, source, "demo")).toMatchObject({ many: [true, true, false] });
  });

  /** The values the reordered occurrences deliver for --many, through the shared coercer. */
  function orderedValues(tokens: string[], scopes: ArgvOptionScope[] = [leaf(tokens)]): unknown {
    // The loose parser reads the tokens Commander leaves: here every spelling Commander did not register.
    const loose = parseLooseCommandOptions(tokens.filter((token) => !REGISTERED.has(token)));
    return coerceLooseCommandOptionsWithFlagDefinitions({ many: [true] }, definitions, orderArgvRepeatableSwitchOccurrences(loose, scopes, definitions), "demo").many;
  }
});
