import { describe, expect, it } from "vitest";
import type { PmToolAction } from "../../../src/sdk/cli-contracts.js";
import { _testOnlyCliContracts, resolveSubcommandFlagContractsForCommand } from "../../../src/sdk/cli-contracts.js";

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
  { action: "close", command: "close", flags: ["--reason", "--close-reason", "--validate-close", "--resolution", "--expected-result", "--actual-result"] },
  { action: "close-task", command: "close-task", flags: ["--validate-close"] },
  { action: "files", command: "files", flags: ["--list"] },
  { action: "health", command: "health", flags: ["--brief", "--summary", "--full"] },
  { action: "validate", command: "validate", flags: ["--dependency-cycle-severity", "--parent-cycle-severity"] },
  { action: "contracts", command: "contracts", flags: ["--action", "--command", "--schema-only", "--flags-only", "--availability-only", "--runtime-only", "--active-only", "--full"] },
];

function camelCaseFlagName(flag: string): string {
  return flag
    .replace(/^--/, "")
    .replace(/-([a-z])/g, (_match, value: string) => value.toUpperCase());
}

describe("action-scoped MCP schema parity", () => {
  it("accepts non-interactive CLI flags that reviewers identified as schema drift", () => {
    for (const { action, command, flags } of SCHEMA_PARITY_CASES) {
      const commandFlags = new Set(resolveSubcommandFlagContractsForCommand(command).map((contract) => contract.flag));
      const schema = _testOnlyCliContracts.buildActionScopedToolSchema(action) as SchemaWithProperties;
      const schemaProperties = new Set(Object.keys(schema.properties ?? {}));

      for (const flag of flags) {
        const parameter = FLAG_PARAMETER_OVERRIDES[flag] ?? camelCaseFlagName(flag);
        expect(commandFlags.has(flag), `${command} should advertise ${flag}`).toBe(true);
        expect(schemaProperties.has(parameter), `${action} schema should accept ${parameter} for ${flag}`).toBe(true);
      }
    }
  });

  it("documents newly exposed terse health output for MCP clients", () => {
    const schema = _testOnlyCliContracts.buildActionScopedToolSchema("health") as {
      properties?: { brief?: { description?: string; examples?: unknown[] } };
    };

    expect(schema.properties?.brief?.description).toContain("low-token");
    expect(schema.properties?.brief?.examples).toEqual([true]);
  });

  it("keeps the package-owned guide contract aligned with its CLI flag table", () => {
    const guideFlags = new Set(resolveSubcommandFlagContractsForCommand("guide").map((contract) => contract.flag));
    const guideContract = _testOnlyCliContracts.toolActionSchemaContracts.guide;

    expect(guideFlags.has("--list"), "guide should advertise --list").toBe(true);
    expect(guideContract?.optional).toEqual(expect.arrayContaining(["list", "format", "depth"]));
    expect(_testOnlyCliContracts.toolParameterMetadata.list?.description).toContain("topics for guide");
  });
});
