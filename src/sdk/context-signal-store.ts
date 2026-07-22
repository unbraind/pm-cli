/**
 * @module sdk/context-signal-store
 *
 * Rebuildable, cursor-stamped feature-store primitives for context relevance.
 * Snapshots are derived read artifacts: callers retain authoritative items and
 * history, while stale, absent, or corrupt snapshots rebuild transparently.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  buildItemContextRelevanceCandidates,
  type BuildItemContextRelevanceCandidatesOptions,
  type ContextRelevanceCandidate,
  type ContextRelevanceSignalName,
  type ContextRelevanceSignals,
} from "./context-relevance.js";
import type { ItemMetadata } from "../types/index.js";
import { readItemMetadataDerivedIndexState } from "./item-metadata-index.js";

/** Current serialized feature-store envelope version. */
export const CONTEXT_SIGNAL_STORE_FORMAT_VERSION = 1;

/** Current canonical signal-vector version. */
export const CONTEXT_SIGNAL_SET_VERSION = 1;

const STORED_CONTEXT_SIGNAL_NAMES = [
  "recency",
  "activity_density",
  "graph_proximity",
  "priority_pressure",
  "risk_pressure",
  "knowledge_density",
] as const satisfies readonly Exclude<ContextRelevanceSignalName, "structural">[];

/** Authoritative substrate used to derive one snapshot. */
export type ContextSignalSnapshotSource = "derived_index" | "scan_fallback";

/** One immutable item signal row. */
export interface ContextSignalSnapshotItem {
  /** Stable item identifier. */
  id: string;
  /** Canonical normalized signal vector. */
  signals: ContextRelevanceSignals;
}

/** Rebuildable, deterministic context-signal snapshot. */
export interface ContextSignalSnapshot {
  /** Serialized envelope version. */
  format_version: number;
  /** Signal algorithm version. */
  signal_set_version: number;
  /** Authoritative history or derived-index cursor folded into this snapshot. */
  source_cursor: string;
  /** Stable clock supplied by the caller. */
  generated_at: string;
  /** Read substrate used for the fold. */
  source: ContextSignalSnapshotSource;
  /** Item rows sorted by canonical id. */
  items: readonly ContextSignalSnapshotItem[];
}

/** Pluggable persistence boundary for context-signal snapshots. */
export interface ContextSignalStoreAdapter {
  /** Read the serialized snapshot, or null when none exists. */
  read(): Promise<unknown | null>;
  /** Atomically replace the serialized snapshot. */
  write(snapshot: ContextSignalSnapshot): Promise<void>;
}

/** Options required to fold authoritative items into a snapshot. */
export interface BuildContextSignalSnapshotOptions
  extends BuildItemContextRelevanceCandidatesOptions {
  /** Authoritative history or derived-index cursor. */
  sourceCursor: string;
  /** Substrate used to load the authoritative items. */
  source: ContextSignalSnapshotSource;
}

/** Result of a feature-store read with explicit degradation metadata. */
export interface ContextSignalStoreReadResult {
  /** Valid snapshot used for candidate assembly. */
  snapshot: ContextSignalSnapshot;
  /** Candidates joined to the caller's authoritative item objects. */
  candidates: ContextRelevanceCandidate<ItemMetadata>[];
  /** Whether the persisted snapshot was reused or rebuilt. */
  cache_status: "fresh" | "rebuilt";
  /** Non-fatal recovery diagnostics. */
  warnings: readonly string[];
}

