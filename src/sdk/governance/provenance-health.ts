/**
 * @module sdk/governance/provenance-health
 *
 * Reads bounded, privacy-safe provenance resolver outcomes for health checks.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { HistoryEntry } from "../../types/index.js";

/** Aggregated resolver attempts for one harness provenance dimension. */
export interface ProvenanceResolverHealthOutcome {
  /** Detected harness namespace. */
  harness: string;
  /** Provenance dimension resolved by the bounded resolver. */
  dimension: string;
  /** Built-in resolver name. */
  resolver: string;
  /** Events on which the resolver was actually attempted. */
  attempts: number;
  /** Attempted events that produced a bounded value. */
  successes: number;
}

/** Aggregate for legacy provenance values that violate the bounded domain. */
export interface ProvenanceValueHealthFinding {
  /** Detected harness namespace. */
  harness: string;
  /** Provenance dimension containing the invalid value. */
  dimension: string;
  /** Privacy-safe invalid-value class. */
  kind: "boolean" | "single_digit";
  /** Events containing this invalid value class. */
  count: number;
}

/** Bounded provenance health result suitable for `pm health` adapters. */
export interface ProvenanceResolverHealthScan {
  /** Stable resolver outcome aggregates. */
  outcomes: ProvenanceResolverHealthOutcome[];
  /** Aggregated invalid legacy values without retaining the values themselves. */
  invalid_values: ProvenanceValueHealthFinding[];
  /** Advisory warnings for attempted resolvers with no success. */
  warnings: string[];
  /** Number of nonblank history events inspected. */
  events_read: number;
  /** Whether an event or byte ceiling omitted history input. */
  truncated: boolean;
}

const DEFAULT_PROVENANCE_HISTORY_BYTE_LIMIT = 8_388_608;
const ATTEMPTED_PROVENANCE_OUTCOME_STATUSES = new Set(["resolved", "failed"]);
const INVALID_PROVENANCE_VALUE_CLASSIFIERS: ReadonlyArray<{
  kind: ProvenanceValueHealthFinding["kind"];
  matches: (value: unknown) => boolean;
}> = [
  {
    kind: "boolean",
    matches: (value) =>
      typeof value === "boolean" ||
      (typeof value === "string" && /^(?:true|false)$/iu.test(value.trim())),
  },
  {
    kind: "single_digit",
    matches: (value) =>
      (typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 9) ||
      (typeof value === "string" && /^\d$/u.test(value.trim())),
  },
];

/** Privacy-safe receipt for an explicit provenance normalization pass. */
export interface ProvenanceNormalizationReceipt {
  /** Whether at least one immutable event required normalization. */
  changed: boolean;
  /** Immutable events whose invalid provenance observations were removed. */
  events_changed: number;
  /** Total invalid observations removed without retaining their values. */
  observations_removed: number;
  /** Aggregate invalid-value classes removed by the pass. */
  invalid_values: ProvenanceValueHealthFinding[];
}

