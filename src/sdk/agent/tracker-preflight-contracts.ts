/**
 * @module sdk/agent/tracker-preflight-contracts
 *
 * Declares and scores executable recovery for tracker filesystem preflight failures.
 */

/** Filesystem states distinguished by the shared tracker preflight. */
export type PmTrackerPreflightFailureKind =
  | "missing_root"
  | "settings_missing"
  | "not_directory"
  | "unreadable_root";

/** Recovery behavior that is safe for a tracker preflight failure. */
export type PmTrackerPreflightRecoveryKind =
  | "initialize"
  | "select_directory"
  | "repair_permissions";

/** Static refusal and recovery obligation for one tracker filesystem state. */
export interface PmTrackerPreflightRecoveryContract {
  /** Stable probe identifier used by repository gates and evidence. */
  probe_id: string;
  /** Filesystem state created by the executable probe. */
  failure_kind: PmTrackerPreflightFailureKind;
  /** Stable structured error code required from CLI and SDK transports. */
  expected_error_code: string;
  /** Process exit code required from the CLI transport. */
  expected_exit_code: 1 | 2 | 3;
  /** Safe recovery behavior for this filesystem state. */
  recovery_kind: PmTrackerPreflightRecoveryKind;
}

/** Runtime evidence captured from one executable tracker preflight probe. */
export interface PmTrackerPreflightRecoveryObservation {
  /** Stable probe identifier from the corresponding contract. */
  probe_id: string;
  /** Structured error code emitted by the refusal. */
  error_code: string;
  /** Process exit code emitted by the refusal. */
  exit_code: number;
  /** Recovery behavior exercised by the probe driver. */
  recovery_kind: PmTrackerPreflightRecoveryKind;
  /** Tokenized retry emitted by the refusal, or an empty list when no deterministic retry is safe. */
  suggested_retry_args: string[];
  /** Whether the emitted retry or safe alternate-root retry executed successfully. */
  retry_succeeded: boolean;
  /** Whether a file-path refusal incorrectly recommended tracker initialization. */
  unsafe_init_recommended: boolean;
}

/** Actionable failure emitted by the tracker preflight closure scorer. */
export interface PmTrackerPreflightRecoveryFinding {
  /** Stable finding code for automation and ratchets. */
  code:
    | "missing_probe"
    | "error_code_mismatch"
    | "exit_code_mismatch"
    | "recovery_kind_mismatch"
    | "missing_init_recovery"
    | "unsafe_init_recovery"
    | "retry_failed";
  /** Probe that failed its recovery obligation. */
  probe_id: string;
  /** Human-readable explanation of the failed obligation. */
  detail: string;
}

/** Aggregate executable-closure report for the tracker preflight corpus. */
export interface PmTrackerPreflightRecoveryReport {
  /** Whether every declared probe met its refusal and recovery contract. */
  ok: boolean;
  /** Number of declared tracker preflight probes. */
  probe_count: number;
  /** Number of probes with no findings. */
  closed_probe_count: number;
  /** Deterministically ordered failed obligations. */
  findings: PmTrackerPreflightRecoveryFinding[];
}

const TRACKER_PREFLIGHT_RECOVERY_CONTRACTS: readonly PmTrackerPreflightRecoveryContract[] =
  [
    {
      probe_id: "tracker-root-missing",
      failure_kind: "missing_root",
      expected_error_code: "tracker_root_missing",
      expected_exit_code: 3,
      recovery_kind: "initialize",
    },
    {
      probe_id: "tracker-root-settings-missing",
      failure_kind: "settings_missing",
      expected_error_code: "tracker_not_initialized",
      expected_exit_code: 3,
      recovery_kind: "initialize",
    },
    {
      probe_id: "tracker-root-not-directory",
      failure_kind: "not_directory",
      expected_error_code: "tracker_root_not_directory",
      expected_exit_code: 2,
      recovery_kind: "select_directory",
    },
    {
      probe_id: "tracker-root-unreadable",
      failure_kind: "unreadable_root",
      expected_error_code: "tracker_root_unreadable",
      expected_exit_code: 1,
      recovery_kind: "repair_permissions",
    },
  ];