/** Workspace-bound feature-store options used by CLI, MCP, and SDK readers. */
export interface ReadWorkspaceContextSignalsOptions
  extends BuildItemContextRelevanceCandidatesOptions {
  /** Tracker root containing rebuildable runtime state. */
  pmRoot: string;
  /** Explicit cursor for custom SDK hosts; the stock host reads the metadata index. */
  sourceCursor?: string;
  /** Explicit source classification paired with sourceCursor. */
  source?: ContextSignalSnapshotSource;
  /** Stable projection namespace when one workspace serves distinct candidate corpora. */
  storeKey?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNormalizedSignal(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function compactSignals(signals: ContextRelevanceSignals): ContextRelevanceSignals {
  const compact: ContextRelevanceSignals = {};
  for (const name of STORED_CONTEXT_SIGNAL_NAMES) {
    const value = signals[name];
    if (value === undefined) continue;
    if (!isNormalizedSignal(value)) {
      throw new TypeError(`Context relevance signal ${name} must be a finite number from 0 to 1`);
    }
    compact[name] = value;
  }
  return compact;
}

function normalizedCountsById(
  items: readonly ItemMetadata[],
  count: (item: ItemMetadata) => number,
): Record<string, number> {
  const counts = items.map((item) => [item.id, count(item)] as const);
  const maximum = Math.max(0, ...counts.map(([, value]) => value));
  return Object.fromEntries(
    counts.map(([id, value]) => [id, maximum === 0 ? 0 : value / maximum]),
  );
}

function deriveGraphProximity(items: readonly ItemMetadata[]): Record<string, number> {
  const degree = new Map(items.map((item) => [item.id, 0]));
  const increment = (id: string): void => {
    degree.set(id, (degree.get(id) ?? 0) + 1);
  };
  for (const item of items) {
    if (typeof item.parent === "string" && item.parent.trim()) {
      increment(item.id);
      increment(item.parent.trim());
    }
    for (const dependency of item.dependencies ?? []) {
      if (typeof dependency.id !== "string" || !dependency.id.trim()) continue;
      increment(item.id);
      increment(dependency.id.trim());
    }
  }
  const maximum = Math.max(0, ...degree.values());
  return Object.fromEntries(
    items.map((item) => [item.id, maximum === 0 ? 0 : (degree.get(item.id) as number) / maximum]),
  );
}

function stableSnapshotOptions(
  items: readonly ItemMetadata[],
  options: BuildContextSignalSnapshotOptions,
): BuildContextSignalSnapshotOptions {
  return {
    ...options,
    activityDensity:
      options.activityDensity ??
      normalizedCountsById(
        items,
        (item) =>
          (item.comments?.length ?? 0) +
          (item.notes?.length ?? 0) +
          (item.learnings?.length ?? 0) +
          (item.test_runs?.length ?? 0),
      ),
    graphProximity: options.graphProximity ?? deriveGraphProximity(items),
  };
}

function parseSnapshotItem(value: unknown): ContextSignalSnapshotItem | null {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.signals)) {
    return null;
  }
  const signals: Record<string, number> = {};
  const supportedSignals = new Set<string>(STORED_CONTEXT_SIGNAL_NAMES);
  for (const [name, signal] of Object.entries(value.signals)) {
    if (!supportedSignals.has(name) || !isNormalizedSignal(signal)) {
      return null;
    }
    signals[name] = signal;
  }
  return { id: value.id, signals: signals as ContextRelevanceSignals };
}

