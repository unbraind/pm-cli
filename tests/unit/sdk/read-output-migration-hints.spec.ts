import { describe, expect, it } from "vitest";
import {
  PM_READ_OUTPUT_SURFACE_CONTRACTS,
  applyReadOutputDimensions,
  applyReadOutputIncludeModes,
  normalizeReadOutputIncludeModeOptions,
  readOutputIncludeModeOptions,
  resolveReadOutputDimensions,
} from "../../../src/sdk/read-output-contracts.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

/**
 * Every migration hint the read-output contract emits names a canonical
 * replacement spelling. Pinning the hint text proves only that the sentence has
 * not changed; it cannot observe whether the recommended spelling still does
 * what the alias it replaces did. These tests execute the recommendation.
 */

const CANONICAL_INCLUDE_HINT =
  /^(--[a-z-]+) is a compatibility alias; prefer --output-include ([a-z_]+)\.$/u;

const RECEIPT_KEYS = new Set([
  "cache",
  "duration_ms",
  "generated_at",
  "now",
  "output_budget_truncation",
  "read_output",
  "read_session",
  "timestamp",
]);

/** Collect every include-dimension hint that recommends a bare mode token. */
function includeModeRecommendations(): Array<{
  command: string;
  flag: string;
  token: string;
}> {
  return PM_READ_OUTPUT_SURFACE_CONTRACTS.flatMap((contract) =>
    contract.dimensions.include.legacy_aliases.flatMap((alias) => {
      const match = CANONICAL_INCLUDE_HINT.exec(alias.migration_hint);
      if (!match || match[2] === "<csv>") return [];
      return [{ command: contract.command, flag: match[1]!, token: match[2]! }];
    }),
  );
}

/** Remove invocation receipts before comparing the result projections they describe. */
function withoutReadOutputReceipts(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => withoutReadOutputReceipts(entry));
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !RECEIPT_KEYS.has(key))
      .map(([key, entry]) => [key, withoutReadOutputReceipts(entry)]),
  );
}

/** Compare only public string-keyed options, excluding internal provenance. */
function visibleOptions(options: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(options));
}

