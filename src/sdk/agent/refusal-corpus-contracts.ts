/**
 * @module sdk/agent/refusal-corpus-contracts
 *
 * Derives executable refusal probes from the public CLI grammar. The corpus is
 * fail-closed: adding a required positional slot or action-dispatching command
 * automatically adds a probe, while an action family without an authoritative
 * value domain throws during contract construction.
 */
import { PLAN_SUBCOMMANDS } from "../lifecycle/plan.js";
import { PROFILE_SUBCOMMANDS } from "../profile.js";
import { SCHEMA_SUBCOMMANDS } from "../schema.js";
import {
  GRAPH_SUBCOMMAND_VALUES,
  MERGE_SUBCOMMAND_VALUES,
} from "../cli-contracts/enum-contracts.js";
import {
  PM_COMMAND_DESTINATION_CONTRACTS,
  PM_COMMAND_POSITIONAL_CONTRACTS,
  PM_POSITIONAL_ACTION_CONTRACTS,
  type PmCommandPositionalContract,
  type PmCommandPositionalSlotContract,
} from "../cli-contracts/grammar-contracts.js";
import { resolveSubcommandFlagContractsForCommand } from "../cli-contracts/flag-contracts.js";

/** Shared executable shape for a refusal that must not mutate tracker state. */
export interface PmGrammarRefusalContract {
  /** Stable probe identity used by ratchets and evidence. */
  probe_id: string;
  /** Canonical command path under test. */
  command: string;
  /** Exact argv expected to refuse. */
  refusal_args: readonly string[];
  /** Exact help argv that must execute successfully after the refusal. */
  recovery_args: readonly string[];
  /** Stable problem-envelope code expected from the refusal. */
  error_code:
    | "invalid_argument_value"
    | "missing_lifecycle_target"
    | "missing_required_argument"
    | "unknown_subcommand";
}

/** One required positional omission derived from the grammar declaration. */
export interface PmRequiredArgumentRefusalContract extends PmGrammarRefusalContract {
  /** Stable positional name deliberately omitted by the probe. */
  missing_argument: string;
  /** Zero-based slot index in the command's declared positional signature. */
  missing_argument_index: number;
}

/** One invalid action probe for a closed positional subcommand family. */
export interface PmSubcommandRefusalContract extends PmGrammarRefusalContract {
  /** Invalid action token used to reach the refusal. */
  rejected_value: string;
  /** Complete authoritative action domain expected in recovery. */
  allowed_values: readonly string[];
}

/** Runtime evidence for one grammar-derived refusal probe. */
export interface PmGrammarRefusalObservation {
  /** Probe identity matching a declared contract. */
  probe_id: string;
  /** Machine-readable code emitted by the refusal. */
  error_code: string;
  /** Process exit code emitted by the refusal. */
  exit_code: number;
  /** Allowed values emitted for a closed action family. */
  allowed_values: readonly string[];
  /** Whether the advertised help recovery exited successfully. */
  recovery_succeeded: boolean;
  /** Whether any tracker state changed while executing the refusal. */
  refusal_mutated_state: boolean;
  /** Repository-relative tracker paths changed by the refusal, when measured. */
  mutated_paths?: readonly string[];
}

/** Stable reason a grammar-derived refusal failed closure. */
export type PmGrammarRefusalFindingCode =
  | "refusal_allowed_values_mismatch"
  | "refusal_error_code_mismatch"
  | "refusal_exit_code_mismatch"
  | "refusal_mutated_state"
  | "refusal_probe_missing"
  | "refusal_recovery_failed"
  | "unexpected_refusal_probe";

/** One actionable grammar-derived refusal closure failure. */
export interface PmGrammarRefusalFinding {
  /** Stable machine-readable failure category. */
  code: PmGrammarRefusalFindingCode;
  /** Probe associated with the finding. */
  probe_id: string;
  /** Human-readable failure detail. */
  detail: string;
}

/** Aggregate closure receipt for the grammar-derived refusal corpus. */
export interface PmGrammarRefusalClosureReport {
  /** Whether every declared probe refused safely and recovered. */
  ok: boolean;
  /** Number of declared probes. */
  probe_count: number;
  /** Number of probes without findings. */
  closed_probe_count: number;
  /** Stable actionable failures. */
  findings: PmGrammarRefusalFinding[];
}

