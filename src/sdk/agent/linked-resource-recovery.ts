/**
 * @module sdk/agent/linked-resource-recovery
 * Derives explicit linked-resource retries from unambiguous positional mistakes.
 */
import { findBootstrapCommandTokenIndex, GLOBAL_VALUE_CONSUMING_FLAGS, BOOTSTRAP_BOOLEAN_FLAGS } from "../cli-contracts/bootstrap-command-scanner.js";
import { findPmNamespacedCommand } from "../cli-contracts/command-aliases.js";
import { STRUCTURED_LINKED_TEST_KEYS } from "../test/entry.js";

/** Recovery retains supplied values; missing test commands never become executable placeholders. */
export interface LinkedResourcePositionalRecovery {
  /** Item operand retained in templates when the actual test command is missing. */
  itemId: string;
  /** Misplaced path, command or metadata value. */
  value: string;
  /** Exact retry, absent when the caller must supply the actual test command. */
  retryArgs?: string[];
  /** Original-scope template whose actual-command placeholder must be filled before replay. */
  templateArgs?: string[];
}

/** Accept only presentation flags after the misplaced value, preserving them in the retry. */
function hasOnlyPresentationSuffix(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (BOOTSTRAP_BOOLEAN_FLAGS.has(token) && token !== "--all") continue;
    const flag = token.split("=", 1)[0]!;
    if (!GLOBAL_VALUE_CONSUMING_FLAGS.has(flag) || ["--author", "--path", "--pm-path"].includes(flag)) return false;
    if (!token.includes("=")) {
      const value = args[++index];
      if (value === undefined || value.startsWith("-")) return false;
    }
  }
  return true;
}

/** Resolve adjacent item/value operands without treating global option values as command names. */
function positionalOperands(command: string, argv: readonly string[]): { idIndex: number; value: string } | undefined {
  const start = findBootstrapCommandTokenIndex(argv);
  if (start === undefined) return undefined;
  const namespaced = findPmNamespacedCommand(argv.slice(start));
  const operation = namespaced?.alias ?? argv[start];
  if (operation !== command) return undefined;
  const idIndex = start + (namespaced?.canonical_argv.length ?? 1);
  const id = argv[idIndex];
  const value = argv[idIndex + 1];
  if (!id || id === "add" || id.startsWith("-")) return undefined;
  if (!value || value.startsWith("-")) return undefined;
  if (!hasOnlyPresentationSuffix(argv.slice(idIndex + 2))) return undefined;
  return { idIndex, value };
}

/** Convert only declared entry identities, leaving missing actual commands as templates. */
function replacementArgs(command: string, value: string): string[] | null | undefined {
  const key = /^[A-Za-z_][A-Za-z0-9_]*=/u.exec(value)?.[0];
  if (command === "test") {
    if (key && !["command=", "cmd="].includes(key)) {
      return (STRUCTURED_LINKED_TEST_KEYS as readonly string[]).includes(key.slice(0, -1)) ? null : undefined;
    }
    return ["--add-json", JSON.stringify({ command: key ? value.slice(key.length) : value })];
  }
  if (key && key !== "path=") return undefined;
  return ["--add", key ? value : `path=${JSON.stringify(value)}`];
}

/** Repair object-first resource syntax without guessing command names or combining mutations. */
export function resolveLinkedResourcePositionalRecovery(command: string | undefined, argv: readonly string[]): LinkedResourcePositionalRecovery | undefined {
  if (command === undefined || !["files", "docs", "test"].includes(command)) return undefined;
  const operands = positionalOperands(command, argv);
  if (!operands) return undefined;
  const { idIndex, value } = operands;
  const itemId = argv[idIndex];
  const replacement = replacementArgs(command, value);
  if (replacement === undefined) return undefined;
  if (replacement === null) return { itemId, value, templateArgs: [...argv.slice(0, idIndex + 1), "--add", `command=<actual command>,${value}`, ...argv.slice(idIndex + 2)] };
  return { itemId, value, retryArgs: [...argv.slice(0, idIndex + 1), ...replacement, ...argv.slice(idIndex + 2)] };
}
