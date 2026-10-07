/**
 * @module sdk/item-transaction
 *
 * Provides the bulk item-mutation convenience layer over
 * `commitWorkspaceTransaction`: atomic, resumable create/update/close batches
 * with correct-by-construction inspection and compensation wiring.
 */
import crypto from "node:crypto";
import { constants, type Stats } from "node:fs";
import { isFileMissingError, readRegularFile, transactionPreviewNonRegularFileError } from "../core/fs/fs-utils.js";
import { cp, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { getActiveExtensionRegistrations, setActiveExtensionRegistrations } from "../core/extensions/index.js";
import path from "node:path";
import {
  transferMutationStdinTokenPolicy,
} from "../core/item/parse.js";
import { EXIT_CODE, PM_REQUIRED_SUBDIRS, SETTINGS_DEFAULTS, SETTINGS_FILENAME } from "../core/shared/constants.js";
import { resolveItemTypeRegistry } from "../core/item/type-registry.js";
import { DEFAULT_RUNTIME_SCHEMA_FILE_PATHS, filePathForSchemaSection, loadRuntimeSchemaFromOptionalFiles, normalizeRuntimeSchemaSettings } from "../core/schema/runtime-schema.js";
import { validateSettings } from "../core/store/settings-validator.js";
import { resolveWorkspaceRoot } from "../core/store/paths.js";
import { getSessionStatePath } from "../core/session/session-state.js";
import { PmCliError } from "../core/shared/errors.js";
import { stableStringify } from "../core/shared/serialization.js";
import { readHistoryEntries } from "./history-read.js";
import { PM_CONTEXT_INTENTS_FILE } from "./context-intent-runtime.js";
import {
  close,
  create,
  deleteItem,
  get,
  release,
  restore,
  update,
  runWithActiveExtensions,
  type PmClientFullMutationOptions,
} from "./runtime.js";
import {
  commitWorkspaceTransaction,
  validateWorkspaceTransactionIdentity,
  type CommitWorkspaceTransactionOptions,
  type WorkspaceTransactionJsonValue,
  type WorkspaceTransactionStep,
  type WorkspaceTransactionStepInspection,
} from "./workspace-transaction.js";

/**
 * One atomic item creation inside a bulk mutation batch. The explicit `id`
 * doubles as the idempotency key: recovery treats an existing item with this id
 * as the already-applied result, so ids must be stable and transaction-owned.
 */
export interface BulkItemCreateMutation {
  /** Discriminates the creation operation. */
  op: "create";
  /** Explicit stable item id (normalized with the configured id_prefix). */
  id: string;
  /** Creation options forwarded to the public `create` runtime primitive. */
  options: PmClientFullMutationOptions;
}

/** One atomic item update inside a bulk mutation batch. */
export interface BulkItemUpdateMutation {
  /** Discriminates the update operation. */
  op: "update";
  /** Target item id. */
  id: string;
  /** Update options forwarded to the public `update` runtime primitive. */
  options: PmClientFullMutationOptions;
}

/** One atomic item closure inside a bulk mutation batch. */
export interface BulkItemCloseMutation {
  /** Discriminates the close operation. */
  op: "close";
  /** Target item id. */
  id: string;
  /** Close reason recorded on the item. */
  reason: string;
  /** Close options forwarded to the public `close` runtime primitive. */
  options?: PmClientFullMutationOptions;
}

/** One atomic claim release inside a bulk mutation batch. */
export interface BulkItemReleaseMutation {
  /** Discriminates the claim-release operation. */
  op: "release";
  /** Target item id. */
  id: string;
  /** Release options forwarded to the public `release` runtime primitive. */
  options?: PmClientFullMutationOptions;
}

/** Union of the item mutations a bulk transaction batch can carry. */
export type BulkItemMutation =
  | BulkItemCreateMutation
  | BulkItemUpdateMutation
  | BulkItemCloseMutation
  | BulkItemReleaseMutation;

/** Options accepted by the bulk item-mutation transaction helper. */
export interface CommitItemMutationsOptions {
  /** Tracker root that owns the journal and workspace-wide writer lock. */
  pmRoot: string;
  /** Stable idempotency key reused to recover an interrupted batch. */
  transactionId: string;
  /** Attributable actor recorded in the journal and forwarded to mutations. */
  author: string;
  /** Ordered item mutations; compensations run in reverse order. */
  mutations: readonly BulkItemMutation[];
  /**
   * Compensation strategy for created items: `close` (default) preserves the
   * item and its history with an explanatory close reason, `delete` removes
   * the item document (its history stream is retained by `pm delete`).
   */
  createCompensation?: "close" | "delete";
  /** Lock lifetime in seconds; size this above the longest expected attempt. */
  lockTtlSeconds?: number;
  /** Maximum time to wait for the workspace writer lock. */
  lockWaitMs?: number;
  /** Optional transition observer used by telemetry and deterministic crash tests. */
  onTransition?: CommitWorkspaceTransactionOptions["onTransition"];
}

/** Journal-safe outcome recorded for one committed bulk item mutation. */
export interface BulkItemMutationOutcome {
  /** Canonical id of the mutated item. */
  id: string;
  /** Operation the batch applied for this item. */
  op: BulkItemMutation["op"];
}

function mergeTransactionMutationOptions(
  source: PmClientFullMutationOptions | undefined,
  additions: PmClientFullMutationOptions,
): PmClientFullMutationOptions {
  const merged = { ...source, ...additions };
  return source === undefined
    ? merged
    : transferMutationStdinTokenPolicy(source, merged);
}

/** Successful durable result of a bulk item-mutation transaction. */
export interface CommitItemMutationsResult {
  /** Stable transaction identifier. */
  transactionId: string;
  /** Final durable state. */
  status: "committed";
  /** Whether an interrupted journal was resumed. */
  recovered: boolean;
  /** One outcome per mutation, keyed by the derived transaction step id. */
  results: Record<string, BulkItemMutationOutcome>;
}

interface LocatedItemSnapshot {
  id: string;
  closedAt: string | undefined;
  updatedAt: string;
  assignee: string | undefined;
  claimPrincipal: string | undefined;
}

/** Read one item's transaction-relevant fields, mapping not-found to undefined. */
async function readItemSnapshot(
  pmRoot: string,
  id: string,
): Promise<LocatedItemSnapshot | undefined> {
  try {
    const located = await get(id, {}, { pmRoot });
    const item = located.item as {
      id: string;
      closed_at?: string;
      updated_at: string;
      assignee?: string;
      claim_principal?: string;
    };
    return {
      id: item.id,
      closedAt: item.closed_at,
      updatedAt: item.updated_at,
      assignee: item.assignee,
      claimPrincipal: item.claim_principal,
    };
  } catch (error) {
    if (error instanceof PmCliError && error.exitCode === EXIT_CODE.NOT_FOUND) {
      return undefined;
    }
    throw error;
  }
}

/** Derive a journal-safe step id bound to position, target, and payload. */
function deriveStepId(mutation: BulkItemMutation, index: number): string {
  const sanitizedTarget = mutation.id.replaceAll(/[^a-zA-Z0-9._-]/gu, "_");
  const fingerprint = crypto
    .createHash("sha256")
    .update(stableStringify(mutation))
    .digest("hex")
    .slice(0, 12);
  return `${index + 1}-${mutation.op}-${sanitizedTarget}-${fingerprint}`;
}

/** Derive the stable public outcome key without exposing journal internals. */
function deriveOutcomeKey(mutation: BulkItemMutation, index: number): string {
  const sanitizedTarget = mutation.id.replaceAll(/[^a-zA-Z0-9._-]/gu, "_");
  return `${index + 1}-${mutation.op}-${sanitizedTarget}`;
}

/** Build the durable history-message marker for one bulk mutation phase. */
function bulkHistoryMarker(
  transactionId: string,
  stepId: string,
  phase: "apply" | "compensate",
): string {
  return `bulk-item-transaction ${transactionId} ${stepId} ${phase}`;
}

/**
 * Report whether a step's forward mutation is durably applied. Mutable item
 * fields cannot prove transaction ownership, so the apply marker in immutable
 * history is the source of truth; a later compensation marker means the
 * mutation was rolled back and must re-apply.
 */
async function isUpdateMarkerApplied(
  pmRoot: string,
  canonicalId: string,
  transactionId: string,
  stepId: string,
): Promise<boolean> {
  const entries = await readHistoryEntries(
    path.join(pmRoot, "history", `${canonicalId}.jsonl`),
    canonicalId,
  );
  const applyMarker = bulkHistoryMarker(transactionId, stepId, "apply");
  const compensateMarker = bulkHistoryMarker(
    transactionId,
    stepId,
    "compensate",
  );
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index].message;
    if (message === applyMarker) {
      return true;
    }
    if (message === compensateMarker) {
      return false;
    }
  }
  return false;
}

