/**
 * @module sdk/history-read
 *
 * Public, mutation-free item time-travel reads backed by the same verified
 * replay kernel used by `pm restore`. Integrators can use this primitive as a
 * building block for provenance browsers, immutable records, and VCS-like
 * systems without acquiring locks or appending history.
 */
import { getActiveExtensionRegistrations } from "../core/extensions/index.js";
import { pathExists } from "../core/fs/fs-utils.js";
import {
  applyHistoryPatch,
  ensureMaterializedHistoryTarget,
  extractPatchFailureContext,
  replayHistoryToTarget,
  resolveHistoryTarget,
  type ResolvedHistoryTarget,
} from "../core/history/projection.js";
import { readHistoryEntries } from "../core/history/read.js";
import {
  hashDocument,
  hashEmptyDocument,
} from "../core/history/history.js";
import {
  replayToCanonicalItemDocument,
  verifyHistoryChain,
} from "../core/history/replay.js";
import { resolveItemTypeRegistry } from "../core/item/type-registry.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import type { HistoryEntry, ItemDocument } from "../types/index.js";
import { resolveHistorySubject } from "./history-redact.js";

/** Workspace resolution controls accepted by {@link getItemAt}. */
export interface GetItemAtOptions {
  /** Explicit tracker root, equivalent to the CLI global `--pm-path`. */
  pmRoot?: string;
  /** Working directory used when discovering the nearest tracker. */
  cwd?: string;
}

/** Verified historical item projection returned by {@link getItemAt}. */
export interface GetItemAtResult {
  /** Reconstructed canonical item document at the selected version. */
  document: ItemDocument;
  /** Always true, preventing consumers from confusing this with current state. */
  reconstructed: true;
  /** One-based version included in the projection. */
  as_of_version: number;
  /** Timestamp of the final included history entry. */
  as_of_timestamp: string;
  /** Normalized target resolution metadata shared with restore. */
  target: ResolvedHistoryTarget;
  /** Total number of entries currently available in the stream. */
  history_length: number;
}

/** Verification projection shared by CLI history reads and SDK consumers. */
export interface HistoryVerificationResult {
  /** Whether the hash chain and optional current document both verify. */
  ok: boolean;
  /** Number of entries verified. */
  entries: number;
  /** Stable verification errors in encounter order. */
  errors: string[];
  /** Hash produced by the newest entry, when one exists. */
  latest_after_hash?: string;
  /** Canonical hash of the supplied current document. */
  current_item_hash?: string;
  /** Whether the supplied document matches the newest history hash. */
  current_matches_latest?: boolean;
}

/**
 * Verify a history chain and optionally compare it with a current document.
 *
 * Omitting the current document is useful for workspace-scoped streams, which
 * aggregate multiple configuration files and therefore have no single item
 * document to compare.
 */
export function verifyHistoryEntries(
  history: HistoryEntry[],
  currentDocument?: ItemDocument,
): HistoryVerificationResult {
  const verification = verifyHistoryChain(history);
  const latestAfterHash =
    history.length > 0
      ? history[history.length - 1].after_hash
      : hashEmptyDocument();
  const currentItemHash =
    currentDocument === undefined ? undefined : hashDocument(currentDocument);
  const currentMatchesLatest =
    currentItemHash === undefined
      ? undefined
      : currentItemHash === latestAfterHash;
  const errors = [...verification.errors];
  if (currentMatchesLatest === false) {
    errors.push("verify_failed:current_item_hash_mismatch");
  }
  return {
    ok: errors.length === 0,
    entries: history.length,
    errors,
    latest_after_hash:
      history.length > 0 ? history[history.length - 1].after_hash : undefined,
    current_item_hash: currentItemHash,
    current_matches_latest: currentMatchesLatest,
  };
}

/**
 * Reconstruct one item at a one-based version or ISO timestamp without locks,
 * item writes, history writes, or derived-index mutations.
 */
export async function getItemAt(
  id: string,
  target: string,
  options: GetItemAtOptions = {},
): Promise<GetItemAtResult> {
  const pmRoot = resolvePmRoot(options.cwd ?? process.cwd(), options.pmRoot);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const subject = await resolveHistorySubject(
    pmRoot,
    id,
    settings,
    typeRegistry.type_to_folder,
  );
  const history = await readHistoryEntries(subject.historyPath, subject.id);
  if (history.length === 0) {
    throw new PmCliError(
      `No history exists for ${subject.id}; point-in-time reads are unavailable.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const resolvedTarget = resolveHistoryTarget(target, history);
  const replay = ensureMaterializedHistoryTarget(
    replayHistoryToTarget(history, resolvedTarget.historyIndex),
    resolvedTarget,
  );
  const document = replayToCanonicalItemDocument(replay, {
    schema: settings.schema,
  });
  if (document.metadata.id !== subject.id) {
    throw new PmCliError(
      `History target resolved to item ${document.metadata.id}, expected ${subject.id}.`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  const targetEntry = history[resolvedTarget.historyIndex];
  return {
    document,
    reconstructed: true,
    as_of_version: resolvedTarget.historyIndex + 1,
    as_of_timestamp: targetEntry.ts,
    target: resolvedTarget,
    history_length: history.length,
  };
}

export {
  applyHistoryPatch,
  ensureMaterializedHistoryTarget,
  extractPatchFailureContext,
  readHistoryEntries,
  replayHistoryToTarget,
  resolveHistoryTarget,
};
