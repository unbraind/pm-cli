import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runContracts } from "../../src/cli/commands/contracts.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import type { GlobalOptions } from "../../src/core/shared/command-types.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

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
    expect(result.selected.runtime_only).toBe(false);
    expect(result.actions).toContain("contracts");
    expect(result.commands).toContain("contracts");
    expect(result.action_availability.some((entry) => entry.action === "create" && entry.invocable)).toBe(true);
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
    expect(result.selected.runtime_only).toBe(false);
    expect(result.command_flags).toBeUndefined();
    const oneOf = (result.schema.oneOf ?? []) as Array<{ properties?: { action?: { const?: string } } }>;
    expect(oneOf).toHaveLength(1);
    expect(oneOf[0]?.properties?.action?.const).toBe("create");
  });

  it("supports runtime-only filtering and reports extension-action availability", async () => {
    const result = await runContracts(
      {
        runtimeOnly: true,
      },
      {
        ...GLOBAL_OPTIONS,
        noExtensions: true,
      },
    );
    expect(result.selected.runtime_only).toBe(true);
    expect(result.actions).not.toContain("beads-import");
    expect(result.actions).toContain("validate");
    expect(result.action_availability.every((entry) => entry.invocable)).toBe(true);

    const fullResult = await runContracts(
      {},
      {
        ...GLOBAL_OPTIONS,
        noExtensions: true,
      },
    );
    const beadsAvailability = fullResult.action_availability.find((entry) => entry.action === "beads-import");
    expect(beadsAvailability).toMatchObject({
      action: "beads-import",
      requires_extension: true,
      provider: "extension",
      invocable: false,
      available: false,
      disabled_reason: "extensions_disabled",
    });
  });

  it("keeps selected actions visible in runtime-only mode", async () => {
    const result = await runContracts(
      {
        action: "beads-import",
        runtimeOnly: true,
        schemaOnly: true,
      },
      {
        ...GLOBAL_OPTIONS,
        noExtensions: true,
      },
    );
    expect(result.actions).toEqual(["beads-import"]);
    expect(result.action_availability).toEqual([
      {
        action: "beads-import",
        invocable: false,
        available: false,
        requires_extension: true,
        provider: "extension",
        disabled_reason: "extensions_disabled",
      },
    ]);
    const oneOf = (result.schema.oneOf ?? []) as Array<{ properties?: { action?: { const?: string } } }>;
    expect(oneOf).toHaveLength(1);
    expect(oneOf[0]?.properties?.action?.const).toBe("beads-import");
  });

  it("surfaces runtime probe failures for extension action availability", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      await rm(settingsPath, { force: true });
      await mkdir(settingsPath, { recursive: true });

      const result = await runContracts(
        {},
        {
          ...GLOBAL_OPTIONS,
          path: context.pmPath,
        },
      );

      const beadsAvailability = result.action_availability.find((entry) => entry.action === "beads-import");
      expect(beadsAvailability).toMatchObject({
        action: "beads-import",
        invocable: false,
        available: false,
        requires_extension: true,
        provider: "extension",
        disabled_reason: "extension_runtime_probe_failed",
      });
    });
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
