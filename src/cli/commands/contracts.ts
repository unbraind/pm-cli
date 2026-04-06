import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { activateExtensions, loadExtensions } from "../../core/extensions/index.js";
import type {
  RegisteredExtensionCommandDefinition,
  RegisteredExtensionFlagDefinitions,
} from "../../core/extensions/index.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import {
  AGGREGATE_FLAG_CONTRACTS,
  CALENDAR_COMMANDER_STRING_OPTION_CONTRACTS,
  CALENDAR_FLAG_CONTRACTS,
  COMMENTS_AUDIT_FLAG_CONTRACTS,
  CLOSE_FLAG_CONTRACTS,
  CONTRACTS_FLAG_CONTRACTS,
  CONTEXT_COMMANDER_STRING_OPTION_CONTRACTS,
  CONTEXT_FLAG_CONTRACTS,
  CREATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
  CREATE_COMMANDER_STRING_OPTION_CONTRACTS,
  CREATE_FLAG_CONTRACTS,
  DEDUPE_AUDIT_FLAG_CONTRACTS,
  GLOBAL_FLAG_CONTRACTS,
  HEALTH_FLAG_CONTRACTS,
  LIST_COMMANDER_STRING_OPTION_CONTRACTS,
  LIST_FILTER_FLAG_CONTRACTS,
  PM_CORE_COMMAND_NAMES,
  PM_TOOL_ACTIONS,
  PM_TOOL_PARAMETERS_SCHEMA,
  REINDEX_FLAG_CONTRACTS,
  SEARCH_COMMANDER_STRING_OPTION_CONTRACTS,
  SEARCH_FLAG_CONTRACTS,
  TEST_ALL_FLAG_CONTRACTS,
  TEST_FLAG_CONTRACTS,
  UPDATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
  UPDATE_COMMANDER_STRING_OPTION_CONTRACTS,
  UPDATE_FLAG_CONTRACTS,
  VALIDATE_FLAG_CONTRACTS,
  type CliFlagContract,
  type CommanderOptionAliasContract,
} from "../../sdk/cli-contracts.js";

export interface ContractsCommandOptions {
  action?: string;
  command?: string;
  schemaOnly?: boolean;
  runtimeOnly?: boolean;
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

export interface ContractsResult {
  schema_version: string | null;
  schema_id: string | null;
  selected: {
    action: string | null;
    command: string | null;
    schema_only: boolean;
    runtime_only: boolean;
  };
  actions: string[];
  action_availability: ContractsActionAvailability[];
  commands: string[];
  schema: Record<string, unknown>;
  command_flags?: CommandFlagSurface[];
  commander_aliases?: Record<string, CommanderOptionAliasContract[]>;
  extension_commands?: ExtensionCommandContract[];
}

type PmToolAction = (typeof PM_TOOL_ACTIONS)[number];

export interface ContractsActionAvailability {
  action: string;
  invocable: boolean;
  available: boolean;
  requires_extension: boolean;
  provider: "core" | "extension";
  disabled_reason: string | null;
}

interface RuntimeExtensionActionProbe {
  handlers: Set<string>;
  disabledReason: string | null;
  commandDefinitions: RegisteredExtensionCommandDefinition[];
  flagRegistrations: RegisteredExtensionFlagDefinitions[];
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

const EXTENSION_ACTION_COMMAND_PATHS: Partial<Record<PmToolAction, string>> = {
  "beads-import": "beads import",
  "todos-import": "todos import",
  "todos-export": "todos export",
};

function normalizeToken(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractActionBranches(schema: Record<string, unknown>): Record<string, unknown>[] {
  const oneOf = schema.oneOf;
  if (!Array.isArray(oneOf)) {
    return [];
  }
  return oneOf.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
}

function filterSchemaByAction(schema: Record<string, unknown>, action: string | undefined): Record<string, unknown> {
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

function filterSchemaByActions(schema: Record<string, unknown>, actions: ReadonlySet<string>): Record<string, unknown> {
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

function toExtensionFlagContract(definition: Record<string, unknown>): CliFlagContract | null {
  const longName = toOptionalTrimmedString(definition.long);
  const shortName = toOptionalTrimmedString(definition.short);
  const normalizedLong = longName && longName.startsWith("--") && longName.length > 2 ? longName : null;
  const normalizedShort = shortName && shortName.startsWith("-") && !shortName.startsWith("--") ? shortName : null;
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
        return left.name.localeCompare(right.name);
      }),
    });
  }
  return normalized;
}

