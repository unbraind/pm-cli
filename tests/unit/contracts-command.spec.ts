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
    expect(result.actions ?? []).toContain("contracts");
    expect(result.actions ?? []).toContain("aggregate");
    expect(result.actions ?? []).toContain("dedupe-audit");
    expect(result.commands).toContain("contracts");
    expect(result.commands).toContain("aggregate");
    expect(result.commands).toContain("dedupe-audit");
    expect((result.action_availability ?? []).some((entry) => entry.action === "create" && entry.invocable)).toBe(true);
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
    const oneOf = (result.schema?.oneOf ?? []) as Array<{ properties?: { action?: { const?: string } } }>;
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
    expect(result.actions ?? []).not.toContain("beads-import");
    expect(result.actions ?? []).toContain("validate");
    expect((result.action_availability ?? []).every((entry) => entry.invocable)).toBe(true);

    const fullResult = await runContracts(
      {},
      {
        ...GLOBAL_OPTIONS,
        noExtensions: true,
      },
    );
    const beadsAvailability = (fullResult.action_availability ?? []).find((entry) => entry.action === "beads-import");
    expect(beadsAvailability).toMatchObject({
      action: "beads-import",
      requires_extension: true,
      provider: "extension",
      invocable: false,
      available: false,
      disabled_reason: "extensions_disabled",
      command_path: "beads import",
      cli_exposed: false,
    });
  });

  it("narrows action and schema scope by command filter by default", async () => {
    const result = await runContracts({ command: "list", runtimeOnly: true }, GLOBAL_OPTIONS);
    expect(result.selected.command).toBe("list");
    expect(result.selected.command_scoped).toBe(true);
    expect(result.actions).toEqual(["list"]);
    expect(result.action_availability).toEqual([
      expect.objectContaining({
        action: "list",
        command_path: "list",
        cli_exposed: true,
      }),
    ]);
    expect(result.commands).toEqual(["list"]);
    const oneOf = (result.schema?.oneOf ?? []) as Array<{ properties?: { action?: { const?: string } } }>;
    expect(oneOf).toHaveLength(1);
    expect(oneOf[0]?.properties?.action?.const).toBe("list");
  });

  it("supports lightweight flags-only and availability-only projections", async () => {
    const flagsOnly = await runContracts({ command: "update", flagsOnly: true }, GLOBAL_OPTIONS);
    expect(flagsOnly.selected.flags_only).toBe(true);
    expect(flagsOnly.selected.availability_only).toBe(false);
    expect(flagsOnly.command_flags?.map((entry) => entry.command)).toEqual(["update"]);
    expect(flagsOnly.schema).toBeUndefined();
    expect(flagsOnly.actions).toBeUndefined();
    expect(flagsOnly.action_availability).toBeUndefined();
    expect(flagsOnly.commander_aliases).toBeUndefined();

    const appendFlags = await runContracts({ command: "append", flagsOnly: true }, GLOBAL_OPTIONS);
    expect(appendFlags.command_flags?.[0]?.flags).toEqual(
      expect.arrayContaining([expect.objectContaining({ flag: "--body" })]),
    );

    const completionFlags = await runContracts({ command: "completion", flagsOnly: true }, GLOBAL_OPTIONS);
    expect(completionFlags.command_flags?.[0]?.flags).toEqual(
      expect.arrayContaining([expect.objectContaining({ flag: "--eager-tags" })]),
    );

    const calendarFlags = await runContracts({ command: "calendar", flagsOnly: true }, GLOBAL_OPTIONS);
    expect(calendarFlags.command_flags?.[0]?.flags).toEqual(
      expect.arrayContaining([expect.objectContaining({ flag: "--full-period" })]),
    );

    const activityFlags = await runContracts({ command: "activity", flagsOnly: true }, GLOBAL_OPTIONS);
    expect(activityFlags.command_flags?.[0]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ flag: "--id" }),
        expect.objectContaining({ flag: "--op" }),
        expect.objectContaining({ flag: "--author" }),
        expect.objectContaining({ flag: "--from" }),
        expect.objectContaining({ flag: "--to" }),
        expect.objectContaining({ flag: "--stream" }),
      ]),
    );

    const commandFlagParityChecks: Array<{ command: string; flags: string[] }> = [
      { command: "comments", flags: ["--add", "--allow-audit-comment"] },
      { command: "comments-audit", flags: ["--assignee-filter", "--limit-items", "--limit", "--full-history", "--latest"] },
      { command: "notes", flags: ["--add", "--limit", "--author", "--message", "--allow-audit-note", "--allow-audit-comment", "--force"] },
      {
        command: "learnings",
        flags: ["--add", "--limit", "--author", "--message", "--allow-audit-learning", "--allow-audit-comment", "--force"],
      },
      { command: "files", flags: ["--add", "--add-glob", "--append-stable", "--validate-paths", "--audit"] },
      { command: "docs", flags: ["--add", "--add-glob", "--validate-paths", "--audit"] },
      { command: "history", flags: ["--limit", "--diff", "--verify"] },
      { command: "config", flags: ["--criterion", "--clear-criteria", "--format", "--policy"] },
      { command: "restore", flags: ["--author", "--message", "--force"] },
      { command: "delete", flags: ["--author", "--message", "--force"] },
      {
        command: "test",
        flags: ["--run", "--background", "--pm-context", "--override-linked-pm-context", "--fail-on-empty-test-run"],
      },
      {
        command: "test-all",
        flags: [
          "--status",
          "--limit",
          "--offset",
          "--background",
          "--pm-context",
          "--override-linked-pm-context",
          "--fail-on-empty-test-run",
        ],
      },
      { command: "extension", flags: ["--install", "--doctor", "--runtime-probe", "--strict-exit"] },
      { command: "test-runs", flags: ["--status", "--limit", "--stream", "--tail", "--force", "--author"] },
      {
        command: "update-many",
        flags: [
          "--filter-status",
          "--dry-run",
          "--rollback",
          "--no-checkpoint",
          "--dep",
          "--replace-tests",
          "--clear-docs",
          "--clear-events",
          "--allow-audit-update",
        ],
      },
      {
        command: "validate",
        flags: ["--check-metadata", "--metadata-profile", "--check-lifecycle", "--check-stale-blockers", "--verbose-file-lists"],
      },
      { command: "health", flags: ["--check-only", "--no-refresh", "--refresh-vectors", "--verbose-stale-items"] },
    ];
    for (const check of commandFlagParityChecks) {
      const parityResult = await runContracts({ command: check.command, flagsOnly: true }, GLOBAL_OPTIONS);
      expect(parityResult.command_flags?.[0]?.flags).toEqual(
        expect.arrayContaining(check.flags.map((flag) => expect.objectContaining({ flag }))),
      );
    }

    const availabilityOnly = await runContracts({ command: "update", availabilityOnly: true }, GLOBAL_OPTIONS);
    expect(availabilityOnly.selected.flags_only).toBe(false);
    expect(availabilityOnly.selected.availability_only).toBe(true);
    expect(availabilityOnly.actions).toEqual(["update"]);
    expect(availabilityOnly.action_availability).toEqual([
      expect.objectContaining({
        action: "update",
        command_path: "update",
        cli_exposed: true,
      }),
    ]);
    expect(availabilityOnly.schema).toBeUndefined();
    expect(availabilityOnly.command_flags).toBeUndefined();
    expect(availabilityOnly.commander_aliases).toBeUndefined();
  });

  it("scopes command_flags by action when no command filter is provided", async () => {
    const commentsAction = await runContracts({ action: "comments", flagsOnly: true }, GLOBAL_OPTIONS);
    expect(commentsAction.commands).toEqual(["comments"]);
    expect(commentsAction.command_flags?.map((entry) => entry.command)).toEqual(["comments"]);
    expect(commentsAction.command_flags?.[0]?.flags).toEqual(
      expect.arrayContaining([expect.objectContaining({ flag: "--allow-audit-comment" })]),
    );

    const testRunsListAction = await runContracts({ action: "test-runs-list", flagsOnly: true }, GLOBAL_OPTIONS);
    expect(testRunsListAction.commands).toEqual(["test-runs"]);
    expect(testRunsListAction.command_flags?.map((entry) => entry.command)).toEqual(["test-runs"]);
    expect(testRunsListAction.command_flags?.[0]?.flags).toEqual(
      expect.arrayContaining([expect.objectContaining({ flag: "--status" }), expect.objectContaining({ flag: "--tail" })]),
    );
  });

  it("rejects conflicting contracts projection flags", async () => {
    await expect(runContracts({ schemaOnly: true, flagsOnly: true }, GLOBAL_OPTIONS)).rejects.toMatchObject<PmCliError>({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(runContracts({ flagsOnly: true, availabilityOnly: true }, GLOBAL_OPTIONS)).rejects.toMatchObject<PmCliError>({
      exitCode: EXIT_CODE.USAGE,
    });
  });

  it("reports lifecycle action command-path discoverability metadata", async () => {
    const result = await runContracts({ action: "start-task" }, GLOBAL_OPTIONS);
    expect(result.actions).toEqual(["start-task"]);
    expect(result.action_availability).toEqual([
      expect.objectContaining({
        action: "start-task",
        command_path: "start-task",
        cli_exposed: true,
      }),
    ]);
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
        command_path: "beads import",
        cli_exposed: false,
      },
    ]);
    const oneOf = (result.schema?.oneOf ?? []) as Array<{ properties?: { action?: { const?: string } } }>;
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

      const beadsAvailability = (result.action_availability ?? []).find((entry) => entry.action === "beads-import");
      expect(beadsAvailability).toMatchObject({
        action: "beads-import",
        invocable: false,
        available: false,
        requires_extension: true,
        provider: "extension",
        disabled_reason: "extension_runtime_probe_failed",
        command_path: "beads import",
        cli_exposed: false,
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

      const oneOf = (result.schema?.oneOf ?? []) as Array<{
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
