/**
 * @module sdk/governance/stale-work
 *
 * Detects abandoned in-progress work from tracker metadata and append-only
 * history without changing item ownership or lifecycle state.
 */
import path from "node:path";
import { readHistoryEntries } from "../../core/history/read.js";
import type { ItemMetadata } from "../../types/index.js";

/** One unclaimed in-progress item whose recorded activity exceeded policy. */
export interface StaleInProgressItem {
  /** Stable item identifier. */
  id: string;
  /** Most recent valid item or history timestamp. */
  last_activity_at: string;
  /** Whole hours elapsed at scan time. */
  age_hours: number;
}

/** Read-only stale-work diagnostic returned to SDK and health consumers. */
export interface StaleInProgressScan {
  /** Policy threshold applied by the scan. */
  threshold_hours: number;
  /** Number of stale items. */
  count: number;
  /** Deterministically ordered stale items. */
  items: StaleInProgressItem[];
  /** Agent-facing recovery guidance. */
  remediation: string;
}

/** Inputs for the pure stale-work classifier. */
export interface InspectStaleInProgressOptions {
  /** Status id configured as the active lifecycle state. */
  in_progress_status?: string;
  /** Age threshold in hours. */
  threshold_hours: number;
  /** Scan timestamp, injectable for deterministic tests. */
  now?: Date;
  /** Optional latest-history timestamp lookup. */
  last_history_activity?: (item: ItemMetadata) => string | undefined;
}

function normalizedStatus(value: string | undefined): string {
  return (value ?? "in_progress").trim().toLowerCase().replaceAll("-", "_");
}

function latestValidTimestamp(
  item: ItemMetadata,
  historyTimestamp: string | undefined,
): string {
  const candidates = [item.updated_at, historyTimestamp]
    .map((value) => ({ value, time: Date.parse(value ?? "") }))
    .filter(
      (candidate): candidate is { value: string; time: number } =>
        typeof candidate.value === "string" && Number.isFinite(candidate.time),
    )
    .sort((left, right) => right.time - left.time);
  return candidates[0]?.value ?? item.updated_at;
}

/** Classify stale unclaimed in-progress items without filesystem access. */
export function inspectStaleInProgressItems(
  items: readonly ItemMetadata[],
  options: InspectStaleInProgressOptions,
): StaleInProgressScan {
  const thresholdHours = Math.max(1, Math.trunc(options.threshold_hours));
  const nowMs = (options.now ?? new Date()).getTime();
  const inProgressStatus = normalizedStatus(options.in_progress_status);
  const staleItems: StaleInProgressItem[] = [];
  for (const item of items) {
    if (
      normalizedStatus(String(item.status)) !== inProgressStatus ||
      (item.assignee?.trim().length ?? 0) > 0
    ) {
      continue;
    }
    const lastActivityAt = latestValidTimestamp(
      item,
      options.last_history_activity?.(item),
    );
    const lastActivityMs = Date.parse(lastActivityAt);
    if (!Number.isFinite(lastActivityMs)) {
      continue;
    }
    const ageHours = Math.max(
      0,
      Math.floor((nowMs - lastActivityMs) / 3_600_000),
    );
    if (ageHours >= thresholdHours) {
      staleItems.push({
        id: item.id,
        last_activity_at: lastActivityAt,
        age_hours: ageHours,
      });
    }
  }
  staleItems.sort(
    (left, right) =>
      right.age_hours - left.age_hours || left.id.localeCompare(right.id),
  );
  return {
    threshold_hours: thresholdHours,
    count: staleItems.length,
    items: staleItems,
    remediation:
      "Claim active work with `pm claim <id>` or return abandoned work to open with `pm update <id> --status open`.",
  };
}

/** Scan tracker history and metadata for stale unclaimed in-progress work. */
export async function scanStaleInProgressItems(
  pmRoot: string,
  items: readonly ItemMetadata[],
  options: Omit<InspectStaleInProgressOptions, "last_history_activity">,
): Promise<StaleInProgressScan> {
  const historyTimestamps = new Map<string, string>();
  await Promise.all(
    items
      .filter(
        (item) =>
          normalizedStatus(String(item.status)) ===
            normalizedStatus(options.in_progress_status) &&
          (item.assignee?.trim().length ?? 0) === 0,
      )
      .map(async (item) => {
        let history: Awaited<ReturnType<typeof readHistoryEntries>>;
        try {
          history = await readHistoryEntries(
            path.join(pmRoot, "history", `${item.id}.jsonl`),
            item.id,
          );
        } catch {
          return;
        }
        const latest = history
          .map((entry) => entry.ts)
          .filter((timestamp) => Number.isFinite(Date.parse(timestamp)))
          .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
        if (latest) {
          historyTimestamps.set(item.id, latest);
        }
      }),
  );
  return inspectStaleInProgressItems(items, {
    ...options,
    last_history_activity: (item) => historyTimestamps.get(item.id),
  });
}