const REJECTED_ACTION = "not-a-declared-action";

function positionalPlaceholder(
  command: string,
  slot: PmCommandPositionalSlotContract,
): string {
  if (command.startsWith("assurance ") && slot.name === "kind") {
    return "measurement";
  }
  switch (slot.value_kind) {
    case "integer":
      return "1";
    case "item_id":
      return "pm-domain";
    case "action":
      throw new Error(
        `Cannot synthesize a preceding action value for positional slot ${slot.name}.`,
      );
    default:
      return "example";
  }
}

function probeSlug(value: string): string {
  return value.replaceAll(/[^a-z0-9]+/gu, "-").replaceAll(/^-|-$/gu, "");
}

/**
 * Return one omission probe for every required slot in the declared grammar.
 * Earlier positionals receive deterministic, non-mutating placeholder values.
 */
export function listPmRequiredArgumentRefusalContracts(
  contracts: readonly PmCommandPositionalContract[] = PM_COMMAND_POSITIONAL_CONTRACTS.filter(
    (contract) =>
      PM_COMMAND_DESTINATION_CONTRACTS.some(
        (destination) =>
          destination.command === contract.command &&
          destination.disposition !== "package_owned",
      ),
  ),
): PmRequiredArgumentRefusalContract[] {
  return contracts
    .flatMap((contract) =>
      contract.slots.flatMap((slot, index) => {
        if (!slot.required) return [];
        const commandArguments = contract.command.split(" ");
        const requiredFlagArguments = resolveSubcommandFlagContractsForCommand(
          contract.command,
        ).flatMap((flagContract) =>
          flagContract.required
            ? [
                flagContract.flag,
                ...(flagContract.value_name ? ["example"] : []),
              ]
            : [],
        );
        const isVirtualAction = PM_POSITIONAL_ACTION_CONTRACTS.some(
          (actionContract) => actionContract.command === contract.command,
        );
        return [
          {
            probe_id: `required-argument-${probeSlug(contract.command)}-${probeSlug(slot.name)}`,
            command: contract.command,
            refusal_args: [
              ...commandArguments,
              ...contract.slots
                .slice(0, index)
                .map((priorSlot) =>
                  positionalPlaceholder(contract.command, priorSlot),
                ),
              ...requiredFlagArguments,
            ],
            recovery_args: [...commandArguments, "--help"],
            error_code:
              isVirtualAction && !contract.command.startsWith("assurance ")
                ? ("invalid_argument_value" as const)
                : /^extension (?:activate|adopt|deactivate|uninstall)$/u.test(
                      contract.command,
                    )
                  ? ("missing_lifecycle_target" as const)
                  : ("missing_required_argument" as const),
            missing_argument: slot.name,
            missing_argument_index: index,
          },
        ];
      }),
    )
    .sort((left, right) => left.probe_id.localeCompare(right.probe_id));
}

function positionalActionValues(command: string): readonly string[] {
  switch (command) {
    case "assurance":
    case "workspace snapshot":
      return PM_POSITIONAL_ACTION_CONTRACTS.filter(
        ({ parent }) => parent === command,
      ).map(({ action }) => action);
    case "graph":
      return GRAPH_SUBCOMMAND_VALUES;
    case "merge":
      return MERGE_SUBCOMMAND_VALUES;
    case "plan":
      return PLAN_SUBCOMMANDS;
    case "profile":
      return PROFILE_SUBCOMMANDS;
    case "schema":
      return SCHEMA_SUBCOMMANDS;
    default:
      throw new Error(
        `Required positional action family ${command} has no authoritative value domain.`,
      );
  }
}

