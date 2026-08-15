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

/** Recovery-reference kinds emitted by structured refusal envelopes. */
export const PM_RECOVERY_REFERENCE_KINDS = [
  "suggested_retry",
  "candidate_command",
  "example",
  "next_step",
  "migration_hint",
  "restore_with",
] as const;

/** Recovery-reference kind emitted by a refusal. */
export type PmRecoveryReferenceKind =
  (typeof PM_RECOVERY_REFERENCE_KINDS)[number];

/** Behavioral promise attached to a recovery reference. */
export type PmRecoveryReferenceSemantics =
  | "recovery"
  | "replacement"
  | "behavior_preserving";

/** One derived promise that another invocation or command path is reachable. */
export interface PmRecoveryReferenceObligation {
  /** Stable reference identifier derived from its emitting envelope. */
  id: string;
  /** Refusal probe that emitted the reference. */
  probe_id: string;
  /** Typed recovery vocabulary rather than prose inference. */
  kind: PmRecoveryReferenceKind;
  /** Whether the reference recovers, replaces, or preserves the original behavior. */
  semantics: PmRecoveryReferenceSemantics;
  /** Exact emitted command or recovery text. */
  value: string;
}

/** Result of executing or resolving one derived recovery obligation. */
export interface PmRecoveryReferenceObservation {
  /** Stable obligation identifier. */
  id: string;
  /** Whether the promised recovery or command path was reachable. */
  reachable: boolean;
  /** How the promise was discharged. */
  proof: "executed" | "declared_command_path" | "linked_execution";
  /** Semantics actually demonstrated by the proof. */
  semantics: PmRecoveryReferenceSemantics;
}

/** Coverage totals for one emitted recovery-reference kind. */
export interface PmRecoveryReferenceKindCoverage {
  /** Typed reference kind. */
  kind: PmRecoveryReferenceKind;
  /** Derived obligations of this kind. */
  declared: number;
  /** Obligations with one observation. */
  observed: number;
  /** Obligations proven reachable. */
  passed: number;
}

/** One recovery-reference coverage failure. */
export interface PmRecoveryReferenceFinding {
  /** Stable finding kind for assurance and CI. */
  kind:
    | "duplicate_obligation"
    | "duplicate_observation"
    | "missing_observation"
    | "unreachable_reference"
    | "wrong_semantics"
    | "undeclared_observation";
  /** Obligation or observation identifier. */
  reference_id: string;
  /** Human-readable mismatch summary. */
  detail: string;
}

/** Complete cross-kind recovery-reference coverage receipt. */
export interface PmRecoveryReferenceReport {
  /** Whether every derived reference was uniquely proven reachable. */
  ok: boolean;
  /** Total references derived from real refusal envelopes. */
  declared_reference_count: number;
  /** Total reference observations supplied. */
  observed_reference_count: number;
  /** Reachable fraction across the declared obligation set. */
  pass_fraction: number;
  /** Stable coverage buckets, including zero-population kinds. */
  coverage_by_kind: PmRecoveryReferenceKindCoverage[];
  /** Stable, sorted conformance findings. */
  findings: PmRecoveryReferenceFinding[];
}

const RECOVERY_REFERENCE_FIELD_CONTRACTS: Readonly<
  Record<
    string,
    {
      kind: PmRecoveryReferenceKind;
      semantics: PmRecoveryReferenceSemantics;
    }
  >
> = {
  suggested_retry: { kind: "suggested_retry", semantics: "recovery" },
  candidate_command: { kind: "candidate_command", semantics: "recovery" },
  candidate_commands: { kind: "candidate_command", semantics: "recovery" },
  example: { kind: "example", semantics: "recovery" },
  examples: { kind: "example", semantics: "recovery" },
  next_step: { kind: "next_step", semantics: "recovery" },
  next_steps: { kind: "next_step", semantics: "recovery" },
  migration_hint: { kind: "migration_hint", semantics: "replacement" },
  migration_hints: { kind: "migration_hint", semantics: "replacement" },
  restore_with: {
    kind: "restore_with",
    semantics: "behavior_preserving",
  },
};

