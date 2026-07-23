/**
 * @module sdk/workspace-memory
 *
 * Builds compact, cursor-bound historical rollups for large workspaces.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { writeFileAtomic } from "../core/fs/fs-utils.js";
import { normalizeStatusForRegistry } from "../core/item/status.js";
import { stableStringify } from "../core/shared/serialization.js";
import { readItemMetadataDerivedIndexState } from "../core/store/item-metadata-cache.js";
import type { RuntimeStatusRegistry } from "../core/schema/runtime-schema.js";
import type { ItemMetadata } from "../types/index.js";
import fs from "node:fs/promises";

const WORKSPACE_MEMORY_FORMAT_VERSION = 1;
/** Default corpus size at which historical rollups become more useful than raw closed rows. */
export const DEFAULT_WORKSPACE_MEMORY_MINIMUM_ITEMS = 10_000;
const DEFAULT_ROLLUP_LIMIT = 12;

/** A bounded item reference retained inside one historical rollup. */
export interface WorkspaceMemoryItemReference {
  /** Stable item identifier. */
  id: string;
  /** Human-readable item title. */
  title: string;
}

/** Deterministic historical summary for one calendar epoch or epic lineage. */
export interface WorkspaceMemoryRollup {
  /** Stable rollup kind. */
  kind: "epoch" | "epic";
  /** Stable kind-scoped rollup key. */
  key: string;
  /** Human-readable rollup label. */
  label: string;
  /** Number of completed items represented by this rollup. */
  item_count: number;
  /** Earliest completion timestamp represented by this rollup. */
  first_closed_at: string;
  /** Latest completion timestamp represented by this rollup. */
  last_closed_at: string;
  /** Bounded newest-first examples that let agents recover exact item context. */
  representative_items: WorkspaceMemoryItemReference[];
  /** Bounded distinct completion outcomes for semantic and keyword recall. */
  outcomes: string[];
  /** Number of durable notes and learnings represented by the rollup. */
  knowledge_entries: number;
}

/** Complete rebuildable workspace-memory projection tied to one source cursor. */
export interface WorkspaceMemorySnapshot {
  /** Serialized projection format version. */
  format_version: number;
  /** Authoritative metadata-index or scan cursor. */
  source_cursor: string;
  /** Number of authoritative items used to derive the projection. */
  source_item_count: number;
  /** Timestamp at which this projection was generated. */
  generated_at: string;
  /** Deterministically ordered historical rollups. */
  rollups: WorkspaceMemoryRollup[];
}

/** Result of reading, rebuilding, or intentionally skipping workspace memory. */
export interface WorkspaceMemoryReadResult {
  /** Projection when the corpus meets the configured tier threshold. */
  snapshot: WorkspaceMemorySnapshot | null;
  /** Whether persistence was reused, rebuilt, or skipped for a small corpus. */
  cache_status: "fresh" | "rebuilt" | "skipped";
  /** Stable degradation warnings. */
  warnings: string[];
}

/** Agent-facing bounded context projection derived from a workspace-memory read. */
export interface WorkspaceMemorySelection {
  /** Whether the persisted projection was reused or rebuilt. */
  cache_status: "fresh" | "rebuilt";
  /** Authoritative cursor represented by the projection. */
  source_cursor: string;
  /** Token-bounded historical rollups. */
  rollups: WorkspaceMemoryRollup[];
}

/** Agent-facing search matches derived from a workspace-memory read. */
export interface WorkspaceMemorySearchResult {
  /** Whether the persisted projection was reused or rebuilt. */
  cache_status: "fresh" | "rebuilt";
  /** Historical rollups matching the query. */
  matches: WorkspaceMemoryRollup[];
}

interface MutableRollup {
  kind: "epoch" | "epic";
  key: string;
  label: string;
  items: ItemMetadata[];
}

function completionTimestamp(item: ItemMetadata): string {
  return item.closed_at ?? item.updated_at;
}

function quarterKey(timestamp: string): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

