/**
 * @module sdk/item-addressing
 *
 * Defines the shared item-address grammar used by CLI adapters. Commands keep
 * their canonical positional id while accepting `--id` as a compatibility
 * spelling, so integrations no longer need a per-command addressing table.
 */
import { findBootstrapCommandTokenIndex } from "../cli-contracts/bootstrap-command-scanner.js";
import { resolvePmCommandOperation } from "../cli-contracts/command-aliases.js";
import {
  type CliFlagContract,
  resolveSubcommandFlagContractsForCommand,
} from "../cli-contracts.js";

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

const TRAILING_POSITIONAL_COUNTS = new Map([
  ["append", 1],
  ["close", 1],
  ["close-task", 1],
  ["comments", 1],
  ["item complete", 1],
  ["learnings", 1],
  ["notes", 1],
  ["restore", 1],
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

interface NamedItemId {
  index: number;
  consumed: number;
  value?: string;
}

/** Return whether a command participates in the shared item-id alias contract. */
export function supportsItemIdAlias(
  commandName: string | undefined,
): boolean {
  const normalized = resolvePmCommandOperation(
    commandName?.trim().toLowerCase() ?? "",
  );
  return (
    ITEM_ID_ALIAS_COMMANDS.has(normalized) ||
    ITEM_ID_ALIAS_SUBCOMMANDS.has(normalized)
  );
}

/** Keep namespace verbs separate from default item addresses and unaddressed context reads. */
function resolveNamespacedItemAddressIndex(argv: string[], commandIndex: number, commandName: string): number | undefined {
  const fallback = ITEM_ID_ALIAS_COMMANDS.has(commandName) ? commandIndex + 1 : undefined;
  const leafOffset = findBootstrapCommandTokenIndex(argv.slice(commandIndex + 1));
  if (leafOffset === undefined) return fallback;
  const leafIndex = commandIndex + 1 + leafOffset;
  const candidate = `${commandName} ${argv[leafIndex]}`;
  const operation = resolvePmCommandOperation(candidate);
  if (operation === candidate) return fallback;
  return supportsItemIdAlias(operation) ? leafIndex + 1 : undefined;
}

/** Resolve the positional-id slot for direct and declared nested commands. */
function resolveItemAddressIndex(
  argv: string[],
  commandIndex: number,
  commandName: string,
): number | undefined {
  if (["history", "context", "ctx", "update", "close"].includes(commandName)) {
    return resolveNamespacedItemAddressIndex(argv, commandIndex, commandName);
  }
  const declaredSubcommand = ITEM_ID_ALIAS_SUBCOMMANDS.get(commandName);
  if (declaredSubcommand === undefined) return commandIndex + 1;
  const usesDeclaredSubcommand =
    argv[commandIndex + 1]?.toLowerCase() === declaredSubcommand;
  if (!usesDeclaredSubcommand && !ITEM_ID_ALIAS_COMMANDS.has(commandName)) {
    return undefined;
  }
  return commandIndex + (usesDeclaredSubcommand ? 2 : 1);
}

function buildFlagContractMap(
  commandPath: string,
): Map<string, CliFlagContract> {
  const contractsByFlag = new Map<string, CliFlagContract>();
  for (const contract of resolveSubcommandFlagContractsForCommand(
    commandPath,
  )) {
    for (const flag of [
      contract.flag,
      contract.short,
      ...(contract.aliases ?? []),
    ]) {
      if (flag) contractsByFlag.set(flag, contract);
    }
  }
  return contractsByFlag;
}

function collectNamedItemIds(argv: string[]): NamedItemId[] {
  const namedIds: NamedItemId[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") break;
    if (token === "--id") {
      namedIds.push({ index, consumed: 2, value: argv[index + 1] });
      index += 1;
    } else if (token.startsWith("--id=")) {
      namedIds.push({
        index,
        consumed: 1,
        value: token.slice("--id=".length),
      });
    }
  }
  return namedIds;
}

/** Skip a following token only for a declared value-taking flag without an inline assignment. */
function consumesSeparateFlagValue(
  token: string,
  nextToken: string | undefined,
  contractsByFlag: ReadonlyMap<string, CliFlagContract>,
): boolean {
  const separatorIndex = token.indexOf("=");
  if (
    separatorIndex >= 0 ||
    nextToken === undefined ||
    nextToken.startsWith("-")
  ) {
    return false;
  }
  const contract = contractsByFlag.get(token);
  return contract !== undefined && contract.value_type !== "boolean";
}

/** Detect an existing item address while excluding named IDs, flag values, and operation-specific trailing positionals. */
function hasPositionalItemId(
  argv: string[],
  addressIndex: number,
  commandPath: string,
  namedIndex: number,
  contractsByFlag: ReadonlyMap<string, CliFlagContract>,
): boolean {
  let trailingPositionals = 0;
  for (let index = addressIndex; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") break;
    if (token === "--id") {
      index += 1;
      continue;
    }
    if (token.startsWith("--id=")) continue;
    if (!token.startsWith("-")) {
      if (index < namedIndex) return true;
      trailingPositionals += 1;
      continue;
    }
    if (
      consumesSeparateFlagValue(token, argv[index + 1], contractsByFlag)
    ) {
      index += 1;
    }
  }
  return (
    trailingPositionals >
    (TRAILING_POSITIONAL_COUNTS.get(
      resolvePmCommandOperation(commandPath),
    ) ?? 0)
  );
}

/**
 * Normalize `pm <command> --id <value>` to the command's positional id form.
 * The transformation is lossless for every other argument and reports a
 * conflict instead of guessing when both forms are present.
 */
export function normalizeItemAddressInvocation(
  argv: string[],
): ItemAddressInvocationResult {
  const commandIndex = findBootstrapCommandTokenIndex(argv);
  const commandName =
    commandIndex === undefined
      ? undefined
      : argv[commandIndex]?.toLowerCase();
  if (commandName !== "context" && commandName !== "ctx" && !supportsItemIdAlias(commandName)) {
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
  const commandPath =
    addressIndex > commandIndex! + 1
      ? `${commandName} ${argv[addressIndex - 1]}`
      : commandName!;
  const contractsByFlag = buildFlagContractMap(commandPath);
  const namedIds = collectNamedItemIds(argv);
  const named = namedIds[0];
  if (!named || !named.value?.trim()) {
    return { argv: [...argv], changed: false, conflict: false };
  }
  if (
    namedIds.length > 1 ||
    hasPositionalItemId(
      argv,
      addressIndex,
      commandPath,
      named.index,
      contractsByFlag,
    )
  ) {
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
  const normalizedCommandIndex =
    findBootstrapCommandTokenIndex(withoutNamed)!;
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
