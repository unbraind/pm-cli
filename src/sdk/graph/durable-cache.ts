/**
 * @module sdk/graph/durable-cache
 *
 * Durable, rebuildable graph query index persisted under the workspace
 * `runtime/` cache directory. One-shot CLI invocations lose the in-process
 * {@link WorkspaceGraphCache} memo between commands; this store persists the
 * fingerprint-keyed deterministic query results (and the audit census
 * baseline) across processes so repeated bounded queries on an unchanged
 * workspace are answered without re-running assembly-derived analysis. The
 * index is never authoritative: every entry is rebuildable from item storage,
 * a fingerprint mismatch invalidates the whole envelope, corrupt or
 * version-drifted files are ignored and rewritten, and writes are atomic
 * (temp-file rename) so a crash can never publish a torn index. Persistence
 * is optional for small projects: envelopes are written only above an item
 * threshold or after an explicit `pm graph index --rebuild` opt-in.
 */
import path from "node:path";
import {
  readFileIfExists,
  removeFileIfExists,
  writeFileAtomic,
} from "../../core/fs/fs-utils.js";
import type { RelationshipAuditSnapshot } from "./governance.js";

/** Envelope format version; any change invalidates persisted entries. */
export const GRAPH_DURABLE_CACHE_VERSION = 1;

/** Workspaces below this item count skip implicit persistence. */
export const GRAPH_DURABLE_CACHE_MIN_ITEMS = 500;

/** Maximum memoized query results retained in one persisted envelope. */
const MAX_DURABLE_RESULTS = 64;

/** Persisted durable graph cache envelope keyed by one workspace fingerprint. */
export interface DurableGraphCacheEnvelope {
  /** Envelope format version guarding decode compatibility. */
  version: number;
  /** Full workspace graph fingerprint every entry answers for. */
  fingerprint: string;
  /** ISO timestamp of the last persisted write. */
  saved_at: string;
  /** Deterministic query results keyed by their canonical query key. */
  results: Record<string, unknown>;
}

/** Compact durable index status projection for observability surfaces. */
export interface DurableGraphCacheStatus {
  /** Whether an envelope file exists on disk. */
  exists: boolean;
  /** Whether the stored fingerprint matches the current workspace snapshot. */
  fresh: boolean;
  /** Stored entry count, 0 when absent. */
  entry_count: number;
  /** Truncated stored fingerprint, absent when no envelope exists. */
  fingerprint?: string;
  /** ISO timestamp of the last persisted write, absent when no envelope exists. */
  saved_at?: string;
  /** Envelope file size in bytes, absent when no envelope exists. */
  bytes?: number;
}

/** Resolve the durable graph cache file path for one workspace root. */
export function durableGraphCachePath(pmRoot: string): string {
  return path.join(pmRoot, "runtime", "graph-cache.json");
}

/** Resolve the persisted audit census baseline path for one workspace root. */
export function graphAuditBaselinePath(pmRoot: string): string {
  return path.join(pmRoot, "runtime", "graph-audit-baseline.json");
}

/** Decode one persisted JSON envelope, returning undefined on any defect. */
function decodeEnvelope(
  raw: string | null,
): DurableGraphCacheEnvelope | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as DurableGraphCacheEnvelope).version !==
        GRAPH_DURABLE_CACHE_VERSION ||
      typeof (parsed as DurableGraphCacheEnvelope).fingerprint !== "string" ||
      typeof (parsed as DurableGraphCacheEnvelope).saved_at !== "string" ||
      typeof (parsed as DurableGraphCacheEnvelope).results !== "object" ||
      (parsed as DurableGraphCacheEnvelope).results === null
    )
      return undefined;
    return parsed as DurableGraphCacheEnvelope;
  } catch {
    // Corrupt or torn writes must never break queries; the index rebuilds.
    return undefined;
  }
}

/** One opened durable index view bound to the current workspace fingerprint. */
export interface DurableGraphCacheView {
  /** Whether any envelope file exists on disk, fresh or not. */
  exists: boolean;
  /** Whether the stored envelope answers for the current fingerprint. */
  fresh: boolean;
  /** Fingerprint-fresh persisted query results; empty when absent or stale. */
  results: Record<string, unknown>;
}

/**
 * Open the persisted envelope against the current workspace fingerprint. A
 * missing, corrupt, version-drifted, or fingerprint-mismatched envelope reads
 * as empty so stale entries can never answer for a mutated workspace.
 */
