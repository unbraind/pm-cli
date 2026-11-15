/**
 * @module sdk/governance/in-progress-work-health
 *
 * Projects the in-progress ownership and idleness scan into `pm health`
 * advisories, bounded storage-check details and executable remedies (GH-1724).
 * Every remedy is a read-only `pm list` sweep built from the workspace's own
 * in-progress status id and threshold, shell-quoted, so an agent can run it as
 * printed. A sweep is a candidate list by metadata time: `--updated-before`
 * reads `updated_at`, while the scan also counts a newer history entry (a
 * restore writes an older `updated_at`), so a sweep can include an item the
 * advisory does not count. The per-item recovery re-judges: `pm claim <id>
 * --takeover-stale` applies the full clock under the item lock.
 */
import { quoteCommandArg, renderPmCommand } from "../command-line.js";
import type { InProgressWorkGroup, InProgressWorkScan } from "./stale-work.js";

/** Most item rows one in-progress work group publishes in health details. */
export const IN_PROGRESS_WORK_DETAIL_LIMIT = 25;

/** Exact one-call sweeps that select each in-progress work population. */
export interface InProgressSweepCommands {
  /** Unowned in-progress work, at any age. */
  unowned: string;
  /** In-progress work with no recorded mutation within the threshold, owned or not. */
  idle: string;
  /** Unowned and idle: the `stale_in_progress_items` population. */
  stale: string;
}

/** One bounded in-progress work group as health details publish it. */
export interface InProgressWorkHealthGroup extends InProgressWorkGroup {
  /** Present when `items` was capped at {@link IN_PROGRESS_WORK_DETAIL_LIMIT}. */
  truncated?: true;
  /** Read-only candidate sweep by metadata time; a superset of the group when history is newer than `updated_at`. */
  sweep: string;
}

/** Storage-check details for unowned and idle in-progress work. */
export interface InProgressWorkHealthDetails {
  /** Threshold the idle classification applied, in whole hours. */
  threshold_hours: number;
  /** Setting that owns the threshold. */
  threshold_setting: "mutation_guard.stale_in_progress_hours";
  /** In-progress items with no assignee. */
  unowned: InProgressWorkHealthGroup;
  /** In-progress items idle past the threshold. */
  idle: InProgressWorkHealthGroup;
  /**
   * Per-item recoveries: claim unowned work, take over another holder's idle
   * claim (re-judged under the item lock with the full clock), or return the
   * work to the open queue.
   */
  item_remedies: { claim: string; take_over_idle: string; return_to_open: string };
}

/** Health warnings, details and remediation overrides derived from one scan. */
export interface InProgressWorkHealthSummary {
  /** `in_progress_unowned:<n>` and `in_progress_idle:<n>`, each only when non-zero. */
  warnings: string[];
  /** Details for the storage check; undefined when no item is unowned or idle. */
  details: InProgressWorkHealthDetails | undefined;
  /** Warning code to the exact sweep command for this workspace. */
  remediation: Record<string, string>;
}

/** Build the exact list sweeps for a workspace's in-progress status id and threshold. */
export function buildInProgressSweepCommands(
  inProgressStatus: string,
  thresholdHours: number,
): InProgressSweepCommands {
  const base = ["list", "--status", inProgressStatus];
  const unowned = ["--assignee-filter", "unassigned"];
  const idle = ["--updated-before", `-${thresholdHours}h`];
  return {
    unowned: renderPmCommand([...base, ...unowned]),
    idle: renderPmCommand([...base, ...idle]),
    stale: renderPmCommand([...base, ...unowned, ...idle]),
  };
}

function boundGroup(
  group: InProgressWorkGroup,
  sweep: string,
): InProgressWorkHealthGroup {
  const truncated = group.items.length > IN_PROGRESS_WORK_DETAIL_LIMIT;
  return {
    count: group.count,
    items: group.items.slice(0, IN_PROGRESS_WORK_DETAIL_LIMIT),
    ...(truncated ? { truncated: true as const } : {}),
    sweep,
  };
}

/** Project an in-progress work scan into health advisories, details and remedies. */
export function buildInProgressWorkHealthSummary(
  scan: InProgressWorkScan,
  statuses: { in_progress: string; open: string },
): InProgressWorkHealthSummary {
  const commands = buildInProgressSweepCommands(statuses.in_progress, scan.threshold_hours);
  const warnings = [
    ...(scan.unowned.count > 0 ? [`in_progress_unowned:${scan.unowned.count}`] : []),
    ...(scan.idle.count > 0 ? [`in_progress_idle:${scan.idle.count}`] : []),
  ];
  return {
    warnings,
    details:
      warnings.length === 0
        ? undefined
        : {
            threshold_hours: scan.threshold_hours,
            threshold_setting: "mutation_guard.stale_in_progress_hours",
            unowned: boundGroup(scan.unowned, commands.unowned),
            idle: boundGroup(scan.idle, commands.idle),
            item_remedies: {
              claim: "pm claim <id>",
              take_over_idle: "pm claim <id> --takeover-stale",
              return_to_open: `pm update <id> --status ${quoteCommandArg(statuses.open)}`,
            },
          },
    remediation: {
      stale_in_progress_items: commands.stale,
      in_progress_unowned: commands.unowned,
      in_progress_idle: commands.idle,
    },
  };
}
