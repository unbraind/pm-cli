/**
 * @module cli/commands/contracts
 *
 * Implements the pm contracts command surface and its agent-facing runtime behavior.
 */
import { EXIT_CODE, SETTINGS_DEFAULTS } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import {
  activateExtensions,
  getActiveExtensionRegistrations,
  loadExtensions,
} from "../../core/extensions/index.js";
import type {
  ExtensionRegistrationRegistry,
  RegisteredExtensionCommandDefinition,
  RegisteredExtensionFlagDefinitions,
} from "../../core/extensions/index.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import {
  commandOptionFlagLabel,
  resolveCommandOptionPolicyState,
  resolveItemTypeRegistry,
} from "../../core/item/type-registry.js";
import {
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  type RuntimeFieldRegistry,
} from "../../core/schema/runtime-schema.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import {
  buildMcpToolContracts,
  type McpToolContract,
} from "../../mcp/tool-definitions.js";
import {
  ACTIVITY_COMMANDER_STRING_OPTION_CONTRACTS,
  ACTIVITY_FLAG_CONTRACTS,
  AGGREGATE_FLAG_CONTRACTS,
  APPEND_FLAG_CONTRACTS,
  CALENDAR_COMMANDER_STRING_OPTION_CONTRACTS,
  CALENDAR_FLAG_CONTRACTS,
  CLAIM_FLAG_CONTRACTS,
  CLOSE_TASK_FLAG_CONTRACTS,
  COMMENTS_FLAG_CONTRACTS,
  CLOSE_FLAG_CONTRACTS,
  CLOSE_MANY_FLAG_CONTRACTS,
  COMPLETION_FLAG_CONTRACTS,
  CONFIG_FLAG_CONTRACTS,
  CONTRACTS_FLAG_CONTRACTS,
  CONTEXT_COMMANDER_STRING_OPTION_CONTRACTS,
  CONTEXT_FLAG_CONTRACTS,
  CREATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
  CREATE_COMMANDER_STRING_OPTION_CONTRACTS,
  CREATE_FLAG_CONTRACTS,
  DELETE_FLAG_CONTRACTS,
  DEPS_FLAG_CONTRACTS,
  GRAPH_FLAG_CONTRACTS,
  DOCS_FLAG_CONTRACTS,
  EXTENSION_ACTIVATE_FLAG_CONTRACTS,
  EXTENSION_ADOPT_ALL_FLAG_CONTRACTS,
  EXTENSION_ADOPT_FLAG_CONTRACTS,
  EXTENSION_CATALOG_FLAG_CONTRACTS,
  EXTENSION_DEACTIVATE_FLAG_CONTRACTS,
  EXTENSION_DESCRIBE_FLAG_CONTRACTS,
  EXTENSION_DOCTOR_FLAG_CONTRACTS,
  EXTENSION_EXPLORE_FLAG_CONTRACTS,
  EXTENSION_FLAG_CONTRACTS,
  EXTENSION_INIT_FLAG_CONTRACTS,
  EXTENSION_INSTALL_FLAG_CONTRACTS,
  EXTENSION_MANAGE_FLAG_CONTRACTS,
  EXTENSION_RELOAD_FLAG_CONTRACTS,
  EXTENSION_UNINSTALL_FLAG_CONTRACTS,
  FILES_FLAG_CONTRACTS,
  GC_FLAG_CONTRACTS,
  GET_FLAG_CONTRACTS,
  GUIDE_FLAG_CONTRACTS,
  GLOBAL_FLAG_CONTRACTS,
  HEALTH_FLAG_CONTRACTS,
  HISTORY_FLAG_CONTRACTS,
  HISTORY_COMPACT_FLAG_CONTRACTS,
  HISTORY_REDACT_FLAG_CONTRACTS,
  HISTORY_REPAIR_FLAG_CONTRACTS,
  INSTALL_FLAG_CONTRACTS,
  INIT_FLAG_CONTRACTS,
  LEARNINGS_FLAG_CONTRACTS,
  LIST_COMMANDER_STRING_OPTION_CONTRACTS,
  LIST_FILTER_FLAG_CONTRACTS,
  NOTES_FLAG_CONTRACTS,
  PACKAGE_FLAG_CONTRACTS,
  PACKAGE_INIT_FLAG_CONTRACTS,
  PM_EXTENSION_CAPABILITY_CONTRACTS,
  PM_EXTENSION_POLICY_MODE_CONTRACTS,
  PM_EXTENSION_POLICY_SURFACE_CONTRACTS,
  PM_EXTENSION_SANDBOX_PROFILE_CONTRACTS,
  PM_EXTENSION_SERVICE_NAME_CONTRACTS,
  PM_EXTENSION_TRUST_MODE_CONTRACTS,
  PLAN_FLAG_CONTRACTS,
  PM_CORE_COMMAND_NAMES,
  PM_TOOL_ACTIONS,
  PM_TOOL_PARAMETERS_SCHEMA,
  REINDEX_FLAG_CONTRACTS,
  RELEASE_FLAG_CONTRACTS,
  RESTORE_FLAG_CONTRACTS,
  SCHEMA_FLAG_CONTRACTS,
  PROFILE_FLAG_CONTRACTS,
  SEARCH_COMMANDER_STRING_OPTION_CONTRACTS,
  EVAL_FLAG_CONTRACTS,
  NEXT_FLAG_CONTRACTS,
  SEARCH_FLAG_CONTRACTS,
  STATS_FLAG_CONTRACTS,
  START_TASK_FLAG_CONTRACTS,
  PAUSE_TASK_FLAG_CONTRACTS,
  TELEMETRY_FLAG_CONTRACTS,
  TEST_ALL_FLAG_CONTRACTS,
  TEST_FLAG_CONTRACTS,
  TEST_RUNS_FLAG_CONTRACTS,
  UPDATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
  UPDATE_COMMANDER_STRING_OPTION_CONTRACTS,
  UPDATE_FLAG_CONTRACTS,
  UPDATE_MANY_FLAG_CONTRACTS,
  UPGRADE_FLAG_CONTRACTS,
  VALIDATE_FLAG_CONTRACTS,
  compactFlagAliasContracts,
  withFlagAliasMetadata,
  type CliFlagContract,
  type CommanderOptionAliasContract,
} from "../../sdk/cli-contracts.js";

/** Documents the contracts command options payload exchanged by command, SDK, and package integrations. */
export interface ContractsCommandOptions {
  /** Value that configures or reports action for this contract. */
  action?: string;
  /** Value that configures or reports command for this contract. */
  command?: string;
  /** Value that configures or reports summary for this contract. */
  summary?: boolean;
  /** Value that configures or reports schema only for this contract. */
  schemaOnly?: boolean;
  /** Value that configures or reports flags only for this contract. */
  flagsOnly?: boolean;
  /** Value that configures or reports availability only for this contract. */
  availabilityOnly?: boolean;
  /** Value that configures or reports runtime only for this contract. */
  runtimeOnly?: boolean;
  /** Value that configures or reports full for this contract. */
  full?: boolean;
}

interface CommandFlagSurface {
  command: string;
  flags: CliFlagContract[];
  provider?: "core" | "extension" | "mixed";
  extension_sources?: Array<{
    layer: "global" | "project";
    name: string;
  }>;
}

interface CommandAliasSurface {
  canonical: string;
  aliases: string[];
}

/** Documents the contracts result payload exchanged by command, SDK, and package integrations. */
export interface ContractsResult {
  /** Value that configures or reports schema version for this contract. */
  schema_version: string | null;
  /** Value that configures or reports schema id for this contract. */
  schema_id: string | null;
  /** Value that configures or reports selected for this contract. */
  selected: {
    action: string | null;
    command: string | null;
    summary: boolean;
    schema_only: boolean;
    flags_only: boolean;
    availability_only: boolean;
    runtime_only: boolean;
    command_scoped: boolean;
  };
  /** Value that configures or reports actions for this contract. */
  actions?: string[];
  /** Value that configures or reports action availability for this contract. */
  action_availability?: ContractsActionAvailability[];
  /** Value that configures or reports commands for this contract. */
  commands: string[];
  /** Value that configures or reports schema for this contract. */
  schema?: Record<string, unknown>;
  /** Value that configures or reports schema omitted reason for this contract. */
  schema_omitted_reason?: string;
  /** Value that configures or reports command flags omitted reason for this contract. */
  command_flags_omitted_reason?: string;
  /** Value that configures or reports commander aliases omitted reason for this contract. */
  commander_aliases_omitted_reason?: string;
  /** Value that configures or reports command flags for this contract. */
  command_flags?: CommandFlagSurface[];
  /** Value that configures or reports command aliases for this contract. */
  command_aliases?: CommandAliasSurface[];
  /** Value that configures or reports commander aliases for this contract. */
  commander_aliases?: Record<string, CommanderOptionAliasContract[]>;
  /** Value that configures or reports extension commands for this contract. */
  extension_commands?: ExtensionCommandContract[];
  /** Value that configures or reports command summaries for this contract. */
  command_summaries?: CommandSummarySurface[];
  /** Value that configures or reports runtime schema for this contract. */
  runtime_schema?: {
    statuses: string[];
    open_status: string;
    close_status: string;
    canceled_status: string;
    types: string[];
    fields_by_command: Record<string, string[]>;
  };
  /** Value that configures or reports extension contracts for this contract. */
  extension_contracts?: {
    capabilities: string[];
    services: string[];
    policy_modes: string[];
    policy_surfaces: string[];
    trust_modes: string[];
    sandbox_profiles: string[];
    manifest_versions: number[];
    compatibility: {
      current: string;
      previous: string[];
      breaking_strategy: string;
    };
  };
  // pm-4os2: static MCP tool surface (tool names, required fields, inputSchema
  // shapes) so the contract golden file catches unintended MCP schema drift.
  // Emitted with --full only — the snapshot script runs `pm contracts --full`.
  /** Value that configures or reports mcp tools for this contract. */
  mcp_tools?: McpToolContract[];
}

type PmToolAction = (typeof PM_TOOL_ACTIONS)[number];

