/**
 * @module sdk/workspace-snapshot
 *
 * Creates and restores content-addressed snapshots of authoritative tracker
 * state while excluding clone-local caches, locks, and recovery journals.
 */
import crypto from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../core/fs/fs-utils.js";
import { appendWorkspaceAuditEvent } from "../core/history/workspace-history.js";
import { acquireLock } from "../core/lock/lock.js";
import { getLockPath } from "../core/store/paths.js";

/** Current content-addressed workspace snapshot manifest schema identifier. */
export const SNAPSHOT_SCHEMA =
  "https://schema.unbrained.dev/pm/workspace-snapshot/v1";
const SNAPSHOT_RUNTIME_PATH = path.join("runtime", "workspace-snapshots");
const EXCLUDED_ROOT_NAMES = new Set([
  "checkpoints",
  "locks",
  "runtime",
  "search",
  "transactions",
]);
const SNAPSHOT_TARGET_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const WORKSPACE_WRITER_LOCK_ID = "sdk-workspace-transaction";

/** Filesystem operations required by atomic snapshot publish and restore swaps. */
export interface WorkspaceSnapshotAtomicOperations {
  /** Rename one filesystem entry atomically. */
  renameEntry: (source: string, target: string) => Promise<void>;
  /** Remove one filesystem entry recursively. */
  removeEntry: (target: string) => Promise<void>;
}

const DEFAULT_ATOMIC_OPERATIONS: WorkspaceSnapshotAtomicOperations = {
  renameEntry: rename,
  removeEntry: async (target) => {
    await rm(target, { recursive: true, force: true });
  },
};

/** Keeps one workspace writer lease current while a long restore is active. */
class WorkspaceLockHeartbeat {
  private readonly lockPath: string;
  private readonly owner: string;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private refresh: Promise<void> | undefined;
  private failure: unknown;

  /** Capture the exact lock identity and derive a sub-TTL renewal interval. */
  constructor(lockPath: string, owner: string, ttlSeconds: number) {
    this.lockPath = lockPath;
    this.owner = owner;
    this.intervalMs = Math.max(10, Math.floor((ttlSeconds * 1_000) / 3));
  }

  /** Begin renewing the lock without keeping the process alive on its own. */
  start(): void {
    this.timer = setInterval(() => {
      if (this.refresh !== undefined) return;
      this.refresh = this.renew()
        .catch((error: unknown) => {
          this.failure = error;
        })
        .finally(() => {
          this.refresh = undefined;
        });
    }, this.intervalMs);
    this.timer.unref();
  }

  /** Fail the restore before activation when lease ownership was lost. */
  assertHealthy(): void {
    if (this.failure !== undefined) {
      throw new Error("Workspace snapshot restore lost its writer lock", {
        cause: this.failure,
      });
    }
  }

  /** Stop future renewals and await the last in-flight atomic write. */
  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.refresh;
    this.assertHealthy();
  }

  /** Atomically refresh only the lock still owned by this process and actor. */
  private async renew(): Promise<void> {
    const parsed = JSON.parse(await readFile(this.lockPath, "utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("Workspace writer lock has invalid structure");
    }
    const lock = parsed as Record<string, unknown>;
    if (
      lock.id !== WORKSPACE_WRITER_LOCK_ID ||
      lock.owner !== this.owner ||
      lock.pid !== process.pid
    ) {
      throw new Error("Workspace writer lock ownership changed");
    }
    await writeFileAtomic(
      this.lockPath,
      `${JSON.stringify(
        { ...lock, created_at: new Date().toISOString() },
        null,
        2,
      )}\n`,
    );
  }
}

/** Internal heartbeat constructor exposed only for deterministic lock tests. */
export const _testOnlyWorkspaceSnapshot = {
  WorkspaceLockHeartbeat,
};

/** Immutable manifest stored with every content-addressed snapshot object. */
export interface WorkspaceSnapshotManifest {
  /** Versioned snapshot schema identifier. */
  schema: typeof SNAPSHOT_SCHEMA;
  /** SHA-256 identity derived from sorted paths and file bytes. */
  fingerprint: string;
  /** Sorted authoritative tracker-relative file paths. */
  files: readonly string[];
  /** Total authoritative payload size in bytes. */
  bytes: number;
}

