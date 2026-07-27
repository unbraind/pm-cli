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

/**
 * Derive dimension coverage from descriptor data. Optional inputs make this a
 * usable negative-control gate instead of a hard-coded assertion.
 */
export function analyzeAgentProvenanceDescriptorCoverage(
  descriptors: readonly HarnessSignalDescriptor[] =
    BUILTIN_HARNESS_SIGNAL_DESCRIPTORS,
  dimensions: readonly string[] = AGENT_PROVENANCE_DIMENSIONS,
): AgentProvenanceDescriptorCoverage[] {
  return dimensions.map((dimension) => {
    const harnesses = descriptors
      .filter((descriptor) => {
        const keys =
          dimension === "model"
            ? descriptor.model_environment_keys
            : descriptor.provenance_environment_keys?.[dimension];
        return (keys?.length ?? 0) > 0;
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
