/**
 * @module sdk/provenance
 *
 * Provides public, storage-only provenance conformance and coverage analysis.
 */
import type { HistoryEntry } from "../types.js";
import {
  AGENT_PROVENANCE_DIMENSIONS,
  BUILTIN_HARNESS_SIGNAL_DESCRIPTORS,
  type HarnessSignalDescriptor,
} from "../core/shared/author.js";

/** One declared provenance dimension and the built-in harnesses that can supply it. */
export interface AgentProvenanceDescriptorCoverage {
  /** Stable provenance dimension name. */
  dimension: string;
  /** Built-in harnesses declaring at least one source for the dimension. */
  harnesses: string[];
  /** Whether at least one built-in harness can populate the dimension. */
  covered: boolean;
}

/** Model-provenance coverage for one harness over a bounded history window. */
export interface AgentModelProvenanceCoverage {
  /** Stable detected harness namespace. */
  harness: string;
  /** History events attributed to the harness. */
  entries: number;
  /** Events carrying an observed model. */
  observed: number;
  /** Events explicitly recording that the model was unavailable. */
  unavailable: number;
  /** Legacy events written before explicit availability existed. */
  legacy_missing: number;
  /** Observed fraction among events with explicit availability. */
  coverage: number | null;
  /** True when a sampled declared signal produced only unavailable values. */
  inert: boolean;
}

/** Availability coverage for one provenance dimension on one harness. */
export interface AgentProvenanceDimensionCoverage extends AgentModelProvenanceCoverage {
  /** Stable provenance dimension being summarized. */
  dimension: string;
}

/** One declared or inferred episode group with deterministically nested children. */
export interface AgentEpisodeGroup {
  /** Stable declared or inferred group key. */
  id: string;
  /** Optional declared human-readable purpose. */
  label?: string;
  /** Optional declared parent episode key. */
  parent_id?: string;
  /** Whether the grouping key was recorded or reconstructed. */
  source: "declared" | "inferred";
  /** Chronologically ordered immutable history entries in this episode. */
  entries: [HistoryEntry, ...HistoryEntry[]];
  /** Deterministically ordered nested episodes. */
  children: AgentEpisodeGroup[];
}

/** Resolve the declared or deterministic legacy identity for one history event. */
export function resolveHistoryEpisodeGroupIdentity(
  entry: HistoryEntry,
): Pick<AgentEpisodeGroup, "id" | "source"> {
  if (entry.agent_episode !== undefined) {
    return { id: entry.agent_episode.id, source: "declared" };
  }
  return {
    id: entry.agent_instance
      ? `inferred:instance:${entry.agent_instance}`
      : `inferred:author:${entry.author}:${entry.ts.slice(0, 13)}`,
    source: "inferred",
  };
}

function episodeParentIsAcyclic(
  group: AgentEpisodeGroup,
  parent: AgentEpisodeGroup,
  declaredGroups: ReadonlyMap<string, AgentEpisodeGroup>,
): boolean {
  let cursor: AgentEpisodeGroup | undefined = parent;
  const seen = new Set([group.id]);
  while (cursor !== undefined && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    cursor = cursor.parent_id
      ? declaredGroups.get(cursor.parent_id)
      : undefined;
  }
  return cursor === undefined;
}

function sortAgentEpisodeForest(roots: AgentEpisodeGroup[]): void {
  const pending: AgentEpisodeGroup[][] = [roots];
  while (pending.length > 0) {
    const values = pending.pop() as AgentEpisodeGroup[];
    values.sort(
      (left, right) =>
        left.entries[0].ts.localeCompare(right.entries[0].ts) ||
        left.id.localeCompare(right.id),
    );
    pending.push(...values.map((value) => value.children));
  }
}

/**
 * Derive dimension coverage from descriptor data. Optional inputs make this a
 * usable negative-control gate instead of a hard-coded assertion.
 */
export function analyzeAgentProvenanceDescriptorCoverage(
  descriptors: readonly HarnessSignalDescriptor[] = BUILTIN_HARNESS_SIGNAL_DESCRIPTORS,
  dimensions: readonly string[] = AGENT_PROVENANCE_DIMENSIONS,
): AgentProvenanceDescriptorCoverage[] {
  return dimensions.map((dimension) => {
    const harnesses = descriptors
      .filter((descriptor) => {
        const keys =
          dimension === "model"
            ? descriptor.model_environment_keys
            : descriptor.provenance_environment_keys?.[dimension];
        return (
          (keys?.length ?? 0) > 0 ||
          descriptor.provenance_resolvers?.[dimension] !== undefined
        );
      })
      .map((descriptor) => descriptor.harness)
      .sort();
    return {
      dimension,
      harnesses,
      covered: harnesses.length > 0,
    };
  });
}

/**
 * Summarize explicit model availability without consulting telemetry or
 * mutable item state. Legacy omissions remain distinct from unavailable.
 */
