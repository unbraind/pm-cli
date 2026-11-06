/**
 * @module cli/runtime/close-fields-retry
 *
 * Turns a strict close refused for missing close evidence into the caller's
 * own invocation with the missing flags added (pm-gh1676). The refused
 * command declares those flags itself, so the retry closes the item in one
 * write instead of a separate update followed by the close. Every other
 * token, including tracker scope, output controls and `--expect-hash`, stays
 * where it was.
 */
import type { PmCliErrorRecoveryPayload } from "../../sdk/runtime-primitives.js";
import { parseBootstrapCommandName } from "../../sdk/cli-bootstrap.js";
import { GLOBAL_FLAG_CONTRACTS, resolveSubcommandFlagContractsForCommand, type CliFlagContract } from "../../sdk/cli-contracts/flag-contracts.js";
import { renderPmCommand } from "../argv-utils.js";

const CLOSE_FIELDS_REFUSAL_CODE = "close_validation_missing_fields";

/** Whether an option consumes the next token; tracker paths consume even flag-looking values. */
function consumesValue(contract: CliFlagContract): boolean {
  return contract.flag === "--pm-path" || contract.value_name !== undefined || contract.list === true || contract.value_type === "number" || contract.value_type === "string";
}

/** Every spelling the command accepts, mapped to its canonical flag and value arity. */
function optionSpellings(contracts: readonly CliFlagContract[]): Map<string, { flag: string; takesValue: boolean }> {
  return new Map(contracts.flatMap((contract) =>
    [contract.flag, ...(contract.aliases ?? [])].map((spelling) => [spelling, { flag: contract.flag, takesValue: consumesValue(contract) }] as const)));
}

/**
 * Drop every occurrence (`--flag value` or `--flag=value`, under any alias) of
 * the given canonical flags, consuming each option's declared value so a value
 * that resembles a flag is never mistaken for one. Returns undefined when an
 * option's arity is unknown, since the scan could then misread an operand.
 */
function withoutOptions(argv: readonly string[], spellings: ReadonlyMap<string, { flag: string; takesValue: boolean }>, removed: ReadonlySet<string>): string[] | undefined {
  const kept: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("-") || token === "-") {
      kept.push(token);
      continue;
    }
    const option = spellings.get(token.split("=", 1)[0]!);
    if (option === undefined && !token.includes("=")) return undefined;
    const width = option?.takesValue === true && !token.includes("=") ? 2 : 1;
    if (option === undefined || !removed.has(option.flag)) kept.push(...argv.slice(index, index + width));
    index += width - 1;
  }
  return kept;
}

/**
 * Rewrite a missing-close-fields refusal's retry as the caller's invocation
 * plus each missing flag, inserted before any `--` terminator. A supplied but
 * blank value for a missing field (under any alias) is replaced rather than
 * repeated. When the invoked command cannot accept every missing field itself,
 * or an option's arity is unknown, the producer's recovery is kept unchanged.
 */
export function repairCloseFieldsRecovery(
  argv: readonly string[],
  code: string | undefined,
  recovery: PmCliErrorRecoveryPayload | undefined,
): PmCliErrorRecoveryPayload | undefined {
  const missing = recovery?.missing;
  const commandName = parseBootstrapCommandName([...argv]);
  if (code !== CLOSE_FIELDS_REFUSAL_CODE || missing === undefined || missing.length === 0 || commandName === undefined) {
    return recovery;
  }
  const spellings = optionSpellings([...GLOBAL_FLAG_CONTRACTS, ...resolveSubcommandFlagContractsForCommand(commandName)]);
  const canonical = missing.map((flag) => spellings.get(flag)?.flag);
  if (canonical.some((flag) => flag === undefined)) return recovery;
  const terminator = argv.indexOf("--");
  const options = withoutOptions(terminator === -1 ? argv : argv.slice(0, terminator), spellings, new Set(canonical as string[]));
  if (options === undefined) return recovery;
  const retry = [...options, ...missing.flatMap((flag) => [flag, "<value>"]), ...(terminator === -1 ? [] : argv.slice(terminator))];
  return { ...recovery, suggested_retry: renderPmCommand(retry), suggested_retry_args: retry };
}