function nearestEpic(
  item: ItemMetadata,
  itemsById: ReadonlyMap<string, ItemMetadata>,
): ItemMetadata | undefined {
  const visited = new Set<string>();
  let parentId = item.parent;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = itemsById.get(parentId);
    if (!parent) return undefined;
    if (parent.type.toLowerCase() === "epic") return parent;
    parentId = parent.parent;
  }
  return undefined;
}

function finalizeRollup(rollup: MutableRollup): WorkspaceMemoryRollup {
  const ordered = [...rollup.items].sort((left, right) => {
    const timestampOrder = completionTimestamp(right).localeCompare(
      completionTimestamp(left),
    );
    return timestampOrder || left.id.localeCompare(right.id);
  });
  const outcomes = new Set<string>();
  let knowledgeEntries = 0;
  for (const item of ordered) {
    const outcome = item.resolution ?? item.close_reason;
    if (outcome?.trim()) outcomes.add(outcome.trim());
    knowledgeEntries +=
      (item.notes?.length ?? 0) + (item.learnings?.length ?? 0);
  }
  return {
    kind: rollup.kind,
    key: rollup.key,
    label: rollup.label,
    item_count: ordered.length,
    first_closed_at: completionTimestamp(ordered.at(-1)!),
    last_closed_at: completionTimestamp(ordered[0]!),
    representative_items: ordered
      .slice(0, 5)
      .map(({ id, title }) => ({ id, title })),
    outcomes: [...outcomes].sort().slice(0, 5),
    knowledge_entries: knowledgeEntries,
  };
}

/**
 * Fold completed history into deterministic calendar-epoch and epic-lineage
 * rollups. The projection contains only rebuildable summaries and bounded item
 * references; authoritative item documents and history remain untouched.
 */
export function buildWorkspaceMemorySnapshot(
  items: readonly ItemMetadata[],
  options: {
    statusRegistry: RuntimeStatusRegistry;
    sourceCursor: string;
    now: string;
  },
): WorkspaceMemorySnapshot {
  if (!options.sourceCursor.trim()) {
    throw new TypeError("Workspace memory source cursor must be non-empty");
  }
  if (!Number.isFinite(Date.parse(options.now))) {
    throw new TypeError("Workspace memory clock must be a valid timestamp");
  }
  const completed = items.filter((item) =>
    options.statusRegistry.terminal_done_statuses.has(
      normalizeStatusForRegistry(item.status, options.statusRegistry),
    ),
  );
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const groups = new Map<string, MutableRollup>();
  for (const item of completed) {
    const epoch = quarterKey(completionTimestamp(item));
    const epochKey = `epoch:${epoch}`;
    const epochRollup = groups.get(epochKey) ?? {
      kind: "epoch" as const,
      key: epoch,
      label: epoch,
      items: [],
    };
    epochRollup.items.push(item);
    groups.set(epochKey, epochRollup);

    const epic = nearestEpic(item, itemsById);
    if (epic) {
      const epicKey = `epic:${epic.id}`;
      const epicRollup = groups.get(epicKey) ?? {
        kind: "epic" as const,
        key: epic.id,
        label: epic.title,
        items: [],
      };
      epicRollup.items.push(item);
      groups.set(epicKey, epicRollup);
    }
  }
  return {
    format_version: WORKSPACE_MEMORY_FORMAT_VERSION,
    source_cursor: options.sourceCursor,
    source_item_count: items.length,
    generated_at: options.now,
    rollups: [...groups.values()]
      .map(finalizeRollup)
      .sort(
        (left, right) =>
          right.last_closed_at.localeCompare(left.last_closed_at) ||
          left.kind.localeCompare(right.kind) ||
          left.key.localeCompare(right.key),
      ),
  };
}

function isWorkspaceMemoryItemReference(
  value: unknown,
): value is WorkspaceMemoryItemReference {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    "title" in value &&
    typeof value.title === "string"
  );
}