/** Capture the restore target used to compensate an update or close mutation. */
async function prepareRestoreCompensation(
  pmRoot: string,
  mutation: BulkItemMutation,
): Promise<WorkspaceTransactionJsonValue> {
  const snapshot = await readItemSnapshot(pmRoot, mutation.id);
  if (snapshot?.updatedAt === undefined) {
    throw new PmCliError(
      `Bulk ${mutation.op} target ${mutation.id} does not exist or has no restorable version`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  return { target_updated_at: snapshot.updatedAt };
}

/** Idempotently restore an item to its captured pre-mutation version. */
async function compensateByRestore(
  config: { pmRoot: string; author: string; transactionId: string },
  itemId: string,
  stepId: string,
  data: WorkspaceTransactionJsonValue | undefined,
): Promise<void> {
  const target =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? data.target_updated_at
      : undefined;
  if (typeof target !== "string") {
    return;
  }
  if ((await readItemSnapshot(config.pmRoot, itemId)) === undefined) {
    return;
  }
  await restore(
    itemId,
    target,
    {
      force: true,
      author: config.author,
      message: bulkHistoryMarker(config.transactionId, stepId, "compensate"),
    },
    { pmRoot: config.pmRoot },
  );
}

/** Build the workspace-transaction step for one item creation. */
function buildCreateStep(
  config: {
    pmRoot: string;
    author: string;
    transactionId: string;
    createCompensation: "close" | "delete";
  },
  mutation: BulkItemCreateMutation,
  stepId: string,
): WorkspaceTransactionStep {
  return {
    id: stepId,
    async inspect(): Promise<WorkspaceTransactionStepInspection> {
      const snapshot = await readItemSnapshot(config.pmRoot, mutation.id);
      if (snapshot === undefined) {
        return { state: "pending" };
      }
      return { state: "applied", result: { id: snapshot.id, op: "create" } };
    },
    async apply(): Promise<WorkspaceTransactionJsonValue> {
      const created = await create(
        mergeTransactionMutationOptions(mutation.options, {
          author: config.author,
          id: mutation.id,
        }),
        { pmRoot: config.pmRoot },
      );
      const createdItem = created.item as Record<string, unknown>;
      return { id: String(createdItem.id), op: "create" };
    },
    async compensate(): Promise<void> {
      const snapshot = await readItemSnapshot(config.pmRoot, mutation.id);
      if (snapshot === undefined) {
        return;
      }
      if (config.createCompensation === "delete") {
        await deleteItem(
          mutation.id,
          {
            force: true,
            author: config.author,
            message: `Compensate interrupted bulk transaction ${config.transactionId}`,
          },
          { pmRoot: config.pmRoot },
        );
        return;
      }
      if (snapshot.closedAt !== undefined) {
        return;
      }
      await close(
        mutation.id,
        `Compensated: interrupted bulk transaction ${config.transactionId}`,
        { force: true, author: config.author },
        { pmRoot: config.pmRoot },
      );
    },
  };
}

/** Build the workspace-transaction step for one item update. */
function buildUpdateStep(
  config: { pmRoot: string; author: string; transactionId: string },
  mutation: BulkItemUpdateMutation,
  stepId: string,
): WorkspaceTransactionStep {
  return {
    id: stepId,
    async inspect(): Promise<WorkspaceTransactionStepInspection> {
      const snapshot = await readItemSnapshot(config.pmRoot, mutation.id);
      if (snapshot === undefined) {
        return { state: "pending" };
      }
      const applied = await isUpdateMarkerApplied(
        config.pmRoot,
        snapshot.id,
        config.transactionId,
        stepId,
      );
      if (!applied) {
        return { state: "pending" };
      }
      return { state: "applied", result: { id: snapshot.id, op: "update" } };
    },
    async prepareCompensation(): Promise<WorkspaceTransactionJsonValue> {
      return prepareRestoreCompensation(config.pmRoot, mutation);
    },
    async apply(): Promise<WorkspaceTransactionJsonValue> {
      const updated = await update(
        mutation.id,
        mergeTransactionMutationOptions(mutation.options, {
          author: config.author,
          message: bulkHistoryMarker(config.transactionId, stepId, "apply"),
        }),
        { pmRoot: config.pmRoot },
      );
      const updatedItem = updated.item as Record<string, unknown>;
      return { id: String(updatedItem.id), op: "update" };
    },
    async compensate(data?: WorkspaceTransactionJsonValue): Promise<void> {
      await compensateByRestore(config, mutation.id, stepId, data);
    },
  };
}

/** Build the workspace-transaction step for one item closure. */
function buildCloseStep(
  config: { pmRoot: string; author: string; transactionId: string },
  mutation: BulkItemCloseMutation,
  stepId: string,
): WorkspaceTransactionStep {
  return {
    id: stepId,
    // An already-terminal target counts as applied: closing it again would
    // fight legitimate prior closure, and recovery must adopt completed work.
    async inspect(): Promise<WorkspaceTransactionStepInspection> {
      const snapshot = await readItemSnapshot(config.pmRoot, mutation.id);
      if (snapshot === undefined) {
        return { state: "pending" };
      }
      if (
        await isUpdateMarkerApplied(
          config.pmRoot,
          snapshot.id,
          config.transactionId,
          stepId,
        )
      ) {
        return { state: "applied", result: { id: snapshot.id, op: "close" } };
      }
      if (snapshot.closedAt === undefined) {
        return { state: "pending" };
      }
      return { state: "applied", result: { id: snapshot.id, op: "close" } };
    },
    async prepareCompensation(): Promise<WorkspaceTransactionJsonValue> {
      return prepareRestoreCompensation(config.pmRoot, mutation);
    },
    async apply(): Promise<WorkspaceTransactionJsonValue> {
      const closed = await close(
        mutation.id,
        mutation.reason,
        mergeTransactionMutationOptions(mutation.options, {
          author: config.author,
          message: bulkHistoryMarker(config.transactionId, stepId, "apply"),
        }),
        { pmRoot: config.pmRoot },
      );
      const closedItem = closed.item as Record<string, unknown>;
      return { id: String(closedItem.id), op: "close" };
    },
    async compensate(data?: WorkspaceTransactionJsonValue): Promise<void> {
      await compensateByRestore(config, mutation.id, stepId, data);
    },
  };
}

/** Build the workspace-transaction step for one claim release. */
function buildReleaseStep(
  config: { pmRoot: string; author: string; transactionId: string },
  mutation: BulkItemReleaseMutation,
  stepId: string,
): WorkspaceTransactionStep {
  return {
    id: stepId,
    async inspect(): Promise<WorkspaceTransactionStepInspection> {
      const snapshot = await readItemSnapshot(config.pmRoot, mutation.id);
      if (snapshot === undefined) {
        return { state: "pending" };
      }
      if (
        await isUpdateMarkerApplied(
          config.pmRoot,
          snapshot.id,
          config.transactionId,
          stepId,
        )
      ) {
        return { state: "applied", result: { id: snapshot.id, op: "release" } };
      }
      if (
        snapshot.assignee !== undefined ||
        snapshot.claimPrincipal !== undefined
      ) {
        return { state: "pending" };
      }
      return { state: "applied", result: { id: snapshot.id, op: "release" } };
    },
    async prepareCompensation(): Promise<WorkspaceTransactionJsonValue> {
      return prepareRestoreCompensation(config.pmRoot, mutation);
    },
    async apply(): Promise<WorkspaceTransactionJsonValue> {
      const released = await release(
        mutation.id,
        mergeTransactionMutationOptions(mutation.options, {
          author: config.author,
          message: bulkHistoryMarker(config.transactionId, stepId, "apply"),
        }),
        { pmRoot: config.pmRoot },
      );
      const releasedItem = released.item as Record<string, unknown>;
      return { id: String(releasedItem.id), op: "release" };
    },
    async compensate(data?: WorkspaceTransactionJsonValue): Promise<void> {
      await compensateByRestore(config, mutation.id, stepId, data);
    },
  };
}

/** Convert one validated bulk mutation into its workspace-transaction step. */
function buildStepForMutation(
  config: {
    pmRoot: string;
    author: string;
    transactionId: string;
    createCompensation: "close" | "delete";
  },
  mutation: BulkItemMutation,
  index: number,
): WorkspaceTransactionStep {
  const stepId = deriveStepId(mutation, index);
  switch (mutation.op) {
    case "create":
      return buildCreateStep(config, mutation, stepId);
    case "update":
      return buildUpdateStep(config, mutation, stepId);
    case "close":
      return buildCloseStep(config, mutation, stepId);
    case "release":
      return buildReleaseStep(config, mutation, stepId);
  }
}

/** Reject malformed bulk mutation rows before any journal or lock work. */
function assertValidBulkMutation(
  mutation: BulkItemMutation,
  index: number,
): void {
  if (
    mutation === null ||
    typeof mutation !== "object" ||
    Array.isArray(mutation)
  ) {
    throw new TypeError(`Bulk mutation ${index + 1} must be an object`);
  }
  if (!["create", "update", "close", "release"].includes(mutation.op)) {
    throw new TypeError(
      `Bulk mutation ${index + 1} op must be create, update, close, or release`,
    );
  }
  if (typeof mutation.id !== "string" || mutation.id.trim().length === 0) {
    throw new TypeError(`Bulk mutation ${index + 1} requires a non-empty id`);
  }
  if (
    mutation.op === "close" &&
    (typeof mutation.reason !== "string" || mutation.reason.trim().length === 0)
  ) {
    throw new TypeError(
      `Bulk close mutation ${index + 1} requires a non-empty reason`,
    );
  }
}

/** Evidence and explicit limits of a non-writing semantic transaction preview. */
export interface ItemMutationPreviewValidation {
  /** True when the coordinator executed staged validation; false for an already committed journal replay. */
  validated: boolean;
  /** Distinguishes newly staged execution from idempotent replay without fresh step validation. */
  state: "staged_snapshot" | "replayed_committed_plan";
  /** Preview leaves current commit state and executable extension effects unvalidated, including host-run pending migrations, mutation guards and hooks. */
  unresolved_commit_constraints: readonly string[];
}

/** Attach the resolved batch position while preserving lifecycle error classification. */
async function validateMutationOperation<T>(mutation: BulkItemMutation, index: number, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PmCliError) {
      throw new PmCliError(error.message, error.exitCode, {
        ...error.context,
        transaction_operation: { index, op: mutation.op, id: mutation.id },
      });
    }
    throw error;
  }
}

