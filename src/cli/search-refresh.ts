#!/usr/bin/env node
/**
 * @module cli/search-refresh
 *
 * Provides CLI runtime support for Search Refresh.
 */
import { runSearchRefreshWorkerEntrypoint } from "../sdk/search-refresh-worker.js";

// Detached worker entry dispatched by the mutation hot path to refresh semantic
// embeddings out of band (see core/search/background-refresh.ts). Resolves the
// pm root from PM_PATH/cwd, then drains the pending queue under the reindex lock.
await runSearchRefreshWorkerEntrypoint();
