/**
 * @module sdk/item-addressing
 *
 * Defines the shared item-address grammar used by CLI adapters. Commands keep
 * their canonical positional id while accepting `--id` as a compatibility
 * spelling, so integrations no longer need a per-command addressing table.
 */

const ITEM_ID_ALIAS_COMMANDS = new Set([
  "append",
  "claim",
  "close",
  "close-task",
  "comments",
  "copy",
  "delete",
  "deps",
  "docs",
  "files",
  "focus",
  "get",
  "history",
  "history-compact",
  "history-redact",
  "history-repair",
  "learnings",
  "notes",
  "pause-task",
  "release",
  "restore",
  "start-task",
  "test",
  "update",
]);

const ITEM_ID_ALIAS_SUBCOMMANDS = new Map([
  ["files", "discover"],
  ["item", "complete"],
]);

const GLOBAL_VALUE_FLAGS = new Set([
  "--author",
  "--output-budget",
  "--output-format",
  "--output-include",
  "--output-limit",
  "--output-session",
  "--path",
  "--pm-path",
]);

/** Result of normalizing one item-addressed invocation. */
export interface ItemAddressInvocationResult {
  /** Canonical argv with an `--id` value moved into positional-id location. */
  argv: string[];
  /** Whether argv changed. */
  changed: boolean;
  /** Whether both positional and named item ids were supplied. */
  conflict: boolean;
  /** Resolved named item id when one was present. */
  itemId?: string;
}

/** Return whether a command participates in the shared item-id alias contract. */
export function supportsItemIdAlias(commandName: string | undefined): boolean {
  const normalized = commandName?.trim().toLowerCase() ?? "";
  return (
    ITEM_ID_ALIAS_COMMANDS.has(normalized) ||
    ITEM_ID_ALIAS_SUBCOMMANDS.has(normalized)
  );
}

function findCommandIndex(argv: string[]): number | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") return undefined;
    if (GLOBAL_VALUE_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return index;
  }
  return undefined;
}

function readNamedItemId(argv: string[]): {
  index: number;
  consumed: number;
  value?: string;
} | null {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") return null;
    if (token === "--id") {
      return { index, consumed: 2, value: argv[index + 1] };
    }
    if (token.startsWith("--id=")) {
      return { index, consumed: 1, value: token.slice("--id=".length) };
    }
  }
  return null;
}

/** Resolve the positional-id slot for direct and declared nested commands. */
function resolveItemAddressIndex(
  argv: string[],
  commandIndex: number,
  commandName: string,
): number | undefined {
  const declaredSubcommand = ITEM_ID_ALIAS_SUBCOMMANDS.get(commandName);
  if (declaredSubcommand === undefined) return commandIndex + 1;
  const usesDeclaredSubcommand =
    argv[commandIndex + 1]?.toLowerCase() === declaredSubcommand;
  if (!usesDeclaredSubcommand && !ITEM_ID_ALIAS_COMMANDS.has(commandName)) {
    return undefined;
  }
  return commandIndex + (usesDeclaredSubcommand ? 2 : 1);
}

/**
 * Normalize `pm <command> --id <value>` to the command's positional id form.
 * The transformation is lossless for every other argument and reports a
 * conflict instead of guessing when both forms are present.
 */
export function normalizeItemAddressInvocation(
  argv: string[],
): ItemAddressInvocationResult {
  const commandIndex = findCommandIndex(argv);
  const commandName =
    commandIndex === undefined ? undefined : argv[commandIndex]?.toLowerCase();
  if (!supportsItemIdAlias(commandName)) {
    return { argv: [...argv], changed: false, conflict: false };
  }
  const named = readNamedItemId(argv);
  if (!named || !named.value?.trim()) {
    return { argv: [...argv], changed: false, conflict: false };
  }
  const addressIndex = resolveItemAddressIndex(
    argv,
    commandIndex!,
    commandName!,
  );
  if (addressIndex === undefined) {
    return { argv: [...argv], changed: false, conflict: false };
  }
  const positional = argv[addressIndex];
  const hasPositional =
    typeof positional === "string" &&
    positional !== "--" &&
    !positional.startsWith("-");
  if (hasPositional) {
    return {
      argv: [...argv],
      changed: false,
      conflict: true,
      itemId: named.value,
    };
  }
  const withoutNamed = [
    ...argv.slice(0, named.index),
    ...argv.slice(named.index + named.consumed),
  ];
  const normalizedCommandIndex = findCommandIndex(withoutNamed)!;
  const normalizedAddressIndex = resolveItemAddressIndex(
    withoutNamed,
    normalizedCommandIndex,
    commandName!,
  )!;
  withoutNamed.splice(normalizedAddressIndex, 0, named.value);
  return {
    argv: withoutNamed,
    changed: true,
    conflict: false,
    itemId: named.value,
  };
}
