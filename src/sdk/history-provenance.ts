/**
 * @module sdk/history-provenance
 *
 * Provides patch-free immutable-history provenance projections, filtering,
 * identity interpretation, and bounded coverage summaries.
 */
import {
  AGENT_PROVENANCE_DIMENSIONS,
  type HarnessSignalDescriptor,
} from "../core/shared/author.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import type { HistoryEntry } from "../types.js";

/** Versioned, workspace-owned interpretation of legacy author spellings. */
export interface AuthorIdentityVocabulary {
  /** Reproducible revision included in projections and summaries. */
  version: number;
  /** Exact author literals mapped to canonical harness namespaces. */
  aliases: Readonly<Record<string, string>>;
}

/** Read predicates shared by history, activity, events, and SDK consumers. */
export interface HistoryProvenanceFilters {
  /** Canonical recorded or vocabulary-resolved harness namespace. */
  harness?: string | readonly string[];
  /** Privacy-safe invocation fingerprint. */
  agentInstance?: string | readonly string[];
  /** Dimension predicates expressed as exact `dimension=value` pairs. */
  provenance?: string | readonly string[];
}

/** Patch-free identity and provenance projection for one immutable event. */
export interface HistoryProvenanceRow {
  /** Optional history stream subject supplied by a collection reader. */
  item_id?: string;
  /** Optional one-based stream version supplied by a collection reader. */
  version?: number;
  /** Immutable event timestamp. */
  ts: string;
  /** Immutable mutation operation. */
  op: string;
  /** Original, byte-preserved author literal. */
  author: string;
  /** Recorded author selection source when available. */
  author_source?: HistoryEntry["author_source"];
  /** Recorded harness or read-time alias interpretation. */
  agent_harness?: string;
  /** Whether the harness was recorded, interpreted, or remains unresolved. */
  harness_source: "recorded" | "vocabulary" | "unresolved";
  /** Vocabulary revision used for this interpretation. */
  vocabulary_version: number;
  /** Privacy-safe invocation fingerprint. */
  agent_instance?: string;
  /** Every recorded extensible provenance observation, without patch payloads. */
  agent_provenance: NonNullable<HistoryEntry["agent_provenance"]>;
  /** Optional event message. */
  message?: string;
}

/** Constant-size provenance coverage report over an inspected history set. */
export interface HistoryProvenanceSummary {
  /** Number of immutable entries inspected. */
  entries: number;
  /** Vocabulary revision used for legacy interpretation. */
  vocabulary_version: number;
  /** Recorded or interpreted harness coverage. */
  harness: {
    /** Entries resolving to a canonical harness. */
    resolved: number;
    /** Entries without a recorded or interpreted harness. */
    unresolved: number;
    /** Most frequent unresolved author literals, bounded to twenty rows. */
    unresolved_authors: Array<{ author: string; entries: number }>;
  };
  /** Availability counts for every observed or declared dimension. */
  dimensions: Array<{
    dimension: string;
    observed: number;
    unavailable: number;
    legacy_missing: number;
  }>;
}

/** Default interpretation used when a legacy workspace has no vocabulary. */
export const DEFAULT_AUTHOR_IDENTITY_VOCABULARY: AuthorIdentityVocabulary = {
  version: 1,
  aliases: {},
};

/** Resolve the extensible dimension vocabulary declared by built-ins and workspace descriptors. */
export function resolveHistoryProvenanceDimensions(
  descriptors: readonly HarnessSignalDescriptor[] = [],
): string[] {
  const dimensions = new Set<string>(AGENT_PROVENANCE_DIMENSIONS);
  const addDimension = (dimension: string): void => {
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(dimension)) {
      dimensions.add(dimension);
    }
  };
  for (const descriptor of descriptors) {
    for (const dimension of Object.keys(
      descriptor.provenance_environment_keys ?? {},
    )) {
      addDimension(dimension);
    }
    for (const dimension of Object.keys(
      descriptor.provenance_resolvers ?? {},
    )) {
      addDimension(dimension);
    }
    for (const dimension of descriptor.provenance_unavailable_dimensions ??
      []) {
      addDimension(dimension);
    }
  }
  return [...dimensions].sort();
}

function normalizeSet(
  value: string | readonly string[] | undefined,
): Set<string> | undefined {
  if (value === undefined) return undefined;
  const values = typeof value === "string" ? [value] : value;
  const normalized = values
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return normalized.length === 0 ? undefined : new Set(normalized);
}

function resolveCanonicalHarness(
  entry: Pick<HistoryEntry, "agent_harness" | "author">,
  vocabulary: AuthorIdentityVocabulary,
): Pick<HistoryProvenanceRow, "agent_harness" | "harness_source"> {
  if (entry.agent_harness?.trim()) {
    return { agent_harness: entry.agent_harness, harness_source: "recorded" };
  }
  const interpreted = vocabulary.aliases[entry.author];
  return interpreted
    ? { agent_harness: interpreted, harness_source: "vocabulary" }
    : { harness_source: "unresolved" };
}