/** Return one invalid-action probe for every required positional action family. */
export function listPmSubcommandRefusalContracts(
  contracts: readonly PmCommandPositionalContract[] = PM_COMMAND_POSITIONAL_CONTRACTS,
): PmSubcommandRefusalContract[] {
  return contracts
    .filter(
      ({ slots }) =>
        slots[0]?.required === true && slots[0].value_kind === "action",
    )
    .map(({ command }) => {
      const commandArguments = command.split(" ");
      return {
        probe_id: `unknown-subcommand-${probeSlug(command)}`,
        command,
        refusal_args: [...commandArguments, REJECTED_ACTION],
        recovery_args: [...commandArguments, "--help"],
        error_code: "unknown_subcommand" as const,
        rejected_value: REJECTED_ACTION,
        allowed_values: [...positionalActionValues(command)].sort(),
      };
    })
    .sort((left, right) => left.probe_id.localeCompare(right.probe_id));
}

function sameValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const sortedRight = [...right].sort();
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === sortedRight[index])
  );
}

function scoreGrammarRefusalObservation(
  contract: PmRequiredArgumentRefusalContract | PmSubcommandRefusalContract,
  observation: PmGrammarRefusalObservation | undefined,
): PmGrammarRefusalFinding[] {
  if (!observation) {
    return [
      {
        code: "refusal_probe_missing",
        probe_id: contract.probe_id,
        detail: `${contract.probe_id} has no runtime observation.`,
      },
    ];
  }
  const findings: PmGrammarRefusalFinding[] = [];
  if (observation.error_code !== contract.error_code) {
    findings.push({
      code: "refusal_error_code_mismatch",
      probe_id: contract.probe_id,
      detail: `${contract.probe_id} emitted ${observation.error_code || "<none>"}; expected ${contract.error_code}.`,
    });
  }
  if (observation.exit_code !== 2) {
    findings.push({
      code: "refusal_exit_code_mismatch",
      probe_id: contract.probe_id,
      detail: `${contract.probe_id} exited ${observation.exit_code}; expected usage exit 2.`,
    });
  }
  if (
    "allowed_values" in contract &&
    !sameValues(observation.allowed_values, contract.allowed_values)
  ) {
    findings.push({
      code: "refusal_allowed_values_mismatch",
      probe_id: contract.probe_id,
      detail: `${contract.probe_id} did not expose its complete action domain.`,
    });
  }
  if (!observation.recovery_succeeded) {
    findings.push({
      code: "refusal_recovery_failed",
      probe_id: contract.probe_id,
      detail: `${contract.probe_id} help recovery did not succeed.`,
    });
  }
  if (observation.refusal_mutated_state) {
    findings.push({
      code: "refusal_mutated_state",
      probe_id: contract.probe_id,
      detail: `${contract.probe_id} changed tracker state while refusing input${observation.mutated_paths?.length ? `: ${observation.mutated_paths.join(", ")}` : "."}`,
    });
  }
  return findings;
}

/** Score exact code, exit, domain, state-safety, and recovery closure. */
export function scorePmGrammarRefusalClosure(
  contracts: readonly (
    | PmRequiredArgumentRefusalContract
    | PmSubcommandRefusalContract
  )[],
  observations: readonly PmGrammarRefusalObservation[],
): PmGrammarRefusalClosureReport {
  const contractsById = new Map(
    contracts.map((contract) => [contract.probe_id, contract]),
  );
  const observationsById = new Map(
    observations.map((observation) => [observation.probe_id, observation]),
  );
  const findings = [
    ...contracts.flatMap((contract) =>
      scoreGrammarRefusalObservation(
        contract,
        observationsById.get(contract.probe_id),
      ),
    ),
    ...observations
      .filter((observation) => !contractsById.has(observation.probe_id))
      .map(
        (observation): PmGrammarRefusalFinding => ({
          code: "unexpected_refusal_probe",
          probe_id: observation.probe_id,
          detail: `${observation.probe_id} has no declared grammar refusal contract.`,
        }),
      ),
  ];
  findings.sort(
    (left, right) =>
      left.probe_id.localeCompare(right.probe_id) ||
      left.code.localeCompare(right.code),
  );
  const failedProbeIds = new Set(
    findings.map(({ probe_id: probeId }) => probeId),
  );
  return {
    ok: findings.length === 0,
    probe_count: contracts.length,
    closed_probe_count: contracts.filter(
      ({ probe_id: probeId }) => !failedProbeIds.has(probeId),
    ).length,
    findings,
  };
}
