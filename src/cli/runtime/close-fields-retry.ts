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
import { resolveSubcommandFlagContractsForCommand } from "../../sdk/cli-contracts/flag-contracts.js";
import { renderPmCommand } from "../argv-utils.js";

const CLOSE_FIELDS_REFUSAL_CODE = "close_validation_missing_fields";

/**
 * The parser's own view of one option: its spellings and whether it takes a
 * required (`<value>`) or optional (`[value]`) argument. Commander `Option`
 * objects satisfy it directly.
 */
export interface ParsedOptionArity {
  /** Long spelling, such as `--message`. */
  long?: string;
  /** Short spelling, such as `-m`. */
  short?: string;
  /** Whether the option always consumes the next token as its value. */
  required: boolean;
  /** Whether the option consumes the next token only when it is not option-shaped. */
  optional: boolean;
}

/** Token span of one parsed option, or the boundary that ends option parsing. */
type ScannedToken =
  | { kind: "option"; spelling: string; width: number }
  | { kind: "operand" }
  | { kind: "terminator" };

/** Consume an option's next token the way Commander does for its arity. */
function valueWidth(option: ParsedOptionArity, next: string | undefined): number {
  if (option.required) return next === undefined ? 1 : 2;
  // Commander treats a following token as an option, not a value, when it is "-x"-shaped.
  return option.optional && next !== undefined && !(next.length > 1 && next.startsWith("-")) ? 2 : 1;
}

/**
 * Classify a short-option cluster: `-mtext` attaches a value to a short option
 * that takes one; `-ab` combines boolean flags. Returns undefined for any
 * short spelling the parser does not declare.
 */
function scanShortCluster(token: string, next: string | undefined, shorts: ReadonlyMap<string, ParsedOptionArity>): ScannedToken | undefined {
  const letters = token.slice(1);
  for (let index = 0; index < letters.length; index += 1) {
    const option = shorts.get(`-${letters[index]}`);
    if (option === undefined) return undefined;
    if (!option.required && !option.optional) continue;
    const attached = index < letters.length - 1;
    return { kind: "option", spelling: option.long ?? `-${letters[index]}`, width: attached ? 1 : valueWidth(option, next) };
  }
  return { kind: "option", spelling: token, width: 1 };
}

/** Classify one argv token, consuming option values exactly as the parser would. */
function scanToken(token: string, next: string | undefined, longs: ReadonlyMap<string, ParsedOptionArity>, shorts: ReadonlyMap<string, ParsedOptionArity>): ScannedToken | undefined {
  if (token === "--") return { kind: "terminator" };
  if (!token.startsWith("-") || token === "-") return { kind: "operand" };
  if (token.startsWith("--")) {
    const spelling = token.split("=", 1)[0]!;
    if (token.includes("=")) return { kind: "option", spelling, width: 1 };
    const option = longs.get(spelling);
    return option === undefined ? undefined : { kind: "option", spelling, width: valueWidth(option, next) };
  }
  return scanShortCluster(token, next, shorts);
}

/**
 * Drop every occurrence of the removed spellings before the first real `--`
 * terminator, returning the kept options and the terminator's index. A `--`
 * consumed as an option's value is not a terminator. Returns undefined when a
 * token's arity is unknown, since the scan could then misread an operand.
 */
function withoutOptions(argv: readonly string[], options: readonly ParsedOptionArity[], removed: ReadonlySet<string>): { kept: string[]; terminator: number } | undefined {
  const longs = new Map(options.flatMap((option) => (option.long === undefined ? [] : [[option.long, option] as const])));
  const shorts = new Map(options.flatMap((option) => (option.short === undefined ? [] : [[option.short, option] as const])));
  const kept: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const scanned = scanToken(argv[index]!, argv[index + 1], longs, shorts);
    if (scanned === undefined) return undefined;
    if (scanned.kind === "terminator") return { kept, terminator: index };
    const width = scanned.kind === "option" ? scanned.width : 1;
    if (scanned.kind === "operand" || !removed.has(scanned.spelling)) kept.push(...argv.slice(index, index + width));
    index += width - 1;
  }
  return { kept, terminator: argv.length };
}

/**
 * Rewrite a missing-close-fields refusal's retry as the caller's invocation
 * plus each missing flag, inserted before any `--` terminator. A supplied but
 * blank value for a missing field (under any alias) is replaced rather than
 * repeated. `options` is the parser's option table for the invoked command,
 * global options included. When the command cannot accept every missing field
 * itself, or a token's arity cannot be proven, the retry is withdrawn rather
 * than replaced by one that would drop the caller's own tokens (such as an
 * `--expect-hash` guard); `missing` and the secondary route stay.
 */
export function repairCloseFieldsRecovery(
  argv: readonly string[],
  code: string | undefined,
  recovery: PmCliErrorRecoveryPayload | undefined,
  options: readonly ParsedOptionArity[] | undefined,
): PmCliErrorRecoveryPayload | undefined {
  const missing = recovery?.missing;
  if (code !== CLOSE_FIELDS_REFUSAL_CODE || missing === undefined || missing.length === 0) return recovery;
  const withdrawn = { ...recovery, suggested_retry: undefined, suggested_retry_args: undefined };
  const contracts = resolveSubcommandFlagContractsForCommand(parseBootstrapCommandName([...argv]));
  const spellings = missing.map((flag) => contracts.find((entry) => entry.flag === flag || entry.aliases?.includes(flag) === true));
  if (options === undefined || spellings.some((contract) => contract === undefined)) return withdrawn;
  const removed = new Set(spellings.flatMap((contract) => [contract!.flag, ...(contract!.aliases ?? [])]));
  const scanned = withoutOptions(argv, options, removed);
  if (scanned === undefined) return withdrawn;
  const retry = [...scanned.kept, ...missing.flatMap((flag) => [flag, "<value>"]), ...argv.slice(scanned.terminator)];
  return { ...recovery, suggested_retry: renderPmCommand(retry), suggested_retry_args: retry };
}
