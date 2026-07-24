/**
 * @module cli/migration-gates
 *
 * Provides CLI runtime support for Migration Gates.
 */
import {
  pathExists,
  getActiveExtensionRegistrations,
  type PreflightRuntimeDecision,
  resolveItemTypeRegistry,
  migrateItemFilesToFormat,
  getSettingsPath,
  readSettingsWithMetadata,
  writeSettings,
  EXIT_CODE,
  PmCliError,
  toNonEmptyStringOrUndefined,
  printError,
  evaluateMutationGuard,
  isMutationAction,
  resolveAuthor,
  locateItem,
  readLocatedItem,
} from "../sdk/runtime-primitives.js";
/** Documents the mandatory migration blocker payload exchanged by command, SDK, and package integrations. */
export interface MandatoryMigrationBlocker {
  /** Value that configures or reports layer for this contract. */
  layer: "global" | "project";
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Lifecycle state reported for status. */
  status: string;
}

/** Documents the write gate decision payload exchanged by command, SDK, and package integrations. */
export interface WriteGateDecision {
  /** Whether mutation applies to this operation. */
  isMutation: boolean;
  /** Value that configures or reports force capable for this contract. */
  forceCapable: boolean;
  /** Value that configures or reports force requested for this contract. */
  forceRequested: boolean;
}

/** Implements resolve migration id for the public runtime surface of this module. */
export function resolveMigrationId(
  definition: Record<string, unknown>,
  fallbackIndex: number,
): string {
  const explicit = toNonEmptyStringOrUndefined(definition.id);
  if (explicit) {
    return explicit;
  }
  return `migration-${String(fallbackIndex + 1).padStart(3, "0")}`;
}

/** Implements resolve normalized migration status for the public runtime surface of this module. */
export function resolveNormalizedMigrationStatus(
  definition: Record<string, unknown>,
): string {
  const normalized = toNonEmptyStringOrUndefined(
    definition.status,
  )?.toLowerCase();
  return normalized ?? "pending";
}

function isMandatoryMigrationDefinition(
  definition: Record<string, unknown>,
): boolean {
  return definition.mandatory === true;
}

