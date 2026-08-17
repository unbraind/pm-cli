/**
 * @module sdk/cli-contracts/grammar-contracts
 *
 * Declares and verifies the agent-facing noun–verb grammar. The destination
 * census is intentionally exact: live command contracts are compared with
 * this checked-in table in both directions so adding or removing a command
 * cannot silently bypass the architecture decision.
 */
import type { PmCommandAliasContract } from "./command-aliases.js";

/** Canonical top-level domains an agent must retain to route pm operations. */
export const PM_CLI_GRAMMAR_NOUNS = [
  "item",
  "list",
  "context",
  "search",
  "graph",
  "history",
  "workspace",
  "package",
  "ops",
  "plan",
  "contracts",
  "help",
] as const;

/** Shared verbs whose meaning transfers across domain nouns. */
export const PM_CLI_SHARED_VERBS = [
  "activate",
  "add",
  "adopt",
  "adopt-all",
  "catalog",
  "compact",
  "complete",
  "create",
  "deactivate",
  "delete",
  "describe",
  "doctor",
  "edit",
  "explore",
  "import",
  "init",
  "inspect",
  "install",
  "list",
  "manage",
  "migrate",
  "mutate",
  "read",
  "redact",
  "reload",
  "remove",
  "repair",
  "restore",
  "run",
  "show",
  "uninstall",
  "verify",
] as const;

/** Why a current command is permitted while the grammar migration proceeds. */
export type PmCommandDestinationDisposition =
  | "target_noun"
  | "consolidation"
  | "package_owned"
  | "keep_as_is";

/** Exact destination decision for one command emitted by runtime contracts. */
export interface PmCommandDestinationContract {
  /** Current executable command path. */
  command: string;
  /** Canonical noun that owns the capability. */
  noun: (typeof PM_CLI_GRAMMAR_NOUNS)[number];
  /** Canonical noun-first invocation or family destination. */
  target: string;
  /** Why the current spelling remains in the executable surface. */
  disposition: PmCommandDestinationDisposition;
  /** PM item or package identifier owning the disposition. */
  owner: string;
  /** Reason required only for a deliberate keep-as-is exception. */
  reason?: string;
}

function destinationRows(
  noun: PmCommandDestinationContract["noun"],
  target: string,
  disposition: Exclude<PmCommandDestinationDisposition, "keep_as_is">,
  owner: string,
  commands: readonly string[],
): PmCommandDestinationContract[] {
  return commands.map((command) => ({
    command,
    noun,
    target,
    disposition,
    owner,
  }));
}

