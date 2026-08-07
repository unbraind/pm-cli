/**
 * @module sdk/command-exit-contracts
 *
 * Declares shell-visible command outcomes and derives effect receipts shared by
 * CLI, SDK, MCP, packages, telemetry, and conformance gates.
 */
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PM_CORE_COMMAND_NAMES } from "./enum-contracts.js";

/** Stable numeric exit codes emitted by core pm commands. */
export type PmCommandExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Effect-oriented outcome vocabulary shared by shells and structured output. */
export type PmCommandExitOutcome =
  | "effect"
  | "internal_failure"
  | "refused_input"
  | "refused_tracker_state"
  | "conflict"
  | "dependency_failed"
  | "no_effect"
  | "partial_effect";

/** Meaning and success semantics for one stable process exit. */
export interface PmCommandExitOutcomeContract {
  /** Stable process exit visible without parsing stdout. */
  exit_code: PmCommandExitCode;
  /** Effect-oriented result independent of implementation details. */
  outcome: PmCommandExitOutcome;
  /** Whether the command completed its requested control flow successfully. */
  success: boolean;
  /** Concise operator-facing meaning. */
  meaning: string;
}

/** Declared numeric exits for one core command path. */
export interface PmCommandExitContract {
  /** Normalized command path. */
  command: string;
  /** Exhaustive exits the command may emit. */
  exit_codes: readonly PmCommandExitCode[];
}

/** One replay observation used to verify command exit declarations. */
export interface PmCommandExitObservation {
  /** Command path executed by the replay. */
  command: string;
  /** Process exit observed from the real command boundary. */
  exit_code: number;
  /** Stable replay case identifier for diagnostics. */
  replay_id: string;
}

/** Drift report produced by exit-contract replay conformance. */
export interface PmCommandExitConformanceReport {
  /** Whether all declaration and observation checks passed. */
  ok: boolean;
  /** Expected commands without a declaration. */
  missing_commands: string[];
  /** Observations whose command or numeric exit is undeclared. */
  undeclared_observations: PmCommandExitObservation[];
  /** Declared numeric outcomes not reached anywhere in the replay corpus. */
  unreachable_exit_codes: PmCommandExitCode[];
}

/** Canonical effect vocabulary for all stable CLI process exits. */
export const PM_COMMAND_EXIT_OUTCOME_CONTRACTS = [
  {
    exit_code: EXIT_CODE.SUCCESS,
    outcome: "effect",
    success: true,
    meaning: "The requested operation completed with its intended effect.",
  },
  {
    exit_code: EXIT_CODE.GENERIC_FAILURE,
    outcome: "internal_failure",
    success: false,
    meaning: "An unexpected runtime or internal failure prevented completion.",
  },
  {
    exit_code: EXIT_CODE.USAGE,
    outcome: "refused_input",
    success: false,
    meaning:
      "The invocation was refused because its input or composition was invalid.",
  },
  {
    exit_code: EXIT_CODE.NOT_FOUND,
    outcome: "refused_tracker_state",
    success: false,
    meaning: "The requested tracker, item, or resource was not present.",
  },
  {
    exit_code: EXIT_CODE.CONFLICT,
    outcome: "conflict",
    success: false,
    meaning: "Current state or concurrency prevented the requested effect.",
  },
  {
    exit_code: EXIT_CODE.DEPENDENCY_FAILED,
    outcome: "dependency_failed",
    success: false,
    meaning: "A required dependency operation failed.",
  },
  {
    exit_code: EXIT_CODE.NO_EFFECT,
    outcome: "no_effect",
    success: true,
    meaning:
      "The request was valid and completed, but matched nothing to change.",
  },
  {
    exit_code: EXIT_CODE.PARTIAL_EFFECT,
    outcome: "partial_effect",
    success: true,
    meaning:
      "The request completed and changed some, but not all, selected targets.",
  },
] as const satisfies readonly PmCommandExitOutcomeContract[];

const STANDARD_COMMAND_EXIT_CODES = [
  EXIT_CODE.SUCCESS,
  EXIT_CODE.GENERIC_FAILURE,
  EXIT_CODE.USAGE,
  EXIT_CODE.NOT_FOUND,
  EXIT_CODE.CONFLICT,
  EXIT_CODE.DEPENDENCY_FAILED,
] as const;

const EFFECT_AWARE_BULK_COMMANDS = new Set(["close-many", "update-many"]);

/** Exhaustive core command exit declarations generated from the command registry. */
export const PM_COMMAND_EXIT_CONTRACTS: readonly PmCommandExitContract[] =
  PM_CORE_COMMAND_NAMES.map((command) => ({
    command,
    exit_codes: EFFECT_AWARE_BULK_COMMANDS.has(command)
      ? [
          ...STANDARD_COMMAND_EXIT_CODES,
          EXIT_CODE.NO_EFFECT,
          EXIT_CODE.PARTIAL_EFFECT,
        ]
      : [...STANDARD_COMMAND_EXIT_CODES],
  }));