function compareMandatoryMigrationBlockers(
  left: MandatoryMigrationBlocker,
  right: MandatoryMigrationBlocker,
): number {
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

/** Implements collect mandatory migration blockers for the public runtime surface of this module. */
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

const ALWAYS_MUTATING_COMMANDS = new Set([
  "create",
  "beads import",
  "todos import",
]);
const FORCEABLE_MUTATING_COMMANDS = new Set([
  "restore",
  "update",
  "close",
  "delete",
  "append",
  "claim",
  "release",
]);
const TEXT_APPEND_COMMANDS = new Set(["comments", "notes", "learnings"]);
const LIST_MUTATION_COMMANDS = new Set(["files", "docs", "test"]);
const POSITIONAL_MUTATION_VERBS = new Set([
  "activate",
  "add",
  "add-field",
  "add-status",
  "add-type",
  "apply",
  "compact",
  "create",
  "deactivate",
  "delete",
  "disable",
  "edit",
  "enable",
  "import",
  "infer",
  "install",
  "materialize",
  "migrate",
  "redact",
  "remove",
  "remove-field",
  "remove-status",
  "remove-type",
  "remap-status",
  "rename-field",
  "rename-type",
  "repair",
  "run",
  "save",
  "set",
  "unset",
  "update",
  "upgrade",
]);

/** Implements decide write gate for the public runtime surface of this module. */
export function decideWriteGate(
  commandPath: string,
  options: Record<string, unknown>,
): WriteGateDecision {
  const forceRequested = options.force === true;
  if (ALWAYS_MUTATING_COMMANDS.has(commandPath)) {
    return { isMutation: true, forceCapable: false, forceRequested: false };
  }
  if (FORCEABLE_MUTATING_COMMANDS.has(commandPath)) {
    return { isMutation: true, forceCapable: true, forceRequested };
  }
  if (TEXT_APPEND_COMMANDS.has(commandPath)) {
    return {
      isMutation: typeof options.add === "string",
      forceCapable: true,
      forceRequested,
    };
  }
  if (LIST_MUTATION_COMMANDS.has(commandPath)) {
    return {
      isMutation:
        hasMutatingListValues(options.add) ||
        hasMutatingListValues(options.remove),
      forceCapable: true,
      forceRequested,
    };
  }
  return { isMutation: false, forceCapable: false, forceRequested: false };
}

function isMutationInvocation(
  commandPath: string,
  commandArgs: string[],
  options: Record<string, unknown>,
): boolean {
  if (decideWriteGate(commandPath, options).isMutation) {
    return true;
  }
  const normalizedCommand = commandPath.trim().toLowerCase();
  if (!isMutationAction(normalizedCommand)) {
    return false;
  }
  if (
    [
      "close-many",
      "close-task",
      "copy",
      "delete",
      "discover",
      "focus",
      "pause-task",
      "start-task",
      "update-many",
    ].includes(normalizedCommand)
  ) {
    return true;
  }
  return commandArgs.some((argument) =>
    POSITIONAL_MUTATION_VERBS.has(argument.trim().toLowerCase()),
  );
}

/** Normalize configured active-status spellings for preflight comparison. */
export function normalizedLifecycleStatus(
  value: string | undefined,
): string {
  return (value ?? "in_progress").trim().toLowerCase().replaceAll("-", "_");
}

/** Convert incomplete schema-evolution CLI invocations into typed usage errors. */
export function enforceSchemaMigrationInput(
  commandPath: string,
  commandArgs: string[],
  options: Record<string, unknown>,
): void {
  const subcommand = commandArgs[0]?.trim().toLowerCase() ?? "";
  if (
    commandPath.trim().toLowerCase() !== "schema" ||
    !["rename-type", "rename-field", "remap-status"].includes(subcommand)
  ) {
    return;
  }
  const missing: string[] = [];
  if (!toNonEmptyStringOrUndefined(commandArgs[1])) missing.push("source");
  if (!toNonEmptyStringOrUndefined(options.to)) missing.push("--to");
  if (
    !toNonEmptyStringOrUndefined(options.migrationId) &&
    !toNonEmptyStringOrUndefined(options.migration_id)
  ) {
    missing.push("--migration-id");
  }
  if (missing.length === 0) {
    return;
  }
  throw new PmCliError(
    `Schema migration requires ${missing.join(", ")}.`,
    EXIT_CODE.USAGE,
    {
      code: "schema_migration_input_required",
      required: missing.join(","),
      why: "Schema migrations are resumable and require an explicit source, target, and stable migration id.",
      recovery: {
        recovery_mode: "compact",
        missing_required_fields: missing,
        suggested_flags: missing.filter((entry) => entry.startsWith("--")),
        suggested_retry: `pm schema ${subcommand} <source> --to <target> --migration-id <id>`,
      },
    },
  );
}

async function warnForUnclaimedInProgressUpdate(
  commandPath: string,
  commandArgs: string[],
  options: Record<string, unknown>,
  pmRoot: string,
  settings: Awaited<ReturnType<typeof readSettingsWithMetadata>>["settings"],
): Promise<void> {
  if (
    commandPath.trim().toLowerCase() !== "update" ||
    typeof options.status !== "string" ||
    normalizedLifecycleStatus(options.status) !==
      normalizedLifecycleStatus(settings.schema.workflow.in_progress_status)
  ) {
    return;
  }
  const rawId = commandArgs[0];
  if (!rawId) {
    return;
  }
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const located = await locateItem(
    pmRoot,
    rawId,
    settings.id_prefix,
    settings.item_format,
    typeRegistry.type_to_folder,
  );
  if (!located) {
    return;
  }
  const current = await readLocatedItem(located, { schema: settings.schema });
  const requestedAssignee =
    typeof options.assignee === "string" ? options.assignee.trim() : undefined;
  const prospectiveAssignee =
    requestedAssignee === undefined
      ? current.document.metadata.assignee?.trim()
      : ["", "none", "null", "undefined"].includes(
            requestedAssignee.toLowerCase(),
          )
        ? undefined
        : requestedAssignee;
  if (prospectiveAssignee) {
    return;
  }
  printError(
    `warning:in_progress_item_unclaimed:${located.id}:claim_with=pm claim ${located.id}`,
  );
}

/**
 * Apply SDK-owned provenance and secret policy to one parsed CLI invocation.
 * Advisory output is stderr-only so JSON/TOON result envelopes stay unchanged.
 */
export async function enforceMutationGuardPreflight(
  commandPath: string,
  commandArgs: string[],
  options: Record<string, unknown>,
  global: { author?: string; force?: boolean; json?: boolean },
  pmRoot: string,
): Promise<void> {
  if (!isMutationInvocation(commandPath, commandArgs, options)) {
    return;
  }
  enforceSchemaMigrationInput(commandPath, commandArgs, options);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    return;
  }
  const settings = await readSettingsWithMetadata(pmRoot);
  if (global.json !== true) {
    await warnForUnclaimedInProgressUpdate(
      commandPath,
      commandArgs,
      options,
      pmRoot,
      settings.settings,
    );
  }
  const result = evaluateMutationGuard({
    author: resolveAuthor(global.author, settings.settings.author_default),
    payload: { command: commandPath, args: commandArgs, options },
    settings: settings.settings.mutation_guard,
    force: global.force === true || options.force === true,
  });
  for (const warning of result.warnings) {
    printError(`warning:${warning}`);
  }
}

/** Implements enforce mandatory migration write gate for the public runtime surface of this module. */
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
    (entry) =>
      `extension_migration_blocking:${entry.layer}:${entry.name}:${entry.id}:${entry.status}`,
  );
  const forceGuidance = decision.forceCapable
    ? "Re-run this command with --force to bypass."
    : "This command path does not support --force bypass.";
  throw new PmCliError(
    `Write command "${commandPath}" blocked by unresolved mandatory extension migrations (${codes.join(",")}). ${forceGuidance}`,
    EXIT_CODE.CONFLICT,
  );
}

/** Implements enforce item format write gate and preflight migration for the public runtime surface of this module. */
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
  if (
    !decision.enforce_item_format_gate &&
    !decision.run_preflight_item_format_sync
  ) {
    return;
  }
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    return;
  }
  const { settings, metadata, warnings } =
    await readSettingsWithMetadata(pmRoot);
  for (const warning of warnings) {
    printError(`warning:${warning}`);
  }
  if (decision.enforce_item_format_gate && !metadata.has_explicit_item_format) {
    await writeSettings(pmRoot, settings, "item_format:auto_select_default");
  }
  if (decision.run_preflight_item_format_sync) {
    const typeRegistry = resolveItemTypeRegistry(
      settings,
      getActiveExtensionRegistrations(),
    );
    await migrateItemFilesToFormat(
      pmRoot,
      settings.item_format,
      "item_format:pre_mutation_sync",
      typeRegistry.type_to_folder,
      settings.schema,
    );
  }
}
