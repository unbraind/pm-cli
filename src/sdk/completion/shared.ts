/**
 * @module sdk/completion/shared
 * Shares command vocabulary and runtime choices across shell generators.
 */
import { BUILTIN_ITEM_TYPE_VALUES,STATUS_VALUES } from "../../types/index.js";
import { listPmCommandsForTier,resolvePmCommandVisibilityTier } from "../agent-capability-contracts.js";
import {
  AGGREGATE_FLAG_CONTRACTS,
  APPEND_FLAG_CONTRACTS,
  CALENDAR_FLAG_CONTRACTS,
  CLOSE_MANY_FLAG_CONTRACTS,
  COMPLETION_FLAG_CONTRACTS,
  CONTEXT_FLAG_CONTRACTS,
  CONTRACTS_FLAG_CONTRACTS,
  COPY_FLAG_CONTRACTS,
  CREATE_FLAG_CONTRACTS,
  DEPS_FLAG_CONTRACTS,
  DUPLICATES_FLAG_CONTRACTS,
  EVENTS_FLAG_CONTRACTS,
  EXTENSION_FLAG_CONTRACTS,
  FOCUS_FLAG_CONTRACTS,
  GET_FLAG_CONTRACTS,
  GLOBAL_FLAG_CONTRACTS,
  GRAPH_FLAG_CONTRACTS,
  GUIDE_FLAG_CONTRACTS,
  HEALTH_FLAG_CONTRACTS,
  HISTORY_AUTHOR_ACKNOWLEDGE_FLAG_CONTRACTS,
  HISTORY_FLAG_CONTRACTS,
  INIT_FLAG_CONTRACTS,
  LIST_FILTER_FLAG_CONTRACTS,
  MEET_FLAG_CONTRACTS,
  NEXT_FLAG_CONTRACTS,
  PACKAGE_FLAG_CONTRACTS,
  PLAN_FLAG_CONTRACTS,
  PM_COMMAND_ALIAS_CONTRACTS,
  PM_NAMESPACED_COMMAND_ALIASES,
  REMIND_FLAG_CONTRACTS,
  SEARCH_FLAG_CONTRACTS,
  STATS_FLAG_CONTRACTS,
  UPDATE_FLAG_CONTRACTS,
  UPDATE_MANY_FLAG_CONTRACTS,
  UPGRADE_FLAG_CONTRACTS,
  resolvePmCommandOperation,
  resolveSubcommandFlagContractsForCommand,
  toCompletionFlagString,
} from "../cli-contracts.js";
import { GLOBAL_VALUE_CONSUMING_FLAGS } from "../cli-contracts/bootstrap-command-scanner.js";
import { WORKFLOW_POLICY_ACTIONS } from "../cli-contracts/enum-contracts.js";
import { PM_COMMAND_DESTINATION_CONTRACTS } from "../cli-contracts/grammar-contracts.js";
import { enrichCliFlagInvocationContracts } from "../flag-invocation-contracts.js";
import { listGuideTopicIds } from "../guide-topics.js";

/** Shell dialects supported by the SDK completion generators. */
export type CompletionShell = "bash" | "zsh" | "fish";

/** Documents the completion result payload exchanged by command, SDK, and package integrations. */
export interface CompletionResult {
  /** Value that configures or reports shell for this contract. */
  shell: CompletionShell;
  /** Value that configures or reports script for this contract. */
  script: string;
  /** Value that configures or reports setup hint for this contract. */
  setup_hint: string;
}

const DEFAULT_ITEM_TYPES = [...BUILTIN_ITEM_TYPE_VALUES];

const DEFAULT_STATUS_VALUES = [...STATUS_VALUES];

type CompletionFlagCommand =
  | "list"
  | "create"
  | "update"
  | "update-many"
  | "search"
  | "calendar"
  | "context";

/** Documents the completion runtime config payload exchanged by command, SDK, and package integrations. */
export interface CompletionRuntimeConfig {
  /** Active package command paths whose namespace facets may be advertised. Legacy aliases are accepted. */
  namespace_commands?: readonly string[];
  /** Value that configures or reports item types for this contract. */
  item_types?: string[];
  /** Value that configures or reports statuses for this contract. */
  statuses?: string[];
  /** Value that configures or reports command flags for this contract. */
  command_flags?: Partial<Record<CompletionFlagCommand, string[]>>;
}

