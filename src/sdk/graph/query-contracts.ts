/**
 * @module sdk/graph/query-contracts
 * Discoverable graph read defaults shared by SDK, CLI, MCP, and package callers.
 * Row limits bound observations, not the topology used to compute analytics.
 */

/** Immutable observation ceilings shared by query execution and contract discovery. */
export const GRAPH_QUERY_DEFAULTS = Object.freeze({
  /** Maximum emitted rows in each traversal or analytics collection. */
  rows: 10,
  /** Maximum paths emitted by path enumeration. */
  paths: 5,
  /** Maximum evidence examples per governance finding. */
  samples: 10,
  /** Default depth of path enumeration; other traversals have no depth ceiling. */
  path_depth: 8,
  /** Maximum partial paths expanded before enumeration reports truncation. */
  visited_paths: 10_000,
});
