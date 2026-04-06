import { mkdir, rm, writeFile } from "node:fs/promises";
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

async function createProjectExtension(
  pmPath: string,
  directory: string,
  manifest: Record<string, unknown>,
  entrySource: string,
): Promise<void> {
  const extensionRoot = path.join(pmPath, "extensions", directory);
  await mkdir(extensionRoot, { recursive: true });
  await writeFile(path.join(extensionRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(extensionRoot, "index.mjs"), entrySource, "utf8");
}

describe("contracts command runtime", () => {
  it("returns schema, actions, command flags, and alias surfaces", async () => {
    const result = await runContracts({}, GLOBAL_OPTIONS);
    expect(result.schema_version).toBe("4.0.0");
    expect(result.schema_id).toContain("tool-parameters-v4");
    expect(result.selected.runtime_only).toBe(false);
    expect(result.actions).toContain("contracts");
    expect(result.actions).toContain("aggregate");
    expect(result.actions).toContain("dedupe-audit");
    expect(result.commands).toContain("contracts");
    expect(result.commands).toContain("aggregate");
    expect(result.commands).toContain("dedupe-audit");
    expect(result.action_availability.some((entry) => entry.action === "create" && entry.invocable)).toBe(true);
    expect(result.command_flags?.some((entry) => entry.command === "contracts")).toBe(true);
    expect(result.command_flags?.find((entry) => entry.command === "aggregate")?.flags).toEqual(
      expect.arrayContaining([expect.objectContaining({ flag: "--group-by" }), expect.objectContaining({ flag: "--count" })]),
    );
    expect(result.commander_aliases).toBeDefined();
    expect(result.commander_aliases?.create_string_options.length).toBeGreaterThan(0);
    expect(result.commander_aliases?.list_string_options).toEqual(
      expect.arrayContaining([expect.objectContaining({ target: "fields" }), expect.objectContaining({ target: "sort" })]),
    );
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
    const createRequiredContracts = (oneOf[0] as Record<string, unknown>)["x-create-required-options"] as
      | {
          default_create_mode?: string;
          by_create_mode?: {
            strict?: { by_type?: Record<string, { required_flags?: string[] }> };
            progressive?: { by_type?: Record<string, { required_flags?: string[] }> };
          };
        }
      | undefined;
    expect(createRequiredContracts?.default_create_mode).toBe("strict");
    expect(createRequiredContracts?.by_create_mode?.strict?.by_type?.Task?.required_flags).toEqual(
      expect.arrayContaining(["--title", "--description", "--type", "--status", "--priority", "--message", "--dep", "--comment", "--doc"]),
    );
    expect(createRequiredContracts?.by_create_mode?.progressive?.by_type?.Task?.required_flags).toEqual(
      expect.arrayContaining(["--title", "--description", "--type"]),
    );
    expect(createRequiredContracts?.by_create_mode?.progressive?.by_type?.Task?.required_flags).not.toEqual(
      expect.arrayContaining(["--dep", "--comment", "--doc"]),
    );
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

  it("merges active extension command/action schemas into contracts output", async () => {
    await withTempPmPath(async (context) => {
      await createProjectExtension(
        context.pmPath,
        "migrate-asset-contracts",
        {
          name: "migrate-asset-contracts",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["commands", "schema"],
        },
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'migrate-asset',",
          "      action: 'migrate-asset',",
          "      description: 'Migrate asset payloads to the current schema version.',",
          "      intent: 'Validate and migrate asset payloads before writing output.',",
          "      examples: [",
          "        'pm migrate-asset --source assets/source.json --target assets/output.json'",
          "      ],",
          "      failure_hints: [",
          "        'Ensure --source points to an existing readable file.'",
          "      ],",
          "      arguments: [",
          "        { name: 'assetId', required: false, description: 'Optional asset identifier override.' }",
          "      ],",
          "      flags: [",
          "        { long: '--source', value_name: 'path', required: true, description: 'Source asset payload path.' },",
          "        { long: '--target', value_name: 'path', description: 'Destination payload path.' },",
          "        { long: '--dry-run', description: 'Preview migration only.' }",
          "      ],",
          "      run: (context) => ({",
          "        command: context.command,",
          "        options: context.options,",
          "      }),",
          "    });",
          "  },",
          "};",
          "",
        ].join("\n"),
      );

      const result = await runContracts(
        {
          action: "migrate-asset",
          command: "migrate-asset",
        },
        {
          ...GLOBAL_OPTIONS,
          path: context.pmPath,
        },
      );

      expect(result.actions).toEqual(["migrate-asset"]);
      expect(result.commands).toEqual(["migrate-asset"]);
      expect(result.action_availability).toEqual([
        expect.objectContaining({
          action: "migrate-asset",
          provider: "extension",
          requires_extension: true,
          invocable: true,
          available: true,
          disabled_reason: null,
        }),
      ]);
      expect(result.extension_commands).toEqual([
        expect.objectContaining({
          command: "migrate-asset",
          action: "migrate-asset",
          source: {
            layer: "project",
            name: "migrate-asset-contracts",
          },
          description: "Migrate asset payloads to the current schema version.",
          intent: "Validate and migrate asset payloads before writing output.",
          arguments: [
            {
              name: "assetId",
              required: false,
              variadic: false,
              description: "Optional asset identifier override.",
            },
          ],
          flags: [
            { flag: "--source" },
            { flag: "--target" },
            { flag: "--dry-run" },
          ],
          examples: ["pm migrate-asset --source assets/source.json --target assets/output.json"],
          failure_hints: ["Ensure --source points to an existing readable file."],
        }),
      ]);
      expect(result.command_flags).toEqual([
        expect.objectContaining({
          command: "migrate-asset",
          provider: "extension",
          flags: [
            { flag: "--source" },
            { flag: "--target" },
            { flag: "--dry-run" },
          ],
          extension_sources: [
            {
              layer: "project",
              name: "migrate-asset-contracts",
            },
          ],
        }),
      ]);

      const oneOf = (result.schema.oneOf ?? []) as Array<{
        properties?: {
          action?: { const?: string };
          assetId?: unknown;
          source?: unknown;
          target?: unknown;
          dryRun?: unknown;
        };
        ["x-extension-source"]?: { layer?: string; name?: string } | null;
      }>;
      const migrateBranch = oneOf.find((entry) => entry.properties?.action?.const === "migrate-asset");
      expect(migrateBranch).toBeDefined();
      expect(migrateBranch?.properties?.assetId).toBeDefined();
      expect(migrateBranch?.properties?.source).toBeDefined();
      expect(migrateBranch?.properties?.target).toBeDefined();
      expect(migrateBranch?.properties?.dryRun).toBeDefined();
      expect(migrateBranch?.["x-extension-source"]).toEqual({
        layer: "project",
        name: "migrate-asset-contracts",
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