/** Normalized entries plus the privacy-safe mutation receipt. */
export interface ProvenanceNormalizationResult {
  /** History entries with invalid bounded observations removed. */
  entries: HistoryEntry[];
  /** Aggregate mutation receipt; never includes an observed value. */
  receipt: ProvenanceNormalizationReceipt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidProvenanceValueKind(
  value: unknown,
): ProvenanceValueHealthFinding["kind"] | undefined {
  return INVALID_PROVENANCE_VALUE_CLASSIFIERS.find((classifier) =>
    classifier.matches(value),
  )?.kind;
}

/**
 * Remove only provenance observations whose values violate the bounded domain.
 * History operations, patches, timestamps, authors, and hashes are retained;
 * the receipt exposes aggregate classes and counts but never the removed value.
 */
export function normalizeInvalidHistoryProvenance(
  entries: HistoryEntry[],
): ProvenanceNormalizationResult {
  const invalidValues = new Map<string, ProvenanceValueHealthFinding>();
  let eventsChanged = 0;
  let observationsRemoved = 0;
  const normalized = entries.map((entry) => {
    const provenance = isRecord(entry.agent_provenance)
      ? entry.agent_provenance
      : undefined;
    if (provenance === undefined) return entry;
    const retained: Record<string, unknown> = {};
    let eventChanged = false;
    for (const [dimension, observation] of Object.entries(provenance)) {
      const kind = isRecord(observation)
        ? invalidProvenanceValueKind(observation.value)
        : undefined;
      if (kind === undefined) {
        retained[dimension] = observation;
        continue;
      }
      eventChanged = true;
      observationsRemoved += 1;
      const harness = entry.agent_harness ?? "unknown";
      const key = `${harness}\0${dimension}\0${kind}`;
      const aggregate = invalidValues.get(key) ?? {
        harness,
        dimension,
        kind,
        count: 0,
      };
      aggregate.count += 1;
      invalidValues.set(key, aggregate);
    }
    if (!eventChanged) return entry;
    eventsChanged += 1;
    const next = { ...entry } as HistoryEntry;
    if (Object.keys(retained).length === 0) {
      delete next.agent_provenance;
    } else {
      next.agent_provenance = retained as HistoryEntry["agent_provenance"];
    }
    return next;
  });
  return {
    entries: normalized,
    receipt: {
      changed: eventsChanged > 0,
      events_changed: eventsChanged,
      observations_removed: observationsRemoved,
      invalid_values: [...invalidValues.values()].sort(
        (left, right) =>
          left.harness.localeCompare(right.harness) ||
          left.dimension.localeCompare(right.dimension) ||
          left.kind.localeCompare(right.kind),
      ),
    },
  };
}

/** Find every history stream requiring provenance normalization without returning raw values. */
export async function listInvalidProvenanceHistoryStreamIds(
  pmRoot: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (const file of await listHistoryFiles(pmRoot)) {
    try {
      const content = await fs.readFile(path.join(pmRoot, "history", file), "utf8");
      for (const line of content.split("\n")) {
        if (line.trim().length === 0) continue;
        const entry = parseHistoryEntry(line);
        if (entry === null || !isRecord(entry.agent_provenance)) continue;
        const invalid = Object.values(entry.agent_provenance).some(
          (observation) =>
            isRecord(observation) &&
            invalidProvenanceValueKind(observation.value) !== undefined,
        );
        if (invalid) {
          ids.push(file.slice(0, -".jsonl".length));
          break;
        }
      }
    } catch {
      // Integrity diagnostics own unreadable or malformed streams. This census
      // only selects safely parseable streams for the explicit normalizer.
    }
  }
  return ids;
}

async function listHistoryFiles(pmRoot: string): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(pmRoot, "history")))
      .filter((file) => file.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }
}