/** Include durable tracker storage and its ancestors, excluding transient caches and locks. */
function includePreviewPath(root: string, file: string, ownedPaths: readonly string[] | undefined, retainedPaths: readonly string[]): boolean {
  const relative = path.relative(root, file);
  if (["locks", "runtime", "search"].includes(relative.split(path.sep)[0]!)) return retainedPaths.some((retained) => relative === retained || relative.startsWith(`${retained}${path.sep}`) || retained.startsWith(`${relative}${path.sep}`));
  return relative === "" || ownedPaths === undefined || ownedPaths.some((owned) => relative === owned || relative.startsWith(`${owned}${path.sep}`) || owned.startsWith(`${relative}${path.sep}`));
}

/** Reject links and special files before preview can traverse or open their targets. */
async function previewEntryStat(file: string): Promise<Stats> {
  const entry = await lstat(file);
  if (entry.isSymbolicLink()) {
    // Retain the native diagnostic for persistent dangling links.
    await stat(file);
  } else if (entry.isDirectory() || entry.isFile()) {
    return entry;
  }
  throw transactionPreviewNonRegularFileError();
}

/**
 * Hash regular-file snapshot bytes in bounded streams after checking the opened
 * descriptor. Available O_NOFOLLOW and O_NONBLOCK flags add platform guards;
 * Windows retains entry, descriptor and snapshot checks without these POSIX
 * flags. Trusted, stable entries and ancestors remain required because these
 * checks do not prevent hostile concurrent path redirection before reading.
 */