function collectExtensionCommandContracts(runtimeProbe: RuntimeExtensionActionProbe): ExtensionCommandContract[] {
  const flagsByCommand = collectExtensionFlagContractsByCommand(runtimeProbe.flagRegistrations);
  const definitionsByCommand = new Map<string, ExtensionCommandContract>();
  for (const definition of runtimeProbe.commandDefinitions) {
    const command = normalizeCommandPath(definition.command);
    if (command.length === 0) {
      continue;
    }
    const action = toOptionalTrimmedString(definition.action) ?? normalizeActionNameFromCommand(command);
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
            (argument): argument is { name: string; required: boolean; variadic: boolean; description: string | null } =>
              argument !== null,
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
  for (const command of [...extensionCommands].sort((left, right) => left.localeCompare(right))) {
    const definition = definitionsByCommand.get(command);
    if (definition) {
      contracts.push({
        ...definition,
        flags: definition.flags.length > 0 ? definition.flags : flagsByCommand.get(command)?.flags ?? [],
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

function extensionSchemaPropertyNameFromFlag(flag: CliFlagContract): string | null {
  const normalized = flag.flag.replace(/^-+/, "").trim();
  if (normalized.length === 0) {
    return null;
  }
  const camelCased = normalized.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
  const cleaned = camelCased.replace(/[^a-zA-Z0-9]/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

function buildExtensionActionSchemaBranch(contract: ExtensionCommandContract): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    action: {
      type: "string",
      const: contract.action,
      description: contract.intent ?? contract.description ?? `Invoke extension command '${contract.command}'.`,
    },
  };
  const required: string[] = ["action"];
  for (const argument of contract.arguments) {
    if (argument.variadic) {
      properties[argument.name] = {
        type: "array",
        items: { type: "string" },
        description: argument.description ?? `Variadic argument '${argument.name}' for extension action '${contract.action}'.`,
      };
    } else {
      properties[argument.name] = {
        type: "string",
        description: argument.description ?? `Argument '${argument.name}' for extension action '${contract.action}'.`,
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

async function resolveRuntimeExtensionActionProbe(global: GlobalOptions): Promise<RuntimeExtensionActionProbe> {
  if (global.noExtensions) {
    return {
      handlers: new Set<string>(),
      disabledReason: "extensions_disabled",
      commandDefinitions: [],
      flagRegistrations: [],
    };
  }

  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    return {
      handlers: new Set<string>(),
      disabledReason: null,
      commandDefinitions: [],
      flagRegistrations: [],
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
      activationResult.commands.handlers.map((entry) => normalizeCommandPath(entry.command)),
    );
    return {
      handlers,
      disabledReason: null,
      commandDefinitions: activationResult.registrations.commands,
      flagRegistrations: activationResult.registrations.flags,
    };
  } catch {
    return {
      handlers: new Set<string>(),
      disabledReason: "extension_runtime_probe_failed",
      commandDefinitions: [],
      flagRegistrations: [],
    };
  }
}

interface ActionContractDescriptor {
  action: string;
  provider: "core" | "extension";
  requires_extension: boolean;
  command_path: string | null;
}

function collectActionContractDescriptors(extensionContracts: ExtensionCommandContract[]): ActionContractDescriptor[] {
  const descriptors = new Map<string, ActionContractDescriptor>();
  for (const action of PM_TOOL_ACTIONS) {
    const extensionCommandPath = EXTENSION_ACTION_COMMAND_PATHS[action as PmToolAction];
    descriptors.set(action, {
      action,
      provider: extensionCommandPath ? "extension" : "core",
      requires_extension: extensionCommandPath !== undefined,
      command_path: extensionCommandPath ? normalizeCommandPath(extensionCommandPath) : null,
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
  return [...descriptors.values()].sort((left, right) => left.action.localeCompare(right.action));
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
    };
  }

  const commandPath = descriptor.command_path ? normalizeCommandPath(descriptor.command_path) : "";
  const extensionCommandAvailable = commandPath.length > 0 && runtimeProbe.handlers.has(commandPath);
  const invocable = runtimeProbe.disabledReason === null && extensionCommandAvailable;
  return {
    action: descriptor.action,
    invocable,
    available: invocable,
    requires_extension: true,
    provider: "extension",
    disabled_reason: invocable ? null : runtimeProbe.disabledReason ?? "extension_command_not_registered",
  };
}

function resolveCoreCommandFlags(command: string): CliFlagContract[] {
  if (command === "create") {
    return CREATE_FLAG_CONTRACTS;
  }
  if (command === "update") {
    return UPDATE_FLAG_CONTRACTS;
  }
  if (command === "calendar" || command === "cal") {
    return CALENDAR_FLAG_CONTRACTS;
  }
  if (command === "context" || command === "ctx") {
    return CONTEXT_FLAG_CONTRACTS;
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
  if (command === "reindex") {
    return REINDEX_FLAG_CONTRACTS;
  }
  if (command === "close") {
    return CLOSE_FLAG_CONTRACTS;
  }
  if (command === "test") {
    return TEST_FLAG_CONTRACTS;
  }
  if (command === "test-all") {
    return TEST_ALL_FLAG_CONTRACTS;
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
  if (LIST_COMMAND_NAMES.has(command)) {
    return LIST_FILTER_FLAG_CONTRACTS;
  }
  return GLOBAL_FLAG_CONTRACTS;
}

function mergeFlagContracts(primary: CliFlagContract[], secondary: CliFlagContract[]): CliFlagContract[] {
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
  return merged;
}

function buildCommandFlagSurface(
  commands: string[],
  extensionFlagMap: ReturnType<typeof collectExtensionFlagContractsByCommand>,
): CommandFlagSurface[] {
  return commands
    .map((command) => {
      const isCoreCommand = PM_CORE_COMMAND_NAMES.includes(command as (typeof PM_CORE_COMMAND_NAMES)[number]);
      const coreFlags = isCoreCommand ? resolveCoreCommandFlags(command) : [];
      const extensionFlags = extensionFlagMap.get(command);
      const flags = mergeFlagContracts(coreFlags, extensionFlags?.flags ?? []);
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

function buildCommanderAliasSurface(): Record<string, CommanderOptionAliasContract[]> {
  return {
    create_string_options: CREATE_COMMANDER_STRING_OPTION_CONTRACTS,
    create_repeatable_options: CREATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
    update_string_options: UPDATE_COMMANDER_STRING_OPTION_CONTRACTS,
    update_repeatable_options: UPDATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
    list_string_options: LIST_COMMANDER_STRING_OPTION_CONTRACTS,
    search_string_options: SEARCH_COMMANDER_STRING_OPTION_CONTRACTS,
    calendar_string_options: CALENDAR_COMMANDER_STRING_OPTION_CONTRACTS,
    context_string_options: CONTEXT_COMMANDER_STRING_OPTION_CONTRACTS,
  };
}

export async function runContracts(options: ContractsCommandOptions, global: GlobalOptions): Promise<ContractsResult> {
  const selectedAction = normalizeToken(options.action);
  const selectedCommand = normalizeToken(options.command);
  const schemaOnly = options.schemaOnly === true;
  const runtimeOnly = options.runtimeOnly === true;
  const runtimeProbe = await resolveRuntimeExtensionActionProbe(global);
  const extensionContracts = collectExtensionCommandContracts(runtimeProbe);
  const extensionFlagMap = collectExtensionFlagContractsByCommand(runtimeProbe.flagRegistrations);
  const actionDescriptors = collectActionContractDescriptors(extensionContracts);
  const actionNames = new Set(actionDescriptors.map((entry) => entry.action));
  if (selectedAction && !actionNames.has(selectedAction)) {
    throw new PmCliError(`Unknown action: "${options.action}".`, EXIT_CODE.USAGE);
  }

  const commandCatalog = [...new Set([...PM_CORE_COMMAND_NAMES, ...extensionContracts.map((entry) => entry.command)])]
    .map((entry) => normalizeCommandPath(entry))
    .filter((entry) => entry.length > 0)
    .sort((left, right) => left.localeCompare(right));
  const commandNames = new Set(commandCatalog);
  if (selectedCommand && !commandNames.has(selectedCommand)) {
    throw new PmCliError(`Unknown command: "${options.command}".`, EXIT_CODE.USAGE);
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
    ? actionDescriptors.filter((descriptor) => descriptor.action === selectedAction)
    : actionDescriptors;
  const allActionAvailability = scopedActionDescriptors.map((descriptor) =>
    resolveActionAvailability(descriptor, runtimeProbe),
  );
  const actionAvailability =
    runtimeOnly && !selectedAction ? allActionAvailability.filter((entry) => entry.invocable) : allActionAvailability;
  const actions = actionAvailability.map((entry) => entry.action);
  let filteredSchema = filterSchemaByAction(mergedSchema, selectedAction);
  if (runtimeOnly && !selectedAction) {
    filteredSchema = filterSchemaByActions(filteredSchema, new Set(actions));
  }
  const commands = selectedCommand ? [selectedCommand] : commandCatalog;
  const extensionCommandContracts = selectedCommand
    ? extensionContracts.filter((entry) => entry.command === selectedCommand)
    : extensionContracts;

  const result: ContractsResult = {
    schema_version: typeof mergedSchema["x-schema-version"] === "string" ? (mergedSchema["x-schema-version"] as string) : null,
    schema_id: typeof mergedSchema.$id === "string" ? (mergedSchema.$id as string) : null,
    selected: {
      action: selectedAction ?? null,
      command: selectedCommand ?? null,
      schema_only: schemaOnly,
      runtime_only: runtimeOnly,
    },
    actions,
    action_availability: actionAvailability,
    commands,
    schema: filteredSchema,
    extension_commands: extensionCommandContracts,
  };

  if (!schemaOnly) {
    result.command_flags = buildCommandFlagSurface(commands, extensionFlagMap);
    result.commander_aliases = buildCommanderAliasSurface();
  }

  return result;
}