async function readHistoryFile(
  pmRoot: string,
  file: string,
  byteLimit: number,
): Promise<{
  content: string;
  bytesRead: number;
  complete: boolean;
} | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(path.join(pmRoot, "history", file), "r");
    const size = (await handle.stat()).size;
    const length = Math.min(size, Math.max(0, byteLimit));
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const decoded = buffer.subarray(0, bytesRead).toString("utf8");
    const complete = bytesRead >= size;
    const finalNewline = decoded.lastIndexOf("\n");
    let content = decoded;
    if (!complete) {
      content = finalNewline === -1 ? "" : decoded.slice(0, finalNewline + 1);
    }
    return {
      content,
      bytesRead,
      complete,
    };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function parseHistoryEntry(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function collectResolverOutcomes(
  entry: Record<string, unknown>,
  aggregates: Map<string, ProvenanceResolverHealthOutcome>,
  invalidValues: Map<string, ProvenanceValueHealthFinding>,
): void {
  const harness =
    typeof entry.agent_harness === "string" ? entry.agent_harness : undefined;
  if (harness === undefined) return;
  const provenance = isRecord(entry.agent_provenance)
    ? entry.agent_provenance
    : {};
  Object.entries(provenance).forEach(([dimension, observation]) => {
    if (!isRecord(observation)) return;
    const kind = invalidProvenanceValueKind(observation.value);
    if (!kind) return;
    const key = `${harness}\0${dimension}\0${kind}`;
    const aggregate = invalidValues.get(key) ?? {
      harness,
      dimension,
      kind,
      count: 0,
    };
    aggregate.count += 1;
    invalidValues.set(key, aggregate);
  });
  if (!isRecord(entry.context)) return;
  const outcomes = entry.context.agent_provenance_outcomes;
  if (!isRecord(outcomes)) return;
  Object.entries(outcomes).forEach(([dimension, rawOutcome]) => {
    if (!isRecord(rawOutcome) || typeof rawOutcome.resolver !== "string") {
      return;
    }
    if (!ATTEMPTED_PROVENANCE_OUTCOME_STATUSES.has(String(rawOutcome.status))) {
      return;
    }
    const key = `${harness}\0${dimension}\0${rawOutcome.resolver}`;
    const aggregate = aggregates.get(key) ?? {
      harness,
      dimension,
      resolver: rawOutcome.resolver,
      attempts: 0,
      successes: 0,
    };
    aggregate.attempts += 1;
    if (rawOutcome.status === "resolved") aggregate.successes += 1;
    aggregates.set(key, aggregate);
  });
}

function collectHistoryContent(
  content: string,
  aggregates: Map<string, ProvenanceResolverHealthOutcome>,
  invalidValues: Map<string, ProvenanceValueHealthFinding>,
  eventLimit: number,
  initialEventsRead: number,
): { eventsRead: number; truncated: boolean } {
  let eventsRead = initialEventsRead;
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue;
    if (eventsRead >= eventLimit) return { eventsRead, truncated: true };
    eventsRead += 1;
    const entry = parseHistoryEntry(line);
    if (entry) collectResolverOutcomes(entry, aggregates, invalidValues);
  }
  return { eventsRead, truncated: false };
}

/** Scan immutable history without failing over malformed streams owned by integrity checks. */
export async function scanProvenanceResolverHealth(
  pmRoot: string,
  eventLimit = 10_000,
): Promise<ProvenanceResolverHealthScan> {
  const aggregates = new Map<string, ProvenanceResolverHealthOutcome>();
  const invalidValues = new Map<string, ProvenanceValueHealthFinding>();
  let eventsRead = 0;
  let bytesRead = 0;
  let truncated = false;
  for (const file of await listHistoryFiles(pmRoot)) {
    const history = await readHistoryFile(
      pmRoot,
      file,
      Math.max(0, DEFAULT_PROVENANCE_HISTORY_BYTE_LIMIT - bytesRead),
    );
    if (history === null) continue;
    bytesRead += history.bytesRead;
    const collected = collectHistoryContent(
      history.content,
      aggregates,
      invalidValues,
      eventLimit,
      eventsRead,
    );
    eventsRead = collected.eventsRead;
    if (collected.truncated) {
      truncated = true;
      break;
    }
    if (!history.complete) {
      truncated = true;
      break;
    }
  }
  const outcomes = [...aggregates.values()].sort(
    (left, right) =>
      left.harness.localeCompare(right.harness) ||
      left.dimension.localeCompare(right.dimension) ||
      left.resolver.localeCompare(right.resolver),
  );
  const invalidValueFindings = [...invalidValues.values()].sort(
    (left, right) =>
      left.harness.localeCompare(right.harness) ||
      left.dimension.localeCompare(right.dimension) ||
      left.kind.localeCompare(right.kind),
  );
  return {
    outcomes,
    invalid_values: invalidValueFindings,
    warnings: truncated
      ? []
      : [
          ...outcomes
            .filter(
              (outcome) => outcome.attempts > 0 && outcome.successes === 0,
            )
            .map(
              (outcome) =>
                `provenance_resolver_zero_success:${outcome.harness}:${outcome.dimension}:${outcome.resolver}:${String(outcome.attempts)}`,
            ),
          ...invalidValueFindings.map(
            (finding) =>
              `provenance_value_domain_invalid:${finding.harness}:${finding.dimension}:${finding.kind}:${String(finding.count)}`,
          ),
        ],
    events_read: eventsRead,
    truncated,
  };
}
