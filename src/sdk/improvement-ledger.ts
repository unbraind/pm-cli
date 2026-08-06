/**
 * @module sdk/improvement-ledger
 *
 * Persists append-only quantitative observations in an audited workspace
 * singleton and exposes bounded trend reads for self-improvement loops.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { pathExists, readFileIfExists } from "../core/fs/fs-utils.js";
import { mutateWorkspaceJsonWithHistory } from "../core/history/workspace-history.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { resolveAuthor } from "../core/shared/author.js";
import { PmCliError } from "../core/shared/errors.js";
import { stableStringify } from "../core/shared/serialization.js";
import { nowIso } from "../core/shared/time.js";
import {
  getSettingsPath,
  resolvePmRoot,
  resolveWorkspaceRoot,
} from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import { parseImprovementLedgerDocument as parseLedger } from "./improvement-ledger-validation.js";

const execFileAsync = promisify(execFile);
const DEFAULT_OBSERVATION_LIMIT = 50;
const MAX_OBSERVATION_LIMIT = 1_000;
const METRIC_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._/-]{0,126}[a-z0-9])?$/u;

/** Direction in which a metric represents improvement. */
export type ImprovementDirection = "higher" | "lower" | "target";

/** One immutable quantitative observation retained by the workspace ledger. */
export interface ImprovementObservation {
  /** Content-derived observation identity. */
  id: string;
  /** Stable, agent-readable metric name. */
  metric: string;
  /** Finite observed numeric value. */
  value: number;
  /** Direction in which later values improve. */
  direction: ImprovementDirection;
  /** Optional domain unit such as count, ms, bytes, or percent. */
  unit?: string;
  /** Required target when direction is target; optional gate threshold otherwise. */
  threshold?: number;
  /** ISO timestamp at which the value was observed. */
  observed_at: string;
  /** Git commit, caller revision, or explicit unversioned marker. */
  revision: string;
  /** How the revision value was obtained. */
  revision_source: "caller" | "git" | "unversioned";
  /** Attributed actor that recorded the observation. */
  author: string;
  /** Optional tracked item owning the measurement. */
  item_id?: string;
  /** Optional producing instrument or gate name. */
  source?: string;
  /** Stable retry key when supplied or derivable from a revision. */
  idempotency_key?: string;
}

/** Versioned workspace singleton containing every retained observation. */
export interface ImprovementLedgerDocument {
  /** Storage contract revision. */
  format_version: 1;
  /** Append-only observations in deterministic chronological order. */
  observations: ImprovementObservation[];
}

/** Mutation controls accepted by {@link recordImprovementObservation}. */
export interface RecordImprovementObservationOptions {
  /** Stable metric name. */
  metric: string;
  /** Finite observed numeric value. */
  value: number;
  /** Direction in which later values improve. */
  direction?: ImprovementDirection;
  /** Optional domain unit. */
  unit?: string;
  /** Target or gate threshold associated with this observation. */
  threshold?: number;
  /** Optional producing instrument or gate name. */
  source?: string;
  /** Optional tracked item owning the observation. */
  itemId?: string;
  /** Explicit source revision; otherwise git HEAD is resolved when available. */
  revision?: string;
  /** Explicit observation time, primarily for reproducible importers. */
  observedAt?: string;
  /** Explicit retry identity. */
  idempotencyKey?: string;
  /** Intentional author override. */
  author?: string;
  /** Human-readable audit rationale. */
  message?: string;
}

/** Receipt returned after recording or replaying one observation. */
export interface RecordImprovementObservationResult {
  /** Whether a new observation was appended. */
  changed: boolean;
  /** Recorded or idempotently replayed observation. */
  observation: ImprovementObservation;
  /** Workspace-relative singleton path. */
  ledger_path: "improvement-ledger.json";
}