const HIDDEN_COMMAND_ALIASES = new Set(
  PM_COMMAND_ALIAS_CONTRACTS.filter((contract) => contract.hidden).map(
    (contract) => contract.alias,
  ),
);

const ALL_COMMANDS = listPmCommandsForTier("full").filter(
  (command) => !command.includes(" ") && !HIDDEN_COMMAND_ALIASES.has(command),
);

const LIST_FLAGS = toCompletionFlagString(LIST_FILTER_FLAG_CONTRACTS);

const AGGREGATE_FLAGS = toCompletionFlagString(AGGREGATE_FLAG_CONTRACTS);

const APPEND_FLAGS = toCompletionFlagString(APPEND_FLAG_CONTRACTS);

const COPY_FLAGS = toCompletionFlagString(COPY_FLAG_CONTRACTS);

const RESTORE_INVOCATIONS = enrichCliFlagInvocationContracts(
  "restore",
  resolveSubcommandFlagContractsForCommand("restore"),
);

const ATTEST_INVOCATIONS = enrichCliFlagInvocationContracts(
  "history-attest",
  resolveSubcommandFlagContractsForCommand("history-attest"),
);

const FOCUS_FLAGS = toCompletionFlagString(FOCUS_FLAG_CONTRACTS);

const MEET_FLAGS = toCompletionFlagString(MEET_FLAG_CONTRACTS);

const REMIND_FLAGS = toCompletionFlagString(REMIND_FLAG_CONTRACTS);

const CREATE_FLAGS = toCompletionFlagString(CREATE_FLAG_CONTRACTS);

const GET_FLAGS = toCompletionFlagString(GET_FLAG_CONTRACTS);

const UPDATE_FLAGS = toCompletionFlagString(UPDATE_FLAG_CONTRACTS);

const UPDATE_MANY_FLAGS = toCompletionFlagString(UPDATE_MANY_FLAG_CONTRACTS);

const CLOSE_MANY_FLAGS = toCompletionFlagString(CLOSE_MANY_FLAG_CONTRACTS);

const NAMESPACE_NOUNS = [...new Set(PM_NAMESPACED_COMMAND_ALIASES.map((entry) => entry.canonical_argv[0]))];

const NAMESPACE_PREFIXES = [...new Set(PM_NAMESPACED_COMMAND_ALIASES.flatMap((entry) => entry.canonical_argv.slice(0, -1).map((_, index) => entry.canonical_argv.slice(0, index + 1).join(" "))))];

const PACKAGE_NAMESPACE_OPERATIONS = new Set(PM_COMMAND_DESTINATION_CONTRACTS.filter((entry) => entry.disposition === "package_owned").map((entry) => resolvePmCommandOperation(entry.command)));

const HISTORY_COMPLETION_ALIASES = PM_NAMESPACED_COMMAND_ALIASES.filter((entry) => entry.canonical_argv[0] === "history");

const HISTORY_LEAVES = HISTORY_COMPLETION_ALIASES.map((entry) => entry.canonical_argv[1]).join(" ");

/** Advertise core namespace leaves plus facets supplied by the active package registry. */
function completionNamespaceLeaves(runtime: CompletionRuntimeConfig): Record<string, string> {
  const available = new Set((runtime.namespace_commands ?? []).map(resolvePmCommandOperation));
  const aliases = PM_NAMESPACED_COMMAND_ALIASES.filter((entry) => resolvePmCommandVisibilityTier(entry.canonical) !== "internal" && (!PACKAGE_NAMESPACE_OPERATIONS.has(entry.alias) || available.has(entry.alias)));
  return Object.fromEntries(NAMESPACE_PREFIXES.map((prefix) => [prefix, [...new Set(aliases.filter((entry) => entry.canonical.startsWith(`${prefix} `)).map((entry) => entry.canonical_argv[prefix.split(" ").length]))].join(" ")]));
}

const HISTORY_OPERATION_FLAGS = HISTORY_COMPLETION_ALIASES.map((entry) => ({
  ...entry,
  flags: toCompletionFlagString(resolveSubcommandFlagContractsForCommand(entry.alias)),
}));

const HISTORY_FLAGS = toCompletionFlagString(HISTORY_FLAG_CONTRACTS);

const HISTORY_AUTHOR_ACKNOWLEDGE_FLAGS = toCompletionFlagString(
  HISTORY_AUTHOR_ACKNOWLEDGE_FLAG_CONTRACTS,
  false,
);

