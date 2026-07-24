/**
 * @module sdk/mutation-events
 *
 * Exposes cursor-resumable, cross-item mutation events over the append-only
 * history store without requiring a daemon or shell subprocess.
 */
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  queryHistoryEventIndex,
  rebuildHistoryEventIndex,
  type IndexedHistoryEvent,
} from "../core/history/event-index.js";
import { pathExists } from "../core/fs/fs-utils.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { stableStringify } from "../core/shared/serialization.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import type { HistoryEntry } from "../types/index.js";

const MUTATION_EVENT_CURSOR_VERSION = 1;
const MUTATION_EVENT_CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 1_000;
const DEFAULT_FOLLOW_INTERVAL_MS = 250;

interface MutationEventCursorEnvelope {
  version: number;
  fingerprint: string;
  ts: string;
  stream_id: string;
  stream_offset: number;
}

/** Workspace and filtering controls for mutation-event reads. */
export interface ListMutationEventsOptions {
  /** Explicit tracker root, equivalent to global `--pm-path`. */
  pmRoot?: string;
  /** Working directory used to discover the nearest tracker. */
  cwd?: string;
  /** Opaque cursor or inclusive ISO timestamp lower bound. */
  since?: string;
  /** Operation name filter, repeatable through arrays. */
  type?: string | readonly string[];
  /** Author filter, repeatable through arrays. */
  author?: string | readonly string[];
  /** Item/workspace stream filter, repeatable through arrays. */
  item?: string | readonly string[];
  /** Maximum events returned, capped at 1,000. */
  limit?: number;
  /** Include the complete history entry instead of the compact projection. */
  full?: boolean;
}

/** One ordered cross-item mutation event. */
export interface MutationEvent {
  /** Cursor that resumes strictly after this event. */
  cursor: string;
  /** Item id or `_workspace` stream subject. */
  item_id: string;
  /** One-based version within the subject's stream. */
  version: number;
  /** Mutation timestamp. */
  ts: string;
  /** Attributed mutation author. */
  author: string;
  /** Stable mutation operation. */
  type: string;
  /** Optional mutation message. */
  message?: string;
  /** Number of JSON Patch operations in the history entry. */
  patch_count: number;
  /** Complete authoritative history entry when `full` is requested. */
  entry?: HistoryEntry;
}

/** Bounded event page returned by {@link listMutationEvents}. */
export interface MutationEventPage {
  /** Ordered mutation events. */
  events: MutationEvent[];
  /** Number of events in this page. */
  count: number;
  /** Whether another matching event is immediately available. */
  has_more: boolean;
  /** Cursor that resumes after the final returned event. */
  next_cursor?: string;
  /** Persistent derived projection used for the read. */
  source: "derived_index";
}

/** Follow controls accepted by {@link subscribeMutationEvents}. */
export interface SubscribeMutationEventsOptions
  extends ListMutationEventsOptions {
  /** Delay between empty catch-up reads. */
  intervalMs?: number;
  /** Cancellation signal for a long-lived subscription. */
  signal?: AbortSignal;
}

function normalizeFilter(
  value: string | readonly string[] | undefined,
): string[] | undefined {
  if (value === undefined) return undefined;
  const values = typeof value === "string" ? [value] : value;
  const normalized = [
    ...new Set(
      values
        .flatMap((entry) => entry.split(","))
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right));
  return normalized.length === 0 ? undefined : normalized;
}