/** Bounded read controls for {@link readImprovementLedger}. */
export interface ReadImprovementLedgerOptions {
  /** Explicit tracker root, equivalent to global --pm-path. */
  pmRoot?: string;
  /** Working directory used for implicit tracker discovery. */
  cwd?: string;
  /** Optional exact metric filter. */
  metric?: string;
  /** Optional tracked owner filter. */
  itemId?: string;
  /** Inclusive ISO timestamp lower bound. */
  since?: string;
  /** Maximum newest observations returned. */
  limit?: number;
}

/** One baseline-to-latest trend computed without rewriting observations. */
export interface ImprovementTrend {
  /** Stable metric name. */
  metric: string;
  /** Direction used to interpret the delta. */
  direction: ImprovementDirection;
  /** Oldest matching observation. */
  baseline: ImprovementObservation;
  /** Newest matching observation. */
  latest: ImprovementObservation;
  /** Latest value minus baseline value. */
  delta: number;
  /** Whether the latest value improved over the baseline. */
  improved: boolean;
  /** Number of observations contributing to the trend. */
  sample_count: number;
}

/** Bounded ledger page plus complete aggregate trend metadata. */
export interface ImprovementLedgerResult {
  /** Newest-first observation page. */
  observations: ImprovementObservation[];
  /** Matching observation count before the page limit. */
  total: number;
  /** Whether older matching rows were omitted. */
  truncated: boolean;
  /** Trends for every matching metric, sorted by metric name. */
  trends: ImprovementTrend[];
  /** Read provenance for deterministic consumers. */
  source: "audited_workspace_singleton";
}

function normalizeMetricName(value: string): string {
  const metric = value.trim().toLowerCase();
  if (!METRIC_NAME_PATTERN.test(metric)) {
    throw new PmCliError(
      `Invalid metric name "${value}"; use 1-128 lowercase letters, digits, dots, slashes, underscores, or hyphens.`,
      EXIT_CODE.USAGE,
      { code: "invalid_improvement_metric" },
    );
  }
  return metric;
}

function normalizeDirection(
  value: ImprovementDirection | undefined,
): ImprovementDirection {
  const direction = value ?? "lower";
  if (!(["higher", "lower", "target"] as const).includes(direction)) {
    throw new PmCliError(
      "Improvement direction must be higher, lower, or target.",
      EXIT_CODE.USAGE,
      { code: "invalid_improvement_observation" },
    );
  }
  return direction;
}

function normalizeOptionalText(
  value: string | undefined,
  field: string,
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > 256) {
    throw new PmCliError(
      `${field} must not exceed 256 characters.`,
      EXIT_CODE.USAGE,
      { code: "invalid_improvement_observation" },
    );
  }
  return normalized;
}

function parseObservationLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_OBSERVATION_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > MAX_OBSERVATION_LIMIT
  ) {
    throw new PmCliError(
      `Improvement observation limit must be an integer from 0 to ${MAX_OBSERVATION_LIMIT}.`,
      EXIT_CODE.USAGE,
      { code: "invalid_improvement_observation_limit" },
    );
  }
  return limit;
}

function parseIsoTimestamp(value: string, field: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new PmCliError(
      `${field} must be an ISO timestamp.`,
      EXIT_CODE.USAGE,
      {
        code: "invalid_improvement_observation_timestamp",
      },
    );
  }
  return new Date(milliseconds).toISOString();
}