async function previewFileDigest(file: string): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const entry = await handle.stat();
    if (!entry.isFile()) throw transactionPreviewNonRegularFileError();
    const contents = crypto.createHash("sha256");
    // Bound this read to the observed size, even if a concurrent writer appends.
    if (entry.size > 0) {
      for await (const chunk of handle.createReadStream({ highWaterMark: 64 * 1024, end: entry.size - 1, autoClose: false })) contents.update(chunk);
    }
    return contents.digest();
  } finally {
    await handle.close();
  }
}

/** Hash durable paths and bytes so a staged copy cannot validate mixed source state. */
async function previewTrackerFingerprint(root: string, ownedPaths: readonly string[] | undefined, retainedPaths: readonly string[]): Promise<string> {
  const fingerprint = crypto.createHash("sha256");
  /** Visit durable entries in stable order, excluding transient runtime and lock state. */
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name);
      if (!includePreviewPath(root, file, ownedPaths, retainedPaths)) continue;
      if ((await previewEntryStat(file)).isDirectory()) {
        await visit(file);
      } else {
        fingerprint.update(JSON.stringify(path.relative(root, file)));
        fingerprint.update(await previewFileDigest(file));
      }
    }
  }
  await visit(root);
  return fingerprint.digest("hex");
}

/** Classify inconsistent snapshot state with actionable retry guidance. */
function previewSnapshotChangedError(): PmCliError {
  return new PmCliError("Tracker changed while preparing the transaction preview; retry against stable state.", EXIT_CODE.CONFLICT, { code: "transaction_preview_snapshot_changed" });
}

