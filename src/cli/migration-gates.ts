/**
 * @module cli/migration-gates
 *
 * Provides CLI runtime support for Migration Gates.
 */
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

/**
 * Documents the mandatory migration blocker payload exchanged by command, SDK, and package integrations.
 */
export interface MandatoryMigrationBlocker {
  layer: "global" | "project";
  name: string;
  id: string;
  status: string;
}

/**
 * Documents the write gate decision payload exchanged by command, SDK, and package integrations.
 */
export interface WriteGateDecision {
  isMutation: boolean;
  forceCapable: boolean;
  forceRequested: boolean;
}

/**
 * Implements resolve migration id for the public runtime surface of this module.
 */
export function resolveMigrationId(definition: Record<string, unknown>, fallbackIndex: number): string {
  const explicit = toNonEmptyStringOrUndefined(definition.id);
  if (explicit) {
    return explicit;
  }
  return `migration-${String(fallbackIndex + 1).padStart(3, "0")}`;
}

/**
 * Implements resolve normalized migration status for the public runtime surface of this module.
 */
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

/**
 * Implements collect mandatory migration blockers for the public runtime surface of this module.
 */
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

const ALWAYS_MUTATING_COMMANDS = new Set(["create", "beads import", "todos import"]);
const FORCEABLE_MUTATING_COMMANDS = new Set(["restore", "update", "close", "delete", "append", "claim", "release"]);
const TEXT_APPEND_COMMANDS = new Set(["comments", "notes", "learnings"]);
const LIST_MUTATION_COMMANDS = new Set(["files", "docs", "test"]);

/**
 * Implements decide write gate for the public runtime surface of this module.
 */
export function decideWriteGate(commandPath: string, options: Record<string, unknown>): WriteGateDecision {
  const forceRequested = options.force === true;
  if (ALWAYS_MUTATING_COMMANDS.has(commandPath)) {
    return { isMutation: true, forceCapable: false, forceRequested: false };
  }
  if (FORCEABLE_MUTATING_COMMANDS.has(commandPath)) {
    return { isMutation: true, forceCapable: true, forceRequested };
  }
  if (TEXT_APPEND_COMMANDS.has(commandPath)) {
    return { isMutation: typeof options.add === "string", forceCapable: true, forceRequested };
  }
  if (LIST_MUTATION_COMMANDS.has(commandPath)) {
    return {
      isMutation: hasMutatingListValues(options.add) || hasMutatingListValues(options.remove),
      forceCapable: true,
      forceRequested,
    };
  }
  return { isMutation: false, forceCapable: false, forceRequested: false };
}

/**
 * Implements enforce mandatory migration write gate for the public runtime surface of this module.
 */
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

/**
 * Implements enforce item format write gate and preflight migration for the public runtime surface of this module.
 */
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
