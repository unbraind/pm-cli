/**
 * @module cli/linked-resource-value-list
 *
 * Recovery for several values written after one repeatable linked-resource
 * flag, such as `pm files <id> --add a.ts b.ts c.ts` (GH-1791, pm-gh1791).
 * Commander reads the values after the first as extra positional operands and
 * refuses the command, so nothing is linked. The fix is one flag occurrence
 * per value; a variadic flag would instead swallow an item id written after
 * it (`pm files --add a.ts <id>` is valid).
 *
 * Every token is classified with Commander's own reading: an option consumes
 * the next token when its value is required, or when it is optional and the
 * next token is not option-like, and a repeatable option is one whose value
 * processor is the shared `collect`. Global options are read with the
 * bootstrap's own rule, which strips them before Commander. A token this
 * module cannot classify leaves the refusal to the other guidance builders
 * instead of guessing.
 */
import type { Command, Option } from "commander";
import { findPmNamespacedCommand } from "../sdk/cli-contracts/command-aliases.js";
import {
  looksLikeStructuredPathEntry,
  parseAddEntries,
  parseAddGlobEntries,
  parseMigrateEntries,
  parseRemoveEntries,
} from "../sdk/linked-artifacts.js";
import { admitsLinkedTestFlagValue } from "../sdk/test/execution.js";
import { findBootstrapCommandTokenIndex, globalBootstrapTokenSpan } from "./bootstrap-args.js";
import { collect } from "./registration-helpers.js";

/** How Commander reads one option spelling. */
export interface OptionArity {
  /** The option's long spelling (its short one when it has none), under which its value parser is known. */
  name: string;
  /** Whether a value is required (`<v>`) or optional (`[v]`), or the option is a switch. */
  value: "required" | "optional" | "none";
  /** Whether every occurrence appends one value (the shared `collect` processor). */
  repeatable: boolean;
}

/** Option arity keyed by every long and short spelling the command accepts. */
export type OptionArityTable = Readonly<Record<string, OptionArity>>;

/** Linked-resource commands whose collection flags take one value per occurrence. */
export const LINKED_RESOURCE_VALUE_LIST_COMMANDS: ReadonlySet<string> = new Set(["files", "docs", "test"]);

/** How Commander reads one declared option. */
function optionArity(option: Option): OptionArity {
  return {
    name: (option.long ?? option.short)!,
    value: option.required ? "required" : option.optional ? "optional" : "none",
    repeatable: option.parseArg === collect,
  };
}

/** The options a command and its ancestors declare, nearest declaration first. */
function declaredOptions(command: Command): Option[] {
  const options: Option[] = [];
  for (let cursor: Command | null = command; cursor; cursor = cursor.parent) options.push(...cursor.options);
  return options;
}

/** The value arity of every option a command and its ancestors declare, nearest declaration first. */
export function readCommandOptionArity(command: Command): Record<string, OptionArity> {
  const table: Record<string, OptionArity> = {};
  for (const option of declaredOptions(command)) {
    const arity = optionArity(option);
    for (const spelling of [option.long, option.short]) {
      if (spelling && !Object.hasOwn(table, spelling)) table[spelling] = arity;
    }
  }
  return table;
}

/**
 * The Commander command an invocation runs. Collection commands are registered
 * under their namespace (`item files`), so the canonical path is walked; an
 * invocation without a declared namespace is looked up by its command name.
 */
export function findInvokedCommand(root: Command, argv: readonly string[], commandName: string): Command | undefined {
  const canonical = findPmNamespacedCommand(argv.slice(findBootstrapCommandTokenIndex([...argv])))?.canonical_argv;
  let command: Command | undefined = root;
  for (const name of canonical ?? [commandName]) command = command?.commands.find((candidate) => candidate.name() === name);
  return command;
}

/** Commander's own test for a token that names an option rather than an operand. */
function isOptionLike(token: string): boolean {
  return token.length > 1 && token.startsWith("-");
}


/** How a list of values for one flag may be replayed. */
type ValueListReading = "exact" | "ambiguous" | "decline";

