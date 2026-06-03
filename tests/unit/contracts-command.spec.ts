import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runContracts } from "../../src/cli/commands/contracts.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import {
  KNOWN_EXTENSION_CAPABILITIES,
  KNOWN_EXTENSION_POLICY_MODES,
  KNOWN_EXTENSION_POLICY_SURFACES,
  KNOWN_EXTENSION_SANDBOX_PROFILES,
  KNOWN_EXTENSION_SERVICE_NAMES,
  KNOWN_EXTENSION_TRUST_MODES,
} from "../../src/core/extensions/extension-types.js";
import type { GlobalOptions } from "../../src/core/shared/command-types.js";
import { readSettings, writeSettings } from "../../src/core/store/settings.js";
import {
  PM_EXTENSION_CAPABILITY_CONTRACTS,
  PM_EXTENSION_POLICY_MODE_CONTRACTS,
  PM_EXTENSION_POLICY_SURFACE_CONTRACTS,
  PM_EXTENSION_SANDBOX_PROFILE_CONTRACTS,
  PM_EXTENSION_SERVICE_NAME_CONTRACTS,
  PM_EXTENSION_TRUST_MODE_CONTRACTS,
} from "../../src/sdk/cli-contracts.js";
import { writeTestExtension } from "../helpers/extensions.js";
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
    expect(result.schema_version).toBe("4.0.2");
    expect(result.schema_id).toBe(
      "https://schema.unbrained.dev/pm-cli/tool-parameters-v4.schema.json",
    );
    expect(result.selected.runtime_only).toBe(false);
    expect(result.actions ?? []).toContain("contracts");
    expect(result.actions ?? []).toContain("aggregate");
    expect(result.actions ?? []).toContain("extension-reload");
    expect(result.actions ?? []).toContain("package-install");
    expect(result.actions ?? []).toContain("package-catalog");
    expect(result.actions ?? []).toContain("install");
    expect(result.actions ?? []).toContain("upgrade");
    expect(result.commands).toContain("contracts");
    expect(result.commands).toContain("aggregate");
    expect(result.commands).toContain("package");
    expect(result.commands).toContain("packages");
    expect(result.commands).toContain("install");
    expect(result.commands).toContain("upgrade");
    expect(result.command_aliases).toEqual(
      expect.arrayContaining([
        { canonical: "context", aliases: ["ctx"] },
        { canonical: "package", aliases: ["extension", "packages", "install"] },
      ]),
    );
    expect(result.schema).toBeUndefined();
    expect(result.schema_omitted_reason).toBe("unfiltered_default_brief");
    expect(result.command_flags).toBeUndefined();
    expect(result.command_flags_omitted_reason).toBe("unfiltered_default_brief");
    expect(result.commander_aliases).toBeUndefined();
    expect(result.commander_aliases_omitted_reason).toBe("unfiltered_default_brief");
    expect(
      (result.action_availability ?? []).some(
        (entry) => entry.action === "create" && entry.invocable,
      ),
    ).toBe(true);
    expect(
      (result.action_availability ?? []).some(
        (entry) =>
          entry.action === "package-install" &&
          entry.command_path === "package install" &&
          entry.cli_exposed,
      ),
    ).toBe(true);
    const packageInstallFlags = await runContracts({ command: "package install", flagsOnly: true }, GLOBAL_OPTIONS);
    expect(packageInstallFlags.command_flags).toEqual([
      expect.objectContaining({
        command: "package install",
        provider: "core",
        flags: expect.arrayContaining([
          expect.objectContaining({ flag: "--project" }),
          expect.objectContaining({ flag: "--github" }),
          expect.objectContaining({ flag: "--ref" }),
        ]),
      }),
    ]);
    const packageCatalogFlags = await runContracts({ command: "package catalog", flagsOnly: true }, GLOBAL_OPTIONS);
    expect(packageCatalogFlags.command_flags?.[0]?.flags).toEqual(
      expect.arrayContaining([expect.objectContaining({ flag: "--fields" })]),
    );
    const optionalCalendarAvailability = await runContracts(
      { command: "calendar", availabilityOnly: true, runtimeOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(optionalCalendarAvailability.action_availability).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "calendar",
        available: false,
        disabled_reason: "optional_package_not_installed:calendar",
      }),
    ]));
    const fullResult = await runContracts({ full: true }, GLOBAL_OPTIONS);
    expect(fullResult.schema).toBeDefined();
    expect(fullResult.schema_omitted_reason).toBeUndefined();
    expect(
      fullResult.command_flags?.some((entry) => entry.command === "contracts"),
    ).toBe(true);
    expect(
      fullResult.command_flags?.find((entry) => entry.command === "aggregate")
        ?.flags,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ flag: "--group-by" }),
        expect.objectContaining({ flag: "--count" }),
      ]),
    );
    expect(fullResult.command_flags?.find((entry) => entry.command === "get")?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ flag: "--depth" }),
        expect.objectContaining({ flag: "--full" }),
        expect.objectContaining({ flag: "--fields" }),
      ]),
    );
    expect(fullResult.commander_aliases).toBeDefined();
    expect(
      fullResult.commander_aliases?.create_string_options.length,
    ).toBeGreaterThan(0);
    expect(fullResult.commander_aliases?.list_string_options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "fields" }),
        expect.objectContaining({ target: "sort" }),
      ]),
    );
    expect(result.extension_contracts).toMatchObject({
      capabilities: expect.arrayContaining(["commands", "schema", "services"]),
      services: expect.arrayContaining(["output_format", "history_append"]),
      policy_modes: expect.arrayContaining(["off", "warn", "enforce"]),
      policy_surfaces: expect.arrayContaining([
        "commands.handler",
        "hooks.beforecommand",
        "search.provider",
      ]),
      trust_modes: expect.arrayContaining(["off", "warn", "enforce"]),
      sandbox_profiles: expect.arrayContaining([
        "none",
        "restricted",
        "strict",
      ]),
      manifest_versions: [1, 2],
      compatibility: {
        current: "v2",
        previous: ["v1"],
        breaking_strategy: "versioned_breaking",
      },
    });
    expect(result.extension_contracts?.capabilities).toEqual([...KNOWN_EXTENSION_CAPABILITIES]);
    expect(result.extension_contracts?.services).toEqual([...KNOWN_EXTENSION_SERVICE_NAMES]);
    expect(result.extension_contracts?.policy_modes).toEqual([...KNOWN_EXTENSION_POLICY_MODES]);
    expect(result.extension_contracts?.policy_surfaces).toEqual([...KNOWN_EXTENSION_POLICY_SURFACES]);
    expect(result.extension_contracts?.trust_modes).toEqual([...KNOWN_EXTENSION_TRUST_MODES]);
    expect(result.extension_contracts?.sandbox_profiles).toEqual([...KNOWN_EXTENSION_SANDBOX_PROFILES]);
    expect(PM_EXTENSION_CAPABILITY_CONTRACTS).toEqual(KNOWN_EXTENSION_CAPABILITIES);
    expect(PM_EXTENSION_SERVICE_NAME_CONTRACTS).toEqual(KNOWN_EXTENSION_SERVICE_NAMES);
    expect(PM_EXTENSION_POLICY_MODE_CONTRACTS).toEqual(KNOWN_EXTENSION_POLICY_MODES);
    expect(PM_EXTENSION_POLICY_SURFACE_CONTRACTS).toEqual(KNOWN_EXTENSION_POLICY_SURFACES);
    expect(PM_EXTENSION_TRUST_MODE_CONTRACTS).toEqual(KNOWN_EXTENSION_TRUST_MODES);
    expect(PM_EXTENSION_SANDBOX_PROFILE_CONTRACTS).toEqual(KNOWN_EXTENSION_SANDBOX_PROFILES);
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
    const oneOf = (result.schema?.oneOf ?? []) as Array<{
      properties?: { action?: { const?: string } };
    }>;
    expect(oneOf).toHaveLength(1);
    expect(oneOf[0]?.properties?.action?.const).toBe("create");
    const createRequiredContracts = (oneOf[0] as Record<string, unknown>)[
      "x-create-required-options"
    ] as
      | {
          default_create_mode?: string;
          by_create_mode?: {
            strict?: {
              by_type?: Record<string, { required_flags?: string[] }>;
            };
            progressive?: {
              by_type?: Record<string, { required_flags?: string[] }>;
            };
          };
        }
      | undefined;
    expect(createRequiredContracts?.default_create_mode).toBe("strict");
    expect(
      createRequiredContracts?.by_create_mode?.strict?.by_type?.Task
        ?.required_flags,
    ).toEqual(
      expect.arrayContaining([
        "--title",
        "--description",
        "--type",
        "--status",
        "--priority",
        "--message",
        "--dep",
        "--comment",
        "--doc",
      ]),
    );
    expect(
      createRequiredContracts?.by_create_mode?.progressive?.by_type?.Task
        ?.required_flags,
    ).toEqual(expect.arrayContaining(["--title", "--type"]));
    expect(
      createRequiredContracts?.by_create_mode?.progressive?.by_type?.Task
        ?.required_flags,
    ).not.toEqual(expect.arrayContaining(["--dep", "--comment", "--doc", "--description"]));
  });

  it("exposes activity projection flags in the action schema", async () => {
    const result = await runContracts(
      {
        action: "activity",
        schemaOnly: true,
      },
      GLOBAL_OPTIONS,
    );
    const oneOf = (result.schema?.oneOf ?? []) as Array<{
      properties?: Record<string, unknown>;
    }>;

    expect(oneOf).toHaveLength(1);
    expect(oneOf[0]?.properties).toHaveProperty("compact");
    expect(oneOf[0]?.properties).toHaveProperty("full");
  });

  it("assigns allowAuditUpdate only to update-family action schemas", async () => {
    const createResult = await runContracts(
      {
        action: "create",
        schemaOnly: true,
      },
      GLOBAL_OPTIONS,
    );
    const updateResult = await runContracts(
      {
        action: "update",
        schemaOnly: true,
      },
      GLOBAL_OPTIONS,
    );
    const createSchema = (createResult.schema?.oneOf ?? [])[0] as { properties?: Record<string, unknown> } | undefined;
    const updateSchema = (updateResult.schema?.oneOf ?? [])[0] as { properties?: Record<string, unknown> } | undefined;

    expect(createSchema?.properties).not.toHaveProperty("allowAuditUpdate");
    expect(updateSchema?.properties).toHaveProperty("allowAuditUpdate");
  });

  it("accepts health and validate diagnostic flags in action schemas", async () => {
    const healthResult = await runContracts(
      {
        action: "health",
        schemaOnly: true,
      },
      GLOBAL_OPTIONS,
    );
    const validateResult = await runContracts(
      {
        action: "validate",
        schemaOnly: true,
      },
      GLOBAL_OPTIONS,
    );
    const healthSchema = (healthResult.schema?.oneOf ?? [])[0] as { properties?: Record<string, unknown> } | undefined;
    const validateSchema = (validateResult.schema?.oneOf ?? [])[0] as { properties?: Record<string, unknown> } | undefined;

    expect(healthSchema?.properties).toEqual(
      expect.objectContaining({
        skipVectors: expect.objectContaining({ type: "boolean" }),
        skipIntegrity: expect.objectContaining({ type: "boolean" }),
        skipDrift: expect.objectContaining({ type: "boolean" }),
      }),
    );
    expect(validateSchema?.properties).toEqual(
      expect.objectContaining({
        verboseDiagnostics: expect.objectContaining({ type: "boolean" }),
      }),
    );
  });

  it("emits a usable plan action schema for strict clients", async () => {
    const result = await runContracts(
      {
        action: "plan",
        schemaOnly: true,
      },
      GLOBAL_OPTIONS,
    );
    const oneOf = (result.schema?.oneOf ?? []) as Array<{
      required?: string[];
      properties?: Record<string, { type?: string; enum?: string[]; anyOf?: Array<{ type?: string }> }>;
    }>;
    const planSchema = oneOf[0];

    expect(planSchema?.required).toEqual(["action", "subcommand"]);
    expect(planSchema?.properties?.subcommand?.enum).toEqual(
      expect.arrayContaining(["create", "show", "add-step", "materialize"]),
    );
    expect(planSchema?.properties?.stepRef?.type).toBe("string");
    expect(planSchema?.properties?.reorderTo?.anyOf).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "number" })]),
    );
    expect(planSchema?.properties?.scope).toMatchObject({ type: "string" });
    expect(planSchema?.properties?.scope).not.toHaveProperty("enum");
    expect(planSchema?.properties?.mode?.enum).toEqual(
      expect.arrayContaining(["draft", "research", "approved", "completed"]),
    );
    expect(planSchema?.properties?.file?.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "string" }),
        expect.objectContaining({ type: "array" }),
      ]),
    );
    expect(planSchema?.properties?.test?.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "string" }),
        expect.objectContaining({ type: "array" }),
      ]),
    );
    expect(planSchema?.properties?.doc?.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "string" }),
        expect.objectContaining({ type: "array" }),
      ]),
    );
  });

  it("includes runtime field flags for list aliases and runtime schema command metadata", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      settings.schema.fields = [
        ...(settings.schema.fields ?? []),
        {
          key: "customer_segment",
          type: "string",
          commands: ["list", "create", "update", "search"],
          cli_aliases: ["segment"],
        },
      ];
      await writeSettings(context.pmPath, settings, "settings:write");

      const listAliasContracts = await runContracts(
        { command: "list-open", flagsOnly: true },
        {
          ...GLOBAL_OPTIONS,
          path: context.pmPath,
        },
      );
      expect(listAliasContracts.command_flags?.[0]?.flags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ flag: "--customer-segment" }),
          expect.objectContaining({ flag: "--segment" }),
        ]),
      );

      const runtimeContracts = await runContracts(
        {},
        {
          ...GLOBAL_OPTIONS,
          path: context.pmPath,
        },
      );
      expect(runtimeContracts.runtime_schema.fields_by_command.list).toEqual(
        expect.arrayContaining(["--customer-segment"]),
      );
    });
  });

  it("supports runtime-only filtering without advertising optional package actions as static core actions", async () => {
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
    expect(
      (result.action_availability ?? []).every((entry) => entry.invocable),
    ).toBe(true);

    const fullResult = await runContracts(
      {},
      {
        ...GLOBAL_OPTIONS,
        noExtensions: true,
      },
    );
    expect(fullResult.actions ?? []).not.toContain("beads-import");
    expect(
      (fullResult.action_availability ?? []).some(
        (entry) => entry.action === "beads-import",
      ),
    ).toBe(false);
  });

  it("narrows action and schema scope by command filter by default", async () => {
    const result = await runContracts(
      { command: "list", runtimeOnly: true },
      GLOBAL_OPTIONS,
    );
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
    const oneOf = (result.schema?.oneOf ?? []) as Array<{
      properties?: { action?: { const?: string } };
    }>;
    expect(oneOf).toHaveLength(1);
    expect(oneOf[0]?.properties?.action?.const).toBe("list");
  });

  it("supports lightweight flags-only and availability-only projections", async () => {
    const flagsOnly = await runContracts(
      { command: "update", flagsOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(flagsOnly.selected.flags_only).toBe(true);
    expect(flagsOnly.selected.availability_only).toBe(false);
    expect(flagsOnly.command_flags?.map((entry) => entry.command)).toEqual([
      "update",
    ]);
    expect(flagsOnly.schema).toBeUndefined();
    expect(flagsOnly.actions).toBeUndefined();
    expect(flagsOnly.action_availability).toBeUndefined();
    expect(flagsOnly.commander_aliases).toBeUndefined();

    const appendFlags = await runContracts(
      { command: "append", flagsOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(appendFlags.command_flags?.[0]?.flags).toEqual(
      expect.arrayContaining([expect.objectContaining({ flag: "--body" })]),
    );

    const createFlags = await runContracts(
      { command: "create", flagsOnly: true },
      GLOBAL_OPTIONS,
    );
    const createAcceptanceFlag = createFlags.command_flags?.[0]?.flags.find(
      (entry) => entry.flag === "--acceptance-criteria",
    );
    expect(createAcceptanceFlag?.aliases).toEqual(
      expect.arrayContaining(["--acceptance_criteria"]),
    );
    expect(
      createFlags.command_flags?.[0]?.flags.some(
        (entry) => entry.flag === "--acceptance_criteria",
      ),
    ).toBe(false);

    const updateFlags = await runContracts(
      { command: "update", flagsOnly: true },
      GLOBAL_OPTIONS,
    );
    const updateWhyNowFlag = updateFlags.command_flags?.[0]?.flags.find(
      (entry) => entry.flag === "--why-now",
    );
    expect(updateWhyNowFlag?.aliases).toEqual(
      expect.arrayContaining(["--why_now"]),
    );
    expect(
      updateFlags.command_flags?.[0]?.flags.some(
        (entry) => entry.flag === "--why_now",
      ),
    ).toBe(false);

    const initFlags = await runContracts(
      { command: "init", flagsOnly: true },
      GLOBAL_OPTIONS,
    );
    const initDefaultsFlag = initFlags.command_flags?.[0]?.flags.find(
      (entry) => entry.flag === "--defaults",
    );
    expect(initDefaultsFlag).toMatchObject({
      flag: "--defaults",
      short: "-y",
    });
    expect(initDefaultsFlag?.aliases).toEqual(expect.arrayContaining(["--yes"]));
    expect(
      initFlags.command_flags?.[0]?.flags.some(
        (entry) => entry.flag === "--yes",
      ),
    ).toBe(false);
    expect(initFlags.command_flags?.[0]?.flags.some((entry) => entry.flag === "--verbose")).toBe(true);
    expect(initFlags.command_flags?.[0]?.flags.some((entry) => entry.flag === "--type-preset")).toBe(true);

    const schemaAction = await runContracts(
      { action: "schema", schemaOnly: true },
      GLOBAL_OPTIONS,
    );
    const schemaBranch = (schemaAction.schema?.oneOf ?? [])[0] as { required?: string[]; properties?: Record<string, unknown> } | undefined;
    expect(schemaBranch?.required).toEqual(["action", "subcommand"]);
    expect(schemaBranch?.properties?.name).toBeDefined();
    expect(schemaBranch).toMatchObject({
      allOf: expect.arrayContaining([
        expect.objectContaining({
          if: { properties: { subcommand: { const: "show" } }, required: ["subcommand"] },
          then: { required: ["name"] },
        }),
      ]),
    });

    const activityFlags = await runContracts(
      { command: "activity", flagsOnly: true },
      GLOBAL_OPTIONS,
    );
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

    const compactFlags = await runContracts(
      { flagsOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(compactFlags.commands).toContain("context");
    expect(compactFlags.commands).toContain("package");
    expect(compactFlags.commands).not.toContain("ctx");
    expect(compactFlags.commands).not.toContain("extension");
    expect(compactFlags.commands).not.toContain("packages");
    expect(compactFlags.commands).not.toContain("install");
    expect(
      compactFlags.command_flags?.some((entry) => entry.command === "ctx"),
    ).toBe(false);
    expect(
      compactFlags.command_flags?.some(
        (entry) => entry.command === "extension",
      ),
    ).toBe(false);
    expect(
      compactFlags.command_flags?.some((entry) => entry.command === "packages"),
    ).toBe(false);
    expect(
      compactFlags.command_flags?.some((entry) => entry.command === "install"),
    ).toBe(false);
    expect(compactFlags.command_aliases).toEqual(
      expect.arrayContaining([
        { canonical: "context", aliases: ["ctx"] },
        { canonical: "package", aliases: ["extension", "packages", "install"] },
      ]),
    );

    const selectedAliasFlags = await runContracts(
      { command: "ctx", flagsOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(selectedAliasFlags.commands).toEqual(["ctx"]);
    expect(
      selectedAliasFlags.command_flags?.map((entry) => entry.command),
    ).toEqual(["ctx"]);

    const installFlags = await runContracts(
      { command: "install", flagsOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(installFlags.command_flags?.[0]?.flags).toEqual([
      { flag: "--project" },
      { flag: "--local" },
      { flag: "--global" },
      { flag: "--gh" },
      { flag: "--github" },
      { flag: "--ref" },
    ]);
    expect(
      installFlags.command_flags?.[0]?.flags.some(
        (entry) => entry.flag === "--doctor" || entry.flag === "--init",
      ),
    ).toBe(false);

    const commandFlagParityChecks: Array<{ command: string; flags: string[] }> =
      [
        {
          command: "create",
          flags: [
            "--acceptance-criteria",
            "--definition-of-ready",
            "--blocked-by",
            "--why-now",
            "--customer-impact",
          ],
        },
        {
          command: "update",
          flags: [
            "--acceptance-criteria",
            "--definition-of-ready",
            "--blocked-by",
            "--why-now",
            "--customer-impact",
          ],
        },
        {
          command: "update-many",
          flags: [
            "--acceptance-criteria",
            "--definition-of-ready",
            "--why-now",
            "--customer-impact",
          ],
        },
        {
          command: "comments",
          flags: ["--add", "--stdin", "--file", "--allow-audit-comment"],
        },
        {
          command: "notes",
          flags: [
            "--add",
            "--limit",
            "--author",
            "--message",
            "--allow-audit-note",
            "--allow-audit-comment",
            "--force",
          ],
        },
        {
          command: "learnings",
          flags: [
            "--add",
            "--limit",
            "--author",
            "--message",
            "--allow-audit-learning",
            "--allow-audit-comment",
            "--force",
          ],
        },
        {
          command: "files",
          flags: [
            "--add",
            "--add-glob",
            "--list",
            "--append-stable",
            "--validate-paths",
            "--audit",
          ],
        },
        {
          command: "docs",
          flags: ["--add", "--add-glob", "--validate-paths", "--audit"],
        },
        { command: "history", flags: ["--limit", "--compact", "--full", "--diff", "--verify"] },
        {
          command: "history-redact",
          flags: ["--literal", "--regex", "--replacement", "--dry-run", "--author", "--message", "--force"],
        },
        {
          command: "plan",
          flags: [
            "--title",
            "--scope",
            "--harness",
            "--mode",
            "--resume-context",
            "--step-title",
            "--step-status",
            "--step-evidence",
            "--depends-on",
            "--link",
            "--link-kind",
            "--depth",
            "--steps",
            "--materialize-type",
            "--decision-text",
            "--discovery-text",
            "--validation-text",
            "--allow-multiple-active",
            "--promote-to-item-dep",
            "--author",
            "--message",
            "--force",
          ],
        },
        {
          command: "config",
          flags: ["--criterion", "--clear-criteria", "--format", "--policy"],
        },
        {
          command: "init",
          flags: ["--preset", "--defaults", "--author", "--agent-guidance", "--with-packages"],
        },
        { command: "restore", flags: ["--author", "--message", "--force"] },
        { command: "delete", flags: ["--dry-run", "--author", "--message", "--force"] },
        {
          command: "test",
          flags: [
            "--run",
            "--background",
            "--pm-context",
            "--override-linked-pm-context",
            "--fail-on-empty-test-run",
            "--check-context",
            "--auto-pm-context",
          ],
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
            "--check-context",
            "--auto-pm-context",
          ],
        },
        { command: "gc", flags: ["--dry-run", "--scope"] },
        {
          command: "list-open",
          flags: ["--compact", "--brief", "--full", "--fields", "--include-body"],
        },
        {
          command: "search",
          flags: ["--mode", "--semantic", "--hybrid", "--include-linked"],
        },
        {
          command: "extension",
          flags: [
            "--init",
            "--install",
            "--doctor",
            "--catalog",
            "--runtime-probe",
            "--strict-exit",
          ],
        },
        {
          command: "package",
          flags: [
            "--init",
            "--install",
            "--doctor",
            "--catalog",
            "--runtime-probe",
            "--strict-exit",
          ],
        },
        {
          command: "packages install",
          flags: ["--gh", "--github", "--ref", "--project", "--global"],
        },
        {
          command: "package catalog",
          flags: ["--fields", "--project", "--global"],
        },
        {
          command: "install",
          flags: ["--gh", "--github", "--ref", "--project", "--global"],
        },
        {
          command: "upgrade",
          flags: [
            "--dry-run",
            "--cli-only",
            "--packages-only",
            "--repair",
            "--tag",
          ],
        },
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
          flags: [
            "--check-metadata",
            "--metadata-profile",
            "--check-lifecycle",
            "--check-stale-blockers",
            "--dependency-cycle-severity",
            "--verbose-file-lists",
            "--verbose-diagnostics",
          ],
        },
        {
          command: "health",
          flags: [
            "--check-only",
            "--no-refresh",
            "--refresh-vectors",
            "--verbose-stale-items",
            "--brief",
            "--summary",
            "--skip-vectors",
            "--skip-integrity",
            "--skip-drift",
            "--full",
          ],
        },
      ];
    for (const check of commandFlagParityChecks) {
      const parityResult = await runContracts(
        { command: check.command, flagsOnly: true },
        GLOBAL_OPTIONS,
      );
      expect(parityResult.command_flags?.[0]?.flags).toEqual(
        expect.arrayContaining(
          check.flags.map((flag) => expect.objectContaining({ flag })),
        ),
      );
      if (check.command === "plan") {
        expect(parityResult.command_flags?.[0]?.flags).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ flag: "--step-title", aliases: expect.arrayContaining(["--step"]) }),
          ]),
        );
      }
    }

    const availabilityOnly = await runContracts(
      { command: "update", availabilityOnly: true },
      GLOBAL_OPTIONS,
    );
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

    const optionalActionAvailability = await runContracts(
      { action: "calendar", availabilityOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(optionalActionAvailability.actions).toEqual(["calendar"]);
    expect(optionalActionAvailability.action_availability).toEqual([
      expect.objectContaining({
        action: "calendar",
        command_path: "calendar|cal",
        disabled_reason: "optional_package_not_installed:calendar",
      }),
    ]);

    const optionalRootCommandAvailability = await runContracts(
      { command: "templates", availabilityOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(optionalRootCommandAvailability.actions).toEqual(["templates-list"]);
    expect(optionalRootCommandAvailability.action_availability).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "templates-list",
        disabled_reason: "optional_package_not_installed:templates",
      }),
    ]));
  });

  it("scopes command_flags by action when no command filter is provided", async () => {
    const commentsAction = await runContracts(
      { action: "comments", flagsOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(commentsAction.commands).toEqual(["comments"]);
    expect(commentsAction.command_flags?.map((entry) => entry.command)).toEqual(
      ["comments"],
    );
    expect(commentsAction.command_flags?.[0]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ flag: "--stdin" }),
        expect.objectContaining({ flag: "--file" }),
        expect.objectContaining({ flag: "--allow-audit-comment" }),
      ]),
    );
  });

  it("rejects conflicting contracts projection flags", async () => {
    await expect(
      runContracts({ schemaOnly: true, flagsOnly: true }, GLOBAL_OPTIONS),
    ).rejects.toMatchObject<PmCliError>({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(
      runContracts({ flagsOnly: true, availabilityOnly: true }, GLOBAL_OPTIONS),
    ).rejects.toMatchObject<PmCliError>({
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

  it("rejects optional package actions from the static SDK schema when the package command is not installed", async () => {
    await expect(
      runContracts(
        {
          action: "beads-import",
          runtimeOnly: true,
          schemaOnly: true,
        },
        {
          ...GLOBAL_OPTIONS,
          noExtensions: true,
        },
      ),
    ).rejects.toMatchObject<PmCliError>({
      exitCode: EXIT_CODE.USAGE,
    });

    await expect(
      runContracts(
        {
          action: "calendar",
          runtimeOnly: true,
          schemaOnly: true,
        },
        {
          ...GLOBAL_OPTIONS,
          noExtensions: true,
        },
      ),
    ).rejects.toMatchObject<PmCliError>({
      exitCode: EXIT_CODE.USAGE,
    });

    await expect(
      runContracts(
        {
          action: "templates-save",
          runtimeOnly: true,
          schemaOnly: true,
        },
        {
          ...GLOBAL_OPTIONS,
          noExtensions: true,
        },
      ),
    ).rejects.toMatchObject<PmCliError>({
      exitCode: EXIT_CODE.USAGE,
    });
  });

  it("keeps installed extension actions visible in runtime-only mode", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: context.pmPath,
        placement: "projectRoot",
        directory: "beads-contract-action",
        manifest: {
          name: "beads-contract-action",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["commands", "schema"],
        },
        entryFilename: "index.mjs",
        entrySource: [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'beads import',",
          "      action: 'beads-import',",
          "      flags: [{ long: '--file', value_name: 'path', value_type: 'string' }],",
          "      run: () => ({ ok: true }),",
          "    });",
          "  },",
          "};",
          "",
        ].join("\n"),
      });

      const result = await runContracts(
        {
          action: "beads-import",
          runtimeOnly: true,
          schemaOnly: true,
        },
        {
          ...GLOBAL_OPTIONS,
          path: context.pmPath,
        },
      );
      expect(result.actions).toEqual(["beads-import"]);
      expect(result.action_availability).toEqual([
        {
          action: "beads-import",
          invocable: true,
          available: true,
          requires_extension: true,
          provider: "extension",
          disabled_reason: null,
          command_path: "beads import",
          cli_exposed: true,
          policy_state: {
            mode: "off",
            trust_mode: "off",
            default_sandbox_profile: "none",
          },
        },
      ]);
      const oneOf = (result.schema?.oneOf ?? []) as Array<{
        properties?: { action?: { const?: string } };
      }>;
      expect(oneOf).toHaveLength(1);
      expect(oneOf[0]?.properties?.action?.const).toBe("beads-import");
    });
  });

  it("does not synthesize optional package action availability when extension runtime probing fails before activation", async () => {
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

      expect(result.actions ?? []).not.toContain("beads-import");
      expect(
        (result.action_availability ?? []).some(
          (entry) => entry.action === "beads-import",
        ),
      ).toBe(false);
    });
  });

  it("merges active extension command/action schemas into contracts output", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: context.pmPath,
        placement: "projectRoot",
        directory: "migrate-asset-contracts",
        manifest: {
          name: "migrate-asset-contracts",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["commands", "schema"],
        },
        entryFilename: "index.mjs",
        entrySource: [
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
      });

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
            { flag: "--source", description: "Source asset payload path.", required: true, value_name: "path", value_type: "string" },
            { flag: "--target", description: "Destination payload path.", value_name: "path", value_type: "string" },
            { flag: "--dry-run", description: "Preview migration only." },
          ],
          examples: [
            "pm migrate-asset --source assets/source.json --target assets/output.json",
          ],
          failure_hints: [
            "Ensure --source points to an existing readable file.",
          ],
        }),
      ]);
      expect(result.command_flags).toEqual([
        expect.objectContaining({
          command: "migrate-asset",
          provider: "extension",
          flags: [
            { flag: "--source", description: "Source asset payload path.", required: true, value_name: "path", value_type: "string" },
            { flag: "--target", description: "Destination payload path.", value_name: "path", value_type: "string" },
            { flag: "--dry-run", description: "Preview migration only." },
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
        ["x-extension-commands"]?: string[];
      }>;
      const migrateBranch = oneOf.find(
        (entry) => entry.properties?.action?.const === "migrate-asset",
      );
      expect(migrateBranch).toBeDefined();
      expect(migrateBranch?.properties?.assetId).toBeDefined();
      expect(migrateBranch?.properties?.source).toBeDefined();
      expect(migrateBranch?.properties?.target).toBeDefined();
      expect(migrateBranch?.properties?.dryRun).toBeDefined();
      expect(migrateBranch?.properties?.source).toMatchObject({ type: "string" });
      expect(migrateBranch?.properties?.dryRun).toMatchObject({ type: "boolean" });
      expect((migrateBranch as { required?: string[] } | undefined)?.required).toContain("source");
      expect(migrateBranch?.["x-extension-source"]).toEqual({
        layer: "project",
        name: "migrate-asset-contracts",
      });
      expect(migrateBranch?.["x-extension-commands"]).toEqual(["migrate-asset"]);
    });
  });

  it("deduplicates extension schema branches by action while preserving command aliases", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: context.pmPath,
        placement: "projectRoot",
        directory: "alias-action-contracts",
        manifest: {
          name: "alias-action-contracts",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["commands", "schema"],
        },
        entryFilename: "index.mjs",
        entrySource: [
          "const flags = [{ long: '--view', value_name: 'value', value_type: 'string', description: 'View.' }];",
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({ name: 'alias-main', action: 'alias-action', flags, run: () => ({ ok: true }) });",
          "    api.registerCommand({ name: 'alias-short', action: 'alias-action', flags, run: () => ({ ok: true }) });",
          "  },",
          "};",
          "",
        ].join("\n"),
      });

      const result = await runContracts(
        { action: "alias-action", schemaOnly: true },
        { ...GLOBAL_OPTIONS, path: context.pmPath },
      );
      const branches = (result.schema?.oneOf ?? []) as Array<{
        properties?: { action?: { const?: string }; view?: unknown };
        ["x-extension-commands"]?: string[];
      }>;
      expect(branches.filter((branch) => branch.properties?.action?.const === "alias-action")).toHaveLength(1);
      expect(branches[0]?.["x-extension-commands"]).toEqual(["alias-main", "alias-short"]);
      expect(branches[0]?.properties?.view).toMatchObject({ type: "string" });
    });
  });

  it("rejects unknown action and command filters", async () => {
    await expect(
      runContracts({ action: "unknown-action" }, GLOBAL_OPTIONS),
    ).rejects.toMatchObject<PmCliError>({
      message: 'Unknown action: "unknown-action".',
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(
      runContracts({ command: "unknown-command" }, GLOBAL_OPTIONS),
    ).rejects.toMatchObject<PmCliError>({
      message: 'Unknown command: "unknown-command".',
      exitCode: EXIT_CODE.USAGE,
      context: expect.objectContaining({
        code: "unknown_command",
        required: expect.any(String),
        why: expect.any(String),
        examples: expect.arrayContaining(["pm contracts --flags-only --json"]),
        nextSteps: expect.arrayContaining([expect.any(String)]),
        recovery: expect.objectContaining({
          suggested_retry: "pm contracts --flags-only --json",
        }),
      }),
    });
    await expect(
      runContracts({ command: "calendar" }, { ...GLOBAL_OPTIONS, path: "/tmp/pm-contracts-no-calendar" }),
    ).rejects.toMatchObject<PmCliError>({
      message: expect.stringContaining("pm install calendar --project"),
      exitCode: EXIT_CODE.USAGE,
      context: expect.objectContaining({
        code: "unknown_command",
        required: expect.any(String),
        why: expect.any(String),
        examples: expect.arrayContaining(["pm install calendar --project"]),
        nextSteps: expect.arrayContaining([expect.any(String)]),
        recovery: expect.objectContaining({
          suggested_retry: "pm install calendar --project",
        }),
      }),
    });
  });
});
