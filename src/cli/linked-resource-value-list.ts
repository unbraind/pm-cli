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
 * processor is the shared `collect`. The table walks the command's ancestors
 * up to the program, which declares the global options, so it is the whole
 * parse. A token this module cannot classify leaves the refusal to the other
 * guidance builders instead of guessing.
 */
import type { Command, Option } from "commander";
import { findPmNamespacedCommand } from "../sdk/cli-contracts/command-aliases.js";
import {
  parseAddEntries,
  parseAddGlobEntries,
  parseMigrateEntries,
  parseRemoveEntries,
} from "../sdk/linked-artifacts.js";
import { admitsLinkedTestFlagValue } from "../sdk/test/execution.js";
import { findBootstrapCommandTokenIndex } from "./bootstrap-args.js";
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
 * A value no shell split can have produced or broken: no whitespace, and none
 * of the separators the entry grammars read (`,` between members, `=` and `:`
 * between a key and its value, as in `path:a,note:…` or a doc label before a
 * URL).
 */
const PLAIN_VALUE = /^[^\s,=:]+$/u;

/**
 * Judge a value list with each flag's own parser. A linked-test list replays
 * only when its parser admits every value as a complete entry; anything else
 * is a command that needs quoting, which the linked-test guidance owns. A file
 * or doc list replays only when every value is plain and the flag's parser
 * accepts it: a structured value (`path=`, `path:`, `pattern:`, a doc label
 * before a URL) may be one argument the shell split, so it gets the quoting
 * hint without an executable retry.
 */
function readValueList(command: string, flag: string, values: readonly string[]): ValueListReading {
  if (command === "test") return values.every((value) => admitsLinkedTestFlagValue(flag, value)) ? "exact" : "decline";
  const parse = ARTIFACT_VALUE_PARSERS[flag];
  const noun = command === "files" ? "file" : "doc";
  // A value that reads as an option (`--add --json a`) is Commander's reading, never the caller's intent.
  return parse !== undefined && values.every((value) => !isOptionLike(value) && PLAIN_VALUE.test(value) && parses(parse, value, noun)) ? "exact" : "ambiguous";
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
  const inline = token.slice(equals + 1);
  // An attached value that reads as an option (`--measure=--p95=3`) is declined like a separate one.
  if (equals >= 0) return arity.value === "none" || isOptionLike(inline) ? undefined : { end: index, spelling, arity, value: inline };
  if (arity.value === "none") return { end: index, spelling, arity };
  const next = argv[index + 1];
  // A required value that reads as an option is where Commander's ancestor-first parse can disagree with a flat
  // scan (`--message --json` gives `--json` to the program), so no span is claimed for it.
  if (arity.value === "required") return next === undefined || isOptionLike(next) ? undefined : { end: index + 1, spelling, arity, value: next };
  return next !== undefined && !isOptionLike(next) ? { end: index + 1, spelling, arity, value: next } : { end: index, spelling, arity };
}

/** Where the command's own tokens start: after the command path, or undefined when argv does not invoke `command`. */
function commandArgumentsStart(command: string, argv: readonly string[]): number | undefined {
  const start = findBootstrapCommandTokenIndex([...argv]);
  if (start === undefined) return undefined;
  const namespaced = findPmNamespacedCommand(argv.slice(start));
  return (namespaced?.alias ?? argv[start]) === command ? start + (namespaced?.canonical_argv.length ?? 1) : undefined;
}

/** The positions of the operands that directly follow `index`, up to the next option-like token. */
function followingOperands(tokens: readonly string[], index: number): number[] {
  const following: number[] = [];
  for (let at = index + 1; at < tokens.length && !isOptionLike(tokens[at]!) && tokens[at] !== "-"; at += 1) following.push(at);
  return following;
}

/** The item operand, and every value written after a repeatable flag's own value with the flag it belongs to. */
interface ValueListScan {
  idAt?: number;
  extras: Array<{ at: number; flag: string }>;
  exact: boolean;
}

