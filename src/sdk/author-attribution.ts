/**
 * @module sdk/author-attribution
 *
 * Provides reusable diagnostics for mutation-author provenance in tracker history.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { appendWorkspaceAuditEvent } from "../core/history/workspace-history.js";
import { readSettings } from "../core/store/settings.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";

/**
 * Refuse an acknowledgment argument as a classified usage error.
 *
 * Argument validation is an expected outcome of a public mutation surface, not a
 * product failure. Raising a bare `TypeError` left the refusal at exit code 1,
 * which the CLI observability boundary reports as an unclassified handled error
 * and the release gate then reads as a blocking production issue. Carrying
 * {@link EXIT_CODE.USAGE} plus a stable code keeps the refusal teachable and
 * keeps expected validation out of the error channel without masking genuine
 * failures, which retain their own exit codes.
 */
function refuseAuthorAcknowledgmentArgument(
  message: string,
  code: string,
): never {
  throw new PmCliError(message, EXIT_CODE.USAGE, { code });
}

/** First release-governance anchor after which unknown authors require remediation. */
export const HISTORY_AUTHOR_ATTRIBUTION_BASELINE = "2026-07-15T06:22:12.276Z";

/** Parsed epoch for the immutable attribution baseline used by every stream scan. */
const HISTORY_AUTHOR_ATTRIBUTION_BASELINE_MS = Date.parse(
  HISTORY_AUTHOR_ATTRIBUTION_BASELINE,
);

/** Attribution policy indexed by unknown-author and post-baseline flags. */
const HISTORY_AUTHOR_EVENT_CLASSIFICATIONS = [
  ["attributed", "attributed"],
  ["legacy_unknown", "actionable_unknown"],
] as const;

/** Return history string fields unchanged while normalizing other values to empty text. */
const historyStringValue = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** Identifies one history event whose mutation author is absent or explicitly unknown. */
export interface UnknownAuthorHistoryEvent {
  /** Item whose history stream contains the event. */
  item_id: string;
  /** One-based JSONL line number. */
  line: number;
}

/** Summarizes mutation-author provenance across all readable tracker history streams. */
export interface HistoryAuthorAttributionScan {
  /** Number of readable history streams inspected. */
  checked_streams: number;
  /** Number of non-empty history events inspected. */
  checked_events: number;
  /** Number of events without attributable authorship. */
  unknown_event_count: number;
  /** Immutable pre-baseline events retained as historical information. */
  legacy_unknown_event_count: number;
  /** Timestamped post-baseline events that require author-attribution fixes. */
  actionable_unknown_event_count: number;
  /** Post-baseline unknown events dispositioned by an append-only review event. */
  acknowledged_actionable_event_count: number;
  /** Stable, sorted item ids containing unknown-author events. */
  affected_item_ids: string[];
  /** Bounded examples suitable for diagnostic output. */
  samples: UnknownAuthorHistoryEvent[];
  /** Whether additional undispositioned unknown-author examples were omitted. */
  samples_truncated: boolean;
  /** Complete actionable coordinates when explicitly requested by a trusted caller. */
  actionable_events?: UnknownAuthorHistoryEvent[];
}

/** Classifies one parsed history event by author provenance and baseline age. */
export const classifyHistoryAuthorEvent = (
  parsed: unknown,
): "attributed" | "legacy_unknown" | "actionable_unknown" => {
  const record = (parsed ?? {}) as { author?: unknown; ts?: unknown };
  const author = historyStringValue(record.author).trim().toLowerCase();
  const authorClass = Number(["", "unknown"].includes(author)) as 0 | 1;
  const timestampClass = Number(
    Date.parse(historyStringValue(record.ts)) >=
      HISTORY_AUTHOR_ATTRIBUTION_BASELINE_MS,
  ) as 0 | 1;
  return HISTORY_AUTHOR_EVENT_CLASSIFICATIONS[authorClass][timestampClass];
};

function inspectHistoryAuthorStreamWithActionableEvents(
  itemId: string,
  raw: string,
  sampleLimit = 20,
  acknowledgedEvents: ReadonlySet<string> = new Set<string>(),
  includeActionableEvents = false,
): Pick<
  HistoryAuthorAttributionScan,
  | "checked_events"
  | "unknown_event_count"
  | "legacy_unknown_event_count"
  | "actionable_unknown_event_count"
  | "acknowledged_actionable_event_count"
  | "samples"
  | "samples_truncated"
  | "actionable_events"