export function summarizeAgentModelProvenance(
  entries: readonly Pick<
    HistoryEntry,
    "agent_harness" | "agent_model" | "agent_provenance"
  >[],
  minimumExplicitSample = 1,
): AgentModelProvenanceCoverage[] {
  const byHarness = new Map<
    string,
    Omit<AgentModelProvenanceCoverage, "coverage" | "inert">
  >();
  for (const entry of entries) {
    if (!entry.agent_harness) continue;
    const row = byHarness.get(entry.agent_harness) ?? {
      harness: entry.agent_harness,
      entries: 0,
      observed: 0,
      unavailable: 0,
      legacy_missing: 0,
    };
    row.entries += 1;
    if (
      entry.agent_model ||
      (entry.agent_provenance?.model &&
        entry.agent_provenance.model.value.length > 0)
    ) {
      row.observed += 1;
    } else if (entry.agent_provenance?.model === null) {
      row.unavailable += 1;
    } else {
      row.legacy_missing += 1;
    }
    byHarness.set(entry.agent_harness, row);
  }
  return [...byHarness.values()]
    .map((row) => {
      const explicit = row.observed + row.unavailable;
      return {
        ...row,
        coverage: explicit === 0 ? null : row.observed / explicit,
        inert: explicit >= minimumExplicitSample && row.observed === 0,
      };
    })
    .sort((left, right) => left.harness.localeCompare(right.harness));
}

/**
 * Summarize observed, explicitly unavailable, and legacy-missing values for
 * every requested provenance dimension without consulting mutable state.
 */
export function summarizeAgentProvenance(
  entries: readonly Pick<
    HistoryEntry,
    "agent_harness" | "agent_model" | "agent_provenance"
  >[],
  dimensions: readonly string[] = AGENT_PROVENANCE_DIMENSIONS,
  minimumExplicitSample = 1,
): AgentProvenanceDimensionCoverage[] {
  const rows = new Map<
    string,
    Omit<AgentProvenanceDimensionCoverage, "coverage" | "inert">
  >();
  for (const entry of entries) {
    if (!entry.agent_harness) continue;
    for (const dimension of dimensions) {
      const key = `${entry.agent_harness}\0${dimension}`;
      const row = rows.get(key) ?? {
        harness: entry.agent_harness,
        dimension,
        entries: 0,
        observed: 0,
        unavailable: 0,
        legacy_missing: 0,
      };
      row.entries += 1;
      const observation = entry.agent_provenance?.[dimension];
      if (
        observation !== undefined &&
        observation !== null &&
        observation.value.length > 0
      ) {
        row.observed += 1;
      } else if (observation === null) {
        row.unavailable += 1;
      } else {
        row.legacy_missing += 1;
      }
      rows.set(key, row);
    }
  }
  return [...rows.values()]
    .map((row) => {
      const explicit = row.observed + row.unavailable;
      return {
        ...row,
        coverage: explicit === 0 ? null : row.observed / explicit,
        inert: explicit >= minimumExplicitSample && row.observed === 0,
      };
    })
    .sort(
      (left, right) =>
        left.harness.localeCompare(right.harness) ||
        left.dimension.localeCompare(right.dimension),
    );
}

/**
 * Group immutable history by declared episode keys. Legacy entries fall back
 * to their privacy-safe agent instance, or to a deterministic author cohort.
 */
export function groupHistoryByEpisode(
  entries: readonly HistoryEntry[],
): AgentEpisodeGroup[] {
  const sorted = [...entries].sort(
    (left, right) =>
      left.ts.localeCompare(right.ts) ||
      left.author.localeCompare(right.author) ||
      left.op.localeCompare(right.op) ||
      left.before_hash.localeCompare(right.before_hash) ||
      left.after_hash.localeCompare(right.after_hash),
  );
  const groups = new Map<string, AgentEpisodeGroup>();
  const declaredGroups = new Map<string, AgentEpisodeGroup>();
  for (const entry of sorted) {
    const episode = entry.agent_episode;
    const identity = resolveHistoryEpisodeGroupIdentity(entry);
    const groupKey = `${identity.source}:${identity.id}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.entries.push(entry);
      continue;
    }
    const group: AgentEpisodeGroup = {
      id: identity.id,
      ...(episode?.label === undefined ? {} : { label: episode.label }),
      ...(episode?.parent_id === undefined
        ? {}
        : { parent_id: episode.parent_id }),
      source: identity.source,
      entries: [entry],
      children: [],
    };
    groups.set(groupKey, group);
    if (episode !== undefined) declaredGroups.set(identity.id, group);
  }
  const roots: AgentEpisodeGroup[] = [];
  for (const group of groups.values()) {
    const parent = group.parent_id
      ? declaredGroups.get(group.parent_id)
      : undefined;
    if (parent && episodeParentIsAcyclic(group, parent, declaredGroups)) {
      parent.children.push(group);
    } else roots.push(group);
  }
  sortAgentEpisodeForest(roots);
  return roots;
}
