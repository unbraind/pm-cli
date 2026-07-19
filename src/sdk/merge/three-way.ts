/**
 * @module sdk/merge/three-way
 *
 * Field-aware three-way merge primitives for every mergeable tracker artifact
 * class: append-only history JSONL streams, item documents (TOON or
 * JSON+Markdown), and key-level JSON configuration/schema files. These
 * primitives are pure (content in, content out) so the CLI merge driver, the
 * MCP surface, and package integrations all share one merge semantics
 * definition for multi-branch agent workflows.
 */
import {
  historyEntriesToRaw,
  reanchorHistoryEntries,
} from "../../core/history/replay.js";
import {
  canonicalDocument,
  parseItemDocument,
  serializeItemDocument,
  type ItemDocumentFormatOptions,
} from "../../core/item/item-format.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { findFirstMergeConflictMarker } from "../../core/shared/conflict-markers.js";
import { PmCliError } from "../../core/shared/errors.js";
import { stableStringify } from "../../core/shared/serialization.js";
import { compareTimestampStrings } from "../../core/shared/time.js";
import type {
  HistoryEntry,
  ItemDocument,
  ItemMetadata,
} from "../../types/index.js";

/** Restricts which side of a three-way merge wins an unresolvable conflict. */
export type MergePreferredSide = "ours" | "theirs";

/** Restricts the strategy labels reported by the history stream merge. */
export type HistoryMergeStrategy =
  | "identical"
  | "fast_forward_ours"
  | "fast_forward_theirs"
  | "union_reanchor";

/** Documents the history stream merge result payload exchanged by command, SDK, and package integrations. */
export interface HistoryMergeResult {
  /** Merged JSONL content ready to be written as the resolved history stream. */
  merged: string;
  /** Strategy the merge used: identical inputs, one-sided fast-forward, or a deterministic union with a re-anchored hash chain. */
  strategy: HistoryMergeStrategy;
  /** Number of entries shared by both sides before their streams diverged. */
  common_entries: number;
  /** Number of divergent entries contributed by the ours side. */
  entries_from_ours: number;
  /** Number of divergent entries contributed by the theirs side. */
  entries_from_theirs: number;
  /** Total entries in the merged stream. */
  entries_total: number;
  /** Whether the merged chain required hash re-anchoring (true for every union merge). */
  reanchored: boolean;
}

