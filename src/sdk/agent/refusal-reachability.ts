/**
 * @module sdk/agent/refusal-reachability
 *
 * Verifies real-entrypoint observations against refusal states declared by the
 * generated public error-code catalog.
 */
import type {
  PmErrorCodeContract,
  PmErrorCodeClass,
} from "../error-code-catalog.js";

/** One recorded result from driving a real public entrypoint into a refusal. */
export interface PmRefusalProbeObservation {
  /** Stable probe identifier from the owning error-code contract. */
  probe_id: string;
  /** Public command entrypoint exercised by the probe. */
  entrypoint: string;
  /** Machine-readable code observed at the transport boundary. */
  code: string;
  /** Semantic exit class observed at the transport boundary. */
  exit_class: PmErrorCodeClass;
}

/** One actionable conformance failure. */
export interface PmRefusalReachabilityFinding {
  /** Stable finding kind for automation. */
  kind:
    | "duplicate_probe"
    | "missing_probe"
    | "wrong_entrypoint"
    | "wrong_error_code"
    | "wrong_exit_class"
    | "undeclared_probe";
  /** Probe whose declaration or observation failed. */
  probe_id: string;
  /** Human-readable mismatch summary. */
  detail: string;
}

/** Complete refusal-reachability conformance receipt. */
export interface PmRefusalReachabilityReport {
  /** Whether every declaration and observation agreed. */
  ok: boolean;
  /** Number of declared probes evaluated. */
  declared_probe_count: number;
  /** Number of real-entrypoint observations supplied. */
  observed_probe_count: number;
  /** Stable, sorted conformance findings. */
  findings: PmRefusalReachabilityFinding[];
}

/** Compare declared refusal states with real-entrypoint observations. */
export function verifyPmRefusalReachability(
  catalog: readonly PmErrorCodeContract[],
  observations: readonly PmRefusalProbeObservation[],
): PmRefusalReachabilityReport {
  const declarations = catalog.flatMap((contract) =>
    (contract.owned_states ?? []).map((state) => ({ contract, state })),
  );
  const findings: PmRefusalReachabilityFinding[] = [];
  const observationsByProbe = new Map<string, PmRefusalProbeObservation>();
  for (const observation of observations) {
    if (observationsByProbe.has(observation.probe_id)) {
      findings.push({
        kind: "duplicate_probe",
        probe_id: observation.probe_id,
        detail: `Observation ${observation.probe_id} was supplied more than once.`,
      });
      continue;
    }
    observationsByProbe.set(observation.probe_id, observation);
  }
  const declaredProbeIds = new Set(
    declarations.map(({ state }) => state.probe_id),
  );
  for (const { contract, state } of declarations) {
    const observation = observationsByProbe.get(state.probe_id);
    if (!observation) {
      findings.push({
        kind: "missing_probe",
        probe_id: state.probe_id,
        detail: `No entrypoint observation was recorded for ${contract.code}.`,
      });
      continue;
    }
    if (observation.code !== contract.code) {
      findings.push({
        kind: "wrong_error_code",
        probe_id: state.probe_id,
        detail: `Expected ${contract.code}; observed ${observation.code}.`,
      });
    }
    if (observation.exit_class !== state.expected_exit_class) {
      findings.push({
        kind: "wrong_exit_class",
        probe_id: state.probe_id,
        detail: `Expected ${state.expected_exit_class}; observed ${observation.exit_class}.`,
      });
    }
    if (!state.entrypoints.includes(observation.entrypoint)) {
      findings.push({
        kind: "wrong_entrypoint",
        probe_id: state.probe_id,
        detail: `Expected one of ${state.entrypoints.join(", ")}; observed ${observation.entrypoint}.`,
      });
    }
  }
  for (const observation of observations) {
    if (!declaredProbeIds.has(observation.probe_id)) {
      findings.push({
        kind: "undeclared_probe",
        probe_id: observation.probe_id,
        detail: `Observation ${observation.probe_id} has no catalog declaration.`,
      });
    }
  }
  findings.sort((left, right) =>
    left.probe_id !== right.probe_id
      ? left.probe_id.localeCompare(right.probe_id)
      : left.kind.localeCompare(right.kind),
  );
  return {
    ok: findings.length === 0,
    declared_probe_count: declarations.length,
    observed_probe_count: observations.length,
    findings,
  };
}
