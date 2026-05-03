import { pathExists } from "../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations, type PreflightRuntimeDecision } from "../core/extensions/index.js";
import { resolveItemTypeRegistry } from "../core/item/type-registry.js";
import { migrateItemFilesToFormat } from "../core/store/item-format-migration.js";
import { getSettingsPath } from "../core/store/paths.js";
import { readSettingsWithMetadata, writeSettings } from "../core/store/settings.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { toNonEmptyStringOrUndefined } from "../core/shared/primitives.js";
import { printError } from "../core/output/output.js";

export interface MandatoryMigrationBlocker {
  layer: "global" | "project";
  name: string;
  id: string;
  status: string;
}

export interface WriteGateDecision {
  isMutation: boolean;
  forceCapable: boolean;
  forceRequested: boolean;
}

export function resolveMigrationId(definition: Record<string, unknown>, fallbackIndex: number): string {
  const explicit = toNonEmptyStringOrUndefined(definition.id);
  if (explicit) {
    return explicit;
  }
  return `migration-${String(fallbackIndex + 1).padStart(3, "0")}`;
}

export function resolveNormalizedMigrationStatus(definition: Record<string, unknown>): string {
  const normalized = toNonEmptyStringOrUndefined(definition.status)?.toLowerCase();
  return normalized ?? "pending";
}

function isMandatoryMigrationDefinition(definition: Record<string, unknown>): boolean {
  return definition.mandatory === true;
}

function compareMandatoryMigrationBlockers(left: MandatoryMigrationBlocker, right: MandatoryMigrationBlocker): number {
  const byLayer = left.layer.localeCompare(right.layer);
  if (byLayer !== 0) {
    return byLayer;
  }
  const byName = left.name.localeCompare(right.name);
  if (byName !== 0) {
    return byName;
  }
  return left.id.localeCompare(right.id);
}

export function collectMandatoryMigrationBlockers(
  migrations: Array<{
    layer: "global" | "project";
    name: string;
    definition: Record<string, unknown>;
  }>,
): MandatoryMigrationBlocker[] {
  const blockers: MandatoryMigrationBlocker[] = [];
  migrations.forEach((entry, index) => {
    if (!isMandatoryMigrationDefinition(entry.definition)) {
      return;
    }
    const status = resolveNormalizedMigrationStatus(entry.definition);
    if (status === "applied") {
      return;
    }
    blockers.push({
      layer: entry.layer,
      name: entry.name,
      id: resolveMigrationId(entry.definition, index),
      status,
    });
  });
  blockers.sort(compareMandatoryMigrationBlockers);
  return blockers;
}

function hasMutatingListValues(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

export function decideWriteGate(commandPath: string, options: Record<string, unknown>): WriteGateDecision {
  const forceRequested = options.force === true;
  switch (commandPath) {
    case "create":
    case "beads import":
    case "todos import":
      return {
        isMutation: true,
        forceCapable: false,
        forceRequested: false,
      };
    case "restore":
    case "update":
    case "close":
    case "delete":
    case "append":
    case "claim":
    case "release":
      return {
        isMutation: true,
        forceCapable: true,
        forceRequested,
      };
    case "comments":
    case "notes":
    case "learnings":
      return {
        isMutation: typeof options.add === "string",
        forceCapable: true,
        forceRequested,
      };
    case "files":
    case "docs":
    case "test":
      return {
        isMutation: hasMutatingListValues(options.add) || hasMutatingListValues(options.remove),
        forceCapable: true,
        forceRequested,
      };
    default:
      return {
        isMutation: false,
        forceCapable: false,
        forceRequested: false,
      };
  }
}

export function enforceMandatoryMigrationWriteGate(
  commandPath: string,
  options: Record<string, unknown>,
  blockers: MandatoryMigrationBlocker[],
): void {
  if (blockers.length === 0) {
    return;
  }
  const decision = decideWriteGate(commandPath, options);
  if (!decision.isMutation) {
    return;
  }
  if (decision.forceCapable && decision.forceRequested) {
    return;
  }
  const codes = blockers.map(
    (entry) => `extension_migration_blocking:${entry.layer}:${entry.name}:${entry.id}:${entry.status}`,
  );
  const forceGuidance = decision.forceCapable
    ? "Re-run this command with --force to bypass."
    : "This command path does not support --force bypass.";
  throw new PmCliError(
    `Write command "${commandPath}" blocked by unresolved mandatory extension migrations (${codes.join(",")}). ${forceGuidance}`,
    EXIT_CODE.CONFLICT,
  );
}

export async function enforceItemFormatWriteGateAndPreflightMigration(
  commandPath: string,
  options: Record<string, unknown>,
  pmRoot: string,
  decision: PreflightRuntimeDecision,
): Promise<void> {
  const writeGate = decideWriteGate(commandPath, options);
  if (!writeGate.isMutation) {
    return;
  }
  if (!decision.enforce_item_format_gate && !decision.run_preflight_item_format_sync) {
    return;
  }
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    return;
  }
  const { settings, metadata, warnings } = await readSettingsWithMetadata(pmRoot);
  for (const warning of warnings) {
    printError(`warning:${warning}`);
  }
  if (decision.enforce_item_format_gate && !metadata.has_explicit_item_format) {
    await writeSettings(pmRoot, settings, "item_format:auto_select_default");
  }
  if (decision.run_preflight_item_format_sync) {
    const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
    await migrateItemFilesToFormat(
      pmRoot,
      settings.item_format,
      "item_format:pre_mutation_sync",
      typeRegistry.type_to_folder,
      settings.schema,
    );
  }
}