const EVENTS_FLAGS = toCompletionFlagString(EVENTS_FLAG_CONTRACTS);

const CALENDAR_FLAGS = toCompletionFlagString(CALENDAR_FLAG_CONTRACTS);

const CONTEXT_FLAGS = toCompletionFlagString(CONTEXT_FLAG_CONTRACTS);

const NEXT_FLAGS = toCompletionFlagString(NEXT_FLAG_CONTRACTS);

const DEPS_FLAGS = toCompletionFlagString(DEPS_FLAG_CONTRACTS);

const DUPLICATES_FLAGS = toCompletionFlagString(DUPLICATES_FLAG_CONTRACTS);

const GRAPH_FLAGS = toCompletionFlagString(GRAPH_FLAG_CONTRACTS);

const GUIDE_FLAGS = toCompletionFlagString(GUIDE_FLAG_CONTRACTS);

const SEARCH_FLAGS = toCompletionFlagString(SEARCH_FLAG_CONTRACTS);

const STATS_FLAGS = toCompletionFlagString(STATS_FLAG_CONTRACTS);

const HEALTH_FLAGS = toCompletionFlagString(HEALTH_FLAG_CONTRACTS);

const INIT_FLAGS = toCompletionFlagString(INIT_FLAG_CONTRACTS);

const CONTRACTS_FLAGS = toCompletionFlagString(CONTRACTS_FLAG_CONTRACTS);

const PLAN_FLAGS = toCompletionFlagString(PLAN_FLAG_CONTRACTS);

const SCHEMA_SUBCOMMAND_CHOICES = `${WORKFLOW_POLICY_ACTIONS.join(" ")} list show show-status add-type remove-type add-status remove-status add-field remove-field list-fields show-field apply-preset rename-type rename-field remap-status`;

const PLAN_SUBCOMMANDS_LIST =
  "create show add-step update-step complete-step block-step reorder-step remove-step link unlink decision discovery validation resume approve materialize";

const COMPLETION_FLAGS = toCompletionFlagString(COMPLETION_FLAG_CONTRACTS);

const COMPLETION_SHELL_CHOICES = `${COMPLETION_FLAGS} bash zsh fish`;

const GUIDE_TOPIC_CHOICES = joinCompletionValues(listGuideTopicIds());

const EXTENSION_LIFECYCLE_ACTIONS =
  "init scaffold install uninstall explore manage describe reload doctor catalog adopt adopt-all activate deactivate migrate";

const PACKAGE_LIFECYCLE_ACTIONS = `${EXTENSION_LIFECYCLE_ACTIONS} upgrade`;

const EXTENSION_LIFECYCLE_FLAGS = toCompletionFlagString(
  EXTENSION_FLAG_CONTRACTS,
);

const PACKAGE_LIFECYCLE_FLAGS = toCompletionFlagString(PACKAGE_FLAG_CONTRACTS);

const UPGRADE_FLAGS = toCompletionFlagString(UPGRADE_FLAG_CONTRACTS);

const MUTATION_FLAGS =
  "--author --message --force --json --quiet --no-changed-fields --id-only --pm-path --path --no-extensions --no-pager --profile --help";

const DELETE_MUTATION_FLAGS =
  "--dry-run --author --message --force --json --quiet --no-changed-fields --id-only --pm-path --path --no-extensions --no-pager --profile --help";

const CLOSE_MUTATION_FLAGS = toCompletionFlagString(resolveSubcommandFlagContractsForCommand("close"));

const CLOSE_TASK_MUTATION_FLAGS = toCompletionFlagString(resolveSubcommandFlagContractsForCommand("close-task"));

const RELEASE_MUTATION_FLAGS = toCompletionFlagString(resolveSubcommandFlagContractsForCommand("release"));

const CLAIM_MUTATION_FLAGS = toCompletionFlagString(resolveSubcommandFlagContractsForCommand("claim"));