/** Validate an untrusted serialized snapshot without accepting partial envelopes. */
export function parseContextSignalSnapshot(value: unknown): ContextSignalSnapshot | null {
  if (
    !isRecord(value) ||
    value.format_version !== CONTEXT_SIGNAL_STORE_FORMAT_VERSION ||
    value.signal_set_version !== CONTEXT_SIGNAL_SET_VERSION ||
    typeof value.source_cursor !== "string" ||
    value.source_cursor.trim().length === 0 ||
    typeof value.generated_at !== "string" ||
    !Number.isFinite(Date.parse(value.generated_at)) ||
    (value.source !== "derived_index" && value.source !== "scan_fallback") ||
    !Array.isArray(value.items)
  ) {
    return null;
  }
  const items = value.items.map(parseSnapshotItem);
  if (items.some((item) => item === null)) {
    return null;
  }
  const validItems = items as ContextSignalSnapshotItem[];
  if (
    new Set(validItems.map((item) => item.id)).size !== validItems.length ||
    validItems.some((item) => item.id.trim().length === 0)
  ) {
    return null;
  }
  return {
    format_version: CONTEXT_SIGNAL_STORE_FORMAT_VERSION,
    signal_set_version: CONTEXT_SIGNAL_SET_VERSION,
    source_cursor: value.source_cursor,
    generated_at: value.generated_at,
    source: value.source,
    items: validItems.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

/** Fold authoritative items into a deterministic, immutable signal snapshot. */
export function buildContextSignalSnapshot(
  items: readonly ItemMetadata[],
  options: BuildContextSignalSnapshotOptions,
): ContextSignalSnapshot {
  if (typeof options.sourceCursor !== "string" || options.sourceCursor.trim().length === 0) {
    throw new TypeError("Context signal source cursor must be non-empty");
  }
  if (!Number.isFinite(Date.parse(options.now))) {
    throw new TypeError("Context signal snapshot clock must be a valid timestamp");
  }
  if (options.source !== "derived_index" && options.source !== "scan_fallback") {
    throw new TypeError("Context signal snapshot source must be derived_index or scan_fallback");
  }
  const rows = buildItemContextRelevanceCandidates(items, stableSnapshotOptions(items, options))
    .map(({ id, signals }) => ({
      id,
      signals: compactSignals(signals),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze({
    format_version: CONTEXT_SIGNAL_STORE_FORMAT_VERSION,
    signal_set_version: CONTEXT_SIGNAL_SET_VERSION,
    source_cursor: options.sourceCursor,
    generated_at: options.now,
    source: options.source,
    items: Object.freeze(rows.map((row) => Object.freeze(row))),
  });
}

/** Filesystem adapter using same-directory atomic replacement. */
export class JsonFileContextSignalStoreAdapter implements ContextSignalStoreAdapter {
  private readonly filePath: string;

  /** Create an adapter for an explicit derived-state file path. */
  constructor(filePath: string) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new TypeError("Context signal store path must be non-empty");
    }
    this.filePath = path.resolve(filePath);
  }

  /** Read and decode the JSON snapshot, returning null when it does not exist. */
  async read(): Promise<unknown | null> {
    try {
      return JSON.parse(await fs.readFile(this.filePath, "utf8")) as unknown;
    } catch (error: unknown) {
      if (isRecord(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  /** Write a complete snapshot through a unique same-directory temporary file. */
  async write(snapshot: ContextSignalSnapshot): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true });
    const temporaryPath = path.join(directory, `.${path.basename(this.filePath)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", flag: "wx" });
      await fs.rename(temporaryPath, this.filePath);
    } finally {
      try {
        await fs.rm(temporaryPath, { force: true });
      } catch {
        // The complete snapshot is already committed; temporary-file cleanup is best effort.
      }
    }
  }
}

/** Cursor-aware feature store that self-heals from absent, stale, or corrupt state. */
export class ContextSignalStore {
  private readonly adapter: ContextSignalStoreAdapter;

  /** Bind the store to a caller-selected persistence adapter. */
  constructor(adapter: ContextSignalStoreAdapter) {
    this.adapter = adapter;
  }

  /** Read matching signals or rebuild them from authoritative items. */
  async readOrRebuild(
    items: readonly ItemMetadata[],
    options: BuildContextSignalSnapshotOptions,
  ): Promise<ContextSignalStoreReadResult> {
    const warnings: string[] = [];
    let snapshot: ContextSignalSnapshot | null = null;
    try {
      const serialized = await this.adapter.read();
      snapshot = parseContextSignalSnapshot(serialized);
      if (serialized !== null && snapshot === null) {
        warnings.push("context_signal_store_invalid");
      }
    } catch {
      warnings.push("context_signal_store_invalid");
    }
    const authoritativeIds = items.map((item) => item.id).sort((left, right) => left.localeCompare(right));
    const snapshotIds = snapshot?.items.map((item) => item.id) ?? [];
    const fresh =
      snapshot !== null &&
      snapshot.source_cursor === options.sourceCursor &&
      snapshot.source === options.source &&
      snapshotIds.length === authoritativeIds.length &&
      snapshotIds.every((id, index) => id === authoritativeIds[index]);
    let resolvedSnapshot: ContextSignalSnapshot;
    if (fresh && snapshot !== null) {
      resolvedSnapshot = snapshot;
    } else {
      if (snapshot !== null) {
        warnings.push("context_signal_store_stale");
      }
      resolvedSnapshot = buildContextSignalSnapshot(items, options);
      try {
        await this.adapter.write(resolvedSnapshot);
      } catch {
        warnings.push("context_signal_store_write_failed");
      }
    }
    const signalsById = new Map(resolvedSnapshot.items.map((item) => [item.id, item.signals]));
    const dynamicCandidates = buildItemContextRelevanceCandidates(items, options);
    return {
      snapshot: resolvedSnapshot,
      candidates: dynamicCandidates.map((candidate) => ({
        ...candidate,
        signals: { ...candidate.signals, ...signalsById.get(candidate.id) },
      })),
      cache_status: fresh ? "fresh" : "rebuilt",
      warnings,
    };
  }
}

function fallbackWorkspaceCursor(items: readonly ItemMetadata[]): string {
  const hash = createHash("sha256");
  for (const item of [...items].sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update(JSON.stringify([
      item.id,
      item.updated_at,
      item.status,
      item.parent ?? null,
      item.priority ?? null,
      item.risk ?? null,
      (item.dependencies ?? []).map((dependency) => dependency.id).sort(),
      item.comments?.length ?? 0,
      item.notes?.length ?? 0,
      item.learnings?.length ?? 0,
      item.test_runs?.length ?? 0,
    ]));
  }
  return `scan:${hash.digest("hex")}`;
}

/** Read cursor-bound workspace signals with deterministic scan fallback. */
export async function readWorkspaceContextSignals(
  items: readonly ItemMetadata[],
  options: ReadWorkspaceContextSignalsOptions,
): Promise<ContextSignalStoreReadResult> {
  const hasSourceCursor = options.sourceCursor !== undefined;
  const hasSource = options.source !== undefined;
  if (hasSourceCursor !== hasSource) {
    throw new TypeError("Context signal source and source cursor must be provided together");
  }
  if (
    options.storeKey !== undefined &&
    !/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u.test(options.storeKey)
  ) {
    throw new TypeError("Context signal store key must be a filesystem-safe identifier");
  }
  const indexState = hasSourceCursor
    ? null
    : await readItemMetadataDerivedIndexState(options.pmRoot);
  const sourceCursor = options.sourceCursor ?? indexState?.source_cursor ?? fallbackWorkspaceCursor(items);
  const source =
    options.source ??
    (indexState === null ? "scan_fallback" : "derived_index");
  const store = new ContextSignalStore(
    new JsonFileContextSignalStoreAdapter(
      path.join(
        options.pmRoot,
        "runtime",
        options.storeKey ? `context-signals-${options.storeKey}.json` : "context-signals.json",
      ),
    ),
  );
  return store.readOrRebuild(items, { ...options, sourceCursor, source });
}
