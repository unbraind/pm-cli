/**
 * @module sdk/extension/migrations
 *
 * Provides durable planning and execution for extension-owned schema migrations.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../../core/fs/fs-utils.js";
import { activateExtensions, loadExtensions } from "../../core/extensions/index.js";
import { writeWorkspaceJsonWithHistory } from "../../core/history/workspace-history.js";
import { readSettings } from "../../core/store/settings.js";
import type { RegisteredExtensionSchemaMigrationDefinition } from "../../core/extensions/extension-types.js";
import type {
  ExtensionCommandResult,
  ExtensionScope,
} from "../extension.js";

/** Durable lifecycle state of one extension migration in one workspace. */
export type ExtensionMigrationOutcomeStatus = "applied" | "failed";

/** One durable extension-migration outcome. */
export interface ExtensionMigrationStateEntry {
  /** Stable layer/name/id identity. */
  key: string;
  /** Extension installation layer. */
  layer: "global" | "project";
  /** Owning extension name. */
  extension: string;
  /** Migration identifier declared by the extension. */
  id: string;
  /** Last durable outcome. */
  status: ExtensionMigrationOutcomeStatus;
  /** ISO timestamp for the last attempt. */
  attempted_at: string;
  /** Failure text retained only for failed outcomes. */
  error?: string;
}

/** Versioned workspace state for extension migrations. */
export interface ExtensionMigrationState {
  /** Storage schema version. */
  version: 1;
  /** Last state change timestamp. */
  updated_at: string;
  /** Deterministically sorted outcomes. */
  entries: ExtensionMigrationStateEntry[];
}

/** Planned or executed row returned for one registered migration. */
export interface ExtensionMigrationReceipt {
  /** Stable layer/name/id identity. */
  key: string;
  /** Extension installation layer. */
  layer: "global" | "project";
  /** Owning extension name. */
  extension: string;
  /** Migration identifier. */
  id: string;
  /** State observed before this invocation. */
  before: "pending" | ExtensionMigrationOutcomeStatus;
  /** Invocation outcome. */
  outcome: "pending" | "applied" | "skipped" | "failed";
  /** Failure text for failed execution. */
  error?: string;
}

/** Structured plan/application envelope for extension migrations. */
export interface ExtensionMigrationRunResult {
  /** Whether the invocation executed no failing migration. */
  ok: boolean;
  /** Whether execution was suppressed. */
  dry_run: boolean;
  /** Durable state path. */
  state_path: string;
  /** Total registered migrations in scope. */
  total: number;
  /** Pending rows in the returned receipt. */
  pending_count: number;
  /** Applied rows in the returned receipt. */
  applied_count: number;
  /** Already-applied rows skipped idempotently. */
  skipped_count: number;
  /** Failed rows in the returned receipt. */
  failed_count: number;
  /** Deterministically ordered per-migration receipts. */
  migrations: ExtensionMigrationReceipt[];
}

/** Options for planning or applying active extension migrations. */
export interface RunExtensionMigrationsOptions {
  /** Tracker root that owns durable migration state. */
  pmRoot: string;
  /** Active runtime registrations. */
  migrations: RegisteredExtensionSchemaMigrationDefinition[];
  /** Audit author written to workspace history. */
  author: string;
  /** Report pending work without invoking extension code. */
  dryRun?: boolean;
  /** Limit execution and receipts to one installation layer. */
  scope?: "global" | "project";
}

/** Minimal lifecycle context required by the migration action dispatcher. */
export interface ExtensionMigrationActionContext {
  /** Selected package scope. */
  scope: ExtensionScope;
  /** Tracker and settings roots for the invocation. */
  resolvedRoots: { pm_root: string; settings_root: string };
  /** Mutable warning collection shared with the lifecycle result. */
  warnings: string[];
  /** Migration-specific command options. */
  options: { dryRun?: boolean };
  /** Relevant global runtime options. */
  global: { noExtensions?: boolean; author?: string };
  /** Construct the standard extension lifecycle result envelope. */
  withResult: (
    details: Record<string, unknown>,
    ok?: boolean,
  ) => ExtensionCommandResult;
}