const COMMAND_COMPLETION_DESCRIPTIONS = [
  ["init", "Initialize pm storage for the current workspace"],
  ["config", "Read or update pm settings"],
  ["package", "Manage package lifecycle operations"],
  ["packages", "Alias for package"],
  ["create", "Create a new project management item"],
  ["item", "Manage item evidence, links, tests, and duplication"],
  ["copy", "Copy an existing item to a new ID"],
  ["focus", "Set/clear/show the session focused parent for new items"],
  ["list", "List active items with optional filters"],
  [
    "aggregate",
    "Aggregate grouped item counts and numeric stats for governance queries",
  ],
  ["duplicates", "Find bounded duplicate clusters across lifecycle statuses"],
  ["guide", "Browse local progressive-disclosure guides"],
  ["calendar", "Show calendar views for deadlines and reminders"],
  ["cal", "Alias for calendar"],
  ["context", "Show a token-efficient project context snapshot"],
  ["ctx", "Alias for context"],
  ["get", "Show item details by ID"],
  ["next", "Recommend the next actionable (unblocked, ready) work item"],
  ["search", "Search items with keyword, semantic, or hybrid modes"],
  ["reindex", "Rebuild search artifacts"],
  ["history", "Show item history entries"],
  [
    "history-compact",
    "Compact history streams into a synthetic baseline + retained tail",
  ],
  [
    "history-redact",
    "Redact sensitive literals/patterns and recompute history hashes",
  ],
  [
    "history-repair",
    "Re-anchor a drifted history chain so pm health/validate report ok",
  ],
  [
    "schema",
    "Manage custom item types and statuses in .agents/pm/schema/*.json",
  ],
  [
    "profile",
    "List, show, apply, and lint project profiles (archetype schema/config/template/package bundles)",
  ],
  [
    "plan",
    "Agent-optimized Plan item workflow (create/show/add-step/update-step/complete-step/link/approve/materialize)",
  ],
  ["activity", "Show recent activity across items"],
  ["restore", "Restore an item to an earlier state"],
  ["update", "Update item fields and metadata"],
  [
    "update-many",
    "Bulk-update matched items with dry-run and rollback checkpoints",
  ],
  ["close", "Close an item (reason requirement follows governance settings)"],
  [
    "close-many",
    "Bulk-close matched items with an optional shared reason and rollback checkpoint",
  ],
  ["delete", "Delete an item and record the change"],
  ["append", "Append text to an item body"],
  ["comments", "List or add comments for an item"],
  ["notes", "List or add notes for an item"],
  ["learnings", "List or add learnings for an item"],
  ["files", "Manage linked files"],
  ["docs", "Manage linked docs"],
  ["deps", "Show dependency relationships for an item"],
  ["graph", "Bounded graph traversal, analytics, and governance-audit queries"],
  ["test", "Manage linked tests and optionally run them"],
  ["test-all", "Run linked tests across matching items"],
  ["test-runs", "Manage background linked-test runs"],
  ["stats", "Show project tracker statistics"],
  ["health", "Show project tracker health checks"],
  ["validate", "Run standalone validation checks"],
  ["gc", "Clean optional cache artifacts"],
  ["contracts", "Show machine-readable command and schema contracts"],
  ["claim", "Claim an item for active work"],
  ["release", "Release the active claim for an item"],
  ["start-task", "Lifecycle alias to claim and set in_progress"],
  ["pause-task", "Lifecycle alias to reopen and release claim"],
  ["close-task", "Lifecycle alias to close and release claim"],
  ["meet", "Shortcut to create a Meeting with scheduling defaults"],
  ["event", "Shortcut to create an Event with scheduling defaults"],
  ["remind", "Shortcut to create a Reminder from a point in time"],
  ["templates", "Manage reusable create templates"],
  ["completion", "Generate shell completion"],
  ["help", "Display help for a command"],
] as const;

const GLOBAL_FLAGS = GLOBAL_FLAG_CONTRACTS.flatMap((entry) => [
  entry.short,
  entry.flag,
  ...(entry.aliases ?? []),
])
  .filter((value): value is string => Boolean(value))
  .join(" ");

const GLOBAL_COMPLETION_VALUE_PATTERNS = [...GLOBAL_VALUE_CONSUMING_FLAGS].join("|");

const GLOBAL_COMPLETION_INLINE_PATTERNS = [...GLOBAL_VALUE_CONSUMING_FLAGS].map((flag) => `${flag}=*`).join("|");

const GLOBAL_COMPLETION_SWITCH_PATTERNS = [...GLOBAL_FLAGS.split(" ").filter((flag) => !GLOBAL_VALUE_CONSUMING_FLAGS.has(flag)), "-h", "-V"].join("|");

/** Deduplicate, sort and join non-empty completion choices for deterministic output. */
function joinCompletionValues(values: string[]): string {
  return [
    ...new Set(
      values.map((value) => value.trim()).filter((value) => value.length > 0),
    ),
  ]
    .sort((left, right) => left.localeCompare(right))
    .join(" ");
}