const COMMAND_EXIT_CONTRACT_BY_PATH = new Map(
  PM_COMMAND_EXIT_CONTRACTS.map((contract) => [contract.command, contract]),
);

/** Stable successful process exits, including machine-distinct effect states. */
export const PM_SUCCESS_EXIT_CODES = [
  EXIT_CODE.SUCCESS,
  EXIT_CODE.NO_EFFECT,
  EXIT_CODE.PARTIAL_EFFECT,
] as const;

/** Portable success effect reported by command result envelopes. */
export type PmCommandEffect =
  | "effect"
  | "no_effect"
  | "partial_effect"
  | "dependency_failed";

/** Shell and envelope representation of one command effect or collected failure. */
export interface PmCommandEffectReceipt {
  /** Semantic effect observed after command execution. */
  outcome: PmCommandEffect;
  /** Stable shell exit paired with the effect. */
  exit_code: 0 | 5 | 6 | 7;
}

/** Counts used to derive one bulk mutation's effect without parsing prose. */
export interface PmBulkMutationEffectCounts {
  /** Rows that completed the requested mutation. */
  applied: number;
  /** Rows deliberately left unchanged. */
  skipped: number;
  /** Rows whose attempted mutation failed. */
  failed: number;
  /** Explicit requested identifiers that did not exist. */
  unmatched: number;
}

/** Return whether an exit represents a successful command outcome. */
export function isPmSuccessfulExitCode(exitCode: number): boolean {
  return PM_SUCCESS_EXIT_CODES.includes(
    exitCode as (typeof PM_SUCCESS_EXIT_CODES)[number],
  );
}

/** Return whether an exit belongs to the declared pm process vocabulary. */
export function isPmKnownExitCode(
  exitCode: number,
): exitCode is PmCommandExitCode {
  return PM_COMMAND_EXIT_OUTCOME_CONTRACTS.some(
    (contract) => contract.exit_code === exitCode,
  );
}

/** Resolve an exact command contract, falling back to its declared root path. */
export function resolvePmCommandExitContract(
  commandPath: string,
): PmCommandExitContract | undefined {
  const normalized = commandPath
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ");
  return (
    COMMAND_EXIT_CONTRACT_BY_PATH.get(normalized) ??
    COMMAND_EXIT_CONTRACT_BY_PATH.get(normalized.split(" ")[0])
  );
}

/** Verify command coverage, observed exits, and vocabulary reachability for a replay corpus. */
export function analyzePmCommandExitConformance(
  observations: readonly PmCommandExitObservation[],
  expectedCommands: readonly string[] = PM_CORE_COMMAND_NAMES,
  contracts: readonly PmCommandExitContract[] = PM_COMMAND_EXIT_CONTRACTS,
): PmCommandExitConformanceReport {
  const contractsByCommand = new Map(
    contracts.map((contract) => [contract.command, contract]),
  );
  const missingCommands = expectedCommands.filter(
    (command) => !contractsByCommand.has(command),
  );
  const undeclaredObservations = observations.filter((observation) => {
    const contract =
      contractsByCommand.get(observation.command) ??
      contractsByCommand.get(observation.command.split(" ")[0]);
    return (
      contract === undefined ||
      !contract.exit_codes.includes(observation.exit_code as PmCommandExitCode)
    );
  });
  const observedExitCodes = new Set(
    observations.map((entry) => entry.exit_code),
  );
  const declaredExitCodes = new Set(
    contracts.flatMap((contract) => contract.exit_codes),
  );
  const unreachableExitCodes = [...declaredExitCodes]
    .filter((exitCode) => !observedExitCodes.has(exitCode))
    .sort((left, right) => left - right);
  return {
    ok:
      missingCommands.length === 0 &&
      undeclaredObservations.length === 0 &&
      unreachableExitCodes.length === 0,
    missing_commands: missingCommands,
    undeclared_observations: undeclaredObservations,
    unreachable_exit_codes: unreachableExitCodes,
  };
}

/** Derive deterministic full, empty, partial, or failed semantics for a bulk mutation. */
export function derivePmBulkMutationEffect(
  counts: PmBulkMutationEffectCounts,
): PmCommandEffectReceipt {
  if (counts.applied === 0 && counts.failed > 0) {
    return {
      outcome: "dependency_failed",
      exit_code: EXIT_CODE.DEPENDENCY_FAILED,
    };
  }
  if (counts.applied === 0) {
    return { outcome: "no_effect", exit_code: EXIT_CODE.NO_EFFECT };
  }
  if (counts.skipped > 0 || counts.failed > 0 || counts.unmatched > 0) {
    return {
      outcome: "partial_effect",
      exit_code: EXIT_CODE.PARTIAL_EFFECT,
    };
  }
  return { outcome: "effect", exit_code: EXIT_CODE.SUCCESS };
}
