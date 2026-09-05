/**
 * @module sdk/duplicates
 *
 * Exposes bounded all-status duplicate-cluster discovery with deterministic
 * canonical-item guidance for CLI, MCP, and embedded SDK consumers.
 */
import type { GlobalOptions } from "../core/shared/command-types.js";
import { resolvePmRoot } from "../core/store/paths.js";
import {
  findDuplicateClusters,
  type DuplicateCluster,
  type DuplicateClustersResult,
} from "./similarity.js";

/** Options shared by the `pm duplicates` command and SDK action. */
export interface DuplicatesCommandOptions {
  /** Compare all pairs instead of using lossless prefix filtering. */
  exhaustive?: boolean;
  /** Lifecycle statuses to include; omitted means every status. */
  status?: readonly string[];
  /** Inclusive creation timestamp lower bound. */
  since?: string;
  /** Minimum similarity score from zero through one. */
  threshold?: number;
  /** Maximum connected clusters to return. */
  limit?: number;
}

/** Duplicate cluster enriched with deterministic close/merge guidance. */
export interface ActionableDuplicateCluster extends DuplicateCluster {
  /** Lexically first item id, used as the stable default canonical candidate. */
  canonical_id: string;
  /** Exact remediation command template for non-canonical members. */
  close_command: string;
}

/** Agent-facing duplicate discovery result. */
export interface DuplicatesResult
  extends Omit<DuplicateClustersResult, "clusters"> {
  /** Bounded, deterministic duplicate clusters. */
  clusters: ActionableDuplicateCluster[];
  /** Concise remediation policy shared by every presentation surface. */
  guidance: {
    strategy: "review_then_close_duplicate";
    command: "pm close <duplicate-id> --duplicate-of <canonical-id>";
  };
}

/** Discover existing duplicate clusters without creating or mutating an item. */
export async function runDuplicates(
  global: GlobalOptions,
  options: DuplicatesCommandOptions = {},
): Promise<DuplicatesResult> {
  const result = await findDuplicateClusters({
    pmRoot: resolvePmRoot(process.cwd(), global.path),
    exhaustive: options.exhaustive,
    ...(options.status === undefined
      ? {}
      : {
          statuses: options.status.flatMap((status) =>
            status
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
          ),
        }),
    ...(options.since === undefined ? {} : { since: options.since }),
    ...(options.threshold === undefined
      ? {}
      : { threshold: options.threshold }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  return {
    ...result,
    clusters: result.clusters.map((cluster) => {
      const canonicalId = cluster.id;
      return {
        ...cluster,
        canonical_id: canonicalId,
        close_command: `pm close <duplicate-id> --duplicate-of ${canonicalId}`,
      };
    }),
    guidance: {
      strategy: "review_then_close_duplicate",
      command: "pm close <duplicate-id> --duplicate-of <canonical-id>",
    },
  };
}