/** Documents the contracts action availability payload exchanged by command, SDK, and package integrations. */
export interface ContractsActionAvailability {
  /** Value that configures or reports action for this contract. */
  action: string;
  /** Value that configures or reports invocable for this contract. */
  invocable: boolean;
  /** Value that configures or reports available for this contract. */
  available: boolean;
  /** Value that configures or reports requires extension for this contract. */
  requires_extension: boolean;
  /** Value that configures or reports provider for this contract. */
  provider: "core" | "extension";
  /** Value that configures or reports disabled reason for this contract. */
  disabled_reason: string | null;
  /** Filesystem path used for command resolution. */
  command_path: string | null;
  /** Value that configures or reports cli exposed for this contract. */
  cli_exposed: boolean;
  /** Value that configures or reports policy state for this contract. */
  policy_state?: {
    mode: string;
    trust_mode: string;
    default_sandbox_profile: string;
  };
}

interface RuntimeExtensionActionProbe {
  handlers: Set<string>;
  disabledReason: string | null;
  commandDefinitions: RegisteredExtensionCommandDefinition[];
  flagRegistrations: RegisteredExtensionFlagDefinitions[];
  registrations: ExtensionRegistrationRegistry | null;
  policyState: {
    mode: string;
    trust_mode: string;
    default_sandbox_profile: string;
  };
}

interface ExtensionCommandContract {
  command: string;
  action: string;
  source: {
    layer: "global" | "project";
    name: string;
  } | null;
  description: string | null;
  intent: string | null;
  arguments: Array<{
    name: string;
    required: boolean;
    variadic: boolean;
    description: string | null;
  }>;
  flags: CliFlagContract[];
  examples: string[];
  failure_hints: string[];
}

interface CommandSummarySurface {
  command: string;
  intent: string;
}

const LIST_COMMAND_NAMES = new Set([
  "list",
  "list-all",
  "list-draft",
  "list-open",
  "list-in-progress",
  "list-blocked",
  "list-closed",
  "list-canceled",
]);

const PACKAGE_OWNED_ACTIONS = new Set<string>([
  "calendar",
  "guide",
  "reindex",
  "completion",
  "test-runs-list",
  "test-runs-status",
  "test-runs-logs",
  "test-runs-stop",
  "test-runs-resume",
  "templates-list",
  "templates-save",
  "templates-show",
]);

const PACKAGE_OWNED_COMMANDS = new Set<string>([
  "cal",
  "calendar",
  "completion",
  "completion-statuses",
  "completion-tags",
  "completion-types",
  "guide",
  "reindex",
  "templates",
  "templates list",
  "templates save",
  "templates show",
  "test-runs",
  "test-runs list",
  "test-runs status",
  "test-runs logs",
  "test-runs stop",
  "test-runs resume",
]);

const PACKAGE_OWNED_COMMAND_INSTALL_HINTS = new Map<string, string>([
  ["cal", "calendar"],
  ["calendar", "calendar"],
  ["completion", "guide-shell"],
  ["completion-statuses", "guide-shell"],
  ["completion-tags", "guide-shell"],
  ["completion-types", "guide-shell"],
  ["guide", "guide-shell"],
  ["reindex", "search-advanced"],
  ["templates", "templates"],
  ["templates list", "templates"],
  ["templates save", "templates"],
  ["templates show", "templates"],
  ["test-runs", "linked-test-adapters"],
  ["test-runs list", "linked-test-adapters"],
  ["test-runs status", "linked-test-adapters"],
  ["test-runs logs", "linked-test-adapters"],
  ["test-runs stop", "linked-test-adapters"],
  ["test-runs resume", "linked-test-adapters"],
]);

const PACKAGE_OWNED_ACTION_COMMAND_PATHS = new Map<string, string>([
  ["calendar", "calendar|cal"],
  ["guide", "guide"],
  ["reindex", "reindex"],
  ["completion", "completion"],
  ["test-runs-list", "test-runs|test-runs list"],
  ["test-runs-status", "test-runs status"],
  ["test-runs-logs", "test-runs logs"],
  ["test-runs-stop", "test-runs stop"],
  ["test-runs-resume", "test-runs resume"],
  ["templates-list", "templates|templates list"],
  ["templates-save", "templates save"],
  ["templates-show", "templates show"],
]);

const PACKAGE_OWNED_COMMAND_ACTIONS = new Map(
  [...PACKAGE_OWNED_ACTION_COMMAND_PATHS.entries()].flatMap(
    ([action, commandPaths]) =>
      splitCommandPathAliases(commandPaths).map(
        (commandPath) => [commandPath, action] as const,
      ),
  ),
);

const CANONICAL_COMMAND_ALIASES: CommandAliasSurface[] = [
  {
    canonical: "context",
    aliases: ["ctx"],
  },
  {
    canonical: "package",
    aliases: ["extension", "packages", "install"],
  },
];

const COMMAND_ALIAS_TO_CANONICAL = new Map(
  CANONICAL_COMMAND_ALIASES.flatMap((entry) =>
    entry.aliases.map((alias) => [alias, entry.canonical] as const),
  ),
);

const COMMAND_NAMESPACE_DISPLAY_LIMIT = 10;
const COMMAND_NAMESPACE_FALLBACK_LIMIT = 20;

const COMMAND_INTENTS = new Map<string, string>([
  ["activity", "Read activity."],
  ["aggregate", "Group counts."],
  ["append", "Append body."],
  ["claim", "Claim work."],
  ["close", "Close work."],
  ["comments", "Manage comments."],
  ["completion", "Generate shell completions."],
  ["config", "Manage settings."],
  ["context", "Build context."],
  ["contracts", "Inspect contracts."],
  ["copy", "Copy work."],
  ["create", "Create work."],
  ["delete", "Delete work."],
  ["deps", "Manage deps."],
  ["docs", "Link docs."],
  ["files", "Link files."],
  ["focus", "Manage focus."],
  ["gc", "Clean caches."],
  ["get", "Read item."],
  ["graph", "Query graph."],
  ["guide", "Show user guides."],
  ["health", "Check health."],
  ["help", "Show help."],
  ["history", "Inspect history."],
  ["init", "Initialize workspace."],
  ["install", "Install packages."],
  ["learnings", "Manage learnings."],
  ["list", "List work."],
  ["next", "Pick next work."],
  ["notes", "Manage notes."],
  ["ops", "Run operations."],
  ["package", "Manage packages."],
  ["plan", "Manage plans."],
  ["profile", "Manage profiles."],
  ["reindex", "Refresh search index."],
  ["release", "Release claim."],
  ["restore", "Restore history."],
  ["schema", "Customize schema."],
  ["search", "Search work."],
  ["stats", "Show stats."],
  ["telemetry", "Manage telemetry."],
  ["test", "Run linked tests."],
  ["update", "Update work."],
  ["upgrade", "Upgrade packages."],
  ["validate", "Validate data."],
]);

// Lifecycle subcommand flag contracts for `pm extension`. Only `init` differs
// between extension and package: `pm package init` / `pm packages init`
// additionally accept the package-only `--declarative` flag, so the package
// variant swaps in PACKAGE_INIT_FLAG_CONTRACTS while every other subcommand is
// shared verbatim.
const EXTENSION_LIFECYCLE_FLAG_CONTRACTS: Array<
  readonly [string, CliFlagContract[]]
> = [
  ["init", EXTENSION_INIT_FLAG_CONTRACTS],
  ["install", EXTENSION_INSTALL_FLAG_CONTRACTS],
  ["uninstall", EXTENSION_UNINSTALL_FLAG_CONTRACTS],
  ["explore", EXTENSION_EXPLORE_FLAG_CONTRACTS],
  ["manage", EXTENSION_MANAGE_FLAG_CONTRACTS],
  ["describe", EXTENSION_DESCRIBE_FLAG_CONTRACTS],
  ["reload", EXTENSION_RELOAD_FLAG_CONTRACTS],
  ["doctor", EXTENSION_DOCTOR_FLAG_CONTRACTS],
  ["catalog", EXTENSION_CATALOG_FLAG_CONTRACTS],
  ["adopt", EXTENSION_ADOPT_FLAG_CONTRACTS],
  ["adopt-all", EXTENSION_ADOPT_ALL_FLAG_CONTRACTS],
  ["activate", EXTENSION_ACTIVATE_FLAG_CONTRACTS],
  ["deactivate", EXTENSION_DEACTIVATE_FLAG_CONTRACTS],
];

const PACKAGE_LIFECYCLE_FLAG_CONTRACTS: Array<
  readonly [string, CliFlagContract[]]
> = EXTENSION_LIFECYCLE_FLAG_CONTRACTS.map(([subcommand, flags]) =>
  subcommand === "init"
    ? ([subcommand, PACKAGE_INIT_FLAG_CONTRACTS] as const)
    : ([subcommand, flags] as const),
);

const CORE_COMMAND_FLAG_CONTRACT_ENTRIES: Array<
  readonly [string, CliFlagContract[]]