/** Derive typed obligations from every recognized recovery field in an emitted envelope. */
export function derivePmRecoveryReferenceObligations(
  probeId: string,
  envelope: unknown,
): PmRecoveryReferenceObligation[] {
  const obligations: PmRecoveryReferenceObligation[] = [];
  const visit = (value: unknown, path: readonly string[]): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, String(index)]));
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, entry] of Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const baseContract = RECOVERY_REFERENCE_FIELD_CONTRACTS[key];
      const contract =
        baseContract?.kind === "migration_hint" &&
        (value as { semantics?: unknown }).semantics === "behavior_preserving"
          ? { ...baseContract, semantics: "behavior_preserving" as const }
          : baseContract;
      const entries = Array.isArray(entry) ? entry : [entry];
      if (contract !== undefined) {
        entries.forEach((candidate, index) => {
          if (typeof candidate !== "string" || candidate.trim().length === 0)
            return;
          const coordinate = [...path, key, String(index)]
            .map((segment) => encodeURIComponent(segment))
            .join("/");
          obligations.push({
            id: `${probeId}:${contract.kind}:${coordinate}`,
            probe_id: probeId,
            kind: contract.kind,
            semantics: contract.semantics,
            value: candidate,
          });
        });
      }
      visit(entry, [...path, key]);
    }
  };
  visit(envelope, []);
  return obligations;
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

/** Verify executable and declared-path proof for emitted recovery references. */
export function verifyPmRecoveryReferences(
  obligations: readonly PmRecoveryReferenceObligation[],
  observations: readonly PmRecoveryReferenceObservation[],
): PmRecoveryReferenceReport {
  const findings: PmRecoveryReferenceFinding[] = [];
  const declaredIds = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const obligation of obligations) {
    if (declaredIds.has(obligation.id)) {
      duplicateIds.add(obligation.id);
      findings.push({
        kind: "duplicate_obligation",
        reference_id: obligation.id,
        detail: `Recovery obligation ${obligation.id} was declared more than once.`,
      });
      continue;
    }
    declaredIds.add(obligation.id);
  }
  const observationsById = new Map<string, PmRecoveryReferenceObservation>();
  for (const observation of observations) {
    if (observationsById.has(observation.id)) {
      findings.push({
        kind: "duplicate_observation",
        reference_id: observation.id,
        detail: `Recovery reference ${observation.id} was observed more than once.`,
      });
      continue;
    }
    observationsById.set(observation.id, observation);
    if (!declaredIds.has(observation.id)) {
      findings.push({
        kind: "undeclared_observation",
        reference_id: observation.id,
        detail: `Recovery observation ${observation.id} has no emitted obligation.`,
      });
    }
  }
  for (const obligation of obligations) {
    if (duplicateIds.has(obligation.id)) continue;
    const observation = observationsById.get(obligation.id);
    if (!observation) {
      findings.push({
        kind: "missing_observation",
        reference_id: obligation.id,
        detail: `No reachability proof was recorded for ${obligation.kind} ${obligation.value}.`,
      });
    } else if (!observation.reachable) {
      findings.push({
        kind: "unreachable_reference",
        reference_id: obligation.id,
        detail: `Recovery reference ${obligation.value} did not reach its promised target.`,
      });
    } else if (observation.semantics !== obligation.semantics) {
      findings.push({
        kind: "wrong_semantics",
        reference_id: obligation.id,
        detail: `Recovery reference ${obligation.value} promised ${obligation.semantics}; proof demonstrated ${observation.semantics}.`,
      });
    }
  }
  const coverageByKind = PM_RECOVERY_REFERENCE_KINDS.map((kind) => {
    const kindObligations = obligations.filter(
      (obligation) => obligation.kind === kind,
    );
    const kindObservations = kindObligations
      .filter((obligation) => !duplicateIds.has(obligation.id))
      .map((obligation) => observationsById.get(obligation.id))
      .filter(
        (observation): observation is PmRecoveryReferenceObservation =>
          observation !== undefined,
      );
    return {
      kind,
      declared: kindObligations.length,
      observed: kindObservations.length,
      passed: kindObligations.filter((obligation) => {
        const observation = observationsById.get(obligation.id);
        return (
          !duplicateIds.has(obligation.id) &&
          observation?.reachable === true &&
          observation.semantics === obligation.semantics
        );
      }).length,
    };
  });
  findings.sort((left, right) =>
    left.reference_id !== right.reference_id
      ? left.reference_id.localeCompare(right.reference_id)
      : left.kind.localeCompare(right.kind),
  );
  const passed = coverageByKind.reduce(
    (total, coverage) => total + coverage.passed,
    0,
  );
  return {
    ok: findings.length === 0,
    declared_reference_count: obligations.length,
    observed_reference_count: observations.length,
    pass_fraction: declaredIds.size === 0 ? 1 : passed / declaredIds.size,
    coverage_by_kind: coverageByKind,
    findings,
  };
}