describe("read-output migration hints are executable", () => {
  it("recommends a canonical include token for at least one alias per shaped surface", () => {
    const recommendations = includeModeRecommendations();
    expect(recommendations.length).toBeGreaterThan(0);
    expect(new Set(recommendations.map((entry) => entry.command)).size).toBe(
      new Set(
        PM_READ_OUTPUT_SURFACE_CONTRACTS.filter((contract) =>
          contract.dimensions.include.legacy_aliases.some((alias) =>
            CANONICAL_INCLUDE_HINT.test(alias.migration_hint),
          ),
        ).map((contract) => contract.command),
      ).size,
    );
  });

  it("maps every recommended include token back to the alias option it replaces", () => {
    for (const { command, flag, token } of includeModeRecommendations()) {
      const options: Record<string, unknown> = {};
      const applied = applyReadOutputIncludeModes(command, token, options);
      expect(
        applied.modes,
        `${command} --output-include ${token} must resolve as a projection mode`,
      ).toEqual([token]);
      expect(
        applied.selectors,
        `${command} --output-include ${token} must not survive as a field selector`,
      ).toEqual([]);
      const optionName = flag
        .slice(2)
        .replace(/-([a-z])/gu, (_, character: string) =>
          character.toUpperCase(),
        );
      expect(
        visibleOptions(options),
        `${command} --output-include ${token} must set the ${flag} option`,
      ).toEqual({ [optionName]: true });
    }
  });

  it("declares a mode option for every non-value-bearing include alias", () => {
    for (const contract of PM_READ_OUTPUT_SURFACE_CONTRACTS) {
      const declared = readOutputIncludeModeOptions(contract.command);
      const expected = contract.dimensions.include.legacy_aliases
        .filter((alias) => alias.semantics === "replacement")
        .map((alias) => alias.flag)
        .filter(
          (flag) => !new Set(["--collapse", "--fields", "--section"]).has(flag),
        )
        .map((flag) => flag.slice(2).replaceAll("-", "_"));
      expect([...declared.keys()].sort()).toEqual(expected.sort());
    }
  });

  it("declares weaker behavior-preserving guidance without exposing a false replacement", () => {
    const dependencyAliases = PM_READ_OUTPUT_SURFACE_CONTRACTS.find(
      (contract) => contract.command === "deps",
    )?.dimensions.include.legacy_aliases;
    expect(dependencyAliases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          flag: "--collapse",
          semantics: "behavior_preserving",
          migration_hint:
            "--collapse retains dependency grouping semantics; --output-include does not replace it.",
        }),
      ]),
    );
    expect(readOutputIncludeModeOptions("deps").has("collapse")).toBe(false);
    expect(readOutputIncludeModeOptions("health").has("check_only")).toBe(
      false,
    );
  });

  it("leaves field selectors untouched and preserves selector order", () => {
    const options: Record<string, unknown> = {};
    const applied = applyReadOutputIncludeModes(
      "list",
      "brief,id,title",
      options,
    );
    expect(applied.modes).toEqual(["brief"]);
    expect(applied.selectors).toEqual(["id", "title"]);
    expect(visibleOptions(options)).toEqual({ brief: true });
  });

  it("treats an unknown token as a field selector rather than a silent mode", () => {
    const options: Record<string, unknown> = {};
    const applied = applyReadOutputIncludeModes("list", "nosuchmode", options);
    expect(applied.modes).toEqual([]);
    expect(applied.selectors).toEqual(["nosuchmode"]);
    expect(options).toEqual({});

    expect(applyReadOutputIncludeModes("list", false, options)).toEqual({
      modes: [],
      selectors: [],
    });
  });

  it("normalizes canonical modes in camel- and snake-case option bags", () => {
    const camelOptions: Record<string, unknown> = {
      outputInclude: "brief,id",
    };
    normalizeReadOutputIncludeModeOptions("list", camelOptions);
    expect(visibleOptions(camelOptions)).toEqual({
      outputInclude: "id",
      brief: true,
    });

    const snakeOptions: Record<string, unknown> = {
      output_include: "brief",
    };
    normalizeReadOutputIncludeModeOptions("list", snakeOptions);
    expect(visibleOptions(snakeOptions)).toEqual({
      outputInclude: undefined,
      output_include: undefined,
      brief: true,
    });
  });

  it("preserves canonical provenance when normalization forwards a mode", () => {
    const canonicalOnly: Record<string, unknown> = {
      outputInclude: "full",
      outputLimit: "unbounded",
    };
    normalizeReadOutputIncludeModeOptions("list", canonicalOnly);
    expect(resolveReadOutputDimensions("list", canonicalOnly)).toMatchObject({
      canonical_options_used: ["--output-include", "--output-limit"],
      legacy_aliases_used: [],
      migration_hints: [],
    });
    expect(
      applyReadOutputDimensions("list", canonicalOnly, {
        items: [{ id: "pm-1", title: "One" }],
      }),
    ).toMatchObject({
      read_output: {
        requested_dimensions: ["include", "amount", "cost"],
        canonical_options_used: ["--output-include", "--output-limit"],
        legacy_aliases_used: [],
        migration_hints: [],
      },
    });

    const mixed: Record<string, unknown> = {
      outputInclude: "full",
      outputLimit: "unbounded",
      full: true,
    };
    normalizeReadOutputIncludeModeOptions("list", mixed);
    expect(resolveReadOutputDimensions("list", mixed)).toMatchObject({
      canonical_options_used: ["--output-include", "--output-limit"],
      legacy_aliases_used: ["--full"],
      migration_hints: [
        "--full is a compatibility alias; prefer --output-include full.",
      ],
    });
  });

  it("records every canonical dimension independently of legacy aliases", () => {
    expect(
      resolveReadOutputDimensions("list", {
        outputInclude: "id,title",
        outputLimit: 2,
        outputBudget: 800,
        outputFormat: "json",
      }),
    ).toMatchObject({
      canonical_options_used: [
        "--output-include",
        "--output-limit",
        "--output-budget",
        "--output-format",
      ],
      legacy_aliases_used: [],
      migration_hints: [],
    });
  });

  it("leaves absent and selector-only include options unchanged", () => {
    const absent: Record<string, unknown> = { limit: 1 };
    normalizeReadOutputIncludeModeOptions("list", absent);
    expect(absent).toEqual({ limit: 1 });

    const selectorOnly: Record<string, unknown> = { outputInclude: "id" };
    normalizeReadOutputIncludeModeOptions("list", selectorOnly);
    expect(selectorOnly).toEqual({ outputInclude: "id" });
  });

  it("returns no modes for a command that is not a read surface", () => {
    expect([...readOutputIncludeModeOptions("create").keys()]).toEqual([]);
    const options: Record<string, unknown> = {};
    expect(applyReadOutputIncludeModes("create", "brief", options)).toEqual({
      modes: [],
      selectors: ["brief"],
    });
    expect(options).toEqual({});
  });

  it("executes every declared replacement and preserves its result projection", async () => {
    await withTempPmPath(async ({ runCli }) => {
      const created = runCli(
        [
          "create",
          "--create-mode",
          "progressive",
          "--title",
          "Executable migration fixture",
          "--description",
          "Rich fixture content for projection parity",
          "--type",
          "Task",
          "--json",
          "--no-extensions",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const itemId = (created.json as { item: { id: string } }).item.id;
      const commandArguments: Readonly<Record<string, readonly string[]>> = {
        activity: [],
        contracts: [],
        deps: [itemId],
        events: [],
        get: [itemId],
        graph: ["analyze"],
        health: [],
        history: [itemId],
        list: [],
        search: ["Executable", "migration"],
        validate: [],
      };

      const recommendations = includeModeRecommendations();
      expect(recommendations).toHaveLength(22);
      for (const { command, flag, token } of recommendations) {
        const base = commandArguments[command];
        expect(base, `${command} needs an executable fixture`).toBeDefined();
        const legacy = runCli(
          [
            command,
            ...(base ?? []),
            flag,
            "--output-limit",
            "unbounded",
            "--json",
            "--no-extensions",
          ],
          { expectJson: true },
        );
        const canonical = runCli(
          [
            command,
            ...(base ?? []),
            "--output-include",
            token,
            "--output-limit",
            "unbounded",
            "--json",
            "--no-extensions",
          ],
          { expectJson: true },
        );
        expect(legacy.code, `${command} ${flag} must execute`).toBe(0);
        expect(
          canonical.code,
          `${command} --output-include ${token} must execute`,
        ).toBe(0);
        expect(
          withoutReadOutputReceipts(canonical.json),
          `${command} --output-include ${token} must preserve ${flag}`,
        ).toEqual(withoutReadOutputReceipts(legacy.json));
        expect(
          (legacy.json as { read_output: Record<string, unknown> }).read_output,
          `${command} ${flag} must identify only the caller-supplied compatibility alias`,
        ).toMatchObject({
          canonical_options_used: ["--output-limit"],
          legacy_aliases_used: [flag],
        });
        expect(
          (canonical.json as { read_output: Record<string, unknown> })
            .read_output,
          `${command} --output-include ${token} must retain canonical provenance`,
        ).toMatchObject({
          canonical_options_used: ["--output-include", "--output-limit"],
          legacy_aliases_used: [],
          migration_hints: [],
        });
      }

      const mixed = runCli(
        [
          "list",
          "--full",
          "--output-include",
          "full",
          "--output-limit",
          "unbounded",
          "--json",
          "--no-extensions",
        ],
        { expectJson: true },
      );
      expect(mixed.code).toBe(0);
      expect(
        (mixed.json as { read_output: Record<string, unknown> }).read_output,
      ).toMatchObject({
        canonical_options_used: ["--output-include", "--output-limit"],
        legacy_aliases_used: ["--full"],
        migration_hints: [
          "--full is a compatibility alias; prefer --output-include full.",
        ],
      });
    });
  }, 30_000);
});
