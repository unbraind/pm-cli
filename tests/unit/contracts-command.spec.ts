import { describe, expect, it } from "vitest";
import { runContracts } from "../../src/cli/commands/contracts.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import type { GlobalOptions } from "../../src/core/shared/command-types.js";

const GLOBAL_OPTIONS: GlobalOptions = {
  json: true,
  quiet: false,
  noExtensions: false,
  profile: false,
};

describe("contracts command runtime", () => {
  it("returns schema, actions, command flags, and alias surfaces", async () => {
    const result = await runContracts({}, GLOBAL_OPTIONS);
    expect(result.schema_version).toBe("4.0.0");
    expect(result.schema_id).toContain("tool-parameters-v4");
    expect(result.actions).toContain("contracts");
    expect(result.commands).toContain("contracts");
    expect(result.command_flags?.some((entry) => entry.command === "contracts")).toBe(true);
    expect(result.commander_aliases).toBeDefined();
    expect(result.commander_aliases?.create_string_options.length).toBeGreaterThan(0);
  });

  it("supports schema-only mode with action filtering", async () => {
    const result = await runContracts(
      {
        action: "create",
        schemaOnly: true,
      },
      GLOBAL_OPTIONS,
    );
    expect(result.selected.action).toBe("create");
    expect(result.selected.schema_only).toBe(true);
    expect(result.command_flags).toBeUndefined();
    const oneOf = (result.schema.oneOf ?? []) as Array<{ properties?: { action?: { const?: string } } }>;
    expect(oneOf).toHaveLength(1);
    expect(oneOf[0]?.properties?.action?.const).toBe("create");
  });

  it("rejects unknown action and command filters", async () => {
    await expect(runContracts({ action: "unknown-action" }, GLOBAL_OPTIONS)).rejects.toMatchObject<PmCliError>({
      message: 'Unknown action: "unknown-action".',
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(runContracts({ command: "unknown-command" }, GLOBAL_OPTIONS)).rejects.toMatchObject<PmCliError>({
      message: 'Unknown command: "unknown-command".',
      exitCode: EXIT_CODE.USAGE,
    });
  });
});
