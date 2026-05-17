import { EXIT_CODE, SETTINGS_DEFAULTS } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import {
  activateExtensions,
  getActiveExtensionRegistrations,
  loadExtensions,
} from "../../core/extensions/index.js";
import type {
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
  ACTIVITY_COMMANDER_STRING_OPTION_CONTRACTS,
  ACTIVITY_FLAG_CONTRACTS,
  AGGREGATE_FLAG_CONTRACTS,
  APPEND_FLAG_CONTRACTS,
  CALENDAR_COMMANDER_STRING_OPTION_CONTRACTS,
  CALENDAR_FLAG_CONTRACTS,
  CLAIM_FLAG_CONTRACTS,
  CLOSE_TASK_FLAG_CONTRACTS,
  COMMENTS_FLAG_CONTRACTS,
  COMMENTS_AUDIT_FLAG_CONTRACTS,
  CLOSE_FLAG_CONTRACTS,
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
  DEDUPE_AUDIT_FLAG_CONTRACTS,
  DOCS_FLAG_CONTRACTS,
  EXTENSION_FLAG_CONTRACTS,
  FILES_FLAG_CONTRACTS,
  GC_FLAG_CONTRACTS,
  GET_FLAG_CONTRACTS,
  GUIDE_FLAG_CONTRACTS,
  GLOBAL_FLAG_CONTRACTS,
  HEALTH_FLAG_CONTRACTS,
  HISTORY_FLAG_CONTRACTS,
  INIT_FLAG_CONTRACTS,
  LEARNINGS_FLAG_CONTRACTS,
  LIST_COMMANDER_STRING_OPTION_CONTRACTS,
  LIST_FILTER_FLAG_CONTRACTS,
  NORMALIZE_FLAG_CONTRACTS,
  NOTES_FLAG_CONTRACTS,
  PM_EXTENSION_CAPABILITY_CONTRACTS,
  PM_EXTENSION_POLICY_MODE_CONTRACTS,
  PM_EXTENSION_POLICY_SURFACE_CONTRACTS,
  PM_EXTENSION_SANDBOX_PROFILE_CONTRACTS,
  PM_EXTENSION_SERVICE_NAME_CONTRACTS,
  PM_EXTENSION_TRUST_MODE_CONTRACTS,
  PM_CORE_COMMAND_NAMES,
  PM_TOOL_ACTIONS,
  PM_TOOL_PARAMETERS_SCHEMA,
  REINDEX_FLAG_CONTRACTS,
  RELEASE_FLAG_CONTRACTS,
  RESTORE_FLAG_CONTRACTS,
  SEARCH_COMMANDER_STRING_OPTION_CONTRACTS,
  SEARCH_FLAG_CONTRACTS,
  START_TASK_FLAG_CONTRACTS,
  PAUSE_TASK_FLAG_CONTRACTS,
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

export interface ContractsCommandOptions {
  action?: string;
  command?: string;
  schemaOnly?: boolean;
  flagsOnly?: boolean;
  availabilityOnly?: boolean;
  runtimeOnly?: boolean;
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

export interface ContractsResult {
  schema_version: string | null;
  schema_id: string | null;
  selected: {
    action: string | null;
    command: string | null;
    schema_only: boolean;
    flags_only: boolean;
    availability_only: boolean;
    runtime_only: boolean;
    command_scoped: boolean;
  };
  actions?: string[];
  action_availability?: ContractsActionAvailability[];
  commands: string[];
  schema?: Record<string, unknown>;
  schema_omitted_reason?: string;
  command_flags_omitted_reason?: string;
  commander_aliases_omitted_reason?: string;
  command_flags?: CommandFlagSurface[];
  command_aliases?: CommandAliasSurface[];
  commander_aliases?: Record<string, CommanderOptionAliasContract[]>;
  extension_commands?: ExtensionCommandContract[];
  runtime_schema?: {
    statuses: string[];
    open_status: string;
    close_status: string;
    canceled_status: string;
    types: string[];
    fields_by_command: Record<string, string[]>;
  };
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
}

type PmToolAction = (typeof PM_TOOL_ACTIONS)[number];

export interface ContractsActionAvailability {
  action: string;
  invocable: boolean;
  available: boolean;
  requires_extension: boolean;
  provider: "core" | "extension";
  disabled_reason: string | null;
  command_path: string | null;
  cli_exposed: boolean;
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
  "dedupe-audit",
  "guide",
  "reindex",
  "normalize",
  "comments-audit",
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
  "comments-audit",
  "completion",
  "completion-tags",
  "dedupe-audit",
  "guide",
  "normalize",
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
  return null;
}

function actionDescriptorMatchesSelectedCommand(
  descriptor: ActionContractDescriptor,
  selectedCommand: string,
): boolean {
  if (descriptor.command_path === null) {
    return false;
  }
  const commandPath = normalizeCommandPath(descriptor.command_path);
  if (commandPath === selectedCommand) {
    return true;
  }
  return commandPath.startsWith(`${selectedCommand} `);
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
    const commandPath = normalizeCommandPath(descriptor.command_path);
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

function toExtensionFlagContract(
  definition: Record<string, unknown>,
): CliFlagContract | null {
  const longName = toOptionalTrimmedString(definition.long);
  const shortName = toOptionalTrimmedString(definition.short);
  const normalizedLong =
    longName && longName.startsWith("--") && longName.length > 2
      ? longName
      : null;
  const normalizedShort =
    shortName && shortName.startsWith("-") && !shortName.startsWith("--")
      ? shortName
      : null;
  const flag = normalizedLong ?? normalizedShort;
  if (!flag) {
    return null;
  }
  const contract: CliFlagContract = { flag };
  if (normalizedShort && normalizedLong) {
    contract.short = normalizedShort;
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

function buildExtensionActionSchemaBranch(
  contract: ExtensionCommandContract,
): Record<string, unknown> {
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
    if (argument.variadic) {
      properties[argument.name] = {
        type: "array",
        items: { type: "string" },
        description:
          argument.description ??
          `Variadic argument '${argument.name}' for extension action '${contract.action}'.`,
      };
    } else {
      properties[argument.name] = {
        type: "string",
        description:
          argument.description ??
          `Argument '${argument.name}' for extension action '${contract.action}'.`,
      };
    }
    if (argument.required) {
      required.push(argument.name);
    }
  }
  for (const flag of contract.flags) {
    const propertyName = extensionSchemaPropertyNameFromFlag(flag);
    if (!propertyName || properties[propertyName] !== undefined) {
      continue;
    }
    const isBooleanFlag = !flag.flag.includes(" ");
    properties[propertyName] = {
      type: isBooleanFlag ? ["boolean", "string"] : "string",
      description: `Extension option '${flag.flag}' for action '${contract.action}'.`,
    };
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: true,
    "x-extension-source": contract.source,
    "x-extension-command": contract.command,
  };
}

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
): ActionContractDescriptor[] {
  const descriptors = new Map<string, ActionContractDescriptor>();
  for (const action of PM_TOOL_ACTIONS) {
    if (PACKAGE_OWNED_ACTIONS.has(action)) {
      continue;
    }
    const commandPath = resolveActionCommandPath(action as PmToolAction);
    descriptors.set(action, {
      action,
      provider: "core",
      requires_extension: false,
      command_path: commandPath,
    });
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
}

function resolveActionAvailability(
  descriptor: ActionContractDescriptor,
  runtimeProbe: RuntimeExtensionActionProbe,
): ContractsActionAvailability {
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

  const commandPath = descriptor.command_path
    ? normalizeCommandPath(descriptor.command_path)
    : "";
  const extensionCommandAvailable =
    commandPath.length > 0 && runtimeProbe.handlers.has(commandPath);
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
      : (runtimeProbe.disabledReason ?? "extension_command_not_registered"),
    command_path: descriptor.command_path,
    cli_exposed: extensionCommandAvailable,
    policy_state: {
      mode: runtimeProbe.policyState.mode,
      trust_mode: runtimeProbe.policyState.trust_mode,
      default_sandbox_profile: runtimeProbe.policyState.default_sandbox_profile,
    },
  };
}

function resolveCoreCommandFlags(command: string): CliFlagContract[] {
  if (command === "init") {
    return INIT_FLAG_CONTRACTS;
  }
  if (command === "config") {
    return CONFIG_FLAG_CONTRACTS;
  }
  if (
    command === "extension" ||
    command === "package" ||
    command === "packages" ||
    command === "install"
  ) {
    return EXTENSION_FLAG_CONTRACTS;
  }
  if (command === "create") {
    return CREATE_FLAG_CONTRACTS;
  }
  if (command === "update") {
    return UPDATE_FLAG_CONTRACTS;
  }
  if (command === "update-many") {
    return UPDATE_MANY_FLAG_CONTRACTS;
  }
  if (command === "upgrade") {
    return UPGRADE_FLAG_CONTRACTS;
  }
  if (command === "normalize") {
    return NORMALIZE_FLAG_CONTRACTS;
  }
  if (command === "calendar" || command === "cal") {
    return CALENDAR_FLAG_CONTRACTS;
  }
  if (command === "context" || command === "ctx") {
    return CONTEXT_FLAG_CONTRACTS;
  }
  if (command === "get") {
    return GET_FLAG_CONTRACTS;
  }
  if (command === "search") {
    return SEARCH_FLAG_CONTRACTS;
  }
  if (command === "aggregate") {
    return AGGREGATE_FLAG_CONTRACTS;
  }
  if (command === "dedupe-audit") {
    return DEDUPE_AUDIT_FLAG_CONTRACTS;
  }
  if (command === "deps") {
    return DEPS_FLAG_CONTRACTS;
  }
  if (command === "guide") {
    return GUIDE_FLAG_CONTRACTS;
  }
  if (command === "reindex") {
    return REINDEX_FLAG_CONTRACTS;
  }
  if (command === "history") {
    return HISTORY_FLAG_CONTRACTS;
  }
  if (command === "restore") {
    return RESTORE_FLAG_CONTRACTS;
  }
  if (command === "delete") {
    return DELETE_FLAG_CONTRACTS;
  }
  if (command === "close") {
    return CLOSE_FLAG_CONTRACTS;
  }
  if (command === "append") {
    return APPEND_FLAG_CONTRACTS;
  }
  if (command === "claim") {
    return CLAIM_FLAG_CONTRACTS;
  }
  if (command === "release") {
    return RELEASE_FLAG_CONTRACTS;
  }
  if (command === "start-task") {
    return START_TASK_FLAG_CONTRACTS;
  }
  if (command === "pause-task") {
    return PAUSE_TASK_FLAG_CONTRACTS;
  }
  if (command === "close-task") {
    return CLOSE_TASK_FLAG_CONTRACTS;
  }
  if (command === "comments") {
    return COMMENTS_FLAG_CONTRACTS;
  }
  if (command === "notes") {
    return NOTES_FLAG_CONTRACTS;
  }
  if (command === "learnings") {
    return LEARNINGS_FLAG_CONTRACTS;
  }
  if (command === "files") {
    return FILES_FLAG_CONTRACTS;
  }
  if (command === "docs") {
    return DOCS_FLAG_CONTRACTS;
  }
  if (command === "test") {
    return TEST_FLAG_CONTRACTS;
  }
  if (command === "test-all") {
    return TEST_ALL_FLAG_CONTRACTS;
  }
  if (command === "test-runs") {
    return TEST_RUNS_FLAG_CONTRACTS;
  }
  if (command === "gc") {
    return GC_FLAG_CONTRACTS;
  }
  if (command === "validate") {
    return VALIDATE_FLAG_CONTRACTS;
  }
  if (command === "comments-audit") {
    return COMMENTS_AUDIT_FLAG_CONTRACTS;
  }
  if (command === "health") {
    return HEALTH_FLAG_CONTRACTS;
  }
  if (command === "contracts") {
    return CONTRACTS_FLAG_CONTRACTS;
  }
  if (command === "completion") {
    return COMPLETION_FLAG_CONTRACTS;
  }
  if (command === "activity") {
    return ACTIVITY_FLAG_CONTRACTS;
  }
  if (LIST_COMMAND_NAMES.has(command)) {
    return LIST_FILTER_FLAG_CONTRACTS;
  }
  return GLOBAL_FLAG_CONTRACTS;
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
    return "update";
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
}

function mergeFlagContracts(
  primary: CliFlagContract[],
  secondary: CliFlagContract[],
): CliFlagContract[] {
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
}

function buildCommandFlagSurface(
  commands: string[],
  extensionFlagMap: ReturnType<typeof collectExtensionFlagContractsByCommand>,
  runtimeFieldFlagMap: Map<string, CliFlagContract[]>,
): CommandFlagSurface[] {
  return commands
    .map((command) => {
      const isCoreCommand =
        PM_CORE_COMMAND_NAMES.includes(
          command as (typeof PM_CORE_COMMAND_NAMES)[number],
        ) && !PACKAGE_OWNED_COMMANDS.has(command);
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

export async function runContracts(
  options: ContractsCommandOptions,
  global: GlobalOptions,
): Promise<ContractsResult> {
  const selectedAction = normalizeToken(options.action);
  const selectedCommand = normalizeToken(options.command);
  const schemaOnly = options.schemaOnly === true;
  const flagsOnly = options.flagsOnly === true;
  const availabilityOnly = options.availabilityOnly === true;
  const runtimeOnly = options.runtimeOnly === true;
  const fullOutput = options.full === true;
  const unfilteredDefaultBriefMode =
    !fullOutput && !schemaOnly && !flagsOnly && !availabilityOnly && !selectedAction && !selectedCommand;
  // Agent token-cost guard: when no filter and no projection flag and not --full,
  // skip the giant schema oneOf union (the 200KB+ chunk). Restore via --full
  // or by scoping to a specific --command/--action.
  const omitUnfilteredSchema = unfilteredDefaultBriefMode;
  const omitUnfilteredCommandFlags = unfilteredDefaultBriefMode;
  const omitUnfilteredCommanderAliases = unfilteredDefaultBriefMode;
  const projectionFlagsEnabled = [
    schemaOnly,
    flagsOnly,
    availabilityOnly,
  ].filter((value) => value).length;
  if (projectionFlagsEnabled > 1) {
    throw new PmCliError(
      "Choose only one projection flag: --schema-only, --flags-only, or --availability-only.",
      EXIT_CODE.USAGE,
    );
  }
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  let settings = structuredClone(SETTINGS_DEFAULTS);
  try {
    settings = await readSettings(pmRoot);
  } catch {
    settings = structuredClone(SETTINGS_DEFAULTS);
  }
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const runtimeFieldRegistry = resolveRuntimeFieldRegistry(settings.schema);
  const runtimeFieldFlagMap =
    buildRuntimeFieldFlagContracts(runtimeFieldRegistry);
  const createRequiredOptionContracts =
    buildCreateRequiredOptionContracts(typeRegistry);
  const runtimeProbe = await resolveRuntimeExtensionActionProbe(global);
  const extensionContracts = collectExtensionCommandContracts(runtimeProbe);
  const extensionFlagMap = collectExtensionFlagContractsByCommand(
    runtimeProbe.flagRegistrations,
  );
  const actionDescriptors =
    collectActionContractDescriptors(extensionContracts);
  const actionNames = new Set(actionDescriptors.map((entry) => entry.action));
  if (selectedAction && !actionNames.has(selectedAction)) {
    throw new PmCliError(
      `Unknown action: "${options.action}".`,
      EXIT_CODE.USAGE,
    );
  }

  const commandCatalog = [
    ...new Set([
      ...PM_CORE_COMMAND_NAMES.filter(
        (entry) => !PACKAGE_OWNED_COMMANDS.has(entry),
      ),
      ...extensionContracts.map((entry) => entry.command),
    ]),
  ]
    .map((entry) => normalizeCommandPath(entry))
    .filter((entry) => entry.length > 0)
    .sort((left, right) => left.localeCompare(right));
  const commandNames = new Set(commandCatalog);
  if (selectedCommand && !commandNames.has(selectedCommand)) {
    throw new PmCliError(
      `Unknown command: "${options.command}".`,
      EXIT_CODE.USAGE,
    );
  }
  const commandScopedDescriptors = selectedCommand
    ? actionDescriptors.filter((descriptor) =>
        actionDescriptorMatchesSelectedCommand(descriptor, selectedCommand),
      )
    : actionDescriptors;
  if (
    selectedCommand &&
    selectedAction &&
    !commandScopedDescriptors.some(
      (descriptor) => descriptor.action === selectedAction,
    )
  ) {
    throw new PmCliError(
      `Action "${options.action}" is not mapped to command "${options.command}" in contracts output.`,
      EXIT_CODE.USAGE,
    );
  }

  const schema = PM_TOOL_PARAMETERS_SCHEMA as Record<string, unknown>;
  const schemaBranches = extractActionBranches(schema);
  const schemaActionSet = new Set(
    schemaBranches
      .map((entry) => {
        const properties = entry.properties;
        if (typeof properties !== "object" || properties === null) {
          return null;
        }
        const actionProperty = (properties as Record<string, unknown>).action;
        if (typeof actionProperty !== "object" || actionProperty === null) {
          return null;
        }
        const actionConst = (actionProperty as { const?: unknown }).const;
        return typeof actionConst === "string" ? actionConst : null;
      })
      .filter((entry): entry is string => entry !== null),
  );
  const extensionBranches = extensionContracts
    .filter((contract) => !schemaActionSet.has(contract.action))
    .map((contract) => buildExtensionActionSchemaBranch(contract));
  const mergedSchema =
    extensionBranches.length > 0
      ? {
          ...schema,
          oneOf: [...schemaBranches, ...extensionBranches],
        }
      : schema;

  const scopedActionDescriptors = selectedAction
    ? commandScopedDescriptors.filter(
        (descriptor) => descriptor.action === selectedAction,
      )
    : commandScopedDescriptors;
  const allActionAvailability = scopedActionDescriptors.map((descriptor) =>
    resolveActionAvailability(descriptor, runtimeProbe),
  );
  const actionAvailability =
    runtimeOnly && !selectedAction
      ? allActionAvailability.filter((entry) => entry.invocable)
      : allActionAvailability;
  const actions = actionAvailability.map((entry) => entry.action);
  const descriptorActionSet = new Set(
    actionDescriptors.map((descriptor) => descriptor.action),
  );
  let filteredSchema = selectedAction
    ? filterSchemaByAction(mergedSchema, selectedAction)
    : selectedCommand
      ? filterSchemaByActions(
          mergedSchema,
          new Set(
            scopedActionDescriptors.map((descriptor) => descriptor.action),
          ),
        )
      : filterSchemaByActions(mergedSchema, descriptorActionSet);
  if (runtimeOnly && !selectedAction) {
    filteredSchema = filterSchemaByActions(filteredSchema, new Set(actions));
  }
  const includeSchemaSurface = !flagsOnly && !availabilityOnly;
  if (includeSchemaSurface) {
    filteredSchema = attachCreateRequiredOptionContracts(
      filteredSchema,
      createRequiredOptionContracts,
    );
  }
  const commands =
    selectedCommand !== undefined
      ? [selectedCommand]
      : selectedAction
        ? resolveScopedCommandsFromActionDescriptors(
            scopedActionDescriptors,
            commandCatalog,
          )
        : commandCatalog;
  const outputCommands =
    flagsOnly && selectedCommand === undefined && selectedAction === undefined
      ? compactCommandAliasSurface(commands)
      : commands;
  const commandAliases = buildCommandAliasSurface(commands);
  const extensionCommandContracts = selectedCommand
    ? extensionContracts.filter((entry) => entry.command === selectedCommand)
    : selectedAction
      ? extensionContracts.filter((entry) =>
          outputCommands.includes(normalizeCommandPath(entry.command)),
        )
      : extensionContracts;

  const result: ContractsResult = {
    schema_version:
      typeof mergedSchema["x-schema-version"] === "string"
        ? (mergedSchema["x-schema-version"] as string)
        : null,
    schema_id:
      typeof mergedSchema.$id === "string"
        ? (mergedSchema.$id as string)
        : null,
    selected: {
      action: selectedAction ?? null,
      command: selectedCommand ?? null,
      schema_only: schemaOnly,
      flags_only: flagsOnly,
      availability_only: availabilityOnly,
      runtime_only: runtimeOnly,
      command_scoped: selectedCommand !== undefined,
    },
    commands: outputCommands,
    runtime_schema: {
      statuses: statusRegistry.definitions.map((definition) => definition.id),
      open_status: statusRegistry.open_status,
      close_status: statusRegistry.close_status,
      canceled_status: statusRegistry.canceled_status,
      types: [...typeRegistry.types],
      fields_by_command: Object.fromEntries(
        [...runtimeFieldRegistry.command_to_fields.entries()].map(
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
    },
    extension_contracts: {
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
    },
  };

  if (!flagsOnly) {
    result.actions = actions;
    result.action_availability = actionAvailability;
  }

  if (includeSchemaSurface && !omitUnfilteredSchema) {
    result.schema = filteredSchema;
    result.extension_commands = extensionCommandContracts;
  } else if (includeSchemaSurface && omitUnfilteredSchema) {
    result.schema_omitted_reason = "unfiltered_default_brief";
    result.extension_commands = extensionCommandContracts;
  }

  if (!schemaOnly && !availabilityOnly) {
    if (!omitUnfilteredCommandFlags) {
      result.command_flags = buildCommandFlagSurface(
        outputCommands,
        extensionFlagMap,
        runtimeFieldFlagMap,
      );
    } else {
      result.command_flags_omitted_reason = "unfiltered_default_brief";
    }
    if (commandAliases.length > 0) {
      result.command_aliases = commandAliases;
    }
  }

  if (!schemaOnly && !flagsOnly && !availabilityOnly) {
    if (!omitUnfilteredCommanderAliases) {
      result.commander_aliases = buildCommanderAliasSurface();
    } else {
      result.commander_aliases_omitted_reason = "unfiltered_default_brief";
    }
  }

  return result;
}
