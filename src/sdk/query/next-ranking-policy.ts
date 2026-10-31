/**
 * @module sdk/query/next-ranking-policy
 *
 * Ranking policies for the `pm next` ready queue (GH-1618). The policy
 * decides whether priority tiers bound the blended relevance order, and the
 * reason helper names any disagreement between policy and relevance. Kept
 * apart from the public `pm next` module so these pure internals stay off the
 * published `./sdk/query` surface while remaining directly testable; the
 * refusal for an unknown policy stays in `next.ts`, the command that owns it.
 */
import type { ActionableEntry } from "../actionability.js";
import {
  normalizeStatusForRegistry,
  normalizeStatusInput,
  type RuntimeStatusRegistry,
} from "../runtime-primitives.js";
import type { ItemMetadata } from "../../types/index.js";

/**
 * Ordering policy applied to the ready queue after relevance scoring.
 * `priority_floor` (default) resumes in-progress work first, then orders by
 * priority tier and lets relevance order items only within a tier, so
 * automated comment churn cannot lift a P2 log above ready P0 work.
 * `weighted` keeps the blended relevance order (GH-1618).
 */
export type NextRankingPolicy = "priority_floor" | "weighted";

/** Policies `pm next` accepts, in documentation order. */
export const NEXT_RANKING_POLICIES: readonly NextRankingPolicy[] = [
  "priority_floor",
  "weighted",
];

/** The scorer model whose blended order the priority floor reorders; extension scorers keep their own order. */
const DEFAULT_WEIGHTED_RELEVANCE_MODEL = "default-weighted-v1";

/**
 * Reorder a scored ready queue under the policy. Returns each id's relevance
 * rank before the policy so explanations and reasons can name it. Only the
 * built-in weighted model is reordered; a project's own scorer keeps its order.
 */
export function applyNextRankingPolicy<T extends { id: string; rank: number; item: ItemMetadata }>(
  ranked: T[],
  statusRegistry: RuntimeStatusRegistry,
  policy: NextRankingPolicy,
  model: string,
): Map<string, number> {
  const relevanceRank = new Map(ranked.map((entry) => [entry.id, entry.rank]));
  if (policy !== "priority_floor" || model !== DEFAULT_WEIGHTED_RELEVANCE_MODEL) {
    return relevanceRank;
  }
  const inProgressStatus = normalizeStatusInput("in_progress", statusRegistry);
  const tier = (entry: T): number =>
    normalizeStatusForRegistry(entry.item.status, statusRegistry) === inProgressStatus
      ? -1
      : entry.item.priority;
  ranked.sort(
    (left, right) =>
      tier(left) - tier(right) ||
      (relevanceRank.get(left.id) ?? 0) - (relevanceRank.get(right.id) ?? 0),
  );
  ranked.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  return relevanceRank;
}

/** Explain, in the default reasons, when policy and relevance disagree about the recommendation. */
export function describeRankingPolicyReason(
  projectedReady: readonly ActionableEntry[],
  relevanceRank: ReadonlyMap<string, number>,
  statusRegistry: RuntimeStatusRegistry,
  policy: NextRankingPolicy,
): string | undefined {
  const leader = projectedReady[0];
  if (!leader) return undefined;
  if (policy === "priority_floor") {
    const rank = relevanceRank.get(leader.item.id);
    return rank !== undefined && rank !== 1 ? `priority floor (relevance rank ${rank})` : undefined;
  }
  const inProgressStatus = normalizeStatusInput("in_progress", statusRegistry);
  const higherPriority = projectedReady
    .slice(1)
    .filter(
      (entry) =>
        entry.item.priority < leader.item.priority &&
        normalizeStatusForRegistry(entry.item.status, statusRegistry) !== inProgressStatus,
    )
    .map((entry) => entry.item.priority);
  return higherPriority.length > 0
    ? `relevance over p${Math.min(...higherPriority)} ready work`
    : undefined;
}