/** Named reference returned by snapshot list operations. */
export interface WorkspaceSnapshotReference {
  /** Human-authored stable reference name. */
  name: string;
  /** Referenced content fingerprint. */
  fingerprint: string;
}

/** Snapshot create outcome, including whether the object was deduplicated. */
export interface CreateWorkspaceSnapshotResult {
  /** Immutable manifest for the captured state. */
  manifest: WorkspaceSnapshotManifest;
  /** Optional named reference updated by the operation. */
  name?: string;
  /** True when an identical content object already existed. */
  deduplicated: boolean;
}

/** Exact destructive impact computed before a workspace snapshot restore. */
export interface WorkspaceSnapshotRestorePlan {
  /** Target snapshot fingerprint. */
  target_fingerprint: string;
  /** Fingerprint of the authoritative state that would be replaced. */
  current_fingerprint: string;
  /** Authoritative files whose bytes differ between current and target state. */
  changed_file_count: number;
  /** Current authoritative files absent from the target snapshot. */
  removed_file_count: number;
  /** Target authoritative files absent from current state. */
  added_file_count: number;
  /** Current item documents absent from the target snapshot. */
  removed_item_count: number;
  /** History streams absent from, or shorter in, the target snapshot. */
  affected_history_stream_count: number;
  /** History entries that the target snapshot does not retain. */
  removed_history_entry_count: number;
  /** Per-stream evidence for history reductions. */
  affected_history_streams: readonly WorkspaceSnapshotHistoryImpact[];
  /** True when applying the plan changes authoritative state. */
  changes_authoritative_state: boolean;
}

/** One history stream whose retained entry count would decrease on restore. */
export interface WorkspaceSnapshotHistoryImpact {
  /** Tracker-relative history stream path. */
  path: string;
  /** Entry count in current authoritative state. */
  current_entries: number;
  /** Entry count in the target snapshot, or zero when the stream is absent. */
  target_entries: number;
  /** Entries no longer present after applying the target snapshot. */
  removed_entries: number;
}

/** Options for a guarded, audited workspace snapshot restore. */
export interface RestoreWorkspaceSnapshotOptions {
  /** Explicit destructive-operation confirmation. */
  force?: boolean;
  /** Actor recorded on the durable workspace audit event. */
  author?: string;
  /** Optional human-readable restore rationale. */
  message?: string;
  /** Workspace-writer and audit lock time-to-live in seconds. */
  lockTtlSeconds?: number;
  /** Maximum workspace-writer and audit lock wait in milliseconds. */
  lockWaitMs?: number;
}

/** Result of an audited and reversible workspace snapshot restore. */
export interface RestoreWorkspaceSnapshotResult {
  /** Immutable target manifest that supplied the restored payload. */
  manifest: WorkspaceSnapshotManifest;
  /** Exact impact accepted by the caller. */
  plan: WorkspaceSnapshotRestorePlan;
  /** Recovery object containing the complete pre-restore authoritative state. */
  recovery_fingerprint: string;
  /** Workspace audit stream receiving the restore event. */
  audit_history_path: string;
  /** Stable audit operation appended after staging and before activation. */
  audit_operation: "workspace_snapshot_restore";
}