function isWorkspaceMemoryRollup(
  value: unknown,
): value is WorkspaceMemoryRollup {
  if (typeof value !== "object" || value === null) return false;
  const rollup = value as Partial<WorkspaceMemoryRollup>;
  const textFields = [rollup.key, rollup.label].every(
    (field) => typeof field === "string" && field.length > 0,
  );
  const timestamps = [rollup.first_closed_at, rollup.last_closed_at].every(
    (timestamp) =>
      typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp)),
  );
  return (
    (rollup.kind === "epoch" || rollup.kind === "epic") &&
    textFields &&
    Number.isSafeInteger(rollup.item_count) &&
    rollup.item_count! > 0 &&
    timestamps &&
    Array.isArray(rollup.representative_items) &&
    rollup.representative_items.every(isWorkspaceMemoryItemReference) &&
    Array.isArray(rollup.outcomes) &&
    rollup.outcomes.every((outcome) => typeof outcome === "string") &&
    Number.isSafeInteger(rollup.knowledge_entries) &&
    rollup.knowledge_entries! >= 0
  );
}

function parseWorkspaceMemorySnapshot(
  value: unknown,
): WorkspaceMemorySnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const snapshot = value as Partial<WorkspaceMemorySnapshot>;
  if (
    snapshot.format_version !== WORKSPACE_MEMORY_FORMAT_VERSION ||
    typeof snapshot.source_cursor !== "string" ||
    !snapshot.source_cursor.trim() ||
    !Number.isSafeInteger(snapshot.source_item_count) ||
    snapshot.source_item_count! < 0 ||
    typeof snapshot.generated_at !== "string" ||
    !Number.isFinite(Date.parse(snapshot.generated_at)) ||
    !Array.isArray(snapshot.rollups)
  ) {
    return null;
  }
  const valid = snapshot.rollups.every(isWorkspaceMemoryRollup);
  return valid ? (snapshot as WorkspaceMemorySnapshot) : null;
}

function fallbackSourceCursor(items: readonly ItemMetadata[]): string {
  return `scan:${createHash("sha256")
    .update(
      stableStringify(
        items
          .map((item) => [item.id, item.updated_at, item.status, item.parent])
          .sort(([left], [right]) => String(left).localeCompare(String(right))),
      ),
    )
    .digest("hex")}`;
}

async function resolveWorkspaceMemorySourceCursor(
  items: readonly ItemMetadata[],
  pmRoot: string,
  explicitCursor: string | undefined,
): Promise<string> {
  if (explicitCursor !== undefined) return explicitCursor;
  const indexState = await readItemMetadataDerivedIndexState(pmRoot);
  return indexState?.source_cursor ?? fallbackSourceCursor(items);
}

async function readPersistedWorkspaceMemory(filePath: string): Promise<{
  snapshot: WorkspaceMemorySnapshot | null;
  invalid: boolean;
}> {
  try {
    const snapshot = parseWorkspaceMemorySnapshot(
      JSON.parse(await fs.readFile(filePath, "utf8")) as unknown,
    );
    return { snapshot, invalid: snapshot === null };
  } catch (error: unknown) {
    const missing =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT";
    return { snapshot: null, invalid: !missing };
  }
}

/** Read a fresh cursor-bound projection or rebuild it from authoritative items. */
export async function readWorkspaceMemory(
  items: readonly ItemMetadata[],
  options: {
    pmRoot: string;
    statusRegistry: RuntimeStatusRegistry;
    now: string;
    minimumItems?: number;
    sourceCursor?: string;
  },
): Promise<WorkspaceMemoryReadResult> {
  const minimumItems = Math.max(
    1,
    Math.floor(options.minimumItems ?? DEFAULT_WORKSPACE_MEMORY_MINIMUM_ITEMS),
  );
  if (items.length < minimumItems) {
    return { snapshot: null, cache_status: "skipped", warnings: [] };
  }
  const sourceCursor = await resolveWorkspaceMemorySourceCursor(
    items,
    options.pmRoot,
    options.sourceCursor,
  );
  const filePath = path.join(
    options.pmRoot,
    "runtime",
    "workspace-memory.json",
  );
  const warnings: string[] = [];
  const persisted = await readPersistedWorkspaceMemory(filePath);
  const parsed = persisted.snapshot;
  if (persisted.invalid) warnings.push("workspace_memory_invalid");
  if (
    parsed?.source_cursor === sourceCursor &&
    parsed.source_item_count === items.length
  ) {
    return { snapshot: parsed, cache_status: "fresh", warnings };
  }
  if (parsed) warnings.push("workspace_memory_stale");
  const snapshot = buildWorkspaceMemorySnapshot(items, {
    statusRegistry: options.statusRegistry,
    sourceCursor,
    now: options.now,
  });
  try {
    await writeFileAtomic(filePath, `${JSON.stringify(snapshot)}\n`);
  } catch {
    warnings.push("workspace_memory_write_failed");
  }
  return { snapshot, cache_status: "rebuilt", warnings };
}

