/**
 * @module sdk/governance/health/history-drift-remedies
 *
 * Chooses the history-drift remedies `pm health` advises so that running each
 * one repairs the streams it names (pm-3os5p6). A chain mismatch that an
 * append-only bridge cannot repair, because a recorded patch applies only on
 * top of the unrecorded change, is reported as `history_drift_chain_unbridgeable`
 * with the rewriting repair as its remedy. The decision runs the append-only
 * repair's own preview, so health and the repair never disagree about a stream.
 */
import type { GlobalOptions } from "../../../core/shared/command-types.js";
import { PmCliError } from "../../../core/shared/errors.js";
import { runHistoryRepair } from "../../history-repair.js";
import type { HealthCheck } from "../health.js";

/** A chain mismatch whose append-only preview refused, with the refusal reasons. */
export interface UnbridgeableChainMismatch {
  /** Item whose stream an append-only bridge cannot repair. */
  id: string;
  /** The append-only refusal reason, for example `patch_does_not_replay`. */
  reason: string;
  /** Present when the rewriting repair's preview refused too, so no pm repair applies. */
  rewrite_refusal?: string;
}

/** Warning-code prefixes for chain mismatches, by remedy. */
const CHAIN_MISMATCH = "history_drift_chain_mismatch";
const CHAIN_UNBRIDGEABLE = "history_drift_chain_unbridgeable";
const CHAIN_UNREPAIRABLE = "history_drift_chain_unrepairable";
const VERSION_SKEW = "history_drift_version_skew";
/** Streams a bulk repair cannot repair, so its row would fail. */
const BULK_BLOCKING_CODES = ["history_drift_unreadable_stream", CHAIN_UNREPAIRABLE, VERSION_SKEW];
/** Codes `pm history-repair --all --append-only` repairs on every stream it names. */
const APPEND_ONLY_BULK_CODES = new Set([CHAIN_MISMATCH, "history_drift_missing_stream"]);
/** Codes whose remedy is not a history repair. */
const NON_REPAIR_CODES = new Set(["history_drift_merge_receipt"]);

/** Read a string array detail written by the history-drift check. */
function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** The typed reason a preview refused with, or `fallback` for any other failure. */
function refusalReason(error: unknown, fallback: string): string {
  if (!(error instanceof PmCliError)) return fallback;
  if (typeof error.context.reason === "string") return error.context.reason;
  return error.code ?? fallback;
}

/** Preview a repair; return the refusal reason, or undefined when the preview succeeds. */
async function previewRefusal(
  id: string,
  appendOnly: boolean,
  global: GlobalOptions,
): Promise<string | undefined> {
  try {
    await runHistoryRepair(id, { appendOnly, dryRun: true }, global);
    return undefined;
  } catch (error: unknown) {
    return refusalReason(error, appendOnly ? "append_only_preview_failed" : "rewrite_preview_failed");
  }
}

/**
 * Preview the append-only repair of every chain-mismatched stream; for each
 * refusal, preview the rewriting repair too, so a stream neither repair can
 * keep is reported without a remedy that would refuse.
 */
export async function findUnbridgeableChainMismatches(
  historyDriftCheck: { check: HealthCheck },
  global: GlobalOptions,
): Promise<UnbridgeableChainMismatch[]> {
  const unbridgeable: UnbridgeableChainMismatch[] = [];
  // This runtime cannot judge the chain of a stream from a newer hash epoch; its remedy is the upgrade.
  const skewed = new Set(stringList(historyDriftCheck.check.details.version_skews));
  for (const id of stringList(historyDriftCheck.check.details.chain_mismatches)) {
    if (skewed.has(id)) continue;
    const reason = await previewRefusal(id, true, global);
    if (reason === undefined) continue;
    const rewriteRefusal = await previewRefusal(id, false, global);
    unbridgeable.push({
      id,
      reason,
      ...(rewriteRefusal === undefined ? {} : { rewrite_refusal: rewriteRefusal }),
    });
  }
  return unbridgeable;
}

/**
 * Report each unbridgeable chain mismatch under its own code so health
 * advises the repair that works. A version-skewed stream keeps only its
 * version-skew warning: its chain verdict is this runtime's misreading, and
 * neither repair applies until pm is upgraded.
 */
export function applyUnbridgeableChainMismatches(
  historyDriftCheck: { check: HealthCheck; warnings: string[] },
  unbridgeable: UnbridgeableChainMismatch[],
): void {
  const skewed = new Set(stringList(historyDriftCheck.check.details.version_skews));
  const codeById = new Map<string, string | null>([
    ...[...skewed].map((id): [string, null] => [id, null]),
    ...unbridgeable.map((row): [string, string] => [
      row.id,
      row.rewrite_refusal === undefined ? CHAIN_UNBRIDGEABLE : CHAIN_UNREPAIRABLE,
    ]),
  ]);
  historyDriftCheck.warnings = historyDriftCheck.warnings
    .flatMap((warning) => {
      if (!warning.startsWith(`${CHAIN_MISMATCH}:`)) return [warning];
      const id = warning.slice(CHAIN_MISMATCH.length + 1);
      const code = codeById.get(id);
      if (code === null) return [];
      return [code === undefined ? warning : `${code}:${id}`];
    })
    .sort((left, right) => left.localeCompare(right));
  if (unbridgeable.length === 0) return;
  historyDriftCheck.check.details = {
    ...historyDriftCheck.check.details,
    chain_unbridgeable: unbridgeable,
  };
}

/**
 * Bulk history-drift remedies when more than one stream drifted. Both bulk
 * forms run on every drifted stream, and a stream that the decoder refuses,
 * that no repair can keep, or that a newer hash epoch wrote fails its row, so
 * while one is present every remedy stays per item. `--all --append-only` is the bulk remedy only when every drifted
 * stream is a bridgeable chain mismatch or a missing stream. Otherwise a
 * bridgeable chain mismatch keeps its per-item append-only remedy, the
 * non-repair remedies stay as they are, and the rest share
 * `pm history-repair --all`.
 */
export function rewriteBulkHistoryDriftRemediation(
  remediationMap: Record<string, string>,
): void {
  if (BULK_BLOCKING_CODES.some((code) => Object.hasOwn(remediationMap, code))) return;
  const codes = Object.keys(remediationMap).filter(
    (code) => !NON_REPAIR_CODES.has(code),
  );
  const appendOnlyBulk = codes.every((code) => APPEND_ONLY_BULK_CODES.has(code));
  for (const code of codes) {
    if (appendOnlyBulk) {
      remediationMap[code] = "pm history-repair --all --append-only";
    } else if (code !== CHAIN_MISMATCH) {
      remediationMap[code] = "pm history-repair --all";
    }
  }
}
