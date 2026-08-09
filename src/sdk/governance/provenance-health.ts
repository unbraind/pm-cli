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
  /** Whether the event ceiling stopped the scan. */
  truncated: boolean;
}

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
): Promise<string | null> {
  try {
    return await fs.readFile(path.join(pmRoot, "history", file), "utf8");
  } catch {
    return null;
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

/** Scan immutable history without failing over malformed streams owned by integrity checks. */
export async function scanProvenanceResolverHealth(
  pmRoot: string,
  eventLimit = 10_000,
): Promise<ProvenanceResolverHealthScan> {
  const aggregates = new Map<string, ProvenanceResolverHealthOutcome>();
  let eventsRead = 0;
  for (const file of await listHistoryFiles(pmRoot)) {
    if (eventsRead >= eventLimit) break;
    const content = await readHistoryFile(pmRoot, file);
    if (content === null) continue;
    for (const line of content.split("\n")) {
      if (eventsRead >= eventLimit) break;
      if (line.trim().length === 0) continue;
      eventsRead += 1;
      const entry = parseHistoryEntry(line);
      if (entry) collectResolverOutcomes(entry, aggregates);
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
    warnings: outcomes
      .filter((outcome) => outcome.attempts > 0 && outcome.successes === 0)
      .map(
        (outcome) =>
          `provenance_resolver_zero_success:${outcome.harness}:${outcome.dimension}:${outcome.resolver}:${String(outcome.attempts)}`,
      ),
    events_read: eventsRead,
    truncated: eventsRead >= eventLimit,
  };
}
