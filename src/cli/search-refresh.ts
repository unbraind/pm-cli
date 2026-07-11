#!/usr/bin/env node
/**
 * @module cli/search-refresh
 *
 * Provides CLI runtime support for Search Refresh.
 */
import { resolvePmRoot } from "../core/store/paths.js";
import { refreshSemanticEmbeddingsForMutatedItems } from "../core/search/cache.js";
import { runSemanticRefreshWorker } from "../core/search/background-refresh.js";

// Detached worker entry dispatched by the mutation hot path to refresh semantic
// embeddings out of band (see core/search/background-refresh.ts). Resolves the
// pm root from PM_PATH/cwd, then drains the pending queue under the reindex lock.
const pmRoot = resolvePmRoot(process.cwd(), process.env.PM_PATH);
await runSemanticRefreshWorker(pmRoot, (root, itemIds) =>
  refreshSemanticEmbeddingsForMutatedItems(root, itemIds, {
    apply_runtime_defaults: true,
  }),
);
