/**
 * pm-gh1665: the shared extension option normalizer that CLI dispatch,
 * `PmClient.run`, MCP, and the test harness all route through.
 */
import { describe, expect, it } from "vitest";
import {
  coerceLooseCommandOptionsWithFlagDefinitions,
  collectExtensionFlagDefinitionsForCommand,
  normalizeDirectExtensionCommandOptions,
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