/** Return defensive copies of every core tracker preflight recovery contract. */
export function listTrackerPreflightRecoveryContracts(): PmTrackerPreflightRecoveryContract[] {
  return TRACKER_PREFLIGHT_RECOVERY_CONTRACTS.map((contract) => ({
    ...contract,
  }));
}

function findTrackerPreflightObservationFindings(
  contract: PmTrackerPreflightRecoveryContract,
  observation: PmTrackerPreflightRecoveryObservation,
): PmTrackerPreflightRecoveryFinding[] {
  const findings: PmTrackerPreflightRecoveryFinding[] = [];
  if (observation.error_code !== contract.expected_error_code) {
    findings.push({
      code: "error_code_mismatch",
      probe_id: contract.probe_id,
      detail: `Expected ${contract.expected_error_code}, received ${observation.error_code}.`,
    });
  }
  if (observation.exit_code !== contract.expected_exit_code) {
    findings.push({
      code: "exit_code_mismatch",
      probe_id: contract.probe_id,
      detail: `Expected exit ${contract.expected_exit_code}, received ${observation.exit_code}.`,
    });
  }
  if (observation.recovery_kind !== contract.recovery_kind) {
    findings.push({
      code: "recovery_kind_mismatch",
      probe_id: contract.probe_id,
      detail: `Expected ${contract.recovery_kind}, received ${observation.recovery_kind}.`,
    });
  }
  const initIndex = observation.suggested_retry_args.indexOf("init");
  const validInitCommand =
    initIndex === 0 ||
    (initIndex === 2 &&
      observation.suggested_retry_args[0] === "--pm-path" &&
      observation.suggested_retry_args[1]?.length > 0);
  if (contract.recovery_kind === "initialize" && !validInitCommand) {
    findings.push({
      code: "missing_init_recovery",
      probe_id: contract.probe_id,
      detail: "Missing and uninitialized roots must emit a tokenized init retry.",
    });
  }
  if (
    observation.unsafe_init_recommended ||
    (contract.recovery_kind !== "initialize" &&
      observation.suggested_retry_args.includes("init"))
  ) {
    findings.push({
      code: "unsafe_init_recovery",
      probe_id: contract.probe_id,
      detail: "A tracker root that cannot be initialized safely must not recommend initialization.",
    });
  }
  if (!observation.retry_succeeded) {
    findings.push({
      code: "retry_failed",
      probe_id: contract.probe_id,
      detail: "The emitted retry or safe alternate-root recovery did not execute successfully.",
    });
  }
  return findings;
}

/** Score runtime observations against the complete tracker preflight recovery corpus. */
export function scoreTrackerPreflightRecoveryClosure(
  observations: readonly PmTrackerPreflightRecoveryObservation[],
): PmTrackerPreflightRecoveryReport {
  const observationsByProbe = new Map(
    observations.map((observation) => [observation.probe_id, observation]),
  );
  const findings: PmTrackerPreflightRecoveryFinding[] = [];
  let closedProbeCount = 0;
  for (const contract of TRACKER_PREFLIGHT_RECOVERY_CONTRACTS) {
    const observation = observationsByProbe.get(contract.probe_id);
    if (observation === undefined) {
      findings.push({
        code: "missing_probe",
        probe_id: contract.probe_id,
        detail: "No runtime observation was supplied for this contract.",
      });
      continue;
    }
    const observationFindings = findTrackerPreflightObservationFindings(
      contract,
      observation,
    );
    findings.push(...observationFindings);
    if (observationFindings.length === 0) closedProbeCount += 1;
  }
  findings.sort(
    (left, right) =>
      left.probe_id.localeCompare(right.probe_id) ||
      left.code.localeCompare(right.code),
  );
  return {
    ok: findings.length === 0,
    probe_count: TRACKER_PREFLIGHT_RECOVERY_CONTRACTS.length,
    closed_probe_count: closedProbeCount,
    findings,
  };
}