/** Checked-in exhaustive destination census for core and known package commands. */
export const PM_COMMAND_DESTINATION_CONTRACTS: readonly PmCommandDestinationContract[] =
  [
    ...destinationRows("item", "item", "target_noun", "pm-pbyu", [
      "item",
      "item complete",
      "item mutate",
    ]),
    ...destinationRows("item", "item", "consolidation", "pm-yql1", [
      "append",
      "claim",
      "close",
      "close-many",
      "close-task",
      "comments",
      "copy",
      "create",
      "delete",
      "docs",
      "files",
      "get",
      "learnings",
      "notes",
      "pause-task",
      "release",
      "start-task",
      "test",
      "update",
      "update-many",
    ]),
    ...destinationRows("list", "list", "target_noun", "pm-pfqi", ["list"]),
    ...destinationRows("list", "list --group-by", "consolidation", "pm-xkgq", [
      "aggregate",
    ]),
    ...destinationRows("context", "context", "target_noun", "pm-pbyu", [
      "context",
    ]),
    ...destinationRows("context", "context", "consolidation", "pm-kcs4", [
      "ctx",
      "focus",
      "next",
    ]),
    ...destinationRows("search", "search", "target_noun", "pm-pbyu", [
      "search",
    ]),
    ...destinationRows(
      "search",
      "search",
      "package_owned",
      "package:search-advanced",
      ["reindex", "search-advanced"],
    ),
    ...destinationRows(
      "search",
      "search duplicates",
      "consolidation",
      "pm-3i9q8g",
      ["duplicates"],
    ),
    ...destinationRows("graph", "graph", "target_noun", "pm-pbyu", ["graph"]),
    ...destinationRows("graph", "graph show", "consolidation", "pm-yql1", [
      "deps",
    ]),
    ...destinationRows("history", "history", "target_noun", "pm-pbyu", [
      "history",
    ]),
    ...destinationRows("history", "history", "consolidation", "pm-tqel", [
      "activity",
      "events",
      "history-author-acknowledge",
      "history-compact",
      "history-redact",
      "history-repair",
      "merge",
      "restore",
    ]),
    ...destinationRows(
      "history",
      "history",
      "package_owned",
      "package:builtin-vcs-exemplar",
      [
        "vcs abandon",
        "vcs create",
        "vcs log",
        "vcs merge",
        "vcs propose",
        "vcs ref-create",
        "vcs show",
      ],
    ),
    ...destinationRows("workspace", "workspace", "target_noun", "pm-pbyu", [
      "workspace",
      "workspace snapshot",
      "workspace snapshot create",
      "workspace snapshot delete",
      "workspace snapshot inspect",
      "workspace snapshot list",
      "workspace snapshot restore",
    ]),
    ...destinationRows(
      "workspace",
      "workspace init",
      "consolidation",
      "pm-n7rr",
      ["init"],
    ),
    ...destinationRows("package", "package", "target_noun", "pm-pbyu", [
      "package",
      "package activate",
      "package adopt",
      "package adopt-all",
      "package catalog",
      "package deactivate",
      "package describe",
      "package doctor",
      "package explore",
      "package init",
      "package install",
      "package manage",
      "package migrate",
      "package reload",
      "package uninstall",
    ]),
    ...destinationRows("package", "package", "consolidation", "pm-tnud", [
      "extension",
      "extension activate",
      "extension adopt",
      "extension adopt-all",
      "extension catalog",
      "extension deactivate",
      "extension describe",
      "extension doctor",
      "extension explore",
      "extension init",
      "extension install",
      "extension manage",
      "extension migrate",
      "extension reload",
      "extension uninstall",
      "install",
      "packages",
      "packages activate",
      "packages adopt",
      "packages adopt-all",
      "packages catalog",
      "packages deactivate",
      "packages describe",
      "packages doctor",
      "packages explore",
      "packages init",
      "packages install",
      "packages manage",
      "packages migrate",
      "packages reload",
      "packages uninstall",
      "upgrade",
    ]),
    ...destinationRows("package", "package", "package_owned", "package:beads", [
      "beads import",
    ]),
    ...destinationRows(
      "package",
      "package",
      "package_owned",
      "package:pm-changelog",
      ["changelog export", "changelog generate"],
    ),
    ...destinationRows(
      "package",
      "package calendar",
      "package_owned",
      "pm-o3fh",
      ["event", "meet", "remind"],
    ),
    ...destinationRows("ops", "ops", "consolidation", "pm-6apl", [
      "assurance",
      "config",
      "eval",
      "gc",
      "health",
      "profile",
      "schema",
      "stats",
      "telemetry",
      "test-all",
      "validate",
    ]),
    ...destinationRows("plan", "plan", "target_noun", "pm-pbyu", ["plan"]),
    ...destinationRows("contracts", "contracts", "target_noun", "pm-pbyu", [
      "contracts",
    ]),
    ...destinationRows("help", "help", "target_noun", "pm-pbyu", ["help"]),
    ...destinationRows(
      "help",
      "help",
      "package_owned",
      "package:builtin-guide-shell",
      [
        "completion",
        "completion-statuses",
        "completion-tags",
        "completion-types",
        "guide",
      ],
    ),
  ];

/** Immutable grammar policy used by contracts and the CI gate. */
export const PM_CLI_GRAMMAR_CONTRACT = {
  nouns: PM_CLI_GRAMMAR_NOUNS,
  shared_verbs: PM_CLI_SHARED_VERBS,
  scope_before_verb: true,
  visible_top_level_ceiling: 69,
  ceiling_raise_requires_pm_item: true,
} as const;

/** One self-correcting grammar-gate finding. */
export interface PmCliGrammarFinding {
  /** Stable diagnostic category suitable for automated remediation. */
  code:
    | "alias_target_missing"
    | "duplicate_destination"
    | "missing_destination"
    | "stale_destination"
    | "unknown_noun"
    | "visible_surface_ceiling_exceeded";
  /** Exact command or alias spelling that violated the contract. */
  spelling: string;
  /** Human-readable explanation of the violated invariant. */
  message: string;
  /** Closest canonical invocation or corrective policy action. */
  nearest_target: string;
}

/** Deterministic conformance report for the live command and alias surfaces. */
export interface PmCliGrammarReport {
  /** Whether every checked grammar invariant passed. */
  ok: boolean;
  /** Number of normalized live command paths evaluated. */
  command_count: number;
  /** Number of checked-in destination-census rows. */
  destination_count: number;
  /** Number of declared aliases omitted from default discovery. */
  hidden_alias_count: number;
  /** Number of distinct visible non-package single-token command paths. */
  visible_top_level_count: number;
  /** Maximum visible single-token command paths permitted by the ADR. */
  visible_top_level_ceiling: number;
  /** Self-correcting conformance diagnostics, empty when `ok` is true. */
  findings: PmCliGrammarFinding[];
}

