/**
 * @module sdk/search-refresh-worker
 *
 * Owns the detached semantic-refresh worker entry used by custom mutation hosts.
 */
import { runSemanticRefreshWorker } from "../core/search/background-refresh.js";
import { refreshSemanticEmbeddingsForMutatedItems } from "../core/search/cache.js";
import { resolvePmRoot } from "../core/store/paths.js";

/** Drain the active workspace's pending semantic-refresh queue. */
export async function runSearchRefreshWorkerEntrypoint(): Promise<void> {
  const pmRoot = resolvePmRoot(process.cwd(), process.env.PM_PATH);
  await runSemanticRefreshWorker(pmRoot, (root, itemIds) =>
    refreshSemanticEmbeddingsForMutatedItems(root, itemIds, {
      apply_runtime_defaults: true,
    }),
  );
}
