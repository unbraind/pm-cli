/**
 * @module sdk/agent/refusal-closure
 *
 * Scores whether a structured refusal contains enough executable context for
 * an agent to recover without another discovery round trip.
 */
import { EXIT_CODE } from "../../core/shared/constants.js";

/** One real refusal and the outcome of executing its advertised retry. */
export interface PmRefusalClosureObservation {
  /** Stable corpus identifier. */
  probe_id: string;
  /** Public entrypoint that refused the invocation. */
  entrypoint: string;
  /** Process exit code returned by the refusal. */
  exit_code: number;
  /** Rejected closed-domain token. */
  rejected_value: string;
  /** Complete accepted domain emitted by the refusal. */
  allowed_values: readonly string[];
  /** Exact command emitted for recovery. */
  suggested_retry: string;
  /** Whether executing the advertised retry succeeded. */
  retry_succeeded: boolean;
}

/** One missing or contradictory recovery primitive. */
export interface PmRefusalClosureFinding {
  /** Stable finding code. */
  code:
    | "accepted_rejected_value"
    | "duplicate_probe"
    | "empty_corpus"
    | "missing_allowed_values"
    | "missing_suggested_retry"
    | "non_refusal_exit"
    | "retry_failed";
  /** Stable corpus identifier. */
  probe_id: string;
  /** Actionable mismatch detail. */
  detail: string;
}

/** Complete recovery-closure score and its fail-closed findings. */
export interface PmRefusalClosureReport {
  /** Whether every refusal was self-contained and executable. */
  ok: boolean;
  /** Number of unique probes scored. */
  probe_count: number;
  /** Number of probes with complete successful closure. */
  closed_probe_count: number;
  /** Closed probes divided by unique probes. */
  closure_fraction: number;
  /** Stable ordered findings. */
  findings: readonly PmRefusalClosureFinding[];
}

/** Return every closure defect contributed by one unique observation. */
function listObservationFindings(
  observation: PmRefusalClosureObservation,
): Array<PmRefusalClosureFinding | undefined> {
  return [
    observation.exit_code !== EXIT_CODE.USAGE
      ? {
          code: "non_refusal_exit",
          probe_id: observation.probe_id,
          detail: `${observation.entrypoint} returned exit code ${observation.exit_code}; a structured usage refusal must return ${EXIT_CODE.USAGE}.`,
        }
      : undefined,
    observation.allowed_values.length === 0
      ? {
          code: "missing_allowed_values",
          probe_id: observation.probe_id,
          detail: "The refusal omitted its complete accepted value domain.",
        }
      : undefined,
    observation.allowed_values.includes(observation.rejected_value)
      ? {
          code: "accepted_rejected_value",
          probe_id: observation.probe_id,
          detail: `${observation.rejected_value} is both rejected and advertised as allowed.`,
        }
      : undefined,
    observation.suggested_retry.trim().length === 0
      ? {
          code: "missing_suggested_retry",
          probe_id: observation.probe_id,
          detail: "The refusal omitted an executable suggested retry.",
        }
      : undefined,
    !observation.retry_succeeded
      ? {
          code: "retry_failed",
          probe_id: observation.probe_id,
          detail: "The advertised suggested retry did not succeed.",
        }
      : undefined,
  ];
}

/** Score structured closed-domain refusals and executable retries. */
export function scorePmRefusalClosure(
  observations: readonly PmRefusalClosureObservation[],
): PmRefusalClosureReport {
  const findings: PmRefusalClosureFinding[] = [];
  const seen = new Set<string>();
  let closedProbeCount = 0;
  if (observations.length === 0) {
    findings.push({
      code: "empty_corpus",
      probe_id: "corpus",
      detail: "At least one real refusal observation is required.",
    });
  }
  for (const observation of observations) {
    if (seen.has(observation.probe_id)) {
      findings.push({
        code: "duplicate_probe",
        probe_id: observation.probe_id,
        detail: `${observation.probe_id} was supplied more than once.`,
      });
      continue;
    }
    seen.add(observation.probe_id);
    const findingCount = findings.length;
    for (const finding of listObservationFindings(observation)) {
      if (finding !== undefined) findings.push(finding);
    }
    if (findings.length === findingCount) closedProbeCount += 1;
  }
  findings.sort((left, right) =>
    left.probe_id !== right.probe_id
      ? left.probe_id.localeCompare(right.probe_id)
      : left.code.localeCompare(right.code),
  );
  return {
    ok: findings.length === 0,
    probe_count: seen.size,
    closed_probe_count: closedProbeCount,
    closure_fraction: seen.size === 0 ? 0 : closedProbeCount / seen.size,
    findings,
  };
}