/** The native parser of each repeatable file or doc flag, for one value. */
const ARTIFACT_VALUE_PARSERS: Readonly<Record<string, (value: string, noun: "file" | "doc") => unknown>> = {
  "--add": (value, noun) => parseAddEntries([value], noun),
  "--add-glob": (value) => parseAddGlobEntries([value]),
  "--remove": (value) => parseRemoveEntries([value]),
  "--migrate": (value) => parseMigrateEntries([value]),
};

/** Whether the native parser admits one value. */
function parses(parse: (value: string, noun: "file" | "doc") => unknown, value: string, noun: "file" | "doc"): boolean {
  try {
    parse(value, noun);
    return true;
  } catch {
    return false;
  }
}

/**
 * Judge a value list with each flag's own parser. A linked-test list replays
 * only when its parser admits every value as a complete entry; anything else
 * is a command that needs quoting, which the linked-test guidance owns. A file
 * or doc list replays when every value parses and the values are all
 * structured entries (`path=`, `path:`, `pattern=`, `from=`) or all bare
 * paths. A structured entry followed by bare words may be one value the shell
 * split (`path:a.ts,note:fix the bug`), so it gets no executable retry.
 */
function readValueList(command: string, flag: string, values: readonly string[]): ValueListReading {
  if (command === "test") return values.every((value) => admitsLinkedTestFlagValue(flag, value)) ? "exact" : "decline";
  const parse = ARTIFACT_VALUE_PARSERS[flag];
  const noun = command === "files" ? "file" : "doc";
  const structured = values.map((value) => looksLikeStructuredPathEntry(value.trim()));
  const uniform = structured.every(Boolean) || !structured.some(Boolean);
  return parse !== undefined && uniform && values.every((value) => parses(parse, value, noun)) ? "exact" : "ambiguous";
}

/** One repeatable flag that received several values, and the replay that gives each its own occurrence. */
export interface LinkedResourceValueListRecovery {
  /** Item operand, kept in place in the retry. */
  itemId: string;
  /** Repeatable flags that were followed by more than one value, in argv order. */
  flags: string[];
  /** The values written after each flag's own value. */
  extraValues: string[];
  /** Exact retry with one flag occurrence per value; absent when a value may be one argument split by the shell. */
  retryArgs?: string[];
}

/** Read the option at `index`, returning the index of its last consumed token and its value, or undefined when it is unknown. */
function readOptionToken(
  argv: readonly string[],
  index: number,
  table: OptionArityTable,
): { end: number; spelling: string; arity: OptionArity; value?: string } | undefined {
  const token = argv[index]!;
  const equals = token.startsWith("--") ? token.indexOf("=") : -1;
  const spelling = equals >= 0 ? token.slice(0, equals) : token;
  const arity = Object.hasOwn(table, spelling) ? table[spelling] : undefined;
  if (!arity) return undefined;
  if (equals >= 0) return arity.value === "none" ? undefined : { end: index, spelling, arity, value: token.slice(equals + 1) };
  if (arity.value === "none") return { end: index, spelling, arity };
  const next = argv[index + 1];
  if (arity.value === "required") return next === undefined ? undefined : { end: index + 1, spelling, arity, value: next };
  return next !== undefined && !isOptionLike(next) ? { end: index + 1, spelling, arity, value: next } : { end: index, spelling, arity };
}

/**
 * The tokens Commander parses, with their positions in argv: global options
 * are stripped first by the bootstrap's own rule, wherever they are written.
 * Undefined when argv holds an end-of-options marker, whose operands this
 * recovery does not judge.
 */
function commanderTokens(argv: readonly string[]): { tokens: string[]; positions: number[] } | undefined {
  const positions: number[] = [];
  for (let index = 0; index < argv.length; ) {
    if (argv[index] === "--") return undefined;
    const span = globalBootstrapTokenSpan(argv, index);
    if (span === 0) positions.push(index);
    index += Math.max(span, 1);
  }
  return { tokens: positions.map((index) => argv[index]!), positions };
}

/** Where the item operand stands: the first operand after the command, or undefined. */
function itemOperandIndex(command: string, tokens: readonly string[]): number | undefined {
  const start = findBootstrapCommandTokenIndex([...tokens]);
  if (start === undefined) return undefined;
  const namespaced = findPmNamespacedCommand(tokens.slice(start));
  if ((namespaced?.alias ?? tokens[start]) !== command) return undefined;
  const index = start + (namespaced?.canonical_argv.length ?? 1);
  const itemId = tokens[index];
  return itemId === undefined || isOptionLike(itemId) || itemId === "-" ? undefined : index;
}

