/**
 * @module sdk/governance/health/history-drift-remedies
 *
 * Chooses the history-drift remedies `pm health` advises so that running each
 * one repairs the streams it names (pm-3os5p6). A chain mismatch that an
 * append-only bridge cannot repair, because a recorded patch applies only on
 * top of the unrecorded change, is reported as `history_drift_chain_unbridgeable`
 * with the rewriting repair as its remedy. A stream no repair can keep is
 * reported as `history_drift_unrepairable_stream`. The decision runs the
 * repairs' own previews, so health and the repair never disagree about a stream.
 */
import { lstat } from "node:fs/promises";
import type { GlobalOptions } from "../../../core/shared/command-types.js";
import { PmCliError } from "../../../core/shared/errors.js";
import { getHistoryPath } from "../../../core/store/paths.js";
import { runHistoryRepair } from "../../history-repair.js";
import type { HealthCheck } from "../health.js";

/** A drifted stream whose repair preview refused, with the refusal reasons. */
export interface HistoryRepairRefusal {
  /** Item whose stream the advised repair would refuse. */
  id: string;
  /** The first refusal reason, for example `patch_does_not_replay`. */
  reason: string;
  /** Present when the rewriting repair refuses too, so no pm repair applies. */
  rewrite_refusal?: string;
}

/** Warning-code prefixes, by remedy. */
const CHAIN_MISMATCH = "history_drift_chain_mismatch";
const CHAIN_UNBRIDGEABLE = "history_drift_chain_unbridgeable";
const UNREPAIRABLE_STREAM = "history_drift_unrepairable_stream";
const HASH_MISMATCH = "history_drift_hash_mismatch";
const MISSING_STREAM = "history_drift_missing_stream";
/**
 * Streams a bulk repair must not run on: it would fail the row of an
 * unreadable, unrepairable or version-skewed stream, and it would reconcile a
 * receipt-attributed stream without the merge audit its receipt requires.
 */
const BULK_BLOCKING_CODES = [
  "history_drift_unreadable_stream",
  UNREPAIRABLE_STREAM,
  "history_drift_version_skew",
  "history_drift_merge_receipt",
];
/** Codes `pm history-repair --all --append-only` repairs on every stream it names. */
const APPEND_ONLY_BULK_CODES = new Set([CHAIN_MISMATCH, MISSING_STREAM]);

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

/** Missing streams whose entry is a link: a rebuild appends, so both repairs refuse them. */
async function findLinkedMissingStreams(
  historyDriftCheck: { check: HealthCheck },
  pmRoot: string,
): Promise<HistoryRepairRefusal[]> {
  const linked: HistoryRepairRefusal[] = [];
  for (const id of stringList(historyDriftCheck.check.details.missing_streams)) {
    const [entry] = await Promise.allSettled([lstat(getHistoryPath(pmRoot, id))]);
    if (entry.status === "fulfilled" && entry.value.isSymbolicLink()) {
      linked.push({ id, reason: "stream_not_regular_file", rewrite_refusal: "stream_not_regular_file" });
    }
  }
  return linked;
}

/**
 * Preview the append-only repair of every chain-mismatched stream; for each
 * refusal, preview the rewriting repair too, so a stream neither repair can
 * keep is reported without a remedy that would refuse. A missing stream whose
 * entry is a link is reported the same way.
 */
export async function findHistoryRepairRefusals(
  historyDriftCheck: { check: HealthCheck },
  global: GlobalOptions,
  pmRoot: string,
): Promise<HistoryRepairRefusal[]> {
  const refusals: HistoryRepairRefusal[] = [];
  // This runtime cannot judge the chain of a stream from a newer hash epoch; its remedy is the upgrade.
  const skewed = new Set(stringList(historyDriftCheck.check.details.version_skews));
  for (const id of stringList(historyDriftCheck.check.details.chain_mismatches)) {
    if (skewed.has(id)) continue;
    const reason = await previewRefusal(id, true, global);
    if (reason === undefined) continue;
    const rewriteRefusal = await previewRefusal(id, false, global);
    refusals.push({
      id,
      reason,
      ...(rewriteRefusal === undefined ? {} : { rewrite_refusal: rewriteRefusal }),
    });
  }
  return [...refusals, ...(await findLinkedMissingStreams(historyDriftCheck, pmRoot))];
}

/** Rewrite one chain-, missing- or hash-mismatch warning; other warnings pass through. */
function reviseDriftWarning(
  warning: string,
  codeById: ReadonlyMap<string, string | null>,
  withoutRepairAdvice: ReadonlySet<string>,
): string[] {
  for (const prefix of [CHAIN_MISMATCH, MISSING_STREAM]) {
    if (!warning.startsWith(`${prefix}:`)) continue;
    const id = warning.slice(prefix.length + 1);
    const code = codeById.get(id);
    if (code === null) return [];
    return [code === undefined ? warning : `${code}:${id}`];
  }
  if (warning.startsWith(`${HASH_MISMATCH}:`)) {
    return withoutRepairAdvice.has(warning.slice(HASH_MISMATCH.length + 1)) ? [] : [warning];
  }
  return [warning];
}

/**
 * Report each refused stream under the code whose remedy works. A stream no
 * repair can keep, and a stream a newer pm wrote, keep only that verdict:
 * their chain- and hash-mismatch warnings would advise a repair that refuses,
 * so they are dropped from the advice while `details` keeps the scan's
 * evidence.
 */
export function applyHistoryRepairRefusals(
  historyDriftCheck: { check: HealthCheck; warnings: string[] },
  refusals: HistoryRepairRefusal[],
): void {
  const skewed = stringList(historyDriftCheck.check.details.version_skews);
  const codeById = new Map<string, string | null>([
    ...skewed.map((id): [string, null] => [id, null]),
    ...refusals.map((row): [string, string] => [
      row.id,
      row.rewrite_refusal === undefined ? CHAIN_UNBRIDGEABLE : UNREPAIRABLE_STREAM,
    ]),
  ]);
  const withoutRepairAdvice = new Set([
    ...skewed,
    ...refusals.filter((row) => row.rewrite_refusal !== undefined).map((row) => row.id),
  ]);
  historyDriftCheck.warnings = historyDriftCheck.warnings
    .flatMap((warning) => reviseDriftWarning(warning, codeById, withoutRepairAdvice))
    .sort((left, right) => left.localeCompare(right));
  if (refusals.length === 0) return;
  historyDriftCheck.check.details = {
    ...historyDriftCheck.check.details,
    repair_refusals: refusals,
  };
}

/**
 * Bulk history-drift remedies when more than one stream drifted. Both bulk
 * forms run on every drifted stream, so while one of them is a stream the
 * bulk run must not touch (BULK_BLOCKING_CODES) every remedy stays per item.
 * `--all --append-only` is the bulk remedy only when every drifted stream is
 * a bridgeable chain mismatch or a missing stream. Otherwise a bridgeable
 * chain mismatch keeps its per-item append-only remedy and the rest share
 * `pm history-repair --all`.
 */
export function rewriteBulkHistoryDriftRemediation(
  remediationMap: Record<string, string>,
): void {
  if (BULK_BLOCKING_CODES.some((code) => Object.hasOwn(remediationMap, code))) return;
  const codes = Object.keys(remediationMap);
  const appendOnlyBulk = codes.every((code) => APPEND_ONLY_BULK_CODES.has(code));
  for (const code of codes) {
    if (appendOnlyBulk) {
      remediationMap[code] = "pm history-repair --all --append-only";
    } else if (code !== CHAIN_MISMATCH) {
      remediationMap[code] = "pm history-repair --all";
    }
  }
}