function parseHistoryJsonl(raw: string, label: string): HistoryEntry[] {
  const conflictMarker = findFirstMergeConflictMarker(raw);
  if (conflictMarker) {
    throw new PmCliError(
      `History merge input (${label}) contains unresolved conflict markers at line ${conflictMarker.line}. Merge drivers must receive clean per-side versions.`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  const entries: HistoryEntry[] = [];
  for (const [index, rawLine] of raw.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new TypeError("history entry must be an object");
      }
      entries.push(parsed as HistoryEntry);
    } catch {
      throw new PmCliError(
        `History merge input (${label}) contains invalid JSON at line ${index + 1}.`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
  }
  return entries;
}

function historyEntryIdentity(entry: HistoryEntry): string {
  return stableStringify({
    ts: entry.ts,
    author: entry.author,
    op: entry.op,
    patch: entry.patch,
    message: entry.message ?? null,
  });
}

function commonHistoryPrefixLength(
  ours: HistoryEntry[],
  theirs: HistoryEntry[],
): number {
  const limit = Math.min(ours.length, theirs.length);
  let shared = 0;
  while (
    shared < limit &&
    historyEntryIdentity(ours[shared]) === historyEntryIdentity(theirs[shared])
  ) {
    shared += 1;
  }
  return shared;
}

/**
 * Deterministically merge two diverged versions of one append-only history
 * JSONL stream. Identical streams and one-sided fast-forwards keep the winning
 * side byte-for-byte; genuinely diverged streams are merged as the shared
 * prefix plus both suffixes ordered by timestamp (ours-first on ties), then
 * hash re-anchored so the resulting chain verifies again. No side's events are
 * ever discarded: content divergence is preserved for the post-merge
 * reconciliation pass (`pm validate` + `pm history-repair`) instead of being
 * silently resolved by last-writer-wins.
 */
export function mergeHistoryStreams(
  baseRaw: string,
  oursRaw: string,
  theirsRaw: string,
): HistoryMergeResult {
  parseHistoryJsonl(baseRaw, "base");
  const ours = parseHistoryJsonl(oursRaw, "ours");
  const theirs = parseHistoryJsonl(theirsRaw, "theirs");
  const shared = commonHistoryPrefixLength(ours, theirs);

  if (shared === ours.length && shared === theirs.length) {
    return {
      merged: historyEntriesToRaw(ours),
      strategy: "identical",
      common_entries: shared,
      entries_from_ours: 0,
      entries_from_theirs: 0,
      entries_total: ours.length,
      reanchored: false,
    };
  }
  if (shared === theirs.length) {
    return {
      merged: historyEntriesToRaw(ours),
      strategy: "fast_forward_ours",
      common_entries: shared,
      entries_from_ours: ours.length - shared,
      entries_from_theirs: 0,
      entries_total: ours.length,
      reanchored: false,
    };
  }
  if (shared === ours.length) {
    return {
      merged: historyEntriesToRaw(theirs),
      strategy: "fast_forward_theirs",
      common_entries: shared,
      entries_from_ours: 0,
      entries_from_theirs: theirs.length - shared,
      entries_total: theirs.length,
      reanchored: false,
    };
  }

  const oursSuffix = ours.slice(shared);
  const seenIdentities = new Set(oursSuffix.map(historyEntryIdentity));
  const theirsSuffix = theirs
    .slice(shared)
    .filter((entry) => !seenIdentities.has(historyEntryIdentity(entry)));
  const mergedSuffix = [...oursSuffix, ...theirsSuffix].sort((left, right) => {
    const byTs = compareTimestampStrings(left.ts, right.ts);
    if (byTs !== 0) {
      return byTs;
    }
    const leftFromOurs = seenIdentities.has(historyEntryIdentity(left));
    const rightFromOurs = seenIdentities.has(historyEntryIdentity(right));
    if (leftFromOurs !== rightFromOurs) {
      return Number(rightFromOurs) - Number(leftFromOurs);
    }
    return historyEntryIdentity(left).localeCompare(historyEntryIdentity(right));
  });
  const reanchored = reanchorHistoryEntries([
    ...ours.slice(0, shared),
    ...mergedSuffix,
  ]);
  return {
    merged: historyEntriesToRaw(reanchored.entries),
    strategy: "union_reanchor",
    common_entries: shared,
    entries_from_ours: oursSuffix.length,
    entries_from_theirs: theirsSuffix.length,
    entries_total: reanchored.entries.length,
    reanchored: true,
  };
}

/** Documents the relationship event stream merge result payload exchanged by command, SDK, and package integrations. */
export interface RelationshipStreamMergeResult {
  /** Merged JSONL content with consecutively renumbered `sequence` values, ready to be written as the resolved event store. */
  merged: string;
  /** Strategy the merge used: identical inputs, one-sided fast-forward, or a deterministic union with renumbered sequences. */
  strategy: HistoryMergeStrategy;
  /** Number of events shared by both sides before their streams diverged. */
  common_entries: number;
  /** Number of divergent events contributed by the ours side. */
  entries_from_ours: number;
  /** Number of divergent events contributed by the theirs side. */
  entries_from_theirs: number;
  /** Total events in the merged stream. */
  entries_total: number;
  /** Whether merged events required sequence renumbering (true for every union merge). */
  reanchored: boolean;
}

interface RelationshipStreamEvent {
  /** Globally unique event identity used for prefix detection and suffix deduplication. */
  eventId: string;
  /** One-based append sequence; rewritten consecutively in the merged stream. */
  sequence: number;
  /** ISO timestamp used to order divergent suffixes deterministically. */
  timestamp?: string;
  /** Remaining event payload fields, preserved verbatim. */
  [key: string]: unknown;
}

function parseRelationshipJsonl(
  raw: string,
  label: string,
): RelationshipStreamEvent[] {
  const conflictMarker = findFirstMergeConflictMarker(raw);
  if (conflictMarker) {
    throw new PmCliError(
      `Relationship merge input (${label}) contains unresolved conflict markers at line ${conflictMarker.line}. Merge drivers must receive clean per-side versions.`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  const events: RelationshipStreamEvent[] = [];
  for (const [index, rawLine] of raw.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new PmCliError(
        `Relationship merge input (${label}) contains invalid JSON at line ${index + 1}.`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { eventId?: unknown }).eventId !== "string" ||
      typeof (parsed as { sequence?: unknown }).sequence !== "number"
    ) {
      throw new PmCliError(
        `Relationship merge input (${label}) line ${index + 1} is not a relationship event (eventId + sequence required).`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    events.push(parsed as RelationshipStreamEvent);
  }
  return events;
}

function relationshipEventsToRaw(events: RelationshipStreamEvent[]): string {
  return events.length === 0
    ? ""
    : `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function renumberRelationshipEvents(
  events: RelationshipStreamEvent[],
): RelationshipStreamEvent[] {
  return events.map((event, index) => ({ ...event, sequence: index + 1 }));
}

/**
 * Deterministically merge two diverged versions of one append-only
 * relationship event JSONL store. The store's loader enforces strictly
 * consecutive one-based `sequence` values, so a plain text union of two
 * diverged streams is always unreadable; this merge keeps the shared prefix,
 * unions both divergent suffixes by `eventId` (ordered by event timestamp,
 * ours-first on ties), and renumbers every merged sequence consecutively so
 * the resulting stream loads again. No side's events are ever discarded.
 */
export function mergeRelationshipEventStreams(
  baseRaw: string,
  oursRaw: string,
  theirsRaw: string,
): RelationshipStreamMergeResult {
  parseRelationshipJsonl(baseRaw, "base");
  const ours = parseRelationshipJsonl(oursRaw, "ours");
  const theirs = parseRelationshipJsonl(theirsRaw, "theirs");
  const limit = Math.min(ours.length, theirs.length);
  let shared = 0;
  while (shared < limit && ours[shared].eventId === theirs[shared].eventId) {
    shared += 1;
  }

  if (shared === ours.length && shared === theirs.length) {
    return {
      merged: relationshipEventsToRaw(ours),
      strategy: "identical",
      common_entries: shared,
      entries_from_ours: 0,
      entries_from_theirs: 0,
      entries_total: ours.length,
      reanchored: false,
    };
  }
  if (shared === theirs.length) {
    return {
      merged: relationshipEventsToRaw(ours),
      strategy: "fast_forward_ours",
      common_entries: shared,
      entries_from_ours: ours.length - shared,
      entries_from_theirs: 0,
      entries_total: ours.length,
      reanchored: false,
    };
  }
  if (shared === ours.length) {
    return {
      merged: relationshipEventsToRaw(theirs),
      strategy: "fast_forward_theirs",
      common_entries: shared,
      entries_from_ours: 0,
      entries_from_theirs: theirs.length - shared,
      entries_total: theirs.length,
      reanchored: false,
    };
  }

  const oursSuffix = ours.slice(shared);
  const oursEventIds = new Set(oursSuffix.map((event) => event.eventId));
  const theirsSuffix = theirs
    .slice(shared)
    .filter((event) => !oursEventIds.has(event.eventId));
  const mergedSuffix = [...oursSuffix, ...theirsSuffix].sort((left, right) => {
    const byTs = compareTimestampStrings(
      String(left.timestamp ?? ""),
      String(right.timestamp ?? ""),
    );
    if (byTs !== 0) {
      return byTs;
    }
    const leftFromOurs = oursEventIds.has(left.eventId);
    const rightFromOurs = oursEventIds.has(right.eventId);
    if (leftFromOurs !== rightFromOurs) {
      return Number(rightFromOurs) - Number(leftFromOurs);
    }
    // Array.prototype.sort is stable: returning zero preserves each side's
    // original append order when its events share a timestamp.
    return 0;
  });
  const merged = renumberRelationshipEvents([
    ...ours.slice(0, shared),
    ...mergedSuffix,
  ]);
  return {
    merged: relationshipEventsToRaw(merged),
    strategy: "union_reanchor",
    common_entries: shared,
    entries_from_ours: oursSuffix.length,
    entries_from_theirs: theirsSuffix.length,
    entries_total: merged.length,
    reanchored: true,
  };
}

/**
 * Item metadata collections merged by element-identity set semantics instead
 * of whole-field three-way comparison: concurrent commutative appends from two
 * branches (notes on A, tags on B, a test run on each) must merge cleanly.
 * Element identity is the stable serialization of the normalized element, so
 * an element edited on one side counts as remove-old + add-new and both sides'
 * contributions survive. Plan collections are deliberately excluded: plan
 * steps carry cross-element ordering invariants that set-union would corrupt,
 * so they stay under scalar three-way semantics with explicit conflicts.
 */
export const ITEM_UNION_COLLECTION_FIELDS = [
  "tags",
  "dependencies",
  "comments",
  "notes",
  "learnings",
  "files",
  "tests",
  "test_runs",
  "docs",
  "reminders",
  "events",
] as const;

/** Item metadata fields resolved by deterministic latest-timestamp-wins instead of three-way conflict, so disjoint-field edits never conflict on the shared freshness scalar every mutation rewrites. */
export const ITEM_LATEST_TIMESTAMP_FIELDS = ["updated_at"] as const;

/** Documents the item document merge result payload exchanged by command, SDK, and package integrations. */
export interface ItemDocumentMergeResult {
  /** Serialized merged item document (always parseable; count headers recomputed by canonical serialization). */
  merged: string;
  /** Metadata fields (plus `body`) where both sides changed to different values; resolved toward the preferred side. */
  conflict_fields: string[];
  /** Fields taken from the theirs side by clean three-way resolution. */
  fields_from_theirs: string[];
  /** Collection fields that merged by element-identity union. */
  union_fields: string[];
  /** Which side unresolvable conflicts were resolved toward. */
  preferred: MergePreferredSide;
}

function jsonEquals(left: unknown, right: unknown): boolean {
  return stableStringify(left ?? null) === stableStringify(right ?? null);
}

function unionCollection(
  base: unknown,
  ours: unknown,
  theirs: unknown,
): unknown[] {
  const toEntries = (value: unknown): unknown[] =>
    Array.isArray(value) ? value : [];
  const baseIds = new Set(toEntries(base).map((entry) => stableStringify(entry)));
  const oursEntries = toEntries(ours);
  const oursIds = new Set(oursEntries.map((entry) => stableStringify(entry)));
  const theirsEntries = toEntries(theirs);
  const theirsIds = new Set(
    theirsEntries.map((entry) => stableStringify(entry)),
  );
  const merged = oursEntries.filter((entry) => {
    const identity = stableStringify(entry);
    // An element kept by ours survives unless theirs deleted it (present in
    // base, absent from theirs).
    return !baseIds.has(identity) || theirsIds.has(identity);
  });
  for (const entry of theirsEntries) {
    const identity = stableStringify(entry);
    if (!oursIds.has(identity) && !baseIds.has(identity)) {
      merged.push(entry);
    }
  }
  return merged;
}

function latestTimestamp(ours: unknown, theirs: unknown): unknown {
  return compareTimestampStrings(String(ours), String(theirs)) >= 0
    ? ours
    : theirs;
}

interface ScalarMergeOutcome {
  value: unknown;
  from_theirs: boolean;
  conflict: boolean;
}

function mergeScalarThreeWay(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  preferred: MergePreferredSide,
): ScalarMergeOutcome {
  if (jsonEquals(ours, theirs)) {
    return { value: ours, from_theirs: false, conflict: false };
  }
  if (jsonEquals(base, ours)) {
    return { value: theirs, from_theirs: true, conflict: false };
  }
  if (jsonEquals(base, theirs)) {
    return { value: ours, from_theirs: false, conflict: false };
  }
  return {
    value: preferred === "theirs" ? theirs : ours,
    from_theirs: preferred === "theirs",
    conflict: true,
  };
}

function toMetadataRecord(document: ItemDocument): Record<string, unknown> {
  return { ...(document.metadata as unknown as Record<string, unknown>) };
}

function parseItemMergeSide(
  raw: string,
  label: string,
  options: ItemDocumentFormatOptions,
): ItemDocument {
  try {
    return canonicalDocument(parseItemDocument(raw, options), options);
  } catch (error) {
    throw new PmCliError(
      `Item merge input (${label}) is not a readable item document: ${String(error)}`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
}

interface ItemMetadataMergeAccumulator {
  /** Merged metadata values keyed by canonical field name. */
  merged: Record<string, unknown>;
  /** Scalar fields where both sides diverged from the base. */
  conflictFields: string[];
  /** Scalar fields cleanly selected from the other branch. */
  fieldsFromTheirs: string[];
  /** Collection fields whose final union differs from ours. */
  unionFields: string[];
}

function mergeItemMetadataRecords(
  baseRecord: Record<string, unknown>,
  oursRecord: Record<string, unknown>,
  theirsRecord: Record<string, unknown>,
  preferred: MergePreferredSide,
): ItemMetadataMergeAccumulator {
  const unionFieldSet = new Set<string>(ITEM_UNION_COLLECTION_FIELDS);
  const latestFieldSet = new Set<string>(ITEM_LATEST_TIMESTAMP_FIELDS);
  const fieldNames = [
    ...new Set([...Object.keys(oursRecord), ...Object.keys(theirsRecord)]),
  ].sort((left, right) => left.localeCompare(right));
  const accumulator: ItemMetadataMergeAccumulator = {
    merged: {},
    conflictFields: [],
    fieldsFromTheirs: [],
    unionFields: [],
  };

  for (const field of fieldNames) {
    const baseValue = baseRecord[field];
    const oursValue = oursRecord[field];
    const theirsValue = theirsRecord[field];
    if (unionFieldSet.has(field)) {
      const union = unionCollection(baseValue, oursValue, theirsValue);
      // `fieldNames` is derived from both records' own keys, so a collection
      // reached here is declared by at least one side. Preserve even an empty
      // result (`tags` is required) so serialization never drops it.
      accumulator.merged[field] = union;
      if (!jsonEquals(union, oursValue)) {
        accumulator.unionFields.push(field);
      }
      continue;
    }
    if (latestFieldSet.has(field)) {
      accumulator.merged[field] = latestTimestamp(oursValue, theirsValue);
      continue;
    }
    const outcome = mergeScalarThreeWay(
      baseValue,
      oursValue,
      theirsValue,
      preferred,
    );
    if (outcome.value !== undefined) {
      accumulator.merged[field] = outcome.value;
    }
    if (outcome.conflict) {
      accumulator.conflictFields.push(field);
    } else if (outcome.from_theirs) {
      accumulator.fieldsFromTheirs.push(field);
    }
  }
  return accumulator;
}

/**
 * Field-aware three-way merge of one tracker item document. Commutative
 * collections (notes, tags, tests, ...) union by element identity so
 * concurrent appends never conflict; `updated_at` resolves to the latest
 * timestamp so disjoint-field edits never collide on the shared freshness
 * scalar; every other metadata field and the body use classic three-way
 * resolution. Unresolvable both-sides-changed conflicts are resolved toward
 * the preferred side but reported in `conflict_fields`, and the merged output
 * is always canonically serialized — count-prefixed TOON array headers are
 * recomputed, so the hand-resolution corruption class (stale `notes[N]`
 * headers) cannot be produced by this merge.
 */
export function mergeItemDocuments(
  baseRaw: string,
  oursRaw: string,
  theirsRaw: string,
  options: ItemDocumentFormatOptions & {
    /** Side that wins unresolvable conflicts (default "ours"). */
    preferred?: MergePreferredSide;
  } = {},
): ItemDocumentMergeResult {
  const preferred: MergePreferredSide = options.preferred ?? "ours";
  // An empty base means both branches created the file independently
  // (add/add); three-way falls back to treating every differing field as an
  // ours/theirs decision, which the scalar resolver already models.
  const hasBase = baseRaw.trim().length > 0;
  const ours = parseItemMergeSide(oursRaw, "ours", options);
  const theirs = parseItemMergeSide(theirsRaw, "theirs", options);
  const base = hasBase ? parseItemMergeSide(baseRaw, "base", options) : ours;

  const baseRecord = hasBase
    ? toMetadataRecord(base)
    : ({} as Record<string, unknown>);
  const oursRecord = toMetadataRecord(ours);
  const theirsRecord = toMetadataRecord(theirs);
  const { merged, conflictFields, fieldsFromTheirs, unionFields } =
    mergeItemMetadataRecords(baseRecord, oursRecord, theirsRecord, preferred);

  const bodyOutcome = mergeScalarThreeWay(
    hasBase ? base.body : "",
    ours.body,
    theirs.body,
    preferred,
  );
  if (bodyOutcome.conflict) {
    conflictFields.push("body");
  } else if (bodyOutcome.from_theirs) {
    fieldsFromTheirs.push("body");
  }

  const mergedRaw = serializeItemDocument(
    {
      metadata: merged as unknown as ItemMetadata,
      body: bodyOutcome.value as string,
    },
    options,
  );
  return {
    merged: mergedRaw,
    conflict_fields: conflictFields,
    fields_from_theirs: fieldsFromTheirs,
    union_fields: unionFields,
    preferred,
  };
}

/** Documents the JSON document merge result payload exchanged by command, SDK, and package integrations. */
export interface JsonDocumentMergeResult {
  /** Serialized merged JSON document (two-space indent, trailing newline — the tracker's canonical config style). */
  merged: string;
  /** Dotted key paths where both sides changed to different values; resolved toward the preferred side. */
  conflict_paths: string[];
  /** Dotted key paths taken from the theirs side by clean three-way resolution. */
  paths_from_theirs: string[];
  /** Which side unresolvable conflicts were resolved toward. */
  preferred: MergePreferredSide;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function parseJsonSide(raw: string, label: string): unknown {
  const conflictMarker = findFirstMergeConflictMarker(raw);
  if (conflictMarker) {
    throw new PmCliError(
      `JSON merge input (${label}) contains unresolved conflict markers at line ${conflictMarker.line}.`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  if (raw.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new PmCliError(
      `JSON merge input (${label}) is not valid JSON.`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
}

function mergeJsonValue(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  preferred: MergePreferredSide,
  pathPrefix: string,
  conflictPaths: string[],
  pathsFromTheirs: string[],
): unknown {
  if (jsonEquals(ours, theirs)) {
    return ours;
  }
  if (isPlainObject(ours) && isPlainObject(theirs)) {
    const baseObject = isPlainObject(base) ? base : {};
    const merged: Record<string, unknown> = {};
    const keys = [
      ...new Set([...Object.keys(ours), ...Object.keys(theirs)]),
    ].sort((left, right) => left.localeCompare(right));
    for (const key of keys) {
      const childPath = pathPrefix.length > 0 ? `${pathPrefix}.${key}` : key;
      const child = mergeJsonKey(
        baseObject,
        ours,
        theirs,
        key,
        preferred,
        childPath,
        conflictPaths,
        pathsFromTheirs,
      );
      if (child !== undefined) {
        merged[key] = child;
      }
    }
    return merged;
  }
  const outcome = mergeScalarThreeWay(base, ours, theirs, preferred);
  if (outcome.conflict) {
    conflictPaths.push(pathPrefix);
  } else if (outcome.from_theirs) {
    pathsFromTheirs.push(pathPrefix);
  }
  return outcome.value;
}

function mergeJsonKey(
  base: Record<string, unknown>,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  key: string,
  preferred: MergePreferredSide,
  childPath: string,
  conflictPaths: string[],
  pathsFromTheirs: string[],
): unknown {
  const inOurs = Object.prototype.hasOwnProperty.call(ours, key);
  const inTheirs = Object.prototype.hasOwnProperty.call(theirs, key);
  const inBase = Object.prototype.hasOwnProperty.call(base, key);
  if (inOurs && inTheirs) {
    return mergeJsonValue(
      base[key],
      ours[key],
      theirs[key],
      preferred,
      childPath,
      conflictPaths,
      pathsFromTheirs,
    );
  }
  if (inOurs) {
    // Present only in ours: either ours added it (keep) or theirs deleted it
    // (honor the delete when ours left it untouched from base).
    if (inBase && jsonEquals(base[key], ours[key])) {
      pathsFromTheirs.push(childPath);
      return undefined;
    }
    if (inBase) {
      conflictPaths.push(childPath);
      return preferred === "theirs" ? undefined : ours[key];
    }
    return ours[key];
  }
  // Present only in theirs (mirror of the branch above).
  if (inBase && jsonEquals(base[key], theirs[key])) {
    return undefined;
  }
  if (inBase) {
    conflictPaths.push(childPath);
    return preferred === "theirs" ? theirs[key] : undefined;
  }
  pathsFromTheirs.push(childPath);
  return theirs[key];
}

/**
 * Key-level three-way merge for the tracker's single-file JSON configuration
 * artifacts (`settings.json`, `schema/*.json`). Nested objects merge
 * recursively per key so two branches editing disjoint settings never
 * conflict; both-sides-changed leaf values resolve toward the preferred side
 * and are reported in `conflict_paths`. The output is always valid JSON, so a
 * merged configuration can never regress into the silent-defaults fallback
 * that raw conflict markers cause.
 */
export function mergeJsonDocuments(
  baseRaw: string,
  oursRaw: string,
  theirsRaw: string,
  options: {
    /** Side that wins unresolvable conflicts (default "ours"). */
    preferred?: MergePreferredSide;
  } = {},
): JsonDocumentMergeResult {
  const preferred: MergePreferredSide = options.preferred ?? "ours";
  const base = parseJsonSide(baseRaw, "base");
  const ours = parseJsonSide(oursRaw, "ours");
  const theirs = parseJsonSide(theirsRaw, "theirs");
  const conflictPaths: string[] = [];
  const pathsFromTheirs: string[] = [];
  const merged = mergeJsonValue(
    base,
    ours,
    theirs,
    preferred,
    "",
    conflictPaths,
    pathsFromTheirs,
  );
  return {
    merged: `${JSON.stringify(merged ?? null, null, 2)}\n`,
    conflict_paths: conflictPaths,
    paths_from_theirs: pathsFromTheirs,
    preferred,
  };
}