> = [
  ...EXTENSION_LIFECYCLE_FLAG_CONTRACTS.map(
    ([subcommand, flags]) => [`extension ${subcommand}`, flags] as const,
  ),
  ...PACKAGE_LIFECYCLE_FLAG_CONTRACTS.flatMap(([subcommand, flags]) => [
    [`package ${subcommand}`, flags] as const,
    [`packages ${subcommand}`, flags] as const,
  ]),
  ["init", INIT_FLAG_CONTRACTS],
  ["config", CONFIG_FLAG_CONTRACTS],
  ["extension", EXTENSION_FLAG_CONTRACTS],
  ["package", PACKAGE_FLAG_CONTRACTS],
  ["packages", PACKAGE_FLAG_CONTRACTS],
  ["install", INSTALL_FLAG_CONTRACTS],
  ["create", CREATE_FLAG_CONTRACTS],
  ["update", UPDATE_FLAG_CONTRACTS],
  ["update-many", UPDATE_MANY_FLAG_CONTRACTS],
  ["upgrade", UPGRADE_FLAG_CONTRACTS],
  ["calendar", CALENDAR_FLAG_CONTRACTS],
  ["cal", CALENDAR_FLAG_CONTRACTS],
  ["context", CONTEXT_FLAG_CONTRACTS],
  ["ctx", CONTEXT_FLAG_CONTRACTS],
  ["get", GET_FLAG_CONTRACTS],
  ["search", SEARCH_FLAG_CONTRACTS],
  ["eval", EVAL_FLAG_CONTRACTS],
  ["next", NEXT_FLAG_CONTRACTS],
  ["aggregate", AGGREGATE_FLAG_CONTRACTS],
  ["deps", DEPS_FLAG_CONTRACTS],
  ["graph", GRAPH_FLAG_CONTRACTS],
  ["guide", GUIDE_FLAG_CONTRACTS],
  ["reindex", REINDEX_FLAG_CONTRACTS],
  ["history", HISTORY_FLAG_CONTRACTS],
  ["history-compact", HISTORY_COMPACT_FLAG_CONTRACTS],
  ["history-redact", HISTORY_REDACT_FLAG_CONTRACTS],
  ["history-repair", HISTORY_REPAIR_FLAG_CONTRACTS],
  ["schema", SCHEMA_FLAG_CONTRACTS],
  ["profile", PROFILE_FLAG_CONTRACTS],
  ["plan", PLAN_FLAG_CONTRACTS],
  ["restore", RESTORE_FLAG_CONTRACTS],
  ["delete", DELETE_FLAG_CONTRACTS],
  ["close", CLOSE_FLAG_CONTRACTS],
  ["close-many", CLOSE_MANY_FLAG_CONTRACTS],
  ["append", APPEND_FLAG_CONTRACTS],
  ["claim", CLAIM_FLAG_CONTRACTS],
  ["release", RELEASE_FLAG_CONTRACTS],
  ["start-task", START_TASK_FLAG_CONTRACTS],
  ["pause-task", PAUSE_TASK_FLAG_CONTRACTS],
  ["close-task", CLOSE_TASK_FLAG_CONTRACTS],
  ["comments", COMMENTS_FLAG_CONTRACTS],
  ["notes", NOTES_FLAG_CONTRACTS],
  ["learnings", LEARNINGS_FLAG_CONTRACTS],
  ["files", FILES_FLAG_CONTRACTS],
  ["docs", DOCS_FLAG_CONTRACTS],
  ["test", TEST_FLAG_CONTRACTS],
  ["test-all", TEST_ALL_FLAG_CONTRACTS],
  ["telemetry", TELEMETRY_FLAG_CONTRACTS],
  ["test-runs", TEST_RUNS_FLAG_CONTRACTS],
  ["gc", GC_FLAG_CONTRACTS],
  ["stats", STATS_FLAG_CONTRACTS],
  ["validate", VALIDATE_FLAG_CONTRACTS],
  ["health", HEALTH_FLAG_CONTRACTS],
  ["contracts", CONTRACTS_FLAG_CONTRACTS],
  ["completion", COMPLETION_FLAG_CONTRACTS],
  ["activity", ACTIVITY_FLAG_CONTRACTS],
  ...[...LIST_COMMAND_NAMES].map(
    (command) => [command, LIST_FILTER_FLAG_CONTRACTS] as const,
  ),
];

const CORE_COMMAND_FLAG_CONTRACTS_BY_COMMAND = new Map(
  CORE_COMMAND_FLAG_CONTRACT_ENTRIES,
);

/* c8 ignore start -- extension contract shaping utilities are exercised by dedicated extension/runtime integration suites. */
function packageOwnedActionForCommand(command: string): string {
  const exactAction = PACKAGE_OWNED_COMMAND_ACTIONS.get(command);
  if (exactAction) {
    return exactAction;
  }
  if (command.startsWith("test-runs ")) {
    return `test-runs-${command.slice("test-runs ".length)}`;
  }
  if (command.startsWith("templates ")) {
    return `templates-${command.slice("templates ".length)}`;
  }
  return command;
}

function resolveActionCommandPath(action: PmToolAction): string | null {
  if (
    PM_CORE_COMMAND_NAMES.includes(
      action as (typeof PM_CORE_COMMAND_NAMES)[number],
    )
  ) {
    return normalizeCommandPath(action);
  }
  if (action.startsWith("extension-")) {
    return normalizeCommandPath(
      `extension ${action.slice("extension-".length)}`,
    );
  }
  if (action.startsWith("package-")) {
    return normalizeCommandPath(`package ${action.slice("package-".length)}`);
  }
  if (action.startsWith("test-runs-")) {
    return normalizeCommandPath(
      `test-runs ${action.slice("test-runs-".length)}`,
    );
  }
  if (action.startsWith("templates-")) {
    return normalizeCommandPath(
      `templates ${action.slice("templates-".length)}`,
    );
  }
  if (PACKAGE_OWNED_ACTIONS.has(action)) {
    return (
      PACKAGE_OWNED_ACTION_COMMAND_PATHS.get(action) ??
      normalizeCommandPath(action)
    );
  }
  return null;
}

function actionDescriptorMatchesSelectedCommand(
  descriptor: ActionContractDescriptor,
  selectedCommand: string,
): boolean {
  if (descriptor.command_path === null) {
    return false;
  }
  return splitCommandPathAliases(descriptor.command_path).some(
    (commandPath) => {
      if (commandPath === selectedCommand) {
        return true;
      }
      return commandPath.startsWith(`${selectedCommand} `);
    },
  );
}

function splitCommandPathAliases(commandPath: string): string[] {
  return commandPath
    .split("|")
    .map((entry) => normalizeCommandPath(entry))
    .filter((entry) => entry.length > 0);
}

function resolveScopedCommandsFromActionDescriptors(
  descriptors: ActionContractDescriptor[],
  commandCatalog: string[],
): string[] {
  const commandSet = new Set(commandCatalog);
  const scoped = new Set<string>();
  for (const descriptor of descriptors) {
    if (!descriptor.command_path) {
      continue;
    }
    for (const commandPath of splitCommandPathAliases(
      descriptor.command_path,
    )) {
      const tokens = commandPath.split(" ").filter((entry) => entry.length > 0);
      if (tokens.length === 0) {
        continue;
      }
      for (let end = tokens.length; end > 0; end -= 1) {
        const candidate = tokens.slice(0, end).join(" ");
        if (!commandSet.has(candidate)) {
          continue;
        }
        scoped.add(candidate);
        break;
      }
    }
  }
  return [...scoped].sort((left, right) => left.localeCompare(right));
}

function normalizeToken(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractActionBranches(
  schema: Record<string, unknown>,
): Record<string, unknown>[] {
  const oneOf = schema.oneOf;
  if (!Array.isArray(oneOf)) {
    return [];
  }
  return oneOf.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null,
  );
}

function filterSchemaByAction(
  schema: Record<string, unknown>,
  action: string | undefined,
): Record<string, unknown> {
  if (!action) {
    return { ...schema };
  }
  const branches = extractActionBranches(schema);
  const filtered = branches.filter((entry) => {
    const properties = entry.properties;
    if (typeof properties !== "object" || properties === null) {
      return false;
    }
    const actionProperty = (properties as Record<string, unknown>).action;
    if (typeof actionProperty !== "object" || actionProperty === null) {
      return false;
    }
    return (actionProperty as { const?: unknown }).const === action;
  });
  return {
    ...schema,
    oneOf: filtered,
  };
}

function filterSchemaByActions(
  schema: Record<string, unknown>,
  actions: ReadonlySet<string>,
): Record<string, unknown> {
  const branches = extractActionBranches(schema);
  const filtered = branches.filter((entry) => {
    const properties = entry.properties;
    if (typeof properties !== "object" || properties === null) {
      return false;
    }
    const actionProperty = (properties as Record<string, unknown>).action;
    if (typeof actionProperty !== "object" || actionProperty === null) {
      return false;
    }
    const actionConst = (actionProperty as { const?: unknown }).const;
    return typeof actionConst === "string" && actions.has(actionConst);
  });
  return {
    ...schema,
    oneOf: filtered,
  };
}

function normalizeCommandPath(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((entry) => entry.length > 0)
    .join(" ");
}

function normalizeActionNameFromCommand(commandPath: string): string {
  return commandPath.replace(/\s+/g, "-");
}

function toOptionalTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringList(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = toOptionalTrimmedString(value);
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function assignExtensionFlagBoolean(
  contract: CliFlagContract,
  key: "required" | "repeatable" | "list",
  enabled: boolean,
): void {
  if (enabled) {
    contract[key] = true;
  }
}

function normalizeExtensionFlagName(
  value: unknown,
  kind: "long" | "short",
): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError("Expected string for extension flag name.");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (kind === "long") {
    return trimmed.startsWith("--") && trimmed.length > 2 ? trimmed : null;
  }
  return trimmed.startsWith("-") &&
    !trimmed.startsWith("--") &&
    trimmed.length > 1
    ? trimmed
    : null;
}

function toExtensionFlagContract(
  definition: Record<string, unknown>,
): CliFlagContract | null {
  const normalizedLong = normalizeExtensionFlagName(definition.long, "long");
  const normalizedShort = normalizeExtensionFlagName(definition.short, "short");
  const flag = normalizedLong ?? normalizedShort;
  if (!flag) {
    return null;
  }
  const contract: CliFlagContract = { flag };
  if (normalizedShort && normalizedLong) {
    contract.short = normalizedShort;
  }
  assignExtensionFlagBoolean(
    contract,
    "required",
    definition.required === true,
  );
  assignExtensionFlagBoolean(
    contract,
    "repeatable",
    definition.repeatable === true,
  );
  assignExtensionFlagBoolean(contract, "list", definition.list === true);
  const description = toOptionalTrimmedString(definition.description);
  if (description) {
    contract.description = description;
  }
  const valueName = toOptionalTrimmedString(definition.value_name);
  if (valueName) {
    contract.value_name = valueName;
  }
  const rawValueType = [
    toOptionalTrimmedString(definition.value_type),
    toOptionalTrimmedString(definition.type),
    valueName ? "string" : null,
  ].find(
    (candidate): candidate is "string" | "number" | "boolean" =>
      candidate === "string" ||
      candidate === "number" ||
      candidate === "boolean",
  );
  if (rawValueType) {
    contract.value_type = rawValueType;
  }
  return contract;
}

function collectExtensionFlagContractsByCommand(
  registrations: RegisteredExtensionFlagDefinitions[],
): Map<
  string,
  {
    flags: CliFlagContract[];
    sources: Array<{ layer: "global" | "project"; name: string }>;
  }