/** Distinguish vanished entries from persistent dangling links and invalid paths. */
async function isDisappearingPreviewPath(error: unknown): Promise<boolean> {
  if (!isFileMissingError(error)) return false;
  const file = (error as NodeJS.ErrnoException).path;
  if (typeof file !== "string") return false;
  const original = path.resolve(file);
  let candidate = original;
  while (true) {
    try {
      const entry = await lstat(candidate);
      // ENOENT below a regular file on Windows is a persistent invalid path.
      // An existing directory ancestor proves that a descendant disappeared.
      return candidate !== original && entry.isDirectory();
    } catch (lookupError) {
      if (!isFileMissingError(lookupError)) return false;
      const parent = path.dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
}

/** Read optional configuration without following interior links, pipes, or special entries. */
async function readPreviewConfiguration(root: string, relative: string): Promise<string | undefined> {
  const file = path.join(root, relative);
  try {
    let current = root;
    for (const component of relative.split(path.sep).slice(0, -1)) {
      current = path.join(current, component);
      await previewEntryStat(current);
    }
    if (!(await previewEntryStat(file)).isFile()) throw transactionPreviewNonRegularFileError();
    return await readRegularFile(file, transactionPreviewNonRegularFileError());
  } catch (error) {
    if (await isDisappearingPreviewPath(error)) return undefined;
    throw error;
  }
}

/** Resolve storage from captured configuration using pure contracts and disposable schema files. */
async function resolvePreviewStorage(root: string, configurationRoot: string, registrations: ReturnType<typeof getActiveExtensionRegistrations>) {
  const configuration = new Map<string, string | undefined>();
  const rawSettings = await readPreviewConfiguration(root, SETTINGS_FILENAME);
  configuration.set(SETTINGS_FILENAME, rawSettings);
  let parsed: unknown;
  try { parsed = JSON.parse(rawSettings ?? "null") as unknown; }
  catch { parsed = null; }
  const validated = validateSettings(parsed);
  const settings = validated.success ? validated.data : undefined;
  const schema = normalizeRuntimeSchemaSettings(settings?.schema);
  for (const [section, configuredPath] of Object.entries(schema.files)) {
    const relative = path.relative(root, filePathForSchemaSection(root, configuredPath, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS[section as keyof typeof schema.files]));
    if (relative === "" || !path.resolve(root, relative).startsWith(path.join(root, path.sep))) {
      throw new PmCliError("Transaction preview requires schema files inside the selected tracker root; relocate the configured schema file before retrying.", EXIT_CODE.USAGE, { code: "transaction_preview_external_schema", field: `schema.files.${section}` });
    }
    schema.files[section as keyof typeof schema.files] = relative;
    const contents = await readPreviewConfiguration(root, relative);
    configuration.set(relative, contents);
    if (contents !== undefined) {
      const target = path.join(configurationRoot, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
  }
  const sessionPath = path.relative(root, getSessionStatePath(root));
  configuration.set(sessionPath, await readPreviewConfiguration(root, sessionPath));
  const loaded = await loadRuntimeSchemaFromOptionalFiles(configurationRoot, schema);
  const registry = resolveItemTypeRegistry({ ...SETTINGS_DEFAULTS, item_types: { definitions: [...(settings?.item_types?.definitions ?? []), ...(loaded.type_definitions_from_file ?? [])] } }, registrations);
  const ownedPaths = resolveWorkspaceRoot(root) === root ? [...PM_REQUIRED_SUBDIRS.filter(Boolean), SETTINGS_FILENAME, PM_CONTEXT_INTENTS_FILE, "transactions", ...registry.folders, ...configuration.keys()].map((entry) => path.normalize(entry)) : undefined;
  // Only the disposable copy is rewritten, so absolute in-root schema paths
  // cannot point lifecycle reads or schema scaffolding back at source files.
  const stagedSettings = settings === undefined ? undefined : JSON.stringify({ ...parsed as Record<string, unknown>, schema: { ...settings.schema, files: schema.files } });
  return { configuration, ownedPaths, stagedSettings, registryFolders: registry.folders };
}

/** Copy a stable tracker without source writes and normalize concurrent disappearance failures. */
async function stagePreviewTracker(sourceRoot: string, stagedRoot: string, registrations: ReturnType<typeof getActiveExtensionRegistrations>): Promise<void> {
  // Preserve an initially missing root's existing error; disappearance after
  // this check is a concurrent snapshot change.
  await stat(sourceRoot);
  try {
    // An explicitly selected root may itself be a link; its resolved directory
    // establishes the boundary. Entries within it must never be dereferenced.
    const resolvedRoot = await realpath(sourceRoot);
    const storage = await resolvePreviewStorage(resolvedRoot, path.join(path.dirname(stagedRoot), "configuration"), registrations);
    const retainedPaths = [...storage.configuration.keys(), ...storage.registryFolders].map((entry) => path.normalize(entry));
    const sourceFingerprint = await previewTrackerFingerprint(resolvedRoot, storage.ownedPaths, retainedPaths);
    await cp(resolvedRoot, stagedRoot, {
      recursive: true, dereference: false,
      filter: async (source) => {
        if (!includePreviewPath(resolvedRoot, source, storage.ownedPaths, retainedPaths)) return false;
        await previewEntryStat(source);
        return true;
      },
    });
    const [currentFingerprint, stagedFingerprint] = await Promise.all([
      previewTrackerFingerprint(resolvedRoot, storage.ownedPaths, retainedPaths), previewTrackerFingerprint(stagedRoot, storage.ownedPaths, retainedPaths),
    ]);
    if (sourceFingerprint !== currentFingerprint || sourceFingerprint !== stagedFingerprint) {
      throw previewSnapshotChangedError();
    }
    for (const [relative, contents] of storage.configuration) {
      if (await readPreviewConfiguration(stagedRoot, relative) !== contents) throw previewSnapshotChangedError();
    }
    if (storage.stagedSettings !== undefined) await writeFile(path.join(stagedRoot, SETTINGS_FILENAME), storage.stagedSettings);
  } catch (error) {
    if (await isDisappearingPreviewPath(error)) throw previewSnapshotChangedError();
    throw error;
  }
}

/** Validate ordered mutations using apply's coordinator in a disposable tracker, without source writes, journals or extension hooks. */
export async function previewItemMutations(options: Pick<CommitItemMutationsOptions, "pmRoot" | "transactionId" | "author" | "mutations">): Promise<ItemMutationPreviewValidation> {
  const identity = validateWorkspaceTransactionIdentity(options);
  const mutations = [...options.mutations];
  if (mutations.length === 0) throw new TypeError("Bulk item transaction requires at least one mutation");
  for (const [index, mutation] of mutations.entries()) assertValidBulkMutation(mutation, index);
  const registrations = getActiveExtensionRegistrations();
  const root = await mkdtemp(path.join(tmpdir(), "pm-transaction-preview-"));
  const stagedRoot = path.join(root, "tracker");
  try {
    await stagePreviewTracker(identity.pmRoot, stagedRoot, registrations);
    let validated = false;
    await runWithActiveExtensions({ path: stagedRoot, noExtensions: true }, async () => {
      setActiveExtensionRegistrations(registrations);
      const config = { ...identity, pmRoot: stagedRoot, createCompensation: "close" as const };
      const steps = mutations.map((mutation, index) => {
        const step = buildStepForMutation(config, mutation, index);
        return {
          ...step,
          inspect: () => validateMutationOperation(mutation, index, () => step.inspect()),
          prepareCompensation: () => validateMutationOperation(mutation, index, async () => step.prepareCompensation?.()),
          apply: () => validateMutationOperation(mutation, index, () => step.apply()),
        };
      });
      await commitWorkspaceTransaction({ ...identity, pmRoot: stagedRoot, steps, onTransition: ({ transition }) => { if (transition === "committed") validated = true; } });
    });
    return { validated, state: validated ? "staged_snapshot" : "replayed_committed_plan", unresolved_commit_constraints: ["concurrent_tracker_changes", "extension_mutation_guards_and_hooks"] };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Commit an ordered batch of item create/update/close mutations atomically
 * (all-or-nothing) in one durable workspace transaction. This is the
 * high-level companion to `commitWorkspaceTransaction`: instead of
 * hand-writing `inspect`/`prepareCompensation`/`apply`/`compensate` for the
 * ubiquitous bulk import/sync case, callers describe the mutations and the
 * helper wires the crash-consistency contract — exists-by-id inspection for
 * creates, version-restore compensation for updates and closes, and
 * close-or-delete compensation for creates. A stable `transactionId` makes
 * interrupted batches resumable across processes and agents.
 */
export async function commitItemMutations(
  options: CommitItemMutationsOptions,
): Promise<CommitItemMutationsResult> {
  const mutations = [...options.mutations];
  if (mutations.length === 0) {
    throw new TypeError("Bulk item transaction requires at least one mutation");
  }
  for (const [index, mutation] of mutations.entries()) {
    assertValidBulkMutation(mutation, index);
  }
  const createCompensation = options.createCompensation ?? "close";
  if (!["close", "delete"].includes(createCompensation)) {
    throw new TypeError(
      "Bulk item transaction createCompensation must be close or delete",
    );
  }
  const stepConfig = {
    pmRoot: options.pmRoot,
    author: options.author,
    transactionId: options.transactionId,
    createCompensation,
  };
  const committed = await commitWorkspaceTransaction({
    pmRoot: options.pmRoot,
    transactionId: options.transactionId,
    author: options.author,
    steps: mutations.map((mutation, index) =>
      buildStepForMutation(stepConfig, mutation, index),
    ),
    ...(options.lockTtlSeconds === undefined
      ? {}
      : { lockTtlSeconds: options.lockTtlSeconds }),
    ...(options.lockWaitMs === undefined
      ? {}
      : { lockWaitMs: options.lockWaitMs }),
    ...(options.onTransition === undefined
      ? {}
      : { onTransition: options.onTransition }),
  });
  const results: Record<string, BulkItemMutationOutcome> = {};
  for (const [index, mutation] of mutations.entries()) {
    const stepId = deriveStepId(mutation, index);
    const value = committed.results[stepId]!;
    // Journal values round-trip this module's own step outputs, which are
    // always {id, op} objects — the cast restores the concrete outcome shape.
    results[deriveOutcomeKey(mutation, index)] =
      value as unknown as BulkItemMutationOutcome;
  }
  return {
    transactionId: committed.transactionId,
    status: "committed",
    recovered: committed.recovered,
    results,
  };
}

/** Options for completing one item as a single atomic SDK transaction. */
export interface CommitItemCompletionOptions {
  /** Tracker root that owns the item and transaction journal. */
  pmRoot: string;
  /** Stable idempotency key for the composed completion. */
  transactionId: string;
  /** Attributable actor for evidence, closure, and claim release. */
  author: string;
  /** Item being completed. */
  id: string;
  /** Durable close reason. */
  reason: string;
  /** Evidence and linked-resource updates recorded before closure. */
  evidence?: PmClientFullMutationOptions;
  /** Structured closure fields and validation policy. */
  closeOptions?: PmClientFullMutationOptions;
  /** Claim-release controls. */
  releaseOptions?: PmClientFullMutationOptions;
  /** Workspace transaction lock lifetime in seconds. */
  lockTtlSeconds?: number;
  /** Maximum time to wait for the workspace transaction lock. */
  lockWaitMs?: number;
  /** Optional transition observer used by telemetry and crash tests. */
  onTransition?: CommitWorkspaceTransactionOptions["onTransition"];
}

/** Build the ordered mutation sequence used by atomic item completion. */
export function buildItemCompletionMutations(
  options: Pick<
    CommitItemCompletionOptions,
    "id" | "reason" | "evidence" | "closeOptions" | "releaseOptions"
  >,
): BulkItemMutation[] {
  const mutations: BulkItemMutation[] = [];
  if (
    options.evidence !== undefined &&
    Object.keys(options.evidence).length > 0
  ) {
    mutations.push({ op: "update", id: options.id, options: options.evidence });
  }
  mutations.push(
    {
      op: "close",
      id: options.id,
      reason: options.reason,
      ...(options.closeOptions === undefined
        ? {}
        : { options: options.closeOptions }),
    },
    {
      op: "release",
      id: options.id,
      ...(options.releaseOptions === undefined
        ? {}
        : { options: options.releaseOptions }),
    },
  );
  return mutations;
}

/**
 * Record evidence, close an item, and release its claim as one compensating
 * transaction. A failure restores the exact pre-completion item version, so
 * callers never observe the protocol's otherwise possible half-finished
 * states through a committed result.
 */
export function commitItemCompletion(
  options: CommitItemCompletionOptions,
): Promise<CommitItemMutationsResult> {
  return commitItemMutations({
    pmRoot: options.pmRoot,
    transactionId: options.transactionId,
    author: options.author,
    mutations: buildItemCompletionMutations(options),
    ...(options.lockTtlSeconds === undefined
      ? {}
      : { lockTtlSeconds: options.lockTtlSeconds }),
    ...(options.lockWaitMs === undefined
      ? {}
      : { lockWaitMs: options.lockWaitMs }),
    ...(options.onTransition === undefined
      ? {}
      : { onTransition: options.onTransition }),
  });
}

/** Public contract for test only item transaction internals, shared with white-box specs. */
export const _testOnlyItemTransaction = {
  buildCreateStep,
  bulkHistoryMarker,
  compensateByRestore,
  deriveStepId,
  isUpdateMarkerApplied,
  readItemSnapshot,
};