/** Return the durable workspace path for extension migration state. */
export function resolveExtensionMigrationStatePath(pmRoot: string): string {
  return path.join(pmRoot, "extension-migrations.json");
}

function migrationId(
  migration: RegisteredExtensionSchemaMigrationDefinition,
  index: number,
): string {
  const id = migration.definition.id;
  return typeof id === "string" && id.trim().length > 0
    ? id.trim()
    : `migration-${String(index + 1).padStart(3, "0")}`;
}

function migrationKey(
  migration: RegisteredExtensionSchemaMigrationDefinition,
  id: string,
): string {
  return `${migration.layer}:${migration.name}:${id}`;
}

/** Read durable extension migration outcomes, degrading absent state to empty. */
export async function readExtensionMigrationState(
  pmRoot: string,
): Promise<ExtensionMigrationState> {
  const statePath = resolveExtensionMigrationStatePath(pmRoot);
  if (!(await pathExists(statePath))) {
    return { version: 1, updated_at: "", entries: [] };
  }
  const parsed = JSON.parse(await fs.readFile(statePath, "utf8")) as Partial<ExtensionMigrationState>;
  return {
    version: 1,
    updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : "",
    entries: Array.isArray(parsed.entries)
      ? parsed.entries.filter(
          (entry): entry is ExtensionMigrationStateEntry =>
            typeof entry?.key === "string" &&
            (entry.status === "applied" || entry.status === "failed"),
        )
      : [],
  };
}

/** Overlay durable outcomes onto freshly activated migration definitions. */
export async function applyStoredExtensionMigrationState(
  pmRoot: string,
  migrations: RegisteredExtensionSchemaMigrationDefinition[],
): Promise<ExtensionMigrationState> {
  const state = await readExtensionMigrationState(pmRoot);
  const byKey = new Map(state.entries.map((entry) => [entry.key, entry]));
  migrations.forEach((migration, index) => {
    const id = migrationId(migration, index);
    const entry = byKey.get(migrationKey(migration, id));
    if (!entry) return;
    migration.definition.status = entry.status;
    if (entry.status === "failed") {
      migration.definition.reason = entry.error;
    } else {
      delete migration.definition.reason;
      delete migration.definition.error;
      delete migration.definition.message;
    }
  });
  return state;
}