function validateCommandDestinations(
  commands: readonly string[],
  destinationsByCommand: ReadonlyMap<
    string,
    readonly PmCommandDestinationContract[]
  >,
  nounSet: ReadonlySet<string>,
): PmCliGrammarFinding[] {
  const findings: PmCliGrammarFinding[] = [];
  for (const command of commands) {
    const destinations = destinationsByCommand.get(command) ?? [];
    if (destinations.length === 0) {
      const separatorIndex = command.indexOf(" ");
      const root =
        separatorIndex === -1 ? command : command.slice(0, separatorIndex);
      findings.push({
        code: "missing_destination",
        spelling: command,
        message: `Command \`${command}\` has no destination census row.`,
        nearest_target: nounSet.has(root) ? root : `ops ${command}`,
      });
      continue;
    }
    if (destinations.length > 1) {
      findings.push({
        code: "duplicate_destination",
        spelling: command,
        message: `Command \`${command}\` has ${destinations.length} destination rows.`,
        nearest_target: destinations[0]!.target,
      });
    }
    for (const destination of destinations) {
      if (
        destination.disposition === "keep_as_is" &&
        (destination.reason?.trim().length ?? 0) === 0
      ) {
        findings.push({
          code: "missing_destination",
          spelling: command,
          message: `Command \`${command}\` is kept as-is without a documented reason.`,
          nearest_target: destination.target,
        });
      }
      if (!nounSet.has(destination.noun)) {
        findings.push({
          code: "unknown_noun",
          spelling: command,
          message: `Command \`${command}\` names undeclared noun \`${destination.noun}\`.`,
          nearest_target: destination.target,
        });
      }
    }
  }
  return findings;
}

function validateDestinationCensus(
  commandSet: ReadonlySet<string>,
  destinations: readonly PmCommandDestinationContract[],
): PmCliGrammarFinding[] {
  return destinations
    .filter(
      (destination) =>
        destination.disposition !== "package_owned" &&
        !commandSet.has(destination.command),
    )
    .map((destination) => ({
      code: "stale_destination" as const,
      spelling: destination.command,
      message: `Destination row \`${destination.command}\` is absent from live contracts.`,
      nearest_target: destination.target,
    }));
}

function validateAliasTargets(
  aliases: readonly PmCommandAliasContract[],
  commandSet: ReadonlySet<string>,
): PmCliGrammarFinding[] {
  return aliases
    .filter((alias) => !commandSet.has(alias.canonical))
    .map((alias) => ({
      code: "alias_target_missing" as const,
      spelling: alias.alias,
      message: `Alias \`${alias.alias}\` targets missing canonical command \`${alias.canonical}\`.`,
      nearest_target: alias.canonical_argv.join(" "),
    }));
}

/** Verify exhaustive census parity, noun ownership, alias targets, and growth. */
export function verifyPmCliGrammar(
  commands: readonly string[],
  aliases?: readonly PmCommandAliasContract[],
): PmCliGrammarReport;
/** Implementation seam accepts an injected census for isolated conformance tests. */
export function verifyPmCliGrammar(
  commands: readonly string[],
  aliases: readonly PmCommandAliasContract[] = [],
  destinations: readonly PmCommandDestinationContract[] = PM_COMMAND_DESTINATION_CONTRACTS,
): PmCliGrammarReport {
  const normalizedCommands = [
    ...new Set(commands.map((command) => command.trim())),
  ]
    .filter((command) => command.length > 0)
    .sort((left, right) => left.localeCompare(right));
  const commandSet = new Set(normalizedCommands);
  const nounSet = new Set<string>(PM_CLI_GRAMMAR_NOUNS);
  const destinationsByCommand = new Map<
    string,
    PmCommandDestinationContract[]
  >();
  for (const destination of destinations) {
    const entries = destinationsByCommand.get(destination.command) ?? [];
    entries.push(destination);
    destinationsByCommand.set(destination.command, entries);
  }
  const findings = [
    ...validateCommandDestinations(
      normalizedCommands,
      destinationsByCommand,
      nounSet,
    ),
    ...validateDestinationCensus(commandSet, destinations),
    ...validateAliasTargets(aliases, commandSet),
  ];
  const hiddenAliasNames = new Set(
    aliases.filter((alias) => alias.hidden).map((alias) => alias.alias),
  );
  const visibleTopLevelCount = new Set(
    normalizedCommands.filter(
      (command) =>
        !command.includes(" ") &&
        !hiddenAliasNames.has(command) &&
        !(destinationsByCommand.get(command) ?? []).some(
          (destination) => destination.disposition === "package_owned",
        ),
    ),
  ).size;
  if (
    visibleTopLevelCount > PM_CLI_GRAMMAR_CONTRACT.visible_top_level_ceiling
  ) {
    findings.push({
      code: "visible_surface_ceiling_exceeded",
      spelling: String(visibleTopLevelCount),
      message: `Visible non-package top-level command count ${visibleTopLevelCount} exceeds ceiling ${PM_CLI_GRAMMAR_CONTRACT.visible_top_level_ceiling}.`,
      nearest_target:
        "Declare the noun placement and tracked waiver before raising the ceiling.",
    });
  }
  return {
    ok: findings.length === 0,
    command_count: normalizedCommands.length,
    destination_count: destinations.length,
    hidden_alias_count: aliases.filter((alias) => alias.hidden).length,
    visible_top_level_count: visibleTopLevelCount,
    visible_top_level_ceiling:
      PM_CLI_GRAMMAR_CONTRACT.visible_top_level_ceiling,
    findings,
  };
}