> {
  const grouped = new Map<
    string,
    {
      flags: CliFlagContract[];
      sources: Array<{ layer: "global" | "project"; name: string }>;
      dedupe: Set<string>;
      sourceDedupe: Set<string>;
    }
  >();
  for (const registration of registrations) {
    const commandPath = normalizeCommandPath(registration.target_command);
    if (commandPath.length === 0) {
      continue;
    }
    const bucket = grouped.get(commandPath) ?? {
      flags: [],
      sources: [],
      dedupe: new Set<string>(),
      sourceDedupe: new Set<string>(),
    };
    const sourceKey = `${registration.layer}:${registration.name}`;
    if (!bucket.sourceDedupe.has(sourceKey)) {
      bucket.sourceDedupe.add(sourceKey);
      bucket.sources.push({
        layer: registration.layer,
        name: registration.name,
      });
    }
    for (const definition of registration.flags) {
      const contract = toExtensionFlagContract(definition);
      if (!contract) {
        continue;
      }
      const key = `${contract.flag}|${contract.short ?? ""}`;
      if (bucket.dedupe.has(key)) {
        continue;
      }
      bucket.dedupe.add(key);
      bucket.flags.push(contract);
    }
    grouped.set(commandPath, bucket);
  }
  const normalized = new Map<
    string,
    {
      flags: CliFlagContract[];
      sources: Array<{ layer: "global" | "project"; name: string }>;
    }
  >();
  for (const [commandPath, bucket] of grouped.entries()) {
    normalized.set(commandPath, {
      flags: bucket.flags,
      sources: bucket.sources.sort((left, right) => {
        const layerOrder = left.layer.localeCompare(right.layer);
        if (layerOrder !== 0) {
          return layerOrder;
        }
        return (left.name ?? "").localeCompare(right.name ?? "");
      }),
    });
  }
  return normalized;
}

function collectExtensionCommandContracts(
  runtimeProbe: RuntimeExtensionActionProbe,
): ExtensionCommandContract[] {
  const flagsByCommand = collectExtensionFlagContractsByCommand(
    runtimeProbe.flagRegistrations,
  );
  const definitionsByCommand = new Map<string, ExtensionCommandContract>();
  for (const definition of runtimeProbe.commandDefinitions) {
    const command = normalizeCommandPath(definition.command);
    if (command.length === 0) {
      continue;
    }
    const action =
      toOptionalTrimmedString(definition.action) ??
      normalizeActionNameFromCommand(command);
    const args = Array.isArray(definition.arguments)
      ? definition.arguments
          .map((argument) => {
            const name = toOptionalTrimmedString(argument.name);
            if (!name) {
              return null;
            }
            return {
              name,
              required: argument.required === true,
              variadic: argument.variadic === true,
              description: toOptionalTrimmedString(argument.description),
            };
          })
          .filter(
            (
              argument,
            ): argument is {
              name: string;
              required: boolean;
              variadic: boolean;
              description: string | null;
            } => argument !== null,
          )
      : [];
    definitionsByCommand.set(command, {
      command,
      action,
      source: {
        layer: definition.layer,
        name: definition.name,
      },
      description: toOptionalTrimmedString(definition.description),
      intent: toOptionalTrimmedString(definition.intent),
      arguments: args,
      flags: flagsByCommand.get(command)?.flags ?? [],
      examples: normalizeStringList(definition.examples),
      failure_hints: normalizeStringList(definition.failure_hints),
    });
  }

  const extensionCommands = new Set<string>();
  for (const command of runtimeProbe.handlers) {
    extensionCommands.add(normalizeCommandPath(command));
  }
  for (const command of definitionsByCommand.keys()) {
    extensionCommands.add(command);
  }
  for (const command of flagsByCommand.keys()) {
    extensionCommands.add(command);
  }

  const contracts: ExtensionCommandContract[] = [];
  for (const command of [...extensionCommands].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const definition = definitionsByCommand.get(command);
    if (definition) {
      contracts.push({
        ...definition,
        flags:
          definition.flags.length > 0
            ? definition.flags
            : (flagsByCommand.get(command)?.flags ?? []),
      });
      continue;
    }
    contracts.push({
      command,
      action: normalizeActionNameFromCommand(command),
      source: null,
      description: null,
      intent: null,
      arguments: [],
      flags: flagsByCommand.get(command)?.flags ?? [],
      examples: [],
      failure_hints: [],
    });
  }
  return contracts;
}

function extensionSchemaPropertyNameFromFlag(
  flag: CliFlagContract,
): string | null {
  const normalized = flag.flag.replace(/^-+/, "").trim();
  if (normalized.length === 0) {
    return null;
  }
  const camelCased = normalized.replace(
    /-([a-z0-9])/g,
    (_match, char: string) => char.toUpperCase(),
  );
  const cleaned = camelCased.replace(/[^a-zA-Z0-9]/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

function buildExtensionArgumentSchema(
  argument: ExtensionCommandContract["arguments"][number],
  action: string,
): Record<string, unknown> {
  if (argument.variadic) {
    return {
      type: "array",
      items: { type: "string" },
      description:
        argument.description ??
        `Variadic argument '${argument.name}' for extension action '${action}'.`,
    };
  }
  return {
    type: "string",
    description:
      argument.description ??
      `Argument '${argument.name}' for extension action '${action}'.`,
  };
}

function buildExtensionFlagSchema(
  flag: CliFlagContract,
  action: string,
): Record<string, unknown> {
  const valueType = flag.value_type ?? "boolean";
  const schemaType =
    valueType === "boolean"
      ? "boolean"
      : valueType === "number"
        ? ["number", "string"]
        : "string";
  const acceptsMultipleValues = flag.repeatable === true || flag.list === true;
  return {
    type: acceptsMultipleValues ? "array" : schemaType,
    ...(acceptsMultipleValues ? { items: { type: schemaType } } : {}),
    description:
      flag.description ??
      `Extension option '${flag.flag}' for action '${action}'.`,
  };
}

function buildExtensionActionSchemaBranch(
  contract: ExtensionCommandContract,
): Record<string, unknown> {
  const commands = contract.command
    .split("|")
    .map((command) => command.trim())
    .filter((command) => command.length > 0);
  const properties: Record<string, unknown> = {
    action: {
      type: "string",
      const: contract.action,
      description:
        contract.intent ??
        contract.description ??
        `Invoke extension command '${contract.command}'.`,
    },
  };
  const required: string[] = ["action"];
  for (const argument of contract.arguments) {
    properties[argument.name] = buildExtensionArgumentSchema(
      argument,
      contract.action,
    );
    if (argument.required) {
      required.push(argument.name);
    }
  }
  for (const flag of contract.flags) {
    const propertyName = extensionSchemaPropertyNameFromFlag(flag);
    if (!propertyName || properties[propertyName] !== undefined) {
      continue;
    }
    properties[propertyName] = buildExtensionFlagSchema(flag, contract.action);
    if (flag.required === true) {
      required.push(propertyName);
    }
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: true,
    "x-extension-source": contract.source,
    "x-extension-command": commands[0] ?? contract.command,
    "x-extension-commands": commands,
  };
}

function mergeExtensionFlagContract(
  existing: CliFlagContract,
  incoming: CliFlagContract,
): void {
  existing.description ??= incoming.description;
  existing.value_name ??= incoming.value_name;
  existing.value_type ??= incoming.value_type;
  if (incoming.required === true) {
    existing.required = true;
  }
  if (incoming.repeatable === true) {
    existing.repeatable = true;
  }
}

function mergeExtensionContractsByAction(
  contracts: ExtensionCommandContract[],
): ExtensionCommandContract[] {
  const byAction = new Map<string, ExtensionCommandContract>();
  for (const contract of contracts) {
    const existing = byAction.get(contract.action);
    if (!existing) {
      byAction.set(contract.action, {
        ...contract,
        flags: [...contract.flags],
        examples: [...contract.examples],
        failure_hints: [...contract.failure_hints],
      });
      continue;
    }
    existing.command = [...new Set([existing.command, contract.command])]
      .sort((left, right) => left.localeCompare(right))
      .join("|");
    existing.arguments =
      existing.arguments.length >= contract.arguments.length
        ? existing.arguments
        : contract.arguments;
    const flagKeys = new Set(
      existing.flags.map((flag) => `${flag.flag}|${flag.short ?? ""}`),
    );
    for (const flag of contract.flags) {
      const key = `${flag.flag}|${flag.short ?? ""}`;
      if (!flagKeys.has(key)) {
        flagKeys.add(key);
        existing.flags.push(flag);
      } else {
        const existingFlag = existing.flags.find(
          (candidate) => `${candidate.flag}|${candidate.short ?? ""}` === key,
        );
        if (existingFlag) {
          mergeExtensionFlagContract(existingFlag, flag);
        }
      }
    }
    existing.examples = [
      ...new Set([...existing.examples, ...contract.examples]),
    ];
    existing.failure_hints = [
      ...new Set([...existing.failure_hints, ...contract.failure_hints]),
    ];
  }
  return [...byAction.values()].sort((left, right) =>
    left.action.localeCompare(right.action),
  );
}
/* c8 ignore stop */

async function resolveRuntimeExtensionActionProbe(
  global: GlobalOptions,
): Promise<RuntimeExtensionActionProbe> {
  const defaultPolicyState = {
    mode: SETTINGS_DEFAULTS.extensions.policy.mode,
    trust_mode: SETTINGS_DEFAULTS.extensions.policy.trust_mode,
    default_sandbox_profile:
      SETTINGS_DEFAULTS.extensions.policy.default_sandbox_profile,
  };
  if (global.noExtensions) {
    return {
      handlers: new Set<string>(),
      disabledReason: "extensions_disabled",
      commandDefinitions: [],
      flagRegistrations: [],
      registrations: null,
      policyState: defaultPolicyState,
    };
  }

  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    return {
      handlers: new Set<string>(),
      disabledReason: null,
      commandDefinitions: [],
      flagRegistrations: [],
      registrations: null,
      policyState: defaultPolicyState,
    };
  }

  try {
    const settings = await readSettings(pmRoot);
    const loadResult = await loadExtensions({
      pmRoot,
      settings,
      cwd: process.cwd(),
      noExtensions: false,
    });
    const activationResult = await activateExtensions({
      ...loadResult,
      loaded: loadResult.loaded,
    });
    const handlers = new Set<string>(
      activationResult.commands.handlers.map((entry) =>
        normalizeCommandPath(entry.command),
      ),
    );
    return {
      handlers,
      disabledReason: null,
      commandDefinitions: activationResult.registrations.commands,
      flagRegistrations: activationResult.registrations.flags,
      registrations: activationResult.registrations,
      policyState: {
        mode: loadResult.policy.mode,
        trust_mode: loadResult.policy.trust_mode,
        default_sandbox_profile: loadResult.policy.default_sandbox_profile,
      },
    };
  } catch {
    return {
      handlers: new Set<string>(),
      disabledReason: "extension_runtime_probe_failed",
      commandDefinitions: [],
      flagRegistrations: [],
      registrations: null,
      policyState: defaultPolicyState,
    };
  }
}

interface ActionContractDescriptor {
  action: string;
  provider: "core" | "extension";
  requires_extension: boolean;
  command_path: string | null;
}

function collectActionContractDescriptors(
  extensionContracts: ExtensionCommandContract[],
  options: { includePackageOwnedActions?: boolean } = {},
): ActionContractDescriptor[] {
  /* c8 ignore start -- package-owned action descriptor permutations are covered in package-install integration suites. */
  const descriptors = new Map<string, ActionContractDescriptor>();
  for (const action of PM_TOOL_ACTIONS) {
    const packageOwned = PACKAGE_OWNED_ACTIONS.has(action);
    if (packageOwned && !options.includePackageOwnedActions) {
      continue;
    }
    const commandPath = resolveActionCommandPath(action as PmToolAction);
    descriptors.set(action, {
      action,
      provider: packageOwned ? "extension" : "core",
      requires_extension: packageOwned,
      command_path: commandPath,
    });
  }
  if (options.includePackageOwnedActions) {
    for (const action of PACKAGE_OWNED_ACTIONS) {
      if (descriptors.has(action)) {
        continue;
      }
      descriptors.set(action, {
        action,
        provider: "extension",
        requires_extension: true,
        command_path: resolveActionCommandPath(action as PmToolAction),
      });
    }
  }
  for (const contract of extensionContracts) {
    if (descriptors.has(contract.action)) {
      continue;
    }
    descriptors.set(contract.action, {
      action: contract.action,
      provider: "extension",
      requires_extension: true,
      command_path: normalizeCommandPath(contract.command),
    });
  }
  return [...descriptors.values()].sort((left, right) =>
    (left.action ?? "").localeCompare(right.action ?? ""),
  );
  /* c8 ignore stop */
}

function resolveActionAvailability(
  descriptor: ActionContractDescriptor,
  runtimeProbe: RuntimeExtensionActionProbe,
): ContractsActionAvailability {
  /* c8 ignore start -- runtime extension availability branches are exercised in extension policy integration tests. */
  if (descriptor.provider === "core" && !descriptor.requires_extension) {
    return {
      action: descriptor.action,
      invocable: true,
      available: true,
      requires_extension: false,
      provider: "core",
      disabled_reason: null,
      command_path: descriptor.command_path,
      cli_exposed: descriptor.command_path !== null,
    };
  }

  const commandPaths = descriptor.command_path
    ? splitCommandPathAliases(descriptor.command_path)
    : [];
  const extensionCommandAvailable = commandPaths.some((commandPath) =>
    runtimeProbe.handlers.has(commandPath),
  );
  const optionalPackageHint = commandPaths
    .map((commandPath) => PACKAGE_OWNED_COMMAND_INSTALL_HINTS.get(commandPath))
    .find((hint): hint is string => typeof hint === "string");
  const invocable =
    runtimeProbe.disabledReason === null && extensionCommandAvailable;
  return {
    action: descriptor.action,
    invocable,
    available: invocable,
    requires_extension: true,
    provider: "extension",
    disabled_reason: invocable
      ? null
      : (runtimeProbe.disabledReason ??
        (optionalPackageHint
          ? `optional_package_not_installed:${optionalPackageHint}`
          : "extension_command_not_registered")),
    command_path: descriptor.command_path,
    cli_exposed: extensionCommandAvailable,
    policy_state: {
      mode: runtimeProbe.policyState.mode,
      trust_mode: runtimeProbe.policyState.trust_mode,
      default_sandbox_profile: runtimeProbe.policyState.default_sandbox_profile,
    },
  };
  /* c8 ignore stop */
}

function resolveCoreCommandFlags(command: string): CliFlagContract[] {
  return (
    CORE_COMMAND_FLAG_CONTRACTS_BY_COMMAND.get(command) ?? GLOBAL_FLAG_CONTRACTS
  );
}

function isCoreCommandPath(command: string): boolean {
  if (PACKAGE_OWNED_COMMANDS.has(command)) {
    return false;
  }
  return CORE_COMMAND_FLAG_CONTRACTS_BY_COMMAND.has(command);
}

function normalizeCommandForRuntimeFieldFlags(command: string): string {
  if (LIST_COMMAND_NAMES.has(command)) {
    return "list";
  }
  if (command === "cal") {
    return "calendar";
  }
  if (command === "ctx") {
    return "context";
  }
  if (command === "update-many") {
    return "update_many";
  }
  return command;
}

function toRuntimeLongFlagToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("--")) {
    return trimmed;
  }
  if (trimmed.startsWith("-")) {
    return null;
  }
  return `--${trimmed}`;
}

function toRuntimeShortFlagToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("--")) {
    return null;
  }
  if (trimmed.startsWith("-")) {
    return trimmed;
  }
  return null;
}

function buildRuntimeFieldFlagContracts(
  fieldRegistry: RuntimeFieldRegistry,
): Map<string, CliFlagContract[]> {
  /* c8 ignore start -- runtime-field alias collision branches are validated in schema/runtime flag integration tests. */
  const buckets = new Map<
    string,
    { flags: CliFlagContract[]; seen: Set<string> }
  >();
  for (const definition of fieldRegistry.definitions) {
    const primaryFlag = toRuntimeLongFlagToken(definition.cli_flag);
    if (!primaryFlag) {
      continue;
    }
    const shortAlias = definition.cli_aliases
      .map((alias) => toRuntimeShortFlagToken(alias))
      .find((alias) => alias !== null);
    const longAliases = definition.cli_aliases
      .map((alias) => toRuntimeLongFlagToken(alias))
      .filter(
        (alias): alias is string => alias !== null && alias !== primaryFlag,
      );
    for (const command of definition.commands) {
      const bucket = buckets.get(command) ?? {
        flags: [],
        seen: new Set<string>(),
      };
      const primaryContract: CliFlagContract = shortAlias
        ? { flag: primaryFlag, short: shortAlias }
        : { flag: primaryFlag };
      const primaryKey = `${primaryContract.flag}|${primaryContract.short ?? ""}`;
      if (!bucket.seen.has(primaryKey)) {
        bucket.seen.add(primaryKey);
        bucket.flags.push(primaryContract);
      }
      for (const alias of longAliases) {
        const key = `${alias}|`;
        if (bucket.seen.has(key)) {
          continue;
        }
        bucket.seen.add(key);
        bucket.flags.push({ flag: alias });
      }
      buckets.set(command, bucket);
    }
  }
  const result = new Map<string, CliFlagContract[]>();
  for (const [command, bucket] of buckets.entries()) {
    result.set(command, compactFlagAliasContracts(bucket.flags));
  }
  return result;
  /* c8 ignore stop */
}

