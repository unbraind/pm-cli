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

const SNAPSHOT_SCHEMA =
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

function validateSnapshotTarget(target: string): void {
  if (!SNAPSHOT_TARGET_PATTERN.test(target)) {
    throw new Error(
      "Snapshot names and fingerprints must use lowercase letters, digits, dots, underscores, or hyphens",
    );
  }
}

function snapshotStore(pmRoot: string): string {
  return path.join(pmRoot, SNAPSHOT_RUNTIME_PATH);
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
    await operations.removeEntry(backup);
  } catch (error: unknown) {
    await operations.renameEntry(backup, pmRoot);
    await operations.removeEntry(staging);
    throw error;
  }
}

async function resolveSnapshotFingerprint(
  pmRoot: string,
  target: string,
): Promise<string> {
  validateSnapshotTarget(target);
  if (/^[a-f0-9]{64}$/.test(target)) {
    return target;
  }
  const reference = JSON.parse(
    await readFile(path.join(snapshotStore(pmRoot), "refs", `${target}.json`), "utf8"),
  ) as WorkspaceSnapshotReference;
  return reference.fingerprint;
}

/** Capture authoritative tracker state as a deduplicated immutable object. */
export async function createWorkspaceSnapshot(
  pmRoot: string,
  options: { name?: string } = {},
): Promise<CreateWorkspaceSnapshotResult> {
  if (options.name !== undefined) {
    validateSnapshotTarget(options.name);
  }
  const { manifest, contents } = await buildManifest(pmRoot);
  const store = snapshotStore(pmRoot);
  const objectRoot = path.join(store, "objects", manifest.fingerprint);
  let deduplicated = false;
  try {
    const objectStat = await lstat(objectRoot);
    deduplicated = objectStat.isDirectory();
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
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
    await writeFile(temporaryRef, `${JSON.stringify(reference, null, 2)}\n`, "utf8");
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
  const manifest = JSON.parse(
    await readFile(
      path.join(snapshotStore(pmRoot), "objects", fingerprint, "manifest.json"),
      "utf8",
    ),
  ) as WorkspaceSnapshotManifest;
  if (
    manifest.schema !== SNAPSHOT_SCHEMA ||
    manifest.fingerprint !== fingerprint
  ) {
    throw new Error(`Snapshot manifest identity mismatch: ${target}`);
  }
  return manifest;
}

/** List immutable objects and human-readable named references. */
export async function listWorkspaceSnapshots(
  pmRoot: string,
): Promise<{
  objects: WorkspaceSnapshotManifest[];
  references: WorkspaceSnapshotReference[];
}> {
  const store = snapshotStore(pmRoot);
  const objectNames = await readdir(path.join(store, "objects")).catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    },
  );
  const referenceNames = await readdir(path.join(store, "refs")).catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
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
        .map(async (name) =>
          JSON.parse(
            await readFile(path.join(store, "refs", name), "utf8"),
          ) as WorkspaceSnapshotReference,
        ),
    ),
  };
}

/** Atomically replace tracker state with an authoritative snapshot payload. */
export async function restoreWorkspaceSnapshot(
  pmRoot: string,
  target: string,
): Promise<WorkspaceSnapshotManifest> {
  const manifest = await inspectWorkspaceSnapshot(pmRoot, target);
  const fingerprint = manifest.fingerprint;
  const store = snapshotStore(pmRoot);
  const source = path.join(store, "objects", fingerprint, "files");
  const parent = path.dirname(pmRoot);
  const base = path.basename(pmRoot);
  const staging = path.join(parent, `.${base}.restore-${crypto.randomUUID()}`);
  const backup = path.join(parent, `.${base}.backup-${crypto.randomUUID()}`);
  await mkdir(staging, { recursive: true });
  await cp(source, staging, { recursive: true, force: false });
  await mkdir(path.join(staging, "runtime"), { recursive: true });
  await cp(store, path.join(staging, SNAPSHOT_RUNTIME_PATH), {
    recursive: true,
    force: false,
  });
  await swapWorkspaceSnapshotRoot(staging, pmRoot, backup);
  return manifest;
}

/** Delete a named reference, or an unreferenced immutable object fingerprint. */
export async function deleteWorkspaceSnapshot(
  pmRoot: string,
  target: string,
): Promise<{ deleted: "reference" | "object"; target: string }> {
  validateSnapshotTarget(target);
  const store = snapshotStore(pmRoot);
  if (!/^[a-f0-9]{64}$/.test(target)) {
    await rm(path.join(store, "refs", `${target}.json`));
    return { deleted: "reference", target };
  }
  const { references } = await listWorkspaceSnapshots(pmRoot);
  if (references.some((reference) => reference.fingerprint === target)) {
    throw new Error(`Snapshot object ${target} is still referenced`);
  }
  await rm(path.join(store, "objects", target), { recursive: true });
  return { deleted: "object", target };
}
