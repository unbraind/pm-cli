/**
 * @module core/test/item-test-run-tracking
 *
 * Runs and records linked-test orchestration for Item Test Run Tracking.
 */
import { mutateItem } from "../store/item-store.js";
import { compareTimestampStrings } from "../shared/time.js";
import type { ItemTestRunSummary, PmSettings } from "../../types/index.js";

const DEFAULT_TRACKED_TEST_RUN_HISTORY_LIMIT = 20;

function trackedTestRunHistoryLimit(): number {
  const raw = process.env.PM_TRACKED_TEST_RUN_HISTORY_LIMIT;
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_TRACKED_TEST_RUN_HISTORY_LIMIT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TRACKED_TEST_RUN_HISTORY_LIMIT;
  }
  return parsed;
}

function normalizeTrackedTestRunSummaries(
  entries: ItemTestRunSummary[],
): ItemTestRunSummary[] {
  return [...entries]
    .filter(
      (entry) =>
        entry.run_id.trim().length > 0 &&
        entry.started_at.trim().length > 0 &&
        entry.finished_at.trim().length > 0 &&
        entry.recorded_at.trim().length > 0,
    )
    .sort((left, right) => {
      const byRecorded = compareTimestampStrings(
        left.recorded_at,
        right.recorded_at,
      );
      if (byRecorded !== 0) return byRecorded;
      const byRunId = left.run_id.localeCompare(right.run_id);
      if (byRunId !== 0) return byRunId;
      return left.kind.localeCompare(right.kind);
    });
}

/** Implements append tracked test run summary for the public runtime surface of this module. */
export async function appendTrackedTestRunSummary(options: {
  pmRoot: string;
  settings: PmSettings;
  itemId: string;
  author: string;
  entry: ItemTestRunSummary;
  message?: string;
}): Promise<void> {
  const historyLimit = trackedTestRunHistoryLimit();
  await mutateItem({
    pmRoot: options.pmRoot,
    settings: options.settings,
    id: options.itemId,
    op: "test_run_track",
    author: options.author,
    message: options.message,
    force: false,
    mutate(document) {
      const current = document.metadata.test_runs ?? [];
      const next = normalizeTrackedTestRunSummaries([
        ...current,
        options.entry,
      ]);
      const bounded =
        next.length > historyLimit
          ? next.slice(next.length - historyLimit)
          : next;
      document.metadata.test_runs = bounded;
      return { changedFields: ["test_runs"] };
    },
  });
}
