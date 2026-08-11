import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PM_TOOL_ACTIONS,
  PM_TOOL_ACTION_PARAMETER_CONTRACTS,
  analyzePmToolActionParity,
  analyzeSdkCliParameterCompleteness,
} from "../../../src/sdk/cli-contracts.js";
import {
  _testOnlyCliContracts,
  resolveSubcommandFlagContractsForCommand,
} from "../../../src/sdk/cli-contracts.js";
import { PM_TOOL_PARAMETER_PROPERTIES } from "../../../src/sdk/cli-contracts/tool-parameter-tables.js";
import { analyzeSdkActionCoverage } from "../../../src/sdk/runtime.js";

type SchemaWithProperties = {
  properties?: Record<string, unknown>;
};

interface CompletenessBaseline {
  minimum_public_actions: number;
  maximum_waivers: Record<string, number>;
}

describe("action-scoped MCP schema parity", () => {
  it("derives CLI action reachability with explicit, shrinking waivers", () => {
    expect(analyzePmToolActionParity()).toEqual({
      missing_cli_actions: [],
      waived_cli_actions: ["packages", "item", "help"],
      stale_waivers: [],
    });
    expect(
      analyzePmToolActionParity(
        ["create", "synthetic-command"],
        ["create"],
        {},
      ),
    ).toEqual({
      missing_cli_actions: ["synthetic-command"],
      waived_cli_actions: [],
      stale_waivers: [],
    });
    expect(
      analyzePmToolActionParity(["create", "waived-command"], ["create"], {
        "waived-command": "transport-only namespace",
        stale: "removed",
      }),
    ).toEqual({
      missing_cli_actions: [],
      waived_cli_actions: ["waived-command"],
      stale_waivers: ["stale"],
    });
  });

  it("derives complete SDK dispatch and parameter coverage for every public action", () => {
    const coverage = analyzeSdkActionCoverage();
    expect(coverage).toHaveLength(PM_TOOL_ACTIONS.length);
    expect(coverage.filter((row) => !row.covered)).toEqual([]);

    for (const action of PM_TOOL_ACTIONS) {
      const contract = PM_TOOL_ACTION_PARAMETER_CONTRACTS[action];
      const schema = _testOnlyCliContracts.buildActionScopedToolSchema(
        action,
      ) as SchemaWithProperties;
      const properties = new Set(Object.keys(schema.properties ?? {}));
      for (const parameter of [
        ...(contract.required ?? []),
        ...(contract.optional ?? []),
      ]) {
        expect(
          properties.has(parameter),
          `${action} schema should expose contracted parameter ${parameter}`,
        ).toBe(true);
      }
    }
  });

  it("fails closed for an unregistered action negative control", () => {
    expect(analyzeSdkActionCoverage(["synthetic-unregistered-action"])).toEqual(
      [
        {
          action: "synthetic-unregistered-action",
          resolved_action: "synthetic-unregistered-action",
          covered: false,
          route: "missing",
        },
      ],
    );
  });

  it("omits a contracted parameter whose canonical definition is unavailable", () => {
    const definition = PM_TOOL_PARAMETER_PROPERTIES.markdown;
    delete PM_TOOL_PARAMETER_PROPERTIES.markdown;
    try {
      const schema = _testOnlyCliContracts.buildActionScopedToolSchema(
        "package-describe",
      ) as SchemaWithProperties;
      expect(schema.properties).not.toHaveProperty("markdown");
    } finally {
      PM_TOOL_PARAMETER_PROPERTIES.markdown = definition;
    }
  });

  it("derives bidirectional CLI/SDK reachability with a shrinking-only waiver ratchet", async () => {
    const baseline = JSON.parse(
      await readFile(
        path.resolve("tests/fixtures/sdk/sdk-cli-parameter-completeness.json"),
        "utf8",
      ),
    ) as CompletenessBaseline;
    const coverage = analyzeSdkCliParameterCompleteness();
    const entries = coverage.flatMap(({ cli, sdk }) => [...cli, ...sdk]);
    const waiverCounts = new Map<string, number>();
    for (const { disposition } of entries) {
      if (disposition === "shared" || disposition === "unclassified") continue;
      waiverCounts.set(disposition, (waiverCounts.get(disposition) ?? 0) + 1);
    }

    expect(coverage).toHaveLength(PM_TOOL_ACTIONS.length);
    expect(coverage.length).toBeGreaterThanOrEqual(
      baseline.minimum_public_actions,
    );
    expect(coverage.flatMap(({ unclassified }) => unclassified)).toEqual([]);
    for (const [disposition, maximum] of Object.entries(
      baseline.maximum_waivers,
    )) {
      expect(
        waiverCounts.get(disposition) ?? 0,
        `${disposition} waiver count must only shrink`,
      ).toBeLessThanOrEqual(maximum);
    }
    expect([...waiverCounts.keys()].sort()).toEqual(
      Object.keys(baseline.maximum_waivers).sort(),
    );
    expect(
      coverage
        .find(({ action }) => action === "files")
        ?.sdk.find(({ input }) => input === "lookupPath"),
    ).toEqual(
      expect.objectContaining({
        counterpart: "lookup <path...>",
        disposition: "shared",
      }),
    );
    expect(
      coverage
        .find(({ action }) => action === "assurance")
        ?.cli.find(({ input }) => input === "--pm-path"),
    ).toEqual(
      expect.objectContaining({ counterpart: "path", disposition: "shared" }),
    );
  });

  it("fails closed when a new CLI flag lacks a schema mapping or waiver", () => {
    const coverage = analyzeSdkCliParameterCompleteness({
      actions: ["create"],
      resolveFlags: (command) => [
        ...resolveSubcommandFlagContractsForCommand(command),
        { flag: "--synthetic-unmapped-control" },
      ],
    });

    expect(coverage[0]?.unclassified).toContainEqual(
      expect.objectContaining({
        input: "--synthetic-unmapped-control",
        disposition: "unclassified",
      }),
    );
  });

  it("fails closed when an action has no strict SDK parameter contract", () => {
    const coverage = analyzeSdkCliParameterCompleteness({
      actions: ["create"],
      resolveParameters: () => undefined,
    });

    expect(coverage[0]?.sdk).toEqual([]);
    expect(coverage[0]?.unclassified.length).toBeGreaterThan(0);
  });

  it("documents newly exposed terse health output for MCP clients", () => {
    const schema = _testOnlyCliContracts.buildActionScopedToolSchema(
      "health",
    ) as {
      properties?: { brief?: { description?: string; examples?: unknown[] } };
    };

    expect(schema.properties?.brief?.description).toContain("low-token");
    expect(schema.properties?.brief?.examples).toEqual([true]);
  });

  it("keeps list-only date-window shorthands out of search tool schemas", () => {
    const listSchema = _testOnlyCliContracts.buildActionScopedToolSchema(
      "list",
    ) as SchemaWithProperties;
    const searchSchema = _testOnlyCliContracts.buildActionScopedToolSchema(
      "search",
    ) as SchemaWithProperties;

    expect(Object.keys(listSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["today", "recent", "updatedAfter"]),
    );
    expect(Object.keys(searchSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["updatedAfter"]),
    );
    expect(searchSchema.properties).not.toHaveProperty("today");
    expect(searchSchema.properties).not.toHaveProperty("recent");
  });

  it("rejects list date-window combinations in action schemas", () => {
    const schema = _testOnlyCliContracts.buildActionScopedToolSchema(
      "list",
    ) as { allOf?: unknown[] };

    expect(JSON.stringify(schema.allOf)).toContain('"today":{"const":true}');
    expect(JSON.stringify(schema.allOf)).toContain('"recent":{"const":true}');
    expect(JSON.stringify(schema.allOf)).toContain(
      '"updatedAfter":{"type":"string","pattern":"\\\\S"}',
    );
  });

  it("documents contracts summary scope and schema projection exclusivity", () => {
    const schema = _testOnlyCliContracts.buildActionScopedToolSchema(
      "contracts",
    ) as {
      allOf?: unknown[];
      properties?: { summary?: { description?: string } };
    };

    expect(schema.properties?.summary?.description).toContain("health rollup");
    expect(JSON.stringify(schema.allOf)).toContain('"summary":{"const":true}');
    expect(JSON.stringify(schema.allOf)).toContain(
      '"availabilityOnly":{"const":true}',
    );
  });

  it("keeps the package-owned guide contract aligned with its CLI flag table", () => {
    const guideFlags = new Set(
      resolveSubcommandFlagContractsForCommand("guide").map(
        (contract) => contract.flag,
      ),
    );
    const guideContract = _testOnlyCliContracts.toolActionSchemaContracts.guide;

    expect(guideFlags.has("--list"), "guide should advertise --list").toBe(
      true,
    );
    expect(guideContract?.optional).toEqual(
      expect.arrayContaining(["list", "format", "depth"]),
    );
    expect(
      _testOnlyCliContracts.toolParameterMetadata.list?.description,
    ).toContain("topics for guide");
  });

  it("scopes the shared name parameter description per action so schema and profile do not cross-reference (pm-fq80)", () => {
    const schemaName = (
      _testOnlyCliContracts.buildActionScopedToolSchema("schema") as {
        properties?: { name?: { description?: string; examples?: unknown[] } };
      }
    ).properties?.name;
    const profileName = (
      _testOnlyCliContracts.buildActionScopedToolSchema("profile") as {
        properties?: { name?: { description?: string; examples?: unknown[] } };
      }
    ).properties?.name;

    // The schema action's `name` describes only schema uses (no profiles), and the
    // profile action's `name` describes only profiles (no item types / statuses / fields).
    expect(schemaName?.description).toContain("Custom item type name");
    expect(schemaName?.description).not.toMatch(/profile/i);
    expect(schemaName?.examples).toEqual(["Spike", "review", "component"]);

    expect(profileName?.description).toContain(
      "Profile name for show/apply/lint",
    );
    expect(profileName?.description).not.toMatch(
      /item type|status id|field key/i,
    );
    expect(profileName?.examples).toEqual(["agile", "ops", "research"]);

    // The flat provider schema keeps a single combined `name` description because its
    // one property must cover every action at once.
    expect(
      _testOnlyCliContracts.toolParameterMetadata.name?.description,
    ).toMatch(/profile/i);
  });
});