/** Take an operand as the item id; a second operand outside a value chain, stdin `-`, or a subcommand name declines. */
function scanOperand(argv: readonly string[], index: number, scan: ValueListScan, subcommands: ReadonlySet<string>): number | undefined {
  // A subcommand name after an option (`files --note N discover`) means the subcommand refused, not this command.
  if (scan.idAt !== undefined || argv[index] === "-" || subcommands.has(argv[index]!)) return undefined;
  scan.idAt = index;
  return index;
}

/** Read one option with its value and any values written after it; the index of its last token, or undefined to decline. */
function scanOption(command: string, argv: readonly string[], index: number, table: OptionArityTable, scan: ValueListScan): number | undefined {
  const option = argv[index] === "--" ? undefined : readOptionToken(argv, index, table);
  if (!option) return undefined;
  const following = option.arity.repeatable && option.value !== undefined ? followingOperands(argv, option.end) : [];
  if (following.length === 0) return option.end;
  if (scan.idAt === undefined) return undefined;
  const reading = readValueList(command, option.arity.name, [option.value!, ...following.map((at) => argv[at]!)]);
  if (reading === "decline") return undefined;
  scan.exact &&= reading === "exact";
  scan.extras.push(...following.map((at) => ({ at, flag: option.spelling })));
  return following.at(-1)!;
}

/**
 * Walk the command's tokens as Commander parses them. Options consume values
 * by their declared arity; the first operand is the item id; every later
 * operand must directly follow a repeatable flag's value. Undefined for any
 * other shape: an undeclared option, a stray operand, values before the item
 * id, an end-of-options marker, or a value list this recovery does not own.
 */
function scanValueLists(command: string, argv: readonly string[], from: number, table: OptionArityTable, subcommands: ReadonlySet<string>): ValueListScan | undefined {
  const scan: ValueListScan = { extras: [], exact: true };
  for (let index = from; index < argv.length; index += 1) {
    const last = isOptionLike(argv[index]!) ? scanOption(command, argv, index, table, scan) : scanOperand(argv, index, scan, subcommands);
    if (last === undefined) return undefined;
    index = last;
  }
  return scan;
}

/**
 * Whether the options written before the command path read as Commander reads
 * them: every one declared, none whose value reads as an option
 * (`--pm-path=--sandbox`), and no operand among them besides the command path.
 */
function rootOptionsAreReadable(argv: readonly string[], table: OptionArityTable): boolean {
  const pathStart = findBootstrapCommandTokenIndex([...argv])!;
  for (let index = 0; index < pathStart; index += 1) {
    const option = isOptionLike(argv[index]!) ? readOptionToken(argv, index, table) : undefined;
    if (!option) return false;
    index = option.end;
  }
  return true;
}

/**
 * Resolve `pm <files|docs|test> <id> --flag a b c` into one occurrence per
 * value, judged with the command's Commander arity, including the global
 * options the program declares. Every extra operand must directly follow a
 * repeatable flag's value, and the item id must be the first operand.
 */
export function resolveLinkedResourceValueListRecovery(
  command: string | undefined,
  argv: readonly string[],
  table: OptionArityTable,
  subcommands: ReadonlySet<string> = new Set(),
): LinkedResourceValueListRecovery | undefined {
  if (command === undefined || !LINKED_RESOURCE_VALUE_LIST_COMMANDS.has(command)) return undefined;
  const from = commandArgumentsStart(command, argv);
  const scan = from === undefined || !rootOptionsAreReadable(argv, table) ? undefined : scanValueLists(command, argv, from, table, subcommands);
  if (scan?.idAt === undefined || scan.extras.length === 0) return undefined;
  const insertions = new Map(scan.extras.map(({ at, flag }) => [at, flag]));
  const retryArgs = argv.flatMap((token, index) => (insertions.has(index) ? [insertions.get(index)!, token] : [token]));
  return {
    itemId: argv[scan.idAt]!,
    flags: [...new Set(scan.extras.map(({ flag }) => flag))],
    extraValues: scan.extras.map(({ at }) => argv[at]!),
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
  if (!command) return undefined;
  const subcommands = new Set(command.commands.flatMap((child) => [child.name(), ...child.aliases()]));
  return resolveLinkedResourceValueListRecovery(commandName, invocationArgv, readCommandOptionArity(command), subcommands);
}