/** Plan or apply active extension migrations with durable idempotency receipts. */
export async function runExtensionMigrations(
  options: RunExtensionMigrationsOptions,
): Promise<ExtensionMigrationRunResult> {
  const state = await applyStoredExtensionMigrationState(
    options.pmRoot,
    options.migrations,
  );
  const stateByKey = new Map(state.entries.map((entry) => [entry.key, entry]));
  const receipts: ExtensionMigrationReceipt[] = [];
  let changed = false;
  const scopedMigrations = options.migrations
    .map((migration, index) => ({ migration, index }))
    .filter(
      ({ migration }) =>
        options.scope === undefined || migration.layer === options.scope,
    );
  for (const { migration, index } of scopedMigrations) {
    const id = migrationId(migration, index);
    const key = migrationKey(migration, id);
    const stored = stateByKey.get(key);
    const declaredStatus = String(migration.definition.status ?? "pending").toLowerCase();
    const before = stored?.status ?? (declaredStatus === "applied" || declaredStatus === "failed" ? declaredStatus : "pending");
    if (before === "applied") {
      receipts.push({ key, layer: migration.layer, extension: migration.name, id, before, outcome: "skipped" });
      continue;
    }
    if (options.dryRun === true) {
      receipts.push({ key, layer: migration.layer, extension: migration.name, id, before, outcome: "pending" });
      continue;
    }
    const run = migration.runtime_definition?.run ?? migration.definition.run;
    if (typeof run !== "function") {
      receipts.push({ key, layer: migration.layer, extension: migration.name, id, before, outcome: "pending" });
      continue;
    }
    const attemptedAt = new Date().toISOString();
    try {
      await Promise.resolve(run({ id, command: "migration", layer: migration.layer, extension: migration.name, pm_root: options.pmRoot, status: before }));
      const entry: ExtensionMigrationStateEntry = { key, layer: migration.layer, extension: migration.name, id, status: "applied", attempted_at: attemptedAt };
      stateByKey.set(key, entry);
      migration.definition.status = "applied";
      delete migration.definition.reason;
      delete migration.definition.error;
      delete migration.definition.message;
      receipts.push({ key, layer: migration.layer, extension: migration.name, id, before, outcome: "applied" });
      changed = true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const entry: ExtensionMigrationStateEntry = { key, layer: migration.layer, extension: migration.name, id, status: "failed", attempted_at: attemptedAt, error: message };
      stateByKey.set(key, entry);
      migration.definition.status = "failed";
      migration.definition.reason = message;
      receipts.push({ key, layer: migration.layer, extension: migration.name, id, before, outcome: "failed", error: message });
      changed = true;
    }
  }
  if (changed) {
    const settings = await readSettings(options.pmRoot);
    const nextState: ExtensionMigrationState = {
      version: 1,
      updated_at: new Date().toISOString(),
      entries: [...stateByKey.values()].sort((left, right) => left.key.localeCompare(right.key)),
    };
    await writeWorkspaceJsonWithHistory({
      pmRoot: options.pmRoot,
      filePath: resolveExtensionMigrationStatePath(options.pmRoot),
      raw: `${JSON.stringify(nextState, null, 2)}\n`,
      op: "extension_migrations_apply",
      author: options.author,
      lockTtlSeconds: settings.locks.ttl_seconds,
      lockWaitMs: settings.locks.wait_ms,
    });
  }
  const pendingCount = receipts.filter((receipt) => receipt.outcome === "pending").length;
  const appliedCount = receipts.filter((receipt) => receipt.outcome === "applied").length;
  const skippedCount = receipts.filter((receipt) => receipt.outcome === "skipped").length;
  const failedCount = receipts.filter((receipt) => receipt.outcome === "failed").length;
  return {
    ok: failedCount === 0,
    dry_run: options.dryRun === true,
    state_path: resolveExtensionMigrationStatePath(options.pmRoot),
    total: receipts.length,
    pending_count: pendingCount,
    applied_count: appliedCount,
    skipped_count: skippedCount,
    failed_count: failedCount,
    migrations: receipts,
  };
}

/** Load active registrations and execute the extension lifecycle migrate action. */
export async function runExtensionMigrateAction(
  context: ExtensionMigrationActionContext,
): Promise<ExtensionCommandResult> {
  const settings = await readSettings(context.resolvedRoots.settings_root);
  const loaded = await loadExtensions({
    pmRoot: context.resolvedRoots.pm_root,
    settings,
    cwd: process.cwd(),
    noExtensions: context.global.noExtensions === true,
  });
  const activated = await activateExtensions(loaded);
  context.warnings.push(...loaded.warnings, ...activated.warnings);
  const migration = await runExtensionMigrations({
    pmRoot: context.resolvedRoots.pm_root,
    migrations: activated.registrations.migrations,
    author:
      typeof context.global.author === "string" &&
      context.global.author.trim().length > 0
        ? context.global.author.trim()
        : "pm-extension-migration",
    dryRun: context.options.dryRun === true,
    ...(context.scope === "global" ? { scope: "global" as const } : {}),
  });
  return context.withResult(
    {
      migration,
      load_failure_count: loaded.failed.length,
      activation_failure_count: activated.failed.length,
    },
    migration.ok,
  );
}