export async function openDurableGraphCache(
  pmRoot: string,
  fingerprint: string,
): Promise<DurableGraphCacheView> {
  const raw = await readFileIfExists(durableGraphCachePath(pmRoot));
  const envelope = decodeEnvelope(raw);
  const fresh = envelope?.fingerprint === fingerprint;
  return {
    exists: raw !== null,
    fresh,
    results: fresh ? envelope!.results : {},
  };
}

/**
 * Persist one query result into the durable envelope, replacing any envelope
 * recorded for a different fingerprint and trimming the oldest entries beyond
 * the retention bound. The write is atomic; concurrent writers last-write-win
 * on a whole consistent envelope, never a torn one.
 */
export async function persistDurableGraphResult(
  pmRoot: string,
  fingerprint: string,
  view: DurableGraphCacheView,
  queryKey: string,
  result: unknown,
): Promise<void> {
  delete view.results[queryKey];
  view.results[queryKey] = result;
  const keys = Object.keys(view.results);
  for (const stale of keys.slice(
    0,
    Math.max(0, keys.length - MAX_DURABLE_RESULTS),
  ))
    delete view.results[stale];
  await writeFileAtomic(
    durableGraphCachePath(pmRoot),
    JSON.stringify({
      version: GRAPH_DURABLE_CACHE_VERSION,
      fingerprint,
      saved_at: new Date().toISOString(),
      results: view.results,
    }),
  );
}

/** Delete the persisted durable graph cache envelope when present. */
export async function clearDurableGraphCache(pmRoot: string): Promise<void> {
  await removeFileIfExists(durableGraphCachePath(pmRoot));
}

/** Report the durable index status against the current workspace fingerprint. */
export async function durableGraphCacheStatus(
  pmRoot: string,
  fingerprint: string,
): Promise<DurableGraphCacheStatus> {
  const cachePath = durableGraphCachePath(pmRoot);
  const raw = await readFileIfExists(cachePath);
  const envelope = decodeEnvelope(raw);
  if (envelope === undefined)
    return { exists: raw !== null, fresh: false, entry_count: 0 };
  return {
    exists: true,
    fresh: envelope.fingerprint === fingerprint,
    entry_count: Object.keys(envelope.results).length,
    fingerprint: envelope.fingerprint.slice(0, 12),
    saved_at: envelope.saved_at,
    bytes: Buffer.byteLength(raw!, "utf8"),
  };
}

/**
 * Decide whether implicit persistence applies to this invocation. Small
 * workspaces skip the index unless an envelope already exists — the explicit
 * `pm graph index --rebuild` opt-in creates it and thereby enables writes.
 */
export function shouldPersistDurableGraphCache(
  itemCount: number,
  envelopeExists: boolean,
): boolean {
  return envelopeExists || itemCount >= GRAPH_DURABLE_CACHE_MIN_ITEMS;
}

/** Return whether a decoded value is a string-keyed non-negative integer count map. */
function isNonnegativeCountRecord(
  value: unknown,
): value is Record<string, number> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((count) => Number.isInteger(count) && count >= 0)
  );
}

/** Decode one persisted audit census baseline, undefined on any defect. */
function decodeBaseline(
  raw: string | null,
): RelationshipAuditSnapshot | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const snapshot = parsed as Partial<RelationshipAuditSnapshot>;
    const profile = snapshot.profile;
    if (
      typeof snapshot.saved_at !== "string" ||
      typeof snapshot.fingerprint !== "string" ||
      !isNonnegativeCountRecord(snapshot.affected_subjects_by_code) ||
      typeof profile !== "object" ||
      profile === null ||
      ![
        profile.nodes,
        profile.edges,
        profile.active_nodes,
        profile.missing_nodes,
        profile.isolated_active_nodes,
        profile.degree_leq_one_active_nodes,
      ].every((value) => Number.isInteger(value) && value >= 0) ||
      !isNonnegativeCountRecord(profile.edges_by_kind) ||
      typeof profile.coverage_by_type !== "object" ||
      profile.coverage_by_type === null
    )
      return undefined;
    return snapshot as RelationshipAuditSnapshot;
  } catch {
    return undefined;
  }
}

/** Load the persisted audit census baseline when present and decodable. */
export async function loadGraphAuditBaseline(
  pmRoot: string,
): Promise<RelationshipAuditSnapshot | undefined> {
  return decodeBaseline(await readFileIfExists(graphAuditBaselinePath(pmRoot)));
}

/** Atomically persist one audit census snapshot as the comparison baseline. */
export async function saveGraphAuditBaseline(
  pmRoot: string,
  snapshot: RelationshipAuditSnapshot,
): Promise<void> {
  await writeFileAtomic(
    graphAuditBaselinePath(pmRoot),
    JSON.stringify(snapshot),
  );
}