function joinCompletionValuesInOrder(values: string[]): string {
  return [
    ...new Set(
      values.map((value) => value.trim()).filter((value) => value.length > 0),
    ),
  ].join(" ");
}

/** Escape shell interpolation characters before embedding a value in a double-quoted resolver fallback. */
function shellDoubleQuote(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`");
}

/** Choose explicit, runtime or built-in item types while retaining their configured order. */
function completionTypeValues(
  itemTypes: string[],
  runtime: CompletionRuntimeConfig,
): string {
  return joinCompletionValuesInOrder(
    itemTypes.length > 0
      ? itemTypes
      : (runtime.item_types ?? DEFAULT_ITEM_TYPES),
  );
}

/** Choose runtime or built-in statuses and normalize them into deterministic completion choices. */
function completionStatusValues(runtime: CompletionRuntimeConfig): string {
  return joinCompletionValues(runtime.statuses ?? DEFAULT_STATUS_VALUES);
}

/** Merge contract-derived flags with runtime schema flags without duplicates. */
function mergeFlagStrings(
  baseFlags: string,
  runtimeFlags: string[] | undefined,
): string {
  const merged = [
    ...baseFlags.split(/\s+/u).filter((value) => value.length > 0),
    ...(runtimeFlags ?? []),
  ];
  return joinCompletionValues(merged);
}

/** Normalize contributed long flags to dashed completion spellings and stable order. */
function normalizeRuntimeCompletionFlags(
  runtimeFlags: string[] | undefined,
): string[] {
  const normalized = (runtimeFlags ?? [])
    .map((value) => value.trim())
    .filter((value) => value.startsWith("--") && value.length > 2)
    .map((value) => `--${value.slice(2).replaceAll("_", "-")}`);
  return [...new Set(normalized)].sort((left, right) =>
    left.localeCompare(right),
  );
}

export { AGGREGATE_FLAGS,ALL_COMMANDS,APPEND_FLAGS,ATTEST_INVOCATIONS,CALENDAR_FLAGS,CLAIM_MUTATION_FLAGS,CLOSE_MANY_FLAGS,CLOSE_MUTATION_FLAGS,CLOSE_TASK_MUTATION_FLAGS,COMMAND_COMPLETION_DESCRIPTIONS,COMPLETION_SHELL_CHOICES,CONTEXT_FLAGS,CONTRACTS_FLAGS,COPY_FLAGS,CREATE_FLAGS,DELETE_MUTATION_FLAGS,DEPS_FLAGS,DUPLICATES_FLAGS,EVENTS_FLAGS,EXTENSION_LIFECYCLE_ACTIONS,EXTENSION_LIFECYCLE_FLAGS,FOCUS_FLAGS,GET_FLAGS,GLOBAL_COMPLETION_INLINE_PATTERNS,GLOBAL_COMPLETION_SWITCH_PATTERNS,GLOBAL_COMPLETION_VALUE_PATTERNS,GLOBAL_FLAGS,GRAPH_FLAGS,GUIDE_FLAGS,GUIDE_TOPIC_CHOICES,HEALTH_FLAGS,HIDDEN_COMMAND_ALIASES,HISTORY_AUTHOR_ACKNOWLEDGE_FLAGS,HISTORY_FLAGS,HISTORY_LEAVES,HISTORY_OPERATION_FLAGS,INIT_FLAGS,LIST_FLAGS,MEET_FLAGS,MUTATION_FLAGS,NAMESPACE_NOUNS,NAMESPACE_PREFIXES,NEXT_FLAGS,PACKAGE_LIFECYCLE_ACTIONS,PACKAGE_LIFECYCLE_FLAGS,PLAN_FLAGS,PLAN_SUBCOMMANDS_LIST,RELEASE_MUTATION_FLAGS,REMIND_FLAGS,RESTORE_INVOCATIONS,SCHEMA_SUBCOMMAND_CHOICES,SEARCH_FLAGS,STATS_FLAGS,UPDATE_FLAGS,UPDATE_MANY_FLAGS,UPGRADE_FLAGS,completionNamespaceLeaves,completionStatusValues,completionTypeValues,joinCompletionValues,mergeFlagStrings,normalizeRuntimeCompletionFlags,shellDoubleQuote };
