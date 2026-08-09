/**
 * @module sdk/governance/provenance-health
 *
 * Reads bounded, privacy-safe provenance resolver outcomes for health checks.
 */
import fs from "node:fs/promises";
import path from "node:path";

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

/** Bounded provenance health result suitable for `pm health` adapters. */
export interface ProvenanceResolverHealthScan {
  /** Stable resolver outcome aggregates. */
  outcomes: ProvenanceResolverHealthOutcome[];
  /** Advisory warnings for attempted resolvers with no success. */
  warnings: string[];
  /** Number of nonblank history events inspected. */
  events_read: number;
  /** Whether an event or byte ceiling omitted history input. */
  truncated: boolean;
}

const DEFAULT_PROVENANCE_HISTORY_BYTE_LIMIT = 8_388_608;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
): void {
  if (!isRecord(entry.context)) return;
  const outcomes = entry.context.agent_provenance_outcomes;
  if (!isRecord(outcomes) || typeof entry.agent_harness !== "string") return;
  for (const [dimension, rawOutcome] of Object.entries(outcomes)) {
    if (!isRecord(rawOutcome) || typeof rawOutcome.resolver !== "string") {
      continue;
    }
    if (rawOutcome.status !== "resolved" && rawOutcome.status !== "failed") {
      continue;
    }
    const key = `${entry.agent_harness}\0${dimension}\0${rawOutcome.resolver}`;
    const aggregate = aggregates.get(key) ?? {
      harness: entry.agent_harness,
      dimension,
      resolver: rawOutcome.resolver,
      attempts: 0,
      successes: 0,
    };
    aggregate.attempts += 1;
    if (rawOutcome.status === "resolved") aggregate.successes += 1;
    aggregates.set(key, aggregate);
  }
}

function collectHistoryContent(
  content: string,
  aggregates: Map<string, ProvenanceResolverHealthOutcome>,
  eventLimit: number,
  initialEventsRead: number,
): { eventsRead: number; truncated: boolean } {
  let eventsRead = initialEventsRead;
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue;
    if (eventsRead >= eventLimit) return { eventsRead, truncated: true };
    eventsRead += 1;
    const entry = parseHistoryEntry(line);
    if (entry) collectResolverOutcomes(entry, aggregates);
  }
  return { eventsRead, truncated: false };
}

/** Scan immutable history without failing over malformed streams owned by integrity checks. */
export async function scanProvenanceResolverHealth(
  pmRoot: string,
  eventLimit = 10_000,
): Promise<ProvenanceResolverHealthScan> {
  const aggregates = new Map<string, ProvenanceResolverHealthOutcome>();
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
  return {
    outcomes,
    warnings: truncated
      ? []
      : outcomes
          .filter((outcome) => outcome.attempts > 0 && outcome.successes === 0)
          .map(
            (outcome) =>
              `provenance_resolver_zero_success:${outcome.harness}:${outcome.dimension}:${outcome.resolver}:${String(outcome.attempts)}`,
          ),
    events_read: eventsRead,
    truncated,
  };
}
