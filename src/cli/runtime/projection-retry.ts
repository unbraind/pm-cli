/**
 * @module cli/runtime/projection-retry
 *
 * Repairs read projections as minimal edits to the original invocation, keeping
 * tracker scope, operands, output encoding and unrelated controls intact.
 */
import type { PmCliErrorRecoveryPayload } from "../../sdk/runtime-primitives.js";
import { parseBootstrapCommandName } from "../../sdk/cli-bootstrap.js";
import { LIST_COMMANDER_STRING_OPTION_CONTRACTS, SEARCH_COMMANDER_STRING_OPTION_CONTRACTS, CONTEXT_COMMANDER_STRING_OPTION_CONTRACTS } from "../../sdk/cli-contracts/commander-types.js";
import { GLOBAL_FLAG_CONTRACTS, resolveSubcommandFlagContractsForCommand, type CliFlagContract } from "../../sdk/cli-contracts/flag-contracts.js";
import { renderPmCommand } from "../argv-utils.js";

const VALUE_PROJECTION_FLAGS = new Set(["--fields", "--output-include", "--depth", "--for", "--token-budget"]);
const BOOLEAN_PROJECTION_FLAGS = new Set(["--full", "--brief", "--compact"]);

/** Derive value arity from the runtime contracts and Commander string options. */
function consumesFlagValue(contract: CliFlagContract, valueFlags: ReadonlySet<string>): boolean {
  // Tracker paths consume even flag-looking values; their host reservation
  // contract deliberately omits a value label.
  return Boolean(contract.flag === "--pm-path" || contract.value_name || contract.list || contract.value_type === "number" || contract.value_type === "string" || valueFlags.has(contract.flag));
}

/** One option token an argv scan located: its canonical flag and whether it consumed the following token. */
export interface ScannedOptionToken {
  /** Canonical spelling of the flag the token selects. */
  flag: string;
  /** Whether the flag consumed the next token as its value (never for an inline `--flag=value`). */
  consumesValue: boolean;
}

/**
 * Scan actual option tokens, consuming their values even when a value
 * resembles a flag. Returns each option token's index, canonical flag and
 * value arity, or undefined when an unknown flag leaves the value arity
 * ambiguous. A caller that resolved a namespaced command path
 * (`item comments`) passes it, so the leaf command's flags are known.
 */
export function scanOptionTokens(argv: readonly string[], commandName = parseBootstrapCommandName([...argv])): Map<number, ScannedOptionToken> | undefined {
  const contracts = resolveSubcommandFlagContractsForCommand(commandName);
  const valueFlags = new Set([...LIST_COMMANDER_STRING_OPTION_CONTRACTS, ...SEARCH_COMMANDER_STRING_OPTION_CONTRACTS, ...CONTEXT_COMMANDER_STRING_OPTION_CONTRACTS].flatMap((contract) => contract.keys.map((key) => `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`)));
  const canonical = new Map([...GLOBAL_FLAG_CONTRACTS, ...contracts].flatMap((contract) => [contract.flag, ...(contract.aliases ?? [])].map((flag) => [flag, contract.flag] as const)));
  const known = new Map([...GLOBAL_FLAG_CONTRACTS, ...contracts].flatMap((contract) => [contract.flag, ...(contract.aliases ?? [])].map((flag) => [flag, consumesFlagValue(contract, valueFlags)] as const)));
  for (const flag of VALUE_PROJECTION_FLAGS) known.set(flag, true);
  for (const flag of BOOLEAN_PROJECTION_FLAGS) known.set(flag, false);
  const options = new Map<number, ScannedOptionToken>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") break;
    if (!token.startsWith("-")) continue;
    const flag = token.split("=")[0]!;
    if (!known.has(flag) && !token.includes("=")) return undefined;
    const consumesValue = known.get(flag) === true && !token.includes("=");
    options.set(index, { flag: canonical.get(flag) ?? flag, consumesValue });
    if (consumesValue) index += 1;
  }
  return options;
}

/** Scan actual option tokens and keep each one's canonical flag. */
function projectionOptionIndices(argv: readonly string[]): Map<number, string> | undefined {
  const scanned = scanOptionTokens(argv);
  return scanned === undefined ? undefined : new Map([...scanned].map(([index, { flag }]) => [index, flag]));
}

/** Remove selected projection options and their consumed values without touching operands. */
function withoutProjectionFlags(argv: readonly string[], options: Map<number, string>, flags: ReadonlySet<string>): string[] {
  const removed = new Set<number>();
  for (const [index, flag] of options) {
    if (!flags.has(flag)) continue;
    removed.add(index);
    if (VALUE_PROJECTION_FLAGS.has(flag) && !argv[index]!.includes("=")) removed.add(index + 1);
  }
  return argv.filter((_, index) => !removed.has(index));
}

/** Keep a single caller-selected mode while using the SDK hint for genuinely conflicting modes. */
function selectProjectionRetryMode(options: Map<number, string>, suggested: readonly string[]): string | undefined {
  const fallback = suggested.find((token) => BOOLEAN_PROJECTION_FLAGS.has(token));
  if (fallback === undefined) return undefined;
  const selected = [...new Set(options.values())].filter((flag) => BOOLEAN_PROJECTION_FLAGS.has(flag));
  return selected.length === 1 ? selected[0] : fallback;
}

/** Preserve the original read invocation when correcting known projection refusals. */
export function repairProjectionRecovery(
  argv: readonly string[],
  code: string | undefined,
  recovery: PmCliErrorRecoveryPayload | undefined,
): PmCliErrorRecoveryPayload | undefined {
  if (!recovery || !["unknown_field_projection", "projection_options_mutually_exclusive"].includes(code ?? "")) return recovery;
  const suggested = recovery.suggested_retry_args;
  const ambiguous = { ...recovery, suggested_retry: undefined, suggested_retry_args: undefined };
  if (!suggested) return ambiguous;
  const options = projectionOptionIndices(argv);
  if (!options) return ambiguous;
  let corrected: string[];
  if (code === "unknown_field_projection") {
    const fieldIndex = suggested.indexOf("--fields");
    if (fieldIndex < 0 || suggested[fieldIndex + 1] === undefined) return ambiguous;
    const position = [...options].find(([_, flag]) => flag === "--fields")?.[0] ?? -1;
    if (position < 0) return ambiguous;
    corrected = withoutProjectionFlags(argv, options, new Set(["--fields"]));
    corrected.splice(position, 0, "--fields", suggested[fieldIndex + 1]!);
  } else {
    const mode = selectProjectionRetryMode(options, suggested);
    if (mode === undefined) return ambiguous;
    // A global selector can precede the command, but its replacement mode is
    // command-local. Keep that mode at its original valid option position.
    if (![...options.values()].includes(mode)) return ambiguous;
    const flags = new Set([...VALUE_PROJECTION_FLAGS, ...BOOLEAN_PROJECTION_FLAGS].filter((flag) => flag !== mode));
    corrected = withoutProjectionFlags(argv, options, flags);
  }
  return { ...recovery, suggested_retry: renderPmCommand(corrected), suggested_retry_args: corrected };
}