/**
 * Select recent rollups within an approximate agent-token budget. Epoch and
 * epic rows are interleaved by recency because snapshot order is deterministic.
 */
export function selectWorkspaceMemoryRollups(
  snapshot: WorkspaceMemorySnapshot,
  tokenBudget: number,
  limit = DEFAULT_ROLLUP_LIMIT,
): WorkspaceMemoryRollup[] {
  const boundedBudget = Math.max(0, Math.floor(tokenBudget));
  let consumed = 0;
  const selected: WorkspaceMemoryRollup[] = [];
  for (const rollup of snapshot.rollups) {
    if (selected.length >= Math.max(0, Math.floor(limit))) break;
    const tokens = Math.ceil(JSON.stringify(rollup).length / 4);
    if (consumed + tokens > boundedBudget) continue;
    selected.push(rollup);
    consumed += tokens;
  }
  return selected;
}

/**
 * Convert a persisted read into a token-bounded context section. Small
 * workspaces and empty token windows intentionally return no section.
 */
export function selectWorkspaceMemory(
  memory: WorkspaceMemoryReadResult,
  tokenBudget: number,
  limit = DEFAULT_ROLLUP_LIMIT,
): WorkspaceMemorySelection | undefined {
  if (memory.snapshot === null) return undefined;
  const rollups = selectWorkspaceMemoryRollups(
    memory.snapshot,
    tokenBudget,
    limit,
  );
  if (rollups.length === 0) return undefined;
  return {
    cache_status: memory.cache_status === "fresh" ? "fresh" : "rebuilt",
    source_cursor: memory.snapshot.source_cursor,
    rollups,
  };
}

/** Search derived rollups without expanding the authoritative closed corpus. */
export function searchWorkspaceMemory(
  snapshot: WorkspaceMemorySnapshot | null,
  query: string,
  limit = 5,
): WorkspaceMemoryRollup[] {
  if (snapshot === null) return [];
  const tokens = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return [];
  return snapshot.rollups
    .map((rollup) => ({
      rollup,
      score: tokens.filter((token) =>
        [
          rollup.key,
          rollup.label,
          ...rollup.outcomes,
          ...rollup.representative_items.flatMap((item) => [
            item.id,
            item.title,
          ]),
        ]
          .join(" ")
          .toLowerCase()
          .includes(token),
      ).length,
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.rollup.last_closed_at.localeCompare(left.rollup.last_closed_at) ||
        left.rollup.key.localeCompare(right.rollup.key),
    )
    .slice(0, Math.max(0, Math.floor(limit)))
    .map(({ rollup }) => rollup);
}

/**
 * Convert a persisted read into bounded query matches. Small workspaces and
 * unmatched queries intentionally return no section.
 */
export function searchWorkspaceMemoryReadResult(
  memory: WorkspaceMemoryReadResult,
  query: string,
  limit = 5,
): WorkspaceMemorySearchResult | undefined {
  const matches = searchWorkspaceMemory(memory.snapshot, query, limit);
  if (matches.length === 0) return undefined;
  return {
    cache_status: memory.cache_status === "fresh" ? "fresh" : "rebuilt",
    matches,
  };
}