/** The positions of the operands that directly follow `index`, up to the next option-like token. */
function followingOperands(tokens: readonly string[], index: number): number[] {
  const following: number[] = [];
  for (let at = index + 1; at < tokens.length && !isOptionLike(tokens[at]!) && tokens[at] !== "-"; at += 1) following.push(at);
  return following;
}

/** Every value written after a repeatable flag's own value, with the flag it belongs to. */
interface ValueListScan {
  extras: Array<{ at: number; flag: string }>;
  exact: boolean;
}

/**
 * Walk the options after the item operand. Every token must be an option the
 * command declares, or an operand that directly follows a repeatable flag's
 * value; undefined otherwise, or when a value list is not this recovery's.
 */
function scanValueLists(command: string, tokens: readonly string[], idIndex: number, table: OptionArityTable): ValueListScan | undefined {
  const scan: ValueListScan = { extras: [], exact: true };
  for (let index = idIndex + 1; index < tokens.length; index += 1) {
    const option = isOptionLike(tokens[index]!) ? readOptionToken(tokens, index, table) : undefined;
    if (!option) return undefined;
    index = option.end;
    const following = option.arity.repeatable && option.value !== undefined ? followingOperands(tokens, index) : [];
    if (following.length === 0) continue;
    const reading = readValueList(command, option.arity.name, [option.value!, ...following.map((at) => tokens[at]!)]);
    if (reading === "decline") return undefined;
    scan.exact &&= reading === "exact";
    scan.extras.push(...following.map((at) => ({ at, flag: option.spelling })));
    index = following.at(-1)!;
  }
  return scan;
}

/**
 * Resolve `pm <files|docs|test> <id> --flag a b c` into one occurrence per
 * value. The tokens are judged as Commander parses them, and every insertion
 * is mapped back to the token's place in argv. Every extra operand must
 * directly follow a repeatable flag's value, the item id must be the first
 * operand after the command, and every option must be one the command
 * declares.
 */
export function resolveLinkedResourceValueListRecovery(
  command: string | undefined,
  argv: readonly string[],
  table: OptionArityTable,
): LinkedResourceValueListRecovery | undefined {
  if (command === undefined || !LINKED_RESOURCE_VALUE_LIST_COMMANDS.has(command)) return undefined;
  const parsed = commanderTokens(argv);
  const idIndex = parsed === undefined ? undefined : itemOperandIndex(command, parsed.tokens);
  const scan = idIndex === undefined ? undefined : scanValueLists(command, parsed!.tokens, idIndex, table);
  if (scan === undefined || scan.extras.length === 0) return undefined;
  const insertions = new Map(scan.extras.map(({ at, flag }) => [parsed!.positions[at]!, flag]));
  const retryArgs = argv.flatMap((token, index) => (insertions.has(index) ? [insertions.get(index)!, token] : [token]));
  return {
    itemId: parsed!.tokens[idIndex!]!,
    flags: [...new Set(scan.extras.map(({ flag }) => flag))],
    extraValues: scan.extras.map(({ at }) => parsed!.tokens[at]!),
    ...(scan.exact ? { retryArgs } : {}),
  };
}

/**
 * The value-list recovery for a refused invocation, judged with the invoked
 * command's own Commander declaration; undefined for any other command.
 * Commander usage resolution imports this module only for a "too many
 * arguments" refusal, so the parsers it reads stay off the CLI's start path.
 */
export function resolveUsageValueListRecovery(
  commandName: string | undefined,
  rootProgram: Command,
  invocationArgv: readonly string[],
): LinkedResourceValueListRecovery | undefined {
  if (commandName === undefined || !LINKED_RESOURCE_VALUE_LIST_COMMANDS.has(commandName)) return undefined;
  const command = findInvokedCommand(rootProgram, invocationArgv, commandName);
  return command ? resolveLinkedResourceValueListRecovery(commandName, invocationArgv, readCommandOptionArity(command)) : undefined;
}
