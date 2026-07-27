/**
 * @module sdk/cli-contracts/agent-output-contracts
 *
 * Declares the agent-facing output budget vocabulary shared by CLI, SDK,
 * packages, contract discovery, and regression gates. The contracts describe
 * output policy without coupling package authors to pm's renderer.
 */
import { PM_CORE_COMMAND_NAMES } from "./enum-contracts.js";

/** Stable degradation stages applied when an output exceeds its token budget. */
export const PM_OUTPUT_DEGRADATION_STEPS = [
  "full",
  "compact",
  "brief",
  "summary",
  "counts",
] as const;

/** Restricts deterministic output degradation stages. */
export type PmOutputDegradationStep =
  (typeof PM_OUTPUT_DEGRADATION_STEPS)[number];

/** Stable command-output classes used to assign conservative default budgets. */
export const PM_OUTPUT_BUDGET_CLASSES = [
  "mutation",
  "read",
  "discovery",
  "governance",
] as const;

/** Restricts command-output budget classes. */
export type PmOutputBudgetClass = (typeof PM_OUTPUT_BUDGET_CLASSES)[number];

/** Describes one command's default agent-output budget and degradation policy. */
export interface PmCommandOutputBudgetContract {
  /** Canonical or compatibility command name. */
  command: (typeof PM_CORE_COMMAND_NAMES)[number];
  /** Workload class that selected the default ceiling. */
  budget_class: PmOutputBudgetClass;
  /** Default estimated-token ceiling for representative output. */
  default_max_estimated_tokens: number;
  /** Ordered fallback projections, from richest to smallest. */
  degradation_ladder: readonly PmOutputDegradationStep[];
  /** Whether callers may explicitly request an unbounded result. */
  allows_unbounded_opt_out: boolean;
  /** Stable estimate used by gates and SDK consumers. */
  token_estimate: "ceil(utf8_bytes / 4)";
}

const MUTATION_COMMANDS = new Set<string>([
  "append",
  "claim",
  "close",
  "close-many",
  "close-task",
  "comments",
  "config",
  "copy",
  "create",
  "delete",
  "docs",
  "event",
  "files",
  "focus",
  "history-author-acknowledge",
  "history-compact",
  "history-redact",
  "history-repair",
  "init",
  "item",
  "learnings",
  "meet",
  "notes",
  "pause-task",
  "release",
  "remind",
  "restore",
  "schema",
  "start-task",
  "update",
  "update-many",
]);

const DISCOVERY_COMMANDS = new Set<string>([
  "contracts",
  "extension",
  "help",
  "install",
  "package",
  "packages",
  "profile",
  "upgrade",
]);

const GOVERNANCE_COMMANDS = new Set<string>([
  "gc",
  "health",
  "merge",
  "stats",
  "telemetry",
  "test",
  "test-all",
  "validate",
]);

const DEFAULT_MAX_ESTIMATED_TOKENS: Record<PmOutputBudgetClass, number> = {
  mutation: 2_000,
  read: 4_000,
  discovery: 3_000,
  governance: 6_000,
};

/**
 * Declares one budget contract while preserving literal command metadata for
 * package-authored registries and test fixtures. Rejects ceilings that cannot
 * represent a positive, deterministic token allowance.
 */
export function definePmCommandOutputBudget<
  TContract extends PmCommandOutputBudgetContract,
>(contract: TContract): TContract {
  if (
    !Number.isSafeInteger(contract.default_max_estimated_tokens) ||
    contract.default_max_estimated_tokens <= 0
  ) {
    throw new RangeError(
      "default_max_estimated_tokens must be a positive safe integer",
    );
  }
  return contract;
}

/** Public default budget contract for every built-in pm command. */
export const PM_COMMAND_OUTPUT_BUDGET_CONTRACTS =
  PM_CORE_COMMAND_NAMES.map((command) => {
    const budgetClass: PmOutputBudgetClass = MUTATION_COMMANDS.has(command)
      ? "mutation"
      : DISCOVERY_COMMANDS.has(command)
        ? "discovery"
        : GOVERNANCE_COMMANDS.has(command)
          ? "governance"
          : "read";
    return definePmCommandOutputBudget({
      command,
      budget_class: budgetClass,
      default_max_estimated_tokens:
        DEFAULT_MAX_ESTIMATED_TOKENS[budgetClass],
      degradation_ladder: PM_OUTPUT_DEGRADATION_STEPS,
      allows_unbounded_opt_out: true,
      token_estimate: "ceil(utf8_bytes / 4)",
    });
  });

const OUTPUT_BUDGET_BY_COMMAND = new Map(
  PM_COMMAND_OUTPUT_BUDGET_CONTRACTS.map(
    (contract) => [contract.command, contract] as const,
  ),
);

/** Resolve the declared output budget for one built-in command. */
export function resolvePmCommandOutputBudget(
  command: string,
): PmCommandOutputBudgetContract | null {
  const [rootCommand] = command.trim().split(/\s+/u);
  return OUTPUT_BUDGET_BY_COMMAND.get(
    rootCommand as (typeof PM_CORE_COMMAND_NAMES)[number],
  ) ?? null;
}

/** Estimate conservative token usage from UTF-8 output bytes. */
export function estimatePmOutputTokens(utf8Bytes: number): number {
  return Math.ceil(Math.max(0, utf8Bytes) / 4);
}
