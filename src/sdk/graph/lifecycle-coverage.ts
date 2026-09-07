/** @module sdk/graph/lifecycle-coverage Recorded-node connectivity censuses across lifecycle and schema-defined statuses. */
import type { WorkspaceRelationshipAssembly } from "./assembly.js";

/** Connectivity counts over an explicitly named recorded-node population. */
export interface RelationshipPopulationCoverage {
  /** Recorded items in the population, including outcome anchors. */
  nodes: number;
  /** Items with no incident relationship. */
  isolated: number;
  /** Items with zero or one incident relationship. */
  degree_leq_one: number;
  /** Items with at least one incident provenance or verification edge. */
  semantic_nodes: number;
  /** Items without incident provenance or verification edges. */
  without_semantic_edges: number;
  /** Incident directed-edge degree distribution, keyed by exact degree. */
  degree_histogram: Record<string, number>;
}

/** Named lifecycle slices and raw-status slices share the same counting convention. */
export interface RelationshipLifecycleCoverage {
  /** Missing and external placeholders are excluded from every population. */
  coverage_by_lifecycle: Record<
    "all" | "active" | "terminal",
    RelationshipPopulationCoverage
  >;
  /** Raw schema statuses are retained, including custom terminal statuses. */
  coverage_by_status: Record<string, RelationshipPopulationCoverage>;
}

/** Allocate independent counters for one population. */
function emptyCoverage(): RelationshipPopulationCoverage {
  return {
    nodes: 0,
    isolated: 0,
    degree_leq_one: 0,
    semantic_nodes: 0,
    without_semantic_edges: 0,
    degree_histogram: {},
  };
}

/** Count each recorded item once per slice; edge incidence uses the assembled graph's deduplicated directed basis. */
export function profileRelationshipLifecycles(
  assembly: WorkspaceRelationshipAssembly,
  isTerminal: (status: string) => boolean,
  isSemantic: (kind: string) => boolean,
  signal?: AbortSignal,
): RelationshipLifecycleCoverage {
  const lifecycle = {
    all: emptyCoverage(),
    active: emptyCoverage(),
    terminal: emptyCoverage(),
  };
  const statuses = new Map<string, RelationshipPopulationCoverage>();
  for (const detail of assembly.details) {
    signal?.throwIfAborted();
    if (
      assembly.missingIdSet.has(detail.id.toLowerCase()) ||
      detail.status === "external"
    )
      continue;
    const status = statuses.get(detail.status) ?? emptyCoverage();
    statuses.set(detail.status, status);
    const incident = assembly.graph.incidentEdges(detail.id);
    const semantic = incident.some((edge) => isSemantic(edge.kind));
    for (const bucket of [
      lifecycle.all,
      lifecycle[isTerminal(detail.status) ? "terminal" : "active"],
      status,
    ]) {
      bucket.nodes += 1;
      bucket.isolated += Number(incident.length === 0);
      if (incident.length <= 1) bucket.degree_leq_one += 1;
      if (semantic) bucket.semantic_nodes += 1;
      else bucket.without_semantic_edges += 1;
      const degree = String(incident.length);
      bucket.degree_histogram[degree] =
        (bucket.degree_histogram[degree] ?? 0) + 1;
    }
  }
  return {
    coverage_by_lifecycle: lifecycle,
    coverage_by_status: Object.fromEntries(
      [...statuses].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

/** Validate a persisted population without accepting malformed or impossible counts. */
function validPopulation(
  value: unknown,
): value is RelationshipPopulationCoverage {
  if (!isCoverageRecord(value)) return false;
  const row = value;
  const fields = [
    "nodes",
    "isolated",
    "degree_leq_one",
    "semantic_nodes",
    "without_semantic_edges",
  ];
  if (
    !fields.every(
      (field) => Number.isSafeInteger(row[field]) && Number(row[field]) >= 0,
    )
  )
    return false;
  if (!isCoverageRecord(row.degree_histogram)) return false;
  const histogram = Object.entries(row.degree_histogram);
  return (
    histogram.every(
      ([key, count]) =>
        /^(0|[1-9]\d*)$/.test(key) &&
        Number.isSafeInteger(count) &&
        Number(count) >= 0,
    ) &&
    histogram.reduce((sum, [, count]) => sum + Number(count), 0) ===
      row.nodes &&
    Number(row.isolated) <= Number(row.degree_leq_one) &&
    Number(row.degree_leq_one) <= Number(row.nodes) &&
    Number(row.semantic_nodes) + Number(row.without_semantic_edges) ===
      row.nodes
  );
}

/** Accept JSON object records while excluding arrays and null sentinels. */
function isCoverageRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accept legacy absence, but reject partial or malformed new lifecycle census fields. */
export function validLifecycleSnapshot(
  profile: Record<string, unknown>,
): boolean {
  for (const field of ["ordering_acyclic", "active_ordering_acyclic"]) {
    if (profile[field] !== undefined && typeof profile[field] !== "boolean")
      return false;
  }
  const lifecycle = profile.coverage_by_lifecycle;
  const statuses = profile.coverage_by_status;
  if (lifecycle === undefined && statuses === undefined) return true;
  if (!isCoverageRecord(lifecycle) || !isCoverageRecord(statuses)) return false;
  return (
    ["all", "active", "terminal"].every((key) =>
      validPopulation(lifecycle[key]),
    ) && Object.values(statuses).every(validPopulation)
  );
}

/** Subtract populations in deterministic order, preserving exact signed degree histograms. */
function diffPopulations(
  before: Record<string, RelationshipPopulationCoverage>,
  after: Record<string, RelationshipPopulationCoverage>,
): Record<string, RelationshipPopulationCoverage> {
  return Object.fromEntries(
    [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .map((key) => {
        const left = Object.hasOwn(before, key) ? before[key] : emptyCoverage();
        const right = Object.hasOwn(after, key) ? after[key] : emptyCoverage();
        const histogram = Object.fromEntries(
          [
            ...new Set([
              ...Object.keys(left.degree_histogram),
              ...Object.keys(right.degree_histogram),
            ]),
          ]
            .sort()
            .map((degree) => [
              degree,
              (right.degree_histogram[degree] ?? 0) -
                (left.degree_histogram[degree] ?? 0),
            ]),
        );
        return [
          key,
          {
            nodes: right.nodes - left.nodes,
            isolated: right.isolated - left.isolated,
            degree_leq_one: right.degree_leq_one - left.degree_leq_one,
            semantic_nodes: right.semantic_nodes - left.semantic_nodes,
            without_semantic_edges:
              right.without_semantic_edges - left.without_semantic_edges,
            degree_histogram: histogram,
          },
        ];
      }),
  );
}

/** Compare measured lifecycle censuses; legacy baselines remain explicitly incomparable. */
export function diffLifecycleCoverage(
  before: Partial<RelationshipLifecycleCoverage>,
  after: Partial<RelationshipLifecycleCoverage>,
): Partial<RelationshipLifecycleCoverage> & { lifecycle_comparable: boolean } {
  if (
    !before.coverage_by_lifecycle ||
    !after.coverage_by_lifecycle ||
    !before.coverage_by_status ||
    !after.coverage_by_status
  )
    return { lifecycle_comparable: false };
  return {
    lifecycle_comparable: true,
    coverage_by_lifecycle: diffPopulations(
      before.coverage_by_lifecycle,
      after.coverage_by_lifecycle,
    ),
    coverage_by_status: diffPopulations(
      before.coverage_by_status,
      after.coverage_by_status,
    ),
  };
}