> {
  const samples: UnknownAuthorHistoryEvent[] = [];
  const actionableEvents: UnknownAuthorHistoryEvent[] = [];
  const unknownCounts = {
    legacy_unknown: 0,
    actionable_unknown: 0,
  };
  const boundedSampleLimit = Math.max(0, sampleLimit);
  let checkedEvents = 0;
  let unknownEvents = 0;
  let acknowledgedActionableEvents = 0;
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    checkedEvents += 1;
    const classification = classifyHistoryAuthorEvent(parsed);
    if (classification === "attributed") {
      continue;
    }
    unknownEvents += 1;
    if (
      classification === "actionable_unknown" &&
      acknowledgedEvents.has(`${itemId}:${index + 1}`)
    ) {
      acknowledgedActionableEvents += 1;
      continue;
    }
    unknownCounts[classification] += 1;
    if (includeActionableEvents && classification === "actionable_unknown") {
      actionableEvents.push({ item_id: itemId, line: index + 1 });
    }
    if (samples.length < boundedSampleLimit) {
      samples.push({ item_id: itemId, line: index + 1 });
    }
  }
  return {
    checked_events: checkedEvents,
    unknown_event_count: unknownEvents,
    legacy_unknown_event_count: unknownCounts.legacy_unknown,
    actionable_unknown_event_count: unknownCounts.actionable_unknown,
    acknowledged_actionable_event_count: acknowledgedActionableEvents,
    samples,
    samples_truncated:
      unknownCounts.legacy_unknown + unknownCounts.actionable_unknown >
      samples.length,
    actionable_events: actionableEvents,
  };
}

/** Inspect one readable JSONL stream without performing filesystem I/O. */
export const inspectHistoryAuthorStream = (
  itemId: string,
  raw: string,
  sampleLimit = 20,
  acknowledgedEvents: ReadonlySet<string> = new Set<string>(),
): Pick<
  HistoryAuthorAttributionScan,
  | "checked_events"
  | "unknown_event_count"
  | "legacy_unknown_event_count"
  | "actionable_unknown_event_count"
  | "acknowledged_actionable_event_count"
  | "samples"
  | "samples_truncated"
  | "actionable_events"
> =>
  inspectHistoryAuthorStreamWithActionableEvents(
    itemId,
    raw,
    sampleLimit,
    acknowledgedEvents,
  );

function collectAcknowledgedUnknownEvents(raw: string): Set<string> {
  const acknowledged = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const context =
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { context?: unknown }).context === "object" &&
      (parsed as { context?: unknown }).context !== null
        ? (parsed as { context: Record<string, unknown> }).context
        : {};
    const acknowledgment = context.author_acknowledgment;
    if (
      typeof acknowledgment !== "object" ||
      acknowledgment === null ||
      !Array.isArray((acknowledgment as { events?: unknown }).events)
    ) {
      continue;
    }
    for (const event of (acknowledgment as { events: unknown[] }).events) {
      if (
        typeof event === "object" &&
        event !== null &&
        typeof (event as { item_id?: unknown }).item_id === "string" &&
        Number.isSafeInteger((event as { line?: unknown }).line)
      ) {
        acknowledged.add(
          `${(event as { item_id: string }).item_id}:${String(
            (event as { line: number }).line,
          )}`,
        );
      }
    }
  }
  return acknowledged;
}

/**
 * Scan append-only tracker history for missing or `unknown` author values.
 * Malformed and unreadable streams are deliberately left to integrity diagnostics.
 */
export const scanHistoryAuthorAttribution = async (
  pmRoot: string,
  sampleLimit = 20,
  includeActionableEvents = false,
): Promise<HistoryAuthorAttributionScan> => {
  const historyDirectory = path.join(pmRoot, "history");
  let fileNames: string[];
  try {
    fileNames = (await fs.readdir(historyDirectory))
      .filter((fileName) => fileName.endsWith(".jsonl"))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    fileNames = [];
  }
  const affectedItemIds = new Set<string>();
  const samples: UnknownAuthorHistoryEvent[] = [];
  const actionableEvents: UnknownAuthorHistoryEvent[] = [];
  let checkedStreams = 0;
  let checkedEvents = 0;
  let unknownEventCount = 0;
  let legacyUnknownEventCount = 0;
  let actionableUnknownEventCount = 0;
  let acknowledgedActionableEventCount = 0;
  const workspaceFileName = "_workspace.jsonl";
  let acknowledgedEvents = new Set<string>();
  if (fileNames.includes(workspaceFileName)) {
    try {
      acknowledgedEvents = collectAcknowledgedUnknownEvents(
        await fs.readFile(
          path.join(historyDirectory, workspaceFileName),
          "utf8",
        ),
      );
    } catch {
      acknowledgedEvents = new Set<string>();
    }
  }
  for (const fileName of fileNames) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(historyDirectory, fileName), "utf8");
    } catch {
      continue;
    }
    const itemId = fileName.slice(0, -".jsonl".length);
    const inspected = inspectHistoryAuthorStreamWithActionableEvents(
      itemId,
      raw,
      sampleLimit - samples.length,
      acknowledgedEvents,
      includeActionableEvents,
    );
    checkedStreams += 1;
    checkedEvents += inspected.checked_events;
    unknownEventCount += inspected.unknown_event_count;
    legacyUnknownEventCount += inspected.legacy_unknown_event_count;
    actionableUnknownEventCount += inspected.actionable_unknown_event_count;
    acknowledgedActionableEventCount +=
      inspected.acknowledged_actionable_event_count;
    if (inspected.unknown_event_count > 0) {
      affectedItemIds.add(itemId);
    }
    samples.push(...inspected.samples);
    if (includeActionableEvents) {
      actionableEvents.push(
        ...(inspected.actionable_events as UnknownAuthorHistoryEvent[]),
      );
    }
  }
  const undispositionedUnknownEventCount =
    legacyUnknownEventCount + actionableUnknownEventCount;
  return {
    checked_streams: checkedStreams,
    checked_events: checkedEvents,
    unknown_event_count: unknownEventCount,
    legacy_unknown_event_count: legacyUnknownEventCount,
    actionable_unknown_event_count: actionableUnknownEventCount,
    acknowledged_actionable_event_count: acknowledgedActionableEventCount,
    affected_item_ids: [...affectedItemIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    samples,
    samples_truncated: undispositionedUnknownEventCount > samples.length,
    ...(includeActionableEvents ? { actionable_events: actionableEvents } : {}),
  };
};