async function collectAuthoritativeFiles(
  root: string,
  relative = "",
): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (relative.length === 0 && EXCLUDED_ROOT_NAMES.has(entry.name)) {
      continue;
    }
    const entryRelative = path.posix.join(
      relative.replaceAll(path.sep, "/"),
      entry.name,
    );
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Workspace snapshots reject symbolic links: ${entryRelative}`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await collectAuthoritativeFiles(root, entryRelative)));
    } else if (entry.isFile()) {
      files.push(entryRelative);
    } else {
      throw new Error(
        `Workspace snapshots reject unsupported filesystem entries: ${entryRelative}`,
      );
    }
  }
  return files;
}

async function buildManifest(
  pmRoot: string,
): Promise<{ manifest: WorkspaceSnapshotManifest; contents: Buffer[] }> {
  const files = await collectAuthoritativeFiles(pmRoot);
  const hash = crypto.createHash("sha256");
  const contents: Buffer[] = [];
  let bytes = 0;
  for (const file of files) {
    const content = await readFile(path.join(pmRoot, file));
    contents.push(content);
    bytes += content.byteLength;
    hash.update(file);
    hash.update("\0");
    hash.update(String(content.byteLength));
    hash.update("\0");
    hash.update(content);
  }
  const fingerprint = hash.digest("hex");
  return {
    manifest: {
      schema: SNAPSHOT_SCHEMA,
      fingerprint,
      files,
      bytes,
    },
    contents,
  };
}

function lineCount(content: Buffer | undefined): number {
  if (content === undefined || content.byteLength === 0) {
    return 0;
  }
  return content
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
}

async function snapshotContents(
  root: string,
  files: readonly string[],
): Promise<Map<string, Buffer>> {
  const contents = new Map<string, Buffer>();
  for (let offset = 0; offset < files.length; offset += 32) {
    const batch = files.slice(offset, offset + 32);
    const entries = await Promise.all(
      batch.map(
        async (file) => [file, await readFile(path.join(root, file))] as const,
      ),
    );
    for (const [file, content] of entries) contents.set(file, content);
  }
  return contents;
}

function validateSnapshotTarget(target: string): void {
  if (!SNAPSHOT_TARGET_PATTERN.test(target)) {
    throw new Error(
      "Snapshot names and fingerprints must use lowercase letters, digits, dots, underscores, or hyphens",
    );
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

function snapshotStore(pmRoot: string): string {
  return path.join(pmRoot, SNAPSHOT_RUNTIME_PATH);
}

async function readSnapshotJson<T>(file: string, target: string): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      throw new Error(`Unknown workspace snapshot: ${target}`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function removeSnapshotEntry(
  entry: string,
  target: string,
  recursive: boolean,
): Promise<void> {
  try {
    await rm(entry, { recursive });
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      throw new Error(`Unknown workspace snapshot: ${target}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Publish a prepared immutable object, treating a concurrent winning publish
 * as successful deduplication.
 */
export async function publishWorkspaceSnapshotObject(
  temporaryRoot: string,
  objectRoot: string,
  operations: WorkspaceSnapshotAtomicOperations = DEFAULT_ATOMIC_OPERATIONS,
): Promise<boolean> {
  try {
    await operations.renameEntry(temporaryRoot, objectRoot);
    return false;
  } catch (error: unknown) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        (error.code === "EEXIST" || error.code === "ENOTEMPTY")
      )
    ) {
      throw error;
    }
    await operations.removeEntry(temporaryRoot);
    return true;
  }
}

/** Activate a staged tracker root and restore the backup if activation fails. */
export async function swapWorkspaceSnapshotRoot(
  staging: string,
  pmRoot: string,
  backup: string,
  operations: WorkspaceSnapshotAtomicOperations = DEFAULT_ATOMIC_OPERATIONS,
): Promise<void> {
  await operations.renameEntry(pmRoot, backup);
  try {
    await operations.renameEntry(staging, pmRoot);
  } catch (error: unknown) {
    await operations.renameEntry(backup, pmRoot);
    await operations.removeEntry(staging);
    throw error;
  }
  await operations.removeEntry(backup);
}

async function resolveSnapshotFingerprint(
  pmRoot: string,
  target: string,
): Promise<string> {
  validateSnapshotTarget(target);
  if (/^[a-f0-9]{64}$/.test(target)) {
    return target;
  }
  const reference = await readSnapshotJson<WorkspaceSnapshotReference>(
    path.join(snapshotStore(pmRoot), "refs", `${target}.json`),
    target,
  );
  return reference.fingerprint;
}

