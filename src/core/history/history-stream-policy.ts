/**
 * @module core/history/history-stream-policy
 *
 * Implements append-only history and replay behavior for History Stream Policy.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { hasActiveOnWriteHooks, runActiveOnWriteHooks } from "../extensions/index.js";
import { ensureDir, pathExists } from "../fs/fs-utils.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { getHistoryPath } from "../store/paths.js";
import type { PmSettings } from "../../types/index.js";

/** Inputs for applying the history stream policy to one item before a mutation writes its history. */
export interface HistoryStreamPolicyParams {
  /** Tracker storage root that owns the item and its history stream. */
  pmRoot: string;
  /** Resolved settings that carry the history stream policy. */
  settings: PmSettings;
  /** Item whose history stream the policy inspects. */
  itemId: string;
  /** Command name reported in policy warnings and auto-created stream notices. */
  commandLabel: string;
}

/** Inputs for applying the history stream policy to several items in one mutation. */
export interface HistoryStreamPolicyManyParams {
  /** Tracker storage root that owns the items and their history streams. */
  pmRoot: string;
  /** Resolved settings that carry the history stream policy. */
  settings: PmSettings;
  /** Items whose history streams the policy inspects. */
  itemIds: string[];
  /** Command name reported in policy warnings and auto-created stream notices. */
  commandLabel: string;
}

/** Documents the history stream policy result payload exchanged by command, SDK, and package integrations. */
export interface HistoryStreamPolicyResult {
  /** Value that configures or reports auto created ids for this contract. */
  auto_created_ids: string[];
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
}

const EXISTENCE_PROBE_CONCURRENCY = 64;

function toSortedUniqueItemIds(itemIds: string[]): string[] {
  return [...new Set(itemIds.filter((value) => value.trim().length > 0))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function strictMissingStreamError(
  itemId: string,
  commandLabel: string,
): PmCliError {
  return new PmCliError(
    `Missing history stream for ${itemId}. ${commandLabel} requires history streams when settings.history.missing_stream is strict_error.`,
    EXIT_CODE.NOT_FOUND,
  );
}

async function createStream(
  historyPath: string,
  commandLabel: string,
): Promise<string[]> {
  await ensureDir(path.dirname(historyPath));
  const handle = await fs.open(historyPath, "a");
  await handle.close();
  return runActiveOnWriteHooks({
    path: historyPath,
    scope: "project",
    op: `${commandLabel}:history:auto_create`,
  });
}

/**
 * Ids whose history stream is absent, probed in bounded parallel chunks and
 * kept in input order. An id whose path cannot be resolved stays a candidate,
 * so its error is raised at its own turn in the ordered loop.
 */
async function probeMissingStreams(pmRoot: string, ids: readonly string[]): Promise<string[]> {
  const missing: string[] = [];
  for (let start = 0; start < ids.length; start += EXISTENCE_PROBE_CONCURRENCY) {
    const chunk = ids.slice(start, start + EXISTENCE_PROBE_CONCURRENCY);
    const present = await Promise.all(
      chunk.map((itemId) => {
        let historyPath: string;
        try {
          historyPath = getHistoryPath(pmRoot, itemId);
        } catch {
          return false;
        }
        return pathExists(historyPath);
      }),
    );
    chunk.forEach((itemId, index) => {
      if (!present[index]) missing.push(itemId);
    });
  }
  return missing;
}

/** Implements enforce history stream policy for item for the public runtime surface of this module. */
export async function enforceHistoryStreamPolicyForItem(
  params: HistoryStreamPolicyParams,
): Promise<HistoryStreamPolicyResult> {
  return enforceHistoryStreamPolicyForItems({
    pmRoot: params.pmRoot,
    settings: params.settings,
    itemIds: [params.itemId],
    commandLabel: params.commandLabel,
  });
}

/** Implements enforce history stream policy for items for the public runtime surface of this module. */
export async function enforceHistoryStreamPolicyForItems(
  params: HistoryStreamPolicyManyParams,
): Promise<HistoryStreamPolicyResult> {
  const ids = toSortedUniqueItemIds(params.itemIds);
  const autoCreated: string[] = [];
  const warnings: string[] = [];

  // A write hook may create or remove a later stream, so with write hooks
  // every id is probed in order right before its turn. Without them the
  // probes are independent reads (a whole-tracker read checks thousands of
  // streams), so they run in bounded parallel chunks; refusal and creation
  // stay in sorted id order either way.
  const candidates = hasActiveOnWriteHooks() ? ids : await probeMissingStreams(params.pmRoot, ids);

  for (const itemId of candidates) {
    const historyPath = getHistoryPath(params.pmRoot, itemId);
    // Another writer may have created the stream since the bulk probe; only
    // an actual creation is reported.
    if (await pathExists(historyPath)) {
      continue;
    }
    if (params.settings.history.missing_stream === "strict_error") {
      throw strictMissingStreamError(itemId, params.commandLabel);
    }
    warnings.push(...(await createStream(historyPath, params.commandLabel)));
    warnings.push(`history_stream_auto_created:${itemId}`);
    autoCreated.push(itemId);
  }

  return {
    auto_created_ids: autoCreated,
    warnings,
  };
}
