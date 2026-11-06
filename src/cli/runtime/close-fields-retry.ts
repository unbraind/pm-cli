/**
 * @module cli/runtime/close-fields-retry
 *
 * Turns a strict close refused for missing close evidence into the caller's
 * own invocation with the missing flags added (pm-gh1676). The refused
 * command declares those flags itself, so the retry closes the item in one
 * write instead of a separate update followed by the close. Every token the
 * caller typed stays where it was, including tracker scope, output controls
 * and `--expect-hash`; nothing is re-parsed or removed, so the retry cannot
 * disagree with the parser about which token belongs to which option.
 */
import type { PmCliErrorRecoveryPayload } from "../../sdk/runtime-primitives.js";
import { findBootstrapCommandTokenIndex } from "../../sdk/cli-bootstrap.js";
import { resolveSubcommandFlagContractsForCommand } from "../../sdk/cli-contracts/flag-contracts.js";
import { renderPmCommand } from "../argv-utils.js";

/** Refusal whose retry this module owns: message-text inference must never rebuild one it withdrew. */
export const CLOSE_FIELDS_REFUSAL_CODE = "close_validation_missing_fields";

/**
 * Place the missing flags. Appended after every typed token, each one is a
 * complete option at a boundary of a successful parse, and Commander keeps the
 * last value of a repeated option, so it also overrides a blank value the
 * caller supplied for that field. A `--` after the command may end option
 * parsing, so the flags go directly after the command token instead, which is
 * only safe when the caller typed no spelling of a missing field (a blank one
 * typed later would win). Returns undefined when neither placement is safe.
 */
function placeMissingFlags(argv: readonly string[], commandIndex: number, spellings: ReadonlySet<string>, pairs: readonly string[]): string[] | undefined {
  const commandTokens = argv.slice(commandIndex + 1);
  if (!commandTokens.includes("--")) return [...argv, ...pairs];
  if (commandTokens.some((token) => spellings.has(token.split("=", 1)[0]!))) return undefined;
  return [...argv.slice(0, commandIndex + 1), ...pairs, ...commandTokens];
}

/**
 * The producer's revision guards: the run of `--expect-hash=<id>=<hash>` tokens
 * it places directly before the trailing `<flag> <value>` placeholders, after
 * its tracker scope and close options. Reading only that run never mistakes a
 * scope operand (a tracker named `--expect-hash=x`) for a guard.
 */
function producerRevisionGuards(producerRetry: readonly string[], missingCount: number): string[] {
  const beforePlaceholders = producerRetry.slice(0, producerRetry.length - 2 * missingCount);
  let start = beforePlaceholders.length;
  while (start > 0 && beforePlaceholders[start - 1]!.startsWith("--expect-hash=")) start -= 1;
  return beforePlaceholders.slice(start);
}

/**
 * Rewrite a missing-close-fields refusal's retry as the caller's invocation
 * plus each missing flag. `scopePrefix` is the tracker selection the parsed
 * invocation did not spell itself (an environment-selected tracker), prepended
 * so the retry closes the same item wherever it runs; null means that selection
 * cannot be made binding (a typed empty tracker option would override it, since
 * the parser keeps the last value), so no retry is proposed. When the invoked command
 * cannot accept every missing field itself, or the flags cannot be placed
 * safely, the retry is withdrawn rather than replaced by one that would drop
 * the caller's own tokens (such as an `--expect-hash` guard); `missing` and the
 * secondary route stay.
 */
export function repairCloseFieldsRecovery(
  argv: readonly string[],
  code: string | undefined,
  recovery: PmCliErrorRecoveryPayload | undefined,
  scopePrefix: readonly string[] | null = [],
): PmCliErrorRecoveryPayload | undefined {
  const missing = recovery?.missing;
  if (code !== CLOSE_FIELDS_REFUSAL_CODE || missing === undefined || missing.length === 0) return recovery;
  // A producer that withdrew its own retry (an SDK-only lifecycle override, or nested revision guards
  // that expect different revisions of one item) knows no CLI command reproduces the close.
  const producerRetry = recovery!.suggested_retry_args;
  if (producerRetry === undefined) return recovery;
  const withdrawn = { ...recovery, suggested_retry: undefined, suggested_retry_args: undefined };
  const commandIndex = findBootstrapCommandTokenIndex([...argv]);
  if (commandIndex === undefined || scopePrefix === null) return withdrawn;
  const contracts = resolveSubcommandFlagContractsForCommand(argv[commandIndex]!.trim().toLowerCase());
  const declared = missing.map((flag) => contracts.find((entry) => entry.flag === flag || entry.aliases?.includes(flag) === true));
  if (declared.some((contract) => contract === undefined)) return withdrawn;
  const spellings = new Set(declared.flatMap((contract) => [contract!.flag, ...(contract!.aliases ?? [])]));
  // Carry every revision guard the producer saw: those from an enclosing SDK scope (an embedded CLI run)
  // never reached argv. A guard the caller also typed repeats with the same revision, which the binder
  // accepts, so no argv token is matched against a hash (a message that equals one is not a guard).
  const guards = producerRevisionGuards(producerRetry, missing.length);
  const placed = placeMissingFlags(argv, commandIndex, spellings, [...missing.flatMap((flag) => [flag, "<value>"]), ...guards]);
  if (placed === undefined) return withdrawn;
  const retry = [...scopePrefix, ...placed];
  return { ...recovery, suggested_retry: renderPmCommand(retry), suggested_retry_args: retry };
}