/** Capture authoritative tracker state as a deduplicated immutable object. */
export async function createWorkspaceSnapshot(
  pmRoot: string,
  options: { name?: string } = {},
): Promise<CreateWorkspaceSnapshotResult> {
  if (options.name !== undefined) {
    validateSnapshotTarget(options.name);
    if (/^[a-f0-9]{64}$/.test(options.name)) {
      throw new Error(
        "Snapshot names must not be 64-character lowercase hexadecimal fingerprints",
      );
    }
  }
  const { manifest, contents } = await buildManifest(pmRoot);
  const store = snapshotStore(pmRoot);
  const objectRoot = path.join(store, "objects", manifest.fingerprint);
  let deduplicated = false;
  try {
    const objectStat = await lstat(objectRoot);
    deduplicated = objectStat.isDirectory();
  } catch (error: unknown) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  if (!deduplicated) {
    const temporaryRoot = path.join(
      store,
      "objects",
      `.create-${process.pid}-${crypto.randomUUID()}`,
    );
    await mkdir(path.join(temporaryRoot, "files"), { recursive: true });
    for (const [index, file] of manifest.files.entries()) {
      const target = path.join(temporaryRoot, "files", file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents[index]);
    }
    await writeFile(
      path.join(temporaryRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await mkdir(path.dirname(objectRoot), { recursive: true });
    deduplicated = await publishWorkspaceSnapshotObject(
      temporaryRoot,
      objectRoot,
    );
  }
  if (options.name !== undefined) {
    const reference: WorkspaceSnapshotReference = {
      name: options.name,
      fingerprint: manifest.fingerprint,
    };
    const refsRoot = path.join(store, "refs");
    await mkdir(refsRoot, { recursive: true });
    const temporaryRef = path.join(
      refsRoot,
      `.ref-${process.pid}-${crypto.randomUUID()}`,
    );
    await writeFile(
      temporaryRef,
      `${JSON.stringify(reference, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryRef, path.join(refsRoot, `${options.name}.json`));
  }
  return {
    manifest,
    ...(options.name === undefined ? {} : { name: options.name }),
    deduplicated,
  };
}

/** Read and verify a snapshot manifest by named reference or fingerprint. */
export async function inspectWorkspaceSnapshot(
  pmRoot: string,
  target: string,
): Promise<WorkspaceSnapshotManifest> {
  const fingerprint = await resolveSnapshotFingerprint(pmRoot, target);
  const manifest = await readSnapshotJson<WorkspaceSnapshotManifest>(
    path.join(snapshotStore(pmRoot), "objects", fingerprint, "manifest.json"),
    target,
  );
  if (
    manifest.schema !== SNAPSHOT_SCHEMA ||
    manifest.fingerprint !== fingerprint
  ) {
    throw new Error(`Snapshot manifest identity mismatch: ${target}`);
  }
  return manifest;
}

/** List immutable objects and human-readable named references. */
export async function listWorkspaceSnapshots(pmRoot: string): Promise<{
  objects: WorkspaceSnapshotManifest[];
  references: WorkspaceSnapshotReference[];
}> {
  const store = snapshotStore(pmRoot);
  const objectNames = await readdir(path.join(store, "objects")).catch(
    (error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    },
  );
  const referenceNames = await readdir(path.join(store, "refs")).catch(
    (error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    },
  );
  return {
    objects: await Promise.all(
      objectNames
        .filter((name) => /^[a-f0-9]{64}$/.test(name))
        .sort()
        .map((name) => inspectWorkspaceSnapshot(pmRoot, name)),
    ),
    references: await Promise.all(
      referenceNames
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map(
          async (name) =>
            JSON.parse(
              await readFile(path.join(store, "refs", name), "utf8"),
            ) as WorkspaceSnapshotReference,
        ),
    ),
  };
}

/** Compute the exact authoritative and history impact of restoring a snapshot. */
export async function planWorkspaceSnapshotRestore(
  pmRoot: string,
  target: string,
): Promise<WorkspaceSnapshotRestorePlan> {
  const targetManifest = await inspectWorkspaceSnapshot(pmRoot, target);
  const { manifest: currentManifest, contents: currentContentList } =
    await buildManifest(pmRoot);
  const currentContents = new Map(
    currentManifest.files.map((file, index) => [
      file,
      currentContentList[index]!,
    ]),
  );
  const targetContents = await snapshotContents(
    path.join(
      snapshotStore(pmRoot),
      "objects",
      targetManifest.fingerprint,
      "files",
    ),
    targetManifest.files,
  );
  const currentFiles = new Set(currentManifest.files);
  const targetFiles = new Set(targetManifest.files);
  const changedFiles = new Set([...currentFiles, ...targetFiles]);
  for (const file of changedFiles) {
    const currentContent = currentContents.get(file);
    const targetContent = targetContents.get(file);
    if (
      currentContent !== undefined &&
      targetContent !== undefined &&
      currentContent.equals(targetContent)
    ) {
      changedFiles.delete(file);
    }
  }
  const affectedHistoryStreams = currentManifest.files
    .filter((file) => file.startsWith("history/") && file.endsWith(".jsonl"))
    .map((file) => {
      const currentEntries = lineCount(currentContents.get(file));
      const targetEntries = lineCount(targetContents.get(file));
      return {
        path: file,
        current_entries: currentEntries,
        target_entries: targetEntries,
        removed_entries: Math.max(0, currentEntries - targetEntries),
      };
    })
    .filter((entry) => entry.removed_entries > 0)
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    target_fingerprint: targetManifest.fingerprint,
    current_fingerprint: currentManifest.fingerprint,
    changed_file_count: changedFiles.size,
    removed_file_count: [...currentFiles].filter(
      (file) => !targetFiles.has(file),
    ).length,
    added_file_count: [...targetFiles].filter((file) => !currentFiles.has(file))
      .length,
    removed_item_count: [...currentFiles].filter(
      (file) => file.endsWith(".toon") && !targetFiles.has(file),
    ).length,
    affected_history_stream_count: affectedHistoryStreams.length,
    removed_history_entry_count: affectedHistoryStreams.reduce(
      (total, entry) => total + entry.removed_entries,
      0,
    ),
    affected_history_streams: affectedHistoryStreams,
    changes_authoritative_state:
      currentManifest.fingerprint !== targetManifest.fingerprint,
  };
}

/**
 * Atomically replace tracker state with an audited, reversible snapshot.
 *
 * The caller must explicitly confirm the whole-workspace mutation. The current
 * state is captured as an immutable recovery object before staging begins, and
 * the staged `_workspace` stream receives the restore event before activation.
 */
export async function restoreWorkspaceSnapshotWithRecovery(
  pmRoot: string,
  target: string,
  options: RestoreWorkspaceSnapshotOptions = {},
): Promise<RestoreWorkspaceSnapshotResult> {
  if (options.force !== true) {
    throw new Error(
      "Workspace snapshot restore requires explicit force confirmation; inspect the impact with planWorkspaceSnapshotRestore or pm workspace snapshot restore <target> --dry-run, then retry with force",
    );
  }
  const author = options.author?.trim() || "pm-sdk";
  const lockTtlSeconds = options.lockTtlSeconds ?? 60;
  const lockWaitMs = options.lockWaitMs ?? 5_000;
  const releaseWorkspaceLock = await acquireLock(
    pmRoot,
    WORKSPACE_WRITER_LOCK_ID,
    lockTtlSeconds,
    author,
    false,
    false,
    lockWaitMs,
  );
  const heartbeat = new WorkspaceLockHeartbeat(
    getLockPath(pmRoot, WORKSPACE_WRITER_LOCK_ID),
    author,
    lockTtlSeconds,
  );
  heartbeat.start();
  let staging: string | undefined;
  let swapStarted = false;
  let heartbeatStopped = false;
  try {
    const plan = await planWorkspaceSnapshotRestore(pmRoot, target);
    const manifest = await inspectWorkspaceSnapshot(pmRoot, target);
    const recovery = await createWorkspaceSnapshot(pmRoot);
    const fingerprint = manifest.fingerprint;
    const store = snapshotStore(pmRoot);
    const source = path.join(store, "objects", fingerprint, "files");
    const parent = path.dirname(pmRoot);
    const base = path.basename(pmRoot);
    staging = path.join(parent, `.${base}.restore-${crypto.randomUUID()}`);
    const backup = path.join(parent, `.${base}.backup-${crypto.randomUUID()}`);
    await mkdir(staging, { recursive: true });
    await cp(source, staging, { recursive: true, force: false });
    await mkdir(path.join(staging, "runtime"), { recursive: true });
    await cp(store, path.join(staging, SNAPSHOT_RUNTIME_PATH), {
      recursive: true,
      force: false,
    });
    const audit = await appendWorkspaceAuditEvent({
      pmRoot: staging,
      op: "workspace_snapshot_restore",
      author,
      message:
        options.message ??
        `Restore workspace snapshot ${fingerprint}; recovery snapshot ${recovery.manifest.fingerprint}`,
      context: {
        target_fingerprint: fingerprint,
        pre_restore_fingerprint: recovery.manifest.fingerprint,
        changed_file_count: plan.changed_file_count,
        removed_file_count: plan.removed_file_count,
        removed_item_count: plan.removed_item_count,
        affected_history_stream_count: plan.affected_history_stream_count,
        removed_history_entry_count: plan.removed_history_entry_count,
      },
      lockTtlSeconds,
      lockWaitMs,
    });
    const auditHistoryPath = path
      .relative(staging, audit.historyPath)
      .replaceAll("\\", "/");
    const stagedWorkspaceLock = getLockPath(staging, WORKSPACE_WRITER_LOCK_ID);
    await mkdir(path.dirname(stagedWorkspaceLock), { recursive: true });
    await writeFile(
      stagedWorkspaceLock,
      await readFile(getLockPath(pmRoot, WORKSPACE_WRITER_LOCK_ID)),
      { flag: "wx" },
    );
    heartbeat.assertHealthy();
    swapStarted = true;
    await swapWorkspaceSnapshotRoot(staging, pmRoot, backup);
    await heartbeat.stop();
    heartbeatStopped = true;
    return {
      manifest,
      plan,
      recovery_fingerprint: recovery.manifest.fingerprint,
      audit_history_path: auditHistoryPath,
      audit_operation: "workspace_snapshot_restore",
    };
  } catch (error: unknown) {
    if (staging !== undefined && !swapStarted) {
      await Promise.allSettled([rm(staging, { recursive: true, force: true })]);
    }
    throw error;
  } finally {
    try {
      if (!heartbeatStopped) await heartbeat.stop();
    } catch {
      // A body failure already owns the outcome; lease cleanup must not mask it.
    } finally {
      await releaseWorkspaceLock();
    }
  }
}

/**
 * Restore a snapshot through the backward-compatible SDK signature.
 *
 * Existing callers retain the manifest return contract while every restore now
 * captures a recovery snapshot and writes a durable audit event. New callers
 * that need impact, recovery, and audit coordinates should use
 * `restoreWorkspaceSnapshotWithRecovery`.
 */
export async function restoreWorkspaceSnapshot(
  pmRoot: string,
  target: string,
): Promise<WorkspaceSnapshotManifest> {
  return (
    await restoreWorkspaceSnapshotWithRecovery(pmRoot, target, {
      force: true,
      message: "Restore requested through the compatibility SDK signature",
    })
  ).manifest;
}

/** Delete a named reference, or an unreferenced immutable object fingerprint. */
export async function deleteWorkspaceSnapshot(
  pmRoot: string,
  target: string,
): Promise<{ deleted: "reference" | "object"; target: string }> {
  validateSnapshotTarget(target);
  const store = snapshotStore(pmRoot);
  if (!/^[a-f0-9]{64}$/.test(target)) {
    await removeSnapshotEntry(
      path.join(store, "refs", `${target}.json`),
      target,
      false,
    );
    return { deleted: "reference", target };
  }
  const { references } = await listWorkspaceSnapshots(pmRoot);
  if (references.some((reference) => reference.fingerprint === target)) {
    throw new Error(`Snapshot object ${target} is still referenced`);
  }
  await removeSnapshotEntry(path.join(store, "objects", target), target, true);
  return { deleted: "object", target };
}