function eventQueryFingerprint(options: ListMutationEventsOptions): string {
  return createHash("sha256")
    .update(
      stableStringify({
        type: normalizeFilter(options.type),
        author: normalizeFilter(options.author),
        item: normalizeFilter(options.item),
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

function encodeMutationEventCursor(
  event: IndexedHistoryEvent,
  fingerprint: string,
): string {
  const envelope: MutationEventCursorEnvelope = {
    version: MUTATION_EVENT_CURSOR_VERSION,
    fingerprint,
    ts: event.entry.ts,
    stream_id: event.stream_id,
    stream_offset: event.stream_offset,
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

function isMutationEventCursorEnvelope(
  value: unknown,
  fingerprint: string,
): value is MutationEventCursorEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<MutationEventCursorEnvelope>;
  return [
    candidate.version === MUTATION_EVENT_CURSOR_VERSION,
    candidate.fingerprint === fingerprint,
    typeof candidate.ts === "string",
    typeof candidate.stream_id === "string",
    typeof candidate.stream_offset === "number",
    Number.isSafeInteger(candidate.stream_offset),
    Number(candidate.stream_offset) >= 0,
  ].every(Boolean);
}

function decodeMutationEventCursor(
  cursor: string,
  fingerprint: string,
): MutationEventCursorEnvelope {
  const normalized = cursor.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 4_096 ||
    !MUTATION_EVENT_CURSOR_PATTERN.test(normalized)
  ) {
    throw new PmCliError(
      "Invalid mutation event cursor.",
      EXIT_CODE.USAGE,
      { code: "invalid_event_cursor" },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(normalized, "base64url").toString("utf8"),
    ) as unknown;
  } catch {
    throw new PmCliError(
      "Invalid mutation event cursor.",
      EXIT_CODE.USAGE,
      { code: "invalid_event_cursor" },
    );
  }
  if (!isMutationEventCursorEnvelope(parsed, fingerprint)) {
    throw new PmCliError(
      "Mutation event cursor does not match this query.",
      EXIT_CODE.USAGE,
      { code: "event_cursor_query_mismatch" },
    );
  }
  return parsed;
}

function parseMutationEventLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_EVENT_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > MAX_EVENT_LIMIT
  ) {
    throw new PmCliError(
      `Mutation event limit must be an integer from 0 to ${MAX_EVENT_LIMIT}.`,
      EXIT_CODE.USAGE,
      { code: "invalid_event_limit" },
    );
  }
  return limit;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function resolveMutationEventStart(
  sinceValue: string | undefined,
  fingerprint: string,
): {
  cursor?: MutationEventCursorEnvelope;
  sinceTimestamp?: string;
} {
  const since = sinceValue?.trim();
  if (!since) return {};
  if (MUTATION_EVENT_CURSOR_PATTERN.test(since)) {
    return { cursor: decodeMutationEventCursor(since, fingerprint) };
  }
  const milliseconds = Date.parse(since);
  if (!Number.isFinite(milliseconds)) {
    throw new PmCliError(
      "Mutation event --since must be an event cursor or ISO timestamp.",
      EXIT_CODE.USAGE,
      { code: "invalid_event_since" },
    );
  }
  return { sinceTimestamp: new Date(milliseconds).toISOString() };
}

/** Read one bounded page of mutation events from the persistent projection. */
export async function listMutationEvents(
  options: ListMutationEventsOptions = {},
): Promise<MutationEventPage> {
  const pmRoot = resolvePmRoot(options.cwd ?? process.cwd(), options.pmRoot);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const requestedLimit = parseMutationEventLimit(options.limit);
  const fingerprint = eventQueryFingerprint(options);
  const { cursor, sinceTimestamp } = resolveMutationEventStart(
    options.since,
    fingerprint,
  );
  const query = {
    ...(cursor
      ? {
          after_ts: cursor.ts,
          after_stream_id: cursor.stream_id,
          after_stream_offset: cursor.stream_offset,
        }
      : sinceTimestamp
        ? { since_ts: sinceTimestamp }
        : {}),
    ops: normalizeFilter(options.type),
    authors: normalizeFilter(options.author),
    stream_ids: normalizeFilter(options.item),
    limit: requestedLimit,
  };
  let indexed = await queryHistoryEventIndex(pmRoot, query);
  if (indexed === null) {
    if (!(await rebuildHistoryEventIndex(pmRoot))) {
      throw new PmCliError(
        "Mutation events require a runtime with stable node:sqlite support.",
        EXIT_CODE.GENERIC_FAILURE,
        { code: "event_index_unavailable" },
      );
    }
    indexed = await queryHistoryEventIndex(pmRoot, query);
  }
  if (indexed === null) {
    throw new PmCliError(
      "Mutation event index could not be opened after rebuild.",
      EXIT_CODE.GENERIC_FAILURE,
      { code: "event_index_unavailable" },
    );
  }
  const events = indexed.events.map((event) => ({
    cursor: encodeMutationEventCursor(event, fingerprint),
    item_id: event.stream_id,
    version: event.stream_offset + 1,
    ts: event.entry.ts,
    author: event.entry.author,
    type: event.entry.op,
    ...(event.entry.message === undefined
      ? {}
      : { message: event.entry.message }),
    patch_count: event.entry.patch.length,
    ...(options.full === true ? { entry: event.entry } : {}),
  }));
  return {
    events,
    count: events.length,
    has_more: indexed.has_more,
    ...(events.length === 0
      ? {}
      : { next_cursor: events[events.length - 1].cursor }),
    source: "derived_index",
  };
}

/**
 * Subscribe to committed mutation facts as an async iterable. The iterator
 * performs cursor catch-up reads and waits only when no new event is available.
 */
export async function* subscribeMutationEvents(
  options: SubscribeMutationEventsOptions = {},
): AsyncGenerator<MutationEvent, void, void> {
  const intervalMs = options.intervalMs ?? DEFAULT_FOLLOW_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10) {
    throw new PmCliError(
      "Mutation event follow interval must be an integer of at least 10ms.",
      EXIT_CODE.USAGE,
      { code: "invalid_event_follow_interval" },
    );
  }
  let cursor = options.since;
  while (options.signal?.aborted !== true) {
    const page = await listMutationEvents({ ...options, since: cursor });
    if (page.events.length > 0) {
      for (const event of page.events) {
        yield event;
      }
      cursor = page.next_cursor;
      continue;
    }
    try {
      await delay(intervalMs, undefined, { signal: options.signal });
    } catch (error: unknown) {
      if (isAbortError(error)) return;
      throw error;
    }
  }
}

/** Public test seams for cursor contract verification. */
export const _testOnlyMutationEvents = {
  decodeMutationEventCursor,
  encodeMutationEventCursor,
  eventQueryFingerprint,
  isAbortError,
  isMutationEventCursorEnvelope,
  parseMutationEventLimit,
  resolveMutationEventStart,
};
