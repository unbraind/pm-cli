import { describe, expect, it } from "vitest";
import type { PmToolAction } from "../../../src/sdk/cli-contracts.js";
import {
  _testOnlyCliContracts,
  resolveSubcommandFlagContractsForCommand,
} from "../../../src/sdk/cli-contracts.js";

type SchemaWithProperties = {
  properties?: Record<string, unknown>;
};

const FLAG_PARAMETER_OVERRIDES: Record<string, string> = {
  "--action": "contractAction",
};

const SCHEMA_PARITY_CASES: Array<{
  action: PmToolAction;
  command: string;
  flags: string[];
}> = [
  {
    action: "close",
    command: "close",
    flags: [
      "--reason",
      "--close-reason",
      "--validate-close",
      "--resolution",
      "--expected-result",
      "--actual-result",
    ],
  },
  { action: "close-task", command: "close-task", flags: ["--validate-close"] },
  { action: "files", command: "files", flags: ["--list"] },
  {
    action: "health",
    command: "health",
    flags: ["--brief", "--summary", "--full"],
  },
  { action: "plan", command: "plan", flags: ["--field"] },
  {
    action: "validate",
    command: "validate",
    flags: ["--dependency-cycle-severity", "--parent-cycle-severity"],
  },
  {
    action: "contracts",
    command: "contracts",
    flags: [
      "--action",
      "--command",
      "--summary",
      "--schema-only",
      "--flags-only",
      "--availability-only",
      "--runtime-only",
      "--active-only",
      "--full",
    ],
  },
];

function camelCaseFlagName(flag: string): string {
  return flag
    .replace(/^--/, "")
    .replace(/-([a-z])/g, (_match, value: string) => value.toUpperCase());
}

describe("action-scoped MCP schema parity", () => {
  it.each(SCHEMA_PARITY_CASES)(
    "accepts non-interactive CLI flags for action $action",
    ({ action, command, flags }) => {
      const commandFlags = new Set(
        resolveSubcommandFlagContractsForCommand(command).map(
          (contract) => contract.flag,
        ),
      );
      const schema = _testOnlyCliContracts.buildActionScopedToolSchema(
        action,
      ) as SchemaWithProperties;
      const schemaProperties = new Set(Object.keys(schema.properties ?? {}));

      for (const flag of flags) {
        const parameter =
          FLAG_PARAMETER_OVERRIDES[flag] ?? camelCaseFlagName(flag);
        expect(
          commandFlags.has(flag),
          `${command} should advertise ${flag}`,
        ).toBe(true);
        expect(
          schemaProperties.has(parameter),
          `${action} schema should accept ${parameter} for ${flag}`,
        ).toBe(true);
      }
    },
  );

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