async function buildImprovementObservation(
  pmRoot: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  options: RecordImprovementObservationOptions,
): Promise<ImprovementObservation> {
  if (!Number.isFinite(options.value)) {
    throw new PmCliError(
      "Improvement observation value must be finite.",
      EXIT_CODE.USAGE,
      { code: "invalid_improvement_observation" },
    );
  }
  const metric = normalizeMetricName(options.metric);
  const direction = normalizeDirection(options.direction);
  if (
    (options.threshold !== undefined && !Number.isFinite(options.threshold)) ||
    (direction === "target" && options.threshold === undefined)
  ) {
    throw new PmCliError(
      "Target-directed observations require a finite threshold.",
      EXIT_CODE.USAGE,
      { code: "invalid_improvement_observation" },
    );
  }
  const revision = await resolveObservationRevision(pmRoot, options.revision);
  const source = normalizeOptionalText(options.source, "source");
  const itemId = normalizeOptionalText(options.itemId, "itemId");
  const unit = normalizeOptionalText(options.unit, "unit");
  const idempotencyKey =
    normalizeOptionalText(options.idempotencyKey, "idempotencyKey") ??
    (revision.revision_source === "unversioned"
      ? undefined
      : [
          revision.revision,
          metric,
          source ?? "manual",
          itemId ?? "workspace",
        ].join(":"));
  const observationWithoutId = {
    metric,
    value: options.value,
    direction,
    ...(unit === undefined ? {} : { unit }),
    ...(options.threshold === undefined
      ? {}
      : { threshold: options.threshold }),
    observed_at: parseIsoTimestamp(
      options.observedAt ?? nowIso(),
      "observedAt",
    ),
    ...revision,
    author: resolveAuthor(options.author, settings.author_default),
    ...(itemId === undefined ? {} : { item_id: itemId }),
    ...(source === undefined ? {} : { source }),
    ...(idempotencyKey === undefined
      ? {}
      : { idempotency_key: idempotencyKey }),
  } satisfies Omit<ImprovementObservation, "id">;
  return {
    id: createHash("sha256")
      .update(stableStringify(observationWithoutId))
      .digest("hex")
      .slice(0, 24),
    ...observationWithoutId,
  };
}

function ensureObservationCanAppend(
  ledger: ImprovementLedgerDocument,
  observation: ImprovementObservation,
): ImprovementObservation | undefined {
  const existing = observation.idempotency_key
    ? ledger.observations.find(
        (row) => row.idempotency_key === observation.idempotency_key,
      )
    : ledger.observations.find((row) => row.id === observation.id);
  if (existing) {
    if (
      existing.metric !== observation.metric ||
      existing.value !== observation.value ||
      existing.direction !== observation.direction ||
      existing.threshold !== observation.threshold ||
      existing.unit !== observation.unit
    ) {
      throw new PmCliError(
        `Improvement observation retry key already records a different value for ${observation.metric}.`,
        EXIT_CODE.CONFLICT,
        { code: "improvement_observation_conflict" },
      );
    }
    return existing;
  }
  const priorMetric = ledger.observations.find(
    (row) => row.metric === observation.metric,
  );
  if (
    priorMetric &&
    (priorMetric.direction !== observation.direction ||
      priorMetric.unit !== observation.unit ||
      (observation.direction === "target" &&
        priorMetric.threshold !== observation.threshold))
  ) {
    throw new PmCliError(
      `Metric ${observation.metric} is already declared with direction ${priorMetric.direction} and unit ${priorMetric.unit ?? "<none>"}.`,
      EXIT_CODE.CONFLICT,
      { code: "improvement_metric_contract_conflict" },
    );
  }
  return undefined;
}

async function resolveObservationRevision(
  pmRoot: string,
  explicit: string | undefined,
): Promise<Pick<ImprovementObservation, "revision" | "revision_source">> {
  const callerRevision = normalizeOptionalText(explicit, "revision");
  if (callerRevision) {
    return { revision: callerRevision, revision_source: "caller" };
  }
  try {
    const result = await execFileAsync(
      "git",
      ["rev-parse", "--verify", "HEAD^{commit}"],
      {
        cwd: resolveWorkspaceRoot(pmRoot),
        encoding: "utf8",
        timeout: 5_000,
      },
    );
    const revision = result.stdout.trim();
    return { revision, revision_source: "git" };
  } catch {
    // Git is optional for root-layout and embedded SDK workspaces.
  }
  return { revision: "unversioned", revision_source: "unversioned" };
}