/** Parse and validate exact provenance dimension predicates. */
export function parseHistoryProvenanceFilters(
  filters: HistoryProvenanceFilters,
  dimensions: readonly string[] = AGENT_PROVENANCE_DIMENSIONS,
): Map<string, Set<string>> {
  const allowed = new Set(dimensions);
  const predicates = new Map<string, Set<string>>();
  const values =
    filters.provenance === undefined
      ? []
      : typeof filters.provenance === "string"
        ? [filters.provenance]
        : filters.provenance;
  for (const raw of values.flatMap((entry) => entry.split(","))) {
    const separator = raw.indexOf("=");
    if (separator < 0) {
      throw new PmCliError(
        `Provenance predicate must use dimension=value; received "${raw.trim()}".`,
        EXIT_CODE.USAGE,
        { code: "invalid_provenance_predicate" },
      );
    }
    const dimension = raw.slice(0, separator).trim().toLowerCase();
    const value = raw.slice(separator + 1).trim();
    if (!allowed.has(dimension)) {
      throw new PmCliError(
        `Unknown provenance dimension "${dimension || raw.trim()}". Declared dimensions: ${[...allowed].sort().join(", ")}.`,
        EXIT_CODE.USAGE,
        { code: "unknown_provenance_dimension" },
      );
    }
    if (value.length === 0) {
      throw new PmCliError(
        `Provenance predicate must use dimension=value; received "${raw.trim()}".`,
        EXIT_CODE.USAGE,
        { code: "invalid_provenance_predicate" },
      );
    }
    const accepted = predicates.get(dimension) ?? new Set<string>();
    accepted.add(value);
    predicates.set(dimension, accepted);
  }
  return predicates;
}

/** Project one immutable entry without its JSON Patch or document hashes. */
export function projectHistoryProvenance(
  entry: HistoryEntry,
  vocabulary: AuthorIdentityVocabulary = DEFAULT_AUTHOR_IDENTITY_VOCABULARY,
  coordinates: { itemId?: string; version?: number } = {},
): HistoryProvenanceRow {
  const harness = resolveCanonicalHarness(entry, vocabulary);
  return {
    ...(coordinates.itemId === undefined
      ? {}
      : { item_id: coordinates.itemId }),
    ...(coordinates.version === undefined
      ? {}
      : { version: coordinates.version }),
    ts: entry.ts,
    op: entry.op,
    author: entry.author,
    ...(entry.author_source === undefined
      ? {}
      : { author_source: entry.author_source }),
    ...harness,
    vocabulary_version: vocabulary.version,
    ...(entry.agent_instance === undefined
      ? {}
      : { agent_instance: entry.agent_instance }),
    agent_provenance: entry.agent_provenance ?? {},
    ...(entry.message === undefined ? {} : { message: entry.message }),
  };
}

/** Test one immutable entry against shared provenance predicates. */
export function historyEntryMatchesProvenance(
  entry: HistoryEntry,
  filters: HistoryProvenanceFilters,
  vocabulary: AuthorIdentityVocabulary = DEFAULT_AUTHOR_IDENTITY_VOCABULARY,
  dimensions: readonly string[] = AGENT_PROVENANCE_DIMENSIONS,
): boolean {
  return compileHistoryProvenanceMatcher(
    filters,
    vocabulary,
    dimensions,
  )(entry);
}

/** Compile shared provenance predicates once for efficient history scans. */
export function compileHistoryProvenanceMatcher(
  filters: HistoryProvenanceFilters,
  vocabulary: AuthorIdentityVocabulary = DEFAULT_AUTHOR_IDENTITY_VOCABULARY,
  dimensions: readonly string[] = AGENT_PROVENANCE_DIMENSIONS,
): (entry: HistoryEntry) => boolean {
  const harnesses = normalizeSet(filters.harness);
  const instances = normalizeSet(filters.agentInstance);
  const predicates = parseHistoryProvenanceFilters(filters, dimensions);
  return (entry) => {
    const resolved = resolveCanonicalHarness(entry, vocabulary);
    const resolvedHarness = resolved.agent_harness;
    if (harnesses && (!resolvedHarness || !harnesses.has(resolvedHarness)))
      return false;
    if (instances && !instances.has(entry.agent_instance ?? "")) return false;
    for (const [dimension, accepted] of predicates) {
      const observation = entry.agent_provenance?.[dimension];
      if (!observation || !accepted.has(observation.value)) return false;
    }
    return true;
  };
}

/** Summarize identity and dimension completeness without returning event rows. */
export function summarizeHistoryProvenance(
  entries: readonly HistoryEntry[],
  vocabulary: AuthorIdentityVocabulary = DEFAULT_AUTHOR_IDENTITY_VOCABULARY,
  dimensions: readonly string[] = AGENT_PROVENANCE_DIMENSIONS,
): HistoryProvenanceSummary {
  const allDimensions = new Set(dimensions);
  const unresolvedAuthors = new Map<string, number>();
  let resolvedHarnesses = 0;
  for (const entry of entries) {
    for (const dimension of Object.keys(entry.agent_provenance ?? {})) {
      allDimensions.add(dimension);
    }
    const harness = resolveCanonicalHarness(entry, vocabulary);
    if (harness.agent_harness) resolvedHarnesses += 1;
    else {
      unresolvedAuthors.set(
        entry.author,
        (unresolvedAuthors.get(entry.author) ?? 0) + 1,
      );
    }
  }
  return {
    entries: entries.length,
    vocabulary_version: vocabulary.version,
    harness: {
      resolved: resolvedHarnesses,
      unresolved: entries.length - resolvedHarnesses,
      unresolved_authors: [...unresolvedAuthors]
        .map(([author, count]) => ({ author, entries: count }))
        .sort(
          (left, right) =>
            right.entries - left.entries ||
            left.author.localeCompare(right.author),
        )
        .slice(0, 20),
    },
    dimensions: [...allDimensions].sort().map((dimension) => {
      let observed = 0;
      let unavailable = 0;
      for (const entry of entries) {
        const observation = entry.agent_provenance?.[dimension];
        if (observation === null) unavailable += 1;
        else if (observation !== undefined) observed += 1;
      }
      return {
        dimension,
        observed,
        unavailable,
        legacy_missing: entries.length - observed - unavailable,
      };
    }),
  };
}