function mergeFlagContracts(
  primary: CliFlagContract[],
  secondary: CliFlagContract[],
): CliFlagContract[] {
  /* c8 ignore start -- flag merge dedupe permutations are covered via command-surface integration fixtures. */
  const merged: CliFlagContract[] = [];
  const seen = new Set<string>();
  for (const contract of [...primary, ...secondary]) {
    const key = `${contract.flag}|${contract.short ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(contract);
  }
  return compactFlagAliasContracts(merged);
  /* c8 ignore stop */
}

function buildCommandFlagSurface(
  commands: string[],
  extensionFlagMap: ReturnType<typeof collectExtensionFlagContractsByCommand>,
  runtimeFieldFlagMap: Map<string, CliFlagContract[]>,
): CommandFlagSurface[] {
  return commands
    .map((command) => {
      const isCoreCommand = isCoreCommandPath(command);
      const coreFlags = isCoreCommand ? resolveCoreCommandFlags(command) : [];
      const runtimeFlags =
        runtimeFieldFlagMap.get(
          normalizeCommandForRuntimeFieldFlags(command),
        ) ?? [];
      const extensionFlags = extensionFlagMap.get(command);
      const coreWithRuntime = mergeFlagContracts(coreFlags, runtimeFlags);
      const flags = mergeFlagContracts(
        coreWithRuntime,
        extensionFlags?.flags ?? [],
      );
      const provider: CommandFlagSurface["provider"] =
        coreFlags.length > 0 && (extensionFlags?.flags.length ?? 0) > 0
          ? "mixed"
          : isCoreCommand
            ? "core"
            : "extension";
      return {
        command,
        flags,
        provider,
        extension_sources: extensionFlags?.sources,
      };
    })
    .sort((left, right) => left.command.localeCompare(right.command));
}

function compactCommandAliasSurface(commands: string[]): string[] {
  const commandSet = new Set(commands);
  const result: string[] = [];
  for (const command of commands) {
    const canonical = COMMAND_ALIAS_TO_CANONICAL.get(command);
    if (canonical && commandSet.has(canonical)) {
      continue;
    }
    result.push(command);
  }
  return result;
}

function buildCommandAliasSurface(commands: string[]): CommandAliasSurface[] {
  const commandSet = new Set(commands);
  return CANONICAL_COMMAND_ALIASES.map((entry) => ({
    canonical: entry.canonical,
    aliases: entry.aliases.filter((alias) => commandSet.has(alias)),
  })).filter(
    (entry) => commandSet.has(entry.canonical) && entry.aliases.length > 0,
  );
}

function buildCommanderAliasSurface(): Record<
  string,
  CommanderOptionAliasContract[]
> {
  return {
    create_string_options: CREATE_COMMANDER_STRING_OPTION_CONTRACTS,
    create_repeatable_options: CREATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
    update_string_options: UPDATE_COMMANDER_STRING_OPTION_CONTRACTS,
    update_repeatable_options: UPDATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
    list_string_options: LIST_COMMANDER_STRING_OPTION_CONTRACTS,
    search_string_options: SEARCH_COMMANDER_STRING_OPTION_CONTRACTS,
    calendar_string_options: CALENDAR_COMMANDER_STRING_OPTION_CONTRACTS,
    context_string_options: CONTEXT_COMMANDER_STRING_OPTION_CONTRACTS,
    activity_string_options: ACTIVITY_COMMANDER_STRING_OPTION_CONTRACTS,
  };
}

function resolveCreateRequiredOptionContract(
  typeDefinition: ReturnType<typeof resolveItemTypeRegistry>["by_type"][string],
  createMode: "strict" | "progressive",
): {
  required_option_keys: string[];
  required_flags: string[];
  required_type_options: string[];
  policy_errors: string[];
} {
  /* c8 ignore start -- create-option policy shaping is validated by dedicated create command contract fixtures. */
  const baseRequiredOptions = new Set<string>(["title", "type"]);
  if (createMode === "strict") {
    for (const field of typeDefinition.required_create_fields) {
      baseRequiredOptions.add(field);
    }
    for (const field of typeDefinition.required_create_repeatables) {
      baseRequiredOptions.add(field);
    }
  }
  const policyState = resolveCommandOptionPolicyState(
    typeDefinition,
    "create",
    baseRequiredOptions,
  );
  const requiredOptionKeys = [...new Set(policyState.required)].sort(
    (left, right) => left.localeCompare(right),
  );
  const requiredFlags = [
    ...new Set(
      requiredOptionKeys.map((option) =>
        commandOptionFlagLabel("create", option),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const requiredTypeOptions = [
    ...new Set(
      typeDefinition.options
        .filter((option) => option.required === true)
        .map((option) => option.key),
    ),
  ].sort((left, right) => left.localeCompare(right));
  return {
    required_option_keys: requiredOptionKeys,
    required_flags: requiredFlags,
    required_type_options: requiredTypeOptions,
    policy_errors: [...new Set(policyState.errors)].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
  /* c8 ignore stop */
}

function buildCreateRequiredOptionContracts(
  typeRegistry: ReturnType<typeof resolveItemTypeRegistry>,
): Record<string, unknown> {
  const byTypeStrict: Record<string, unknown> = {};
  const byTypeProgressive: Record<string, unknown> = {};
  for (const typeName of [...typeRegistry.types].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const typeDefinition = typeRegistry.by_type[typeName];
    byTypeStrict[typeName] = resolveCreateRequiredOptionContract(
      typeDefinition,
      "strict",
    );
    byTypeProgressive[typeName] = resolveCreateRequiredOptionContract(
      typeDefinition,
      "progressive",
    );
  }
  return {
    default_create_mode: "strict",
    by_create_mode: {
      strict: {
        by_type: byTypeStrict,
      },
      progressive: {
        by_type: byTypeProgressive,
      },
    },
  };
}

function attachCreateRequiredOptionContracts(
  schema: Record<string, unknown>,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const branches = extractActionBranches(schema);
  if (branches.length === 0) {
    return schema;
  }
  let touched = false;
  const enrichedBranches = branches.map((branch) => {
    const properties = branch.properties;
    if (typeof properties !== "object" || properties === null) {
      return branch;
    }
    const actionProperty = (properties as Record<string, unknown>).action;
    if (typeof actionProperty !== "object" || actionProperty === null) {
      return branch;
    }
    if ((actionProperty as { const?: unknown }).const !== "create") {
      return branch;
    }
    touched = true;
    return {
      ...branch,
      "x-create-required-options": metadata,
    };
  });
  if (!touched) {
    return schema;
  }
  return {
    ...schema,
    oneOf: enrichedBranches,
  };
}

interface ContractsSelection {
  selectedAction: string | undefined;
  selectedCommand: string | undefined;
  summary: boolean;
  schemaOnly: boolean;
  flagsOnly: boolean;
  availabilityOnly: boolean;
  runtimeOnly: boolean;
  fullOutput: boolean;
  omitUnfilteredSchema: boolean;
  omitUnfilteredCommandFlags: boolean;
  omitUnfilteredCommanderAliases: boolean;
}

interface ContractsRuntimeContext {
  settings: Awaited<ReturnType<typeof readSettings>>;
  runtimeProbe: RuntimeExtensionActionProbe;
  typeRegistry: ReturnType<typeof resolveItemTypeRegistry>;
  statusRegistry: ReturnType<typeof resolveRuntimeStatusRegistry>;
  runtimeFieldRegistry: RuntimeFieldRegistry;
  runtimeFieldFlagMap: Map<string, CliFlagContract[]>;
  createRequiredOptionContracts: Record<string, unknown>;
  extensionContracts: ExtensionCommandContract[];
  mergedExtensionContracts: ExtensionCommandContract[];
  extensionFlagMap: ReturnType<typeof collectExtensionFlagContractsByCommand>;
}

interface ContractsActionContext {
  actionDescriptors: ActionContractDescriptor[];
  commandCatalog: string[];
  commandScopedDescriptors: ActionContractDescriptor[];
  scopedActionDescriptors: ActionContractDescriptor[];
  selectedPackageOwnedAction: string | undefined;
  actionAvailability: ContractsActionAvailability[];
  actions: string[];
}

interface ContractsSchemaContext {
  mergedSchema: Record<string, unknown>;
  filteredSchema: Record<string, unknown>;
}

function resolveContractsSelection(
  options: ContractsCommandOptions,
): ContractsSelection {
  const summary = options.summary === true;
  const schemaOnly = options.schemaOnly === true;
  const flagsOnly = options.flagsOnly === true;
  const availabilityOnly = options.availabilityOnly === true;
  const runtimeOnly = options.runtimeOnly === true;
  const fullOutput = options.full === true;
  const selectedAction = normalizeToken(options.action);
  const selectedCommand = normalizeToken(options.command);
  const unfilteredDefaultBriefMode =
    !summary &&
    !fullOutput &&
    !schemaOnly &&
    !flagsOnly &&
    !availabilityOnly &&
    !selectedAction &&
    !selectedCommand;
  return {
    selectedAction,
    selectedCommand,
    summary,
    schemaOnly,
    flagsOnly,
    availabilityOnly,
    runtimeOnly,
    fullOutput,
    omitUnfilteredSchema: unfilteredDefaultBriefMode,
    omitUnfilteredCommandFlags: unfilteredDefaultBriefMode,
    omitUnfilteredCommanderAliases: unfilteredDefaultBriefMode,
  };
}

function assertSingleContractsProjection(selection: ContractsSelection): void {
  const projectionFlagsEnabled = [
    selection.summary,
    selection.schemaOnly,
    selection.flagsOnly,
    selection.availabilityOnly,
  ].filter((value) => value).length;
  if (projectionFlagsEnabled > 1) {
    throw new PmCliError(
      "Choose only one projection flag: --summary, --schema-only, --flags-only, or --availability-only.",
      EXIT_CODE.USAGE,
    );
  }
}

async function readContractsSettings(
  pmRoot: string,
): Promise<Awaited<ReturnType<typeof readSettings>>> {
  try {
    return await readSettings(pmRoot);
  } catch {
    return structuredClone(SETTINGS_DEFAULTS);
  }
}

async function resolveContractsRuntimeContext(
  global: GlobalOptions,
  pmRoot: string,
): Promise<ContractsRuntimeContext> {
  const settings = await readContractsSettings(pmRoot);
  const runtimeProbe = await resolveRuntimeExtensionActionProbe(global);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    runtimeProbe.registrations ?? getActiveExtensionRegistrations(),
  );
  const runtimeFieldRegistry = resolveRuntimeFieldRegistry(settings.schema);
  const extensionContracts = collectExtensionCommandContracts(runtimeProbe);
  return {
    settings,
    runtimeProbe,
    typeRegistry,
    statusRegistry: resolveRuntimeStatusRegistry(settings.schema),
    runtimeFieldRegistry,
    runtimeFieldFlagMap: buildRuntimeFieldFlagContracts(runtimeFieldRegistry),
    createRequiredOptionContracts:
      buildCreateRequiredOptionContracts(typeRegistry),
    extensionContracts,
    mergedExtensionContracts:
      mergeExtensionContractsByAction(extensionContracts),
    extensionFlagMap: collectExtensionFlagContractsByCommand(
      runtimeProbe.flagRegistrations,
    ),
  };
}

function shouldIncludePackageOwnedActions(
  selection: ContractsSelection,
): boolean {
  return (
    selection.availabilityOnly &&
    ((selection.selectedAction !== undefined &&
      PACKAGE_OWNED_ACTIONS.has(selection.selectedAction)) ||
      (selection.selectedCommand !== undefined &&
        PACKAGE_OWNED_COMMANDS.has(selection.selectedCommand)))
  );
}

function collectContractsActionDescriptors(
  selection: ContractsSelection,
  mergedExtensionContracts: ExtensionCommandContract[],
): ActionContractDescriptor[] {
  const actionDescriptors = collectActionContractDescriptors(
    mergedExtensionContracts,
    {
      includePackageOwnedActions: shouldIncludePackageOwnedActions(selection),
    },
  );
  if (
    shouldIncludePackageOwnedActions(selection) &&
    selection.selectedCommand !== undefined &&
    PACKAGE_OWNED_COMMANDS.has(selection.selectedCommand) &&
    !actionDescriptors.some(
      (entry) => entry.command_path === selection.selectedCommand,
    )
  ) {
    actionDescriptors.push({
      action: packageOwnedActionForCommand(selection.selectedCommand),
      provider: "extension",
      requires_extension: true,
      command_path: selection.selectedCommand,
    });
  }
  return actionDescriptors;
}

function assertKnownContractsAction(
  selection: ContractsSelection,
  actionDescriptors: ActionContractDescriptor[],
): void {
  const actionNames = new Set(actionDescriptors.map((entry) => entry.action));
  if (selection.selectedAction && !actionNames.has(selection.selectedAction)) {
    throw new PmCliError(
      `Unknown action: "${selection.selectedAction}".`,
      EXIT_CODE.USAGE,
    );
  }
}

function buildContractsCommandCatalog(
  actionDescriptors: ActionContractDescriptor[],
  mergedExtensionContracts: ExtensionCommandContract[],
): string[] {
  return [
    ...new Set([
      ...PM_CORE_COMMAND_NAMES.filter(
        (entry) => !PACKAGE_OWNED_COMMANDS.has(entry),
      ),
      ...[...CORE_COMMAND_FLAG_CONTRACTS_BY_COMMAND.keys()].filter(
        (entry) => !PACKAGE_OWNED_COMMANDS.has(entry),
      ),
      /* c8 ignore next -- action descriptors always include concrete command paths in command-scoped test fixtures. */
      ...actionDescriptors.flatMap((entry) =>
        entry.command_path ? splitCommandPathAliases(entry.command_path) : [],
      ),
      ...mergedExtensionContracts.flatMap((entry) => entry.command.split("|")),
    ]),
  ]
    .map((entry) => normalizeCommandPath(entry))
    .filter((entry) => entry.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function buildCommandNamespaceError(
  command: string,
  namespaceChildren: string[],
): PmCliError {
  const displayedNamespaceChildren = namespaceChildren.slice(
    0,
    COMMAND_NAMESPACE_DISPLAY_LIMIT,
  );
  const hiddenNamespaceChildCount =
    namespaceChildren.length - displayedNamespaceChildren.length;
  const displayedChildCommandList =
    hiddenNamespaceChildCount > 0
      ? `${displayedNamespaceChildren.join(", ")}, and ${hiddenNamespaceChildCount} more`
      : displayedNamespaceChildren.join(", ");
  const fallbackCandidates = namespaceChildren.slice(
    0,
    COMMAND_NAMESPACE_FALLBACK_LIMIT,
  );
  const childCommandExamples = namespaceChildren
    .slice(0, 5)
    .map(
      (childCommand) =>
        `pm contracts --command "${childCommand}" --flags-only --json`,
    );
  const suggestedChildCommand = namespaceChildren[0];
  return new PmCliError(
    `Command "${command}" is a command namespace. Choose a concrete child command: ${displayedChildCommandList}.`,
    EXIT_CODE.USAGE,
    {
      code: "command_namespace",
      required:
        "Use a concrete child command path listed under this namespace.",
      why: "Command groups expose help at the namespace root, but command flag contracts belong to executable child commands.",
      examples: childCommandExamples,
      nextSteps: [
        `Retry with a child command, for example: ${childCommandExamples[0]}`,
      ],
      recovery: {
        suggested_retry: `pm contracts --command "${suggestedChildCommand}" --flags-only --json`,
        fallback_candidates: fallbackCandidates.map((childCommand) => ({
          source: "command_namespace",
          command: `pm contracts --command "${childCommand}" --flags-only --json`,
          reason: `Child command under ${command}`,
        })),
      },
    },
  );
}

function buildPackageOwnedCommandError(
  command: string,
  packageHint: string,
): PmCliError {
  return new PmCliError(
    `Unknown command: "${command}". Command "${command}" is provided by the optional "${packageHint}" package. Run "pm install ${packageHint} --project" and retry.`,
    EXIT_CODE.USAGE,
    {
      code: "unknown_command",
      required: `Install the optional "${packageHint}" package, or choose a command from pm contracts --flags-only --json.`,
      why: "Command contracts include core commands plus commands registered by active packages and extensions.",
      examples: [
        `pm install ${packageHint} --project`,
        `pm contracts --command ${command} --flags-only --json`,
      ],
      nextSteps: [
        `Install the optional package first: pm install ${packageHint} --project`,
      ],
      recovery: {
        suggested_retry: `pm install ${packageHint} --project`,
      },
    },
  );
}

function buildUnknownCommandError(command: string): PmCliError {
  return new PmCliError(`Unknown command: "${command}".`, EXIT_CODE.USAGE, {
    code: "unknown_command",
    required: "Use a command path listed by pm contracts --flags-only --json.",
    why: "Command contracts are generated from the active core, package, and extension command registry.",
    examples: ["pm contracts --flags-only --json", "pm --help"],
    nextSteps: [
      "Verify spelling and active packages/extensions, then rerun with a known command path.",
    ],
    recovery: {
      suggested_retry: "pm contracts --flags-only --json",
    },
  });
}

function assertKnownContractsCommand(
  selection: ContractsSelection,
  commandCatalog: string[],
): void {
  if (!selection.selectedCommand) {
    return;
  }
  const commandNames = new Set(commandCatalog);
  if (commandNames.has(selection.selectedCommand)) {
    return;
  }
  const namespaceChildren = commandCatalog.filter((command) =>
    command.startsWith(`${selection.selectedCommand} `),
  );
  if (namespaceChildren.length > 0) {
    throw buildCommandNamespaceError(
      selection.selectedCommand,
      namespaceChildren,
    );
  }
  const packageHint = PACKAGE_OWNED_COMMAND_INSTALL_HINTS.get(
    selection.selectedCommand,
  );
  if (packageHint) {
    throw buildPackageOwnedCommandError(selection.selectedCommand, packageHint);
  }
  throw buildUnknownCommandError(selection.selectedCommand);
}

function resolveContractsActionContext(
  selection: ContractsSelection,
  runtime: ContractsRuntimeContext,
): ContractsActionContext {
  const actionDescriptors = collectContractsActionDescriptors(
    selection,
    runtime.mergedExtensionContracts,
  );
  assertKnownContractsAction(selection, actionDescriptors);
  const commandCatalog = buildContractsCommandCatalog(
    actionDescriptors,
    runtime.mergedExtensionContracts,
  );
  assertKnownContractsCommand(selection, commandCatalog);
  const selectedPackageOwnedAction = selection.selectedCommand
    ? PACKAGE_OWNED_COMMAND_ACTIONS.get(selection.selectedCommand)
    : undefined;
  const commandScopedDescriptors = selection.selectedCommand
    ? actionDescriptors.filter((descriptor) =>
        selectedPackageOwnedAction
          ? descriptor.action === selectedPackageOwnedAction
          : actionDescriptorMatchesSelectedCommand(
              descriptor,
              selection.selectedCommand as string,
            ),
      )
    : actionDescriptors;
  if (
    selection.selectedCommand &&
    selection.selectedAction &&
    !commandScopedDescriptors.some(
      (descriptor) => descriptor.action === selection.selectedAction,
    )
  ) {
    throw new PmCliError(
      `Action "${selection.selectedAction}" is not mapped to command "${selection.selectedCommand}" in contracts output.`,
      EXIT_CODE.USAGE,
    );
  }
  const scopedActionDescriptors = selection.selectedAction
    ? commandScopedDescriptors.filter(
        (descriptor) => descriptor.action === selection.selectedAction,
      )
    : commandScopedDescriptors;
  const allActionAvailability = [
    ...new Map(
      scopedActionDescriptors
        .map((descriptor) =>
          resolveActionAvailability(descriptor, runtime.runtimeProbe),
        )
        .map(
          (entry) =>
            [
              /* c8 ignore next -- keyed dedupe by action|path is covered by runtime policy integration tests. */
              selectedPackageOwnedAction
                ? entry.action
                : `${entry.action}|${entry.command_path ?? ""}`,
              entry,
            ] as const,
        ),
    ).values(),
  ];
  const actionAvailability =
    selection.runtimeOnly &&
    !selection.selectedAction &&
    !selection.availabilityOnly
      ? allActionAvailability.filter((entry) => entry.invocable)
      : allActionAvailability;
  return {
    actionDescriptors,
    commandCatalog,
    commandScopedDescriptors,
    scopedActionDescriptors,
    selectedPackageOwnedAction,
    actionAvailability,
    actions: [...new Set(actionAvailability.map((entry) => entry.action))],
  };
}

function buildSchemaActionSet(schema: Record<string, unknown>): Set<string> {
  return new Set(
    extractActionBranches(schema)
      .map((entry) => {
        const properties = entry.properties;
        /* c8 ignore start -- PM_TOOL_PARAMETERS_SCHEMA action branches always carry a properties object; the property-less fallback is validated in schema-level contract tests. */
        if (typeof properties !== "object" || properties === null) {
          return null;
        }
        /* c8 ignore stop */
        const actionProperty = (properties as Record<string, unknown>).action;
        /* c8 ignore start -- PM_TOOL_PARAMETERS_SCHEMA action branches always carry an action object; the missing-action fallback is validated in schema-level contract tests. */
        if (typeof actionProperty !== "object" || actionProperty === null) {
          return null;
        }
        /* c8 ignore stop */
        const actionConst = (actionProperty as { const?: unknown }).const;
        /* c8 ignore start -- the action.const is always a string in PM_TOOL_PARAMETERS_SCHEMA; the non-string fallback is validated in schema-level contract tests. */
        return typeof actionConst === "string" ? actionConst : null;
        /* c8 ignore stop */
      })
      .filter((entry): entry is string => entry !== null),
  );
}

function buildMergedContractsSchema(
  mergedExtensionContracts: ExtensionCommandContract[],
): Record<string, unknown> {
  const schema = PM_TOOL_PARAMETERS_SCHEMA as Record<string, unknown>;
  const schemaBranches = extractActionBranches(schema);
  const schemaActionSet = buildSchemaActionSet(schema);
  const extensionBranches = mergedExtensionContracts
    .filter((contract) => !schemaActionSet.has(contract.action))
    .map((contract) => buildExtensionActionSchemaBranch(contract));
  return extensionBranches.length > 0
    ? {
        ...schema,
        oneOf: [...schemaBranches, ...extensionBranches],
      }
    : schema;
}

function filterContractsSchema(
  selection: ContractsSelection,
  actionContext: ContractsActionContext,
  mergedSchema: Record<string, unknown>,
): Record<string, unknown> {
  const descriptorActionSet = new Set(
    actionContext.actionDescriptors.map((descriptor) => descriptor.action),
  );
  const filteredSchema = selection.selectedAction
    ? filterSchemaByAction(mergedSchema, selection.selectedAction)
    : selection.selectedCommand
      ? filterSchemaByActions(
          mergedSchema,
          new Set(
            actionContext.scopedActionDescriptors.map(
              (descriptor) => descriptor.action,
            ),
          ),
        )
      : filterSchemaByActions(mergedSchema, descriptorActionSet);
  return selection.runtimeOnly && !selection.selectedAction
    ? filterSchemaByActions(filteredSchema, new Set(actionContext.actions))
    : filteredSchema;
}

function resolveContractsSchemaContext(
  selection: ContractsSelection,
  runtime: ContractsRuntimeContext,
  actionContext: ContractsActionContext,
): ContractsSchemaContext {
  const mergedSchema = buildMergedContractsSchema(
    runtime.mergedExtensionContracts,
  );
  const includeSchemaSurface =
    !selection.flagsOnly && !selection.availabilityOnly;
  const filteredSchema = includeSchemaSurface
    ? attachCreateRequiredOptionContracts(
        filterContractsSchema(selection, actionContext, mergedSchema),
        runtime.createRequiredOptionContracts,
      )
    : filterContractsSchema(selection, actionContext, mergedSchema);
  return { mergedSchema, filteredSchema };
}

function resolveContractsCommands(
  selection: ContractsSelection,
  actionContext: ContractsActionContext,
): string[] {
  if (selection.selectedCommand !== undefined) {
    return [selection.selectedCommand];
  }
  if (selection.selectedAction) {
    return resolveScopedCommandsFromActionDescriptors(
      actionContext.scopedActionDescriptors,
      actionContext.commandCatalog,
    );
  }
  return actionContext.commandCatalog;
}

function resolveOutputCommands(
  selection: ContractsSelection,
  commands: string[],
): string[] {
  return selection.flagsOnly &&
    selection.selectedCommand === undefined &&
    selection.selectedAction === undefined
    ? compactCommandAliasSurface(commands)
    : commands;
}

function summarizeCommandIntent(command: string): string {
  const rootCommand = command.split(" ")[0];
  return (
    COMMAND_INTENTS.get(command) ??
    COMMAND_INTENTS.get(rootCommand) ??
    "Inspect flags."
  );
}

function canonicalSummaryCommand(command: string): string {
  const rootCommand = command.split(" ")[0];
  if (rootCommand.startsWith("list-")) {
    return "list";
  }
  if (rootCommand.startsWith("history-")) {
    return "history";
  }
  if (rootCommand === "ctx") {
    return "context";
  }
  if (rootCommand === "packages") {
    return "package";
  }
  return COMMAND_ALIAS_TO_CANONICAL.get(rootCommand) ?? rootCommand;
}

function buildCommandSummarySurface(
  commands: readonly string[],
): CommandSummarySurface[] {
  const rootCommands = [
    ...new Set(commands.map((command) => canonicalSummaryCommand(command))),
  ]
    .filter((command) => command.length > 0)
    .sort((left, right) => left.localeCompare(right));
  return rootCommands.map((command) => ({
    command,
    intent: summarizeCommandIntent(command),
  }));
}

function resolveExtensionCommandContracts(
  selection: ContractsSelection,
  runtime: ContractsRuntimeContext,
  outputCommands: string[],
): ExtensionCommandContract[] {
  if (selection.selectedCommand) {
    return runtime.extensionContracts.filter((entry) =>
      splitCommandPathAliases(entry.command).includes(
        selection.selectedCommand as string,
      ),
    );
  }
  if (selection.selectedAction) {
    const outputCommandSet = new Set(outputCommands);
    return runtime.extensionContracts.filter((entry) =>
      splitCommandPathAliases(entry.command).some((command) =>
        outputCommandSet.has(command),
      ),
    );
  }
  return runtime.extensionContracts;
}

function createContractsResult(
  selection: ContractsSelection,
  schemaContext: ContractsSchemaContext,
  actionContext: ContractsActionContext,
  outputCommands: string[],
): ContractsResult {
  return {
    schema_version:
      /* c8 ignore next -- schema version/id fallbacks are exercised by schema snapshot tests. */
      typeof schemaContext.mergedSchema["x-schema-version"] === "string"
        ? (schemaContext.mergedSchema["x-schema-version"] as string)
        : null,
    schema_id:
      /* c8 ignore next -- schema version/id fallbacks are exercised by schema snapshot tests. */
      typeof schemaContext.mergedSchema.$id === "string"
        ? (schemaContext.mergedSchema.$id as string)
        : null,
    selected: {
      action: selection.selectedAction ?? null,
      command: selection.selectedCommand ?? null,
      summary: selection.summary,
      schema_only: selection.schemaOnly,
      flags_only: selection.flagsOnly,
      availability_only: selection.availabilityOnly,
      runtime_only: selection.runtimeOnly,
      command_scoped: selection.selectedCommand !== undefined,
    },
    commands: selection.summary ? [] : outputCommands,
    ...(!selection.summary && !selection.flagsOnly
      ? {
          actions: actionContext.actions,
          action_availability: actionContext.actionAvailability,
        }
      : {}),
  };
}

function attachRuntimeContractsResult(
  result: ContractsResult,
  runtime: ContractsRuntimeContext,
): void {
  result.runtime_schema = {
    statuses: runtime.statusRegistry.definitions.map(
      (definition) => definition.id,
    ),
    open_status: runtime.statusRegistry.open_status,
    close_status: runtime.statusRegistry.close_status,
    canceled_status: runtime.statusRegistry.canceled_status,
    types: [...runtime.typeRegistry.types],
    fields_by_command: Object.fromEntries(
      [...runtime.runtimeFieldRegistry.command_to_fields.entries()].map(
        ([command, definitions]) => [
          command,
          [
            ...new Set(
              definitions.map((definition) => `--${definition.cli_flag}`),
            ),
          ].sort((left, right) => left.localeCompare(right)),
        ],
      ),
    ),
  };
  result.extension_contracts = {
    capabilities: [...PM_EXTENSION_CAPABILITY_CONTRACTS],
    services: [...PM_EXTENSION_SERVICE_NAME_CONTRACTS],
    policy_modes: [...PM_EXTENSION_POLICY_MODE_CONTRACTS],
    policy_surfaces: [...PM_EXTENSION_POLICY_SURFACE_CONTRACTS],
    trust_modes: [...PM_EXTENSION_TRUST_MODE_CONTRACTS],
    sandbox_profiles: [...PM_EXTENSION_SANDBOX_PROFILE_CONTRACTS],
    manifest_versions: [1, 2],
    compatibility: {
      current: "v2",
      previous: ["v1"],
      breaking_strategy: "versioned_breaking",
    },
  };
}

function attachSchemaContractsResult(
  result: ContractsResult,
  selection: ContractsSelection,
  schemaContext: ContractsSchemaContext,
  extensionCommandContracts: ExtensionCommandContract[],
): void {
  if (selection.flagsOnly || selection.availabilityOnly) {
    return;
  }
  if (!selection.omitUnfilteredSchema) {
    result.schema = schemaContext.filteredSchema;
    result.extension_commands = extensionCommandContracts;
    return;
  }
  result.schema_omitted_reason = "unfiltered_default_brief";
  result.extension_commands = extensionCommandContracts;
}

function attachFlagContractsResult(
  result: ContractsResult,
  selection: ContractsSelection,
  runtime: ContractsRuntimeContext,
  outputCommands: string[],
  commandAliases: CommandAliasSurface[],
): void {
  if (selection.schemaOnly || selection.availabilityOnly) {
    return;
  }
  if (!selection.omitUnfilteredCommandFlags) {
    result.command_flags = buildCommandFlagSurface(
      outputCommands,
      runtime.extensionFlagMap,
      runtime.runtimeFieldFlagMap,
    );
  } else {
    result.command_flags_omitted_reason = "unfiltered_default_brief";
  }
  if (commandAliases.length > 0) {
    result.command_aliases = commandAliases;
  }
}

function attachCommanderAliasContractsResult(
  result: ContractsResult,
  selection: ContractsSelection,
): void {
  if (
    selection.schemaOnly ||
    selection.flagsOnly ||
    selection.availabilityOnly
  ) {
    return;
  }
  if (!selection.omitUnfilteredCommanderAliases) {
    result.commander_aliases = buildCommanderAliasSurface();
    return;
  }
  result.commander_aliases_omitted_reason = "unfiltered_default_brief";
}

/** Implements run contracts for the public runtime surface of this module. */
export async function runContracts(
  options: ContractsCommandOptions,
  global: GlobalOptions,
): Promise<ContractsResult> {
  const selection = resolveContractsSelection(options);
  assertSingleContractsProjection(selection);
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const runtime = await resolveContractsRuntimeContext(global, pmRoot);
  const actionContext = resolveContractsActionContext(selection, runtime);
  const schemaContext = resolveContractsSchemaContext(
    selection,
    runtime,
    actionContext,
  );
  const commands = resolveContractsCommands(selection, actionContext);
  const outputCommands = resolveOutputCommands(selection, commands);
  const result = createContractsResult(
    selection,
    schemaContext,
    actionContext,
    outputCommands,
  );

  if (selection.summary) {
    result.command_summaries = buildCommandSummarySurface(outputCommands);
    return result;
  }
  const commandAliases = buildCommandAliasSurface(commands);
  const extensionCommandContracts = resolveExtensionCommandContracts(
    selection,
    runtime,
    outputCommands,
  );
  if (!(selection.flagsOnly && !selection.fullOutput)) {
    attachRuntimeContractsResult(result, runtime);
  }
  attachSchemaContractsResult(
    result,
    selection,
    schemaContext,
    extensionCommandContracts,
  );
  attachFlagContractsResult(
    result,
    selection,
    runtime,
    outputCommands,
    commandAliases,
  );
  attachCommanderAliasContractsResult(result, selection);

  // pm-4os2: snapshot the static MCP tool surface in the full projection so
  // `pnpm contracts:check` (CI static gate) fails on unintended inputSchema
  // drift in src/mcp/tool-definitions.ts.
  if (
    selection.fullOutput &&
    !selection.schemaOnly &&
    !selection.flagsOnly &&
    !selection.availabilityOnly
  ) {
    result.mcp_tools = buildMcpToolContracts();
  }

  return result;
}

/** Public contract for test only contracts command, shared by SDK and presentation-layer consumers. */
export const _testOnlyContractsCommand = {
  actionDescriptorMatchesSelectedCommand,
  attachCreateRequiredOptionContracts,
  buildExtensionActionSchemaBranch,
  buildCommandSummarySurface,
  buildRuntimeFieldFlagContracts,
  collectActionContractDescriptors,
  collectExtensionCommandContracts,
  collectExtensionFlagContractsByCommand,
  extractActionBranches,
  extensionSchemaPropertyNameFromFlag,
  filterSchemaByAction,
  filterSchemaByActions,
  isCoreCommandPath,
  mergeExtensionContractsByAction,
  normalizeExtensionFlagName,
  normalizeActionNameFromCommand,
  normalizeCommandForRuntimeFieldFlags,
  normalizeCommandPath,
  packageOwnedActionForCommand,
  resolveActionCommandPath,
  resolveActionAvailability,
  resolveCoreCommandFlags,
  resolveScopedCommandsFromActionDescriptors,
  splitCommandPathAliases,
  toRuntimeLongFlagToken,
  toRuntimeShortFlagToken,
};