/** Parameters for append-only disposition of immutable unknown-author events. */
export interface AcknowledgeUnknownAuthorEventsOptions {
  /** Events identified by item id and one-based history line. */
  events?: UnknownAuthorHistoryEvent[];
  /** Select every currently actionable, undispositioned event in the tracker. */
  all_actionable?: boolean;
  /** Principal attributed by maintainer review. */
  attributed_author: string;
  /** Reviewer appending the disposition event. */
  reviewer: string;
  /** Evidence-backed rationale for the attribution. */
  reason: string;
}

/**
 * Append an audited disposition for immutable unknown-author events without
 * rewriting their original streams.
 */
export async function acknowledgeUnknownAuthorHistoryEvents(
  pmRoot: string,
  options: AcknowledgeUnknownAuthorEventsOptions,
): Promise<{ acknowledged: number; history_path: string }> {
  const reviewer = options.reviewer.trim();
  const attributedAuthor = options.attributed_author.trim();
  const reason = options.reason.trim();
  const explicitEvents = options.events ?? [];
  const selectorCount =
    Number(options.all_actionable === true) + Number(explicitEvents.length > 0);
  if (selectorCount > 1) {
    refuseAuthorAcknowledgmentArgument(
      "Author acknowledgment accepts either explicit events or all_actionable, not both.",
      "history_author_acknowledge_selector_conflict",
    );
  }
  const selectedEvents =
    options.all_actionable === true
      ? ((await scanHistoryAuthorAttribution(pmRoot, 0, true))
          .actionable_events as UnknownAuthorHistoryEvent[])
      : explicitEvents;
  const requiredValuesMissing = [
    selectedEvents.length > 0,
    reviewer.length > 0,
    reviewer.toLowerCase() !== "unknown",
    attributedAuthor.length > 0,
    attributedAuthor.toLowerCase() !== "unknown",
    reason.length > 0,
  ].includes(false);
  if (requiredValuesMissing) {
    refuseAuthorAcknowledgmentArgument(
      "Author acknowledgment requires events, reviewer, attributed_author, and reason.",
      "history_author_acknowledge_required_values_missing",
    );
  }
  const uniqueEvents = [
    ...new Map(
      selectedEvents.map((event) => [
        `${event.item_id}:${event.line}`,
        { item_id: event.item_id, line: event.line },
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.item_id.localeCompare(right.item_id) || left.line - right.line,
  );
  for (const event of uniqueEvents) {
    const invalidCoordinate = [
      /^[a-z0-9][a-z0-9-]*$/i.test(event.item_id),
      Number.isSafeInteger(event.line),
      event.line >= 1,
    ].includes(false);
    if (invalidCoordinate) {
      refuseAuthorAcknowledgmentArgument(
        `Unknown-author acknowledgment target ${event.item_id}:${event.line} is not readable.`,
        "history_author_acknowledge_target_unreadable",
      );
    }
    let parsed: unknown;
    try {
      const raw = await fs.readFile(
        path.join(pmRoot, "history", `${event.item_id}.jsonl`),
        "utf8",
      );
      const line = raw.split(/\r?\n/)[event.line - 1];
      parsed = JSON.parse(line ?? "");
    } catch {
      refuseAuthorAcknowledgmentArgument(
        `Unknown-author acknowledgment target ${event.item_id}:${event.line} is not readable.`,
        "history_author_acknowledge_target_unreadable",
      );
    }
    if (classifyHistoryAuthorEvent(parsed) !== "actionable_unknown") {
      refuseAuthorAcknowledgmentArgument(
        `Author acknowledgment target ${event.item_id}:${event.line} is not an actionable unknown-author event.`,
        "history_author_acknowledge_target_not_actionable",
      );
    }
  }
  const settings = await readSettings(pmRoot);
  const appended = await appendWorkspaceAuditEvent({
    pmRoot,
    op: "history:author-acknowledge",
    author: reviewer,
    context: {
      author_acknowledgment: {
        events: uniqueEvents,
        attributed_author: attributedAuthor,
      },
    },
    message: reason,
    lockTtlSeconds: settings.locks.ttl_seconds,
    lockWaitMs: settings.locks.wait_ms,
  });
  return {
    acknowledged: uniqueEvents.length,
    history_path: appended.historyPath,
  };
}