function trendForMetric(
  observations: ImprovementObservation[],
): ImprovementTrend {
  const baseline = observations[0];
  const latest = observations[observations.length - 1];
  const delta = latest.value - baseline.value;
  const improved =
    latest.direction === "higher"
      ? delta > 0
      : latest.direction === "lower"
        ? delta < 0
        : Math.abs(latest.value - (latest.threshold as number)) <
          Math.abs(baseline.value - (baseline.threshold as number));
  return {
    metric: latest.metric,
    direction: latest.direction,
    baseline,
    latest,
    delta,
    improved,
    sample_count: observations.length,
  };
}

/** Record one audited observation, returning an idempotent receipt on retry. */
export async function recordImprovementObservation(
  options: RecordImprovementObservationOptions,
  global: { path?: string } = {},
): Promise<RecordImprovementObservationResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const settings = await readSettings(pmRoot);
  const observation = await buildImprovementObservation(
    pmRoot,
    settings,
    options,
  );
  const filePath = path.join(pmRoot, "improvement-ledger.json");
  const mutation = await mutateWorkspaceJsonWithHistory({
    pmRoot,
    filePath,
    op: "improvement_observe",
    author: observation.author,
    lockTtlSeconds: settings.locks.ttl_seconds,
    lockWaitMs: settings.locks.wait_ms,
    message:
      options.message ??
      `Record ${observation.metric}=${String(options.value)} improvement observation`,
    mutate: (beforeRaw) => {
      const ledger = parseLedger(beforeRaw);
      const existing = ensureObservationCanAppend(ledger, observation);
      if (existing) {
        return { raw: beforeRaw!, result: existing };
      }
      ledger.observations.push(observation);
      ledger.observations.sort(
        (left, right) =>
          left.observed_at.localeCompare(right.observed_at) ||
          left.metric.localeCompare(right.metric) ||
          left.id.localeCompare(right.id),
      );
      return {
        raw: `${stableStringify(ledger)}\n`,
        result: observation,
      };
    },
  });
  return {
    changed: mutation.changed,
    observation: mutation.result,
    ledger_path: "improvement-ledger.json",
  };
}

/** Read a bounded newest-first observation page and derive complete trends. */
export async function readImprovementLedger(
  options: ReadImprovementLedgerOptions = {},
): Promise<ImprovementLedgerResult> {
  const pmRoot = resolvePmRoot(options.cwd ?? process.cwd(), options.pmRoot);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const metric =
    options.metric === undefined
      ? undefined
      : normalizeMetricName(options.metric);
  const since =
    options.since === undefined
      ? undefined
      : parseIsoTimestamp(options.since, "since");
  const limit = parseObservationLimit(options.limit);
  const ledger = parseLedger(
    await readFileIfExists(path.join(pmRoot, "improvement-ledger.json")),
  );
  const matching = ledger.observations.filter(
    (row) =>
      (metric === undefined || row.metric === metric) &&
      (options.itemId === undefined || row.item_id === options.itemId) &&
      (since === undefined || row.observed_at >= since),
  );
  const byMetric = new Map<string, ImprovementObservation[]>();
  for (const observation of matching) {
    const rows = byMetric.get(observation.metric) ?? [];
    rows.push(observation);
    byMetric.set(observation.metric, rows);
  }
  return {
    observations: [...matching].reverse().slice(0, limit),
    total: matching.length,
    truncated: matching.length > limit,
    trends: [...byMetric]
      .map(([, observations]) => trendForMetric(observations))
      .sort((left, right) => left.metric.localeCompare(right.metric)),
    source: "audited_workspace_singleton",
  };
}

/** Pure helpers exposed for storage and trend contract tests. */
export const _testOnlyImprovementLedger = {
  normalizeMetricName,
  normalizeDirection,
  parseLedger,
  parseObservationLimit,
  trendForMetric,
};
