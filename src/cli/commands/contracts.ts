import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import {
  CALENDAR_COMMANDER_STRING_OPTION_CONTRACTS,
  CALENDAR_FLAG_CONTRACTS,
  CONTRACTS_FLAG_CONTRACTS,
  CONTEXT_COMMANDER_STRING_OPTION_CONTRACTS,
  CONTEXT_FLAG_CONTRACTS,
  CREATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
  CREATE_COMMANDER_STRING_OPTION_CONTRACTS,
  CREATE_FLAG_CONTRACTS,
  GLOBAL_FLAG_CONTRACTS,
  LIST_COMMANDER_STRING_OPTION_CONTRACTS,
  LIST_FILTER_FLAG_CONTRACTS,
  PM_CORE_COMMAND_NAMES,
  PM_TOOL_ACTIONS,
  PM_TOOL_PARAMETERS_SCHEMA,
  SEARCH_COMMANDER_STRING_OPTION_CONTRACTS,
  SEARCH_FLAG_CONTRACTS,
  UPDATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
  UPDATE_COMMANDER_STRING_OPTION_CONTRACTS,
  UPDATE_FLAG_CONTRACTS,
  type CliFlagContract,
  type CommanderOptionAliasContract,
} from "../../sdk/cli-contracts.js";

export interface ContractsCommandOptions {
  action?: string;
  command?: string;
  schemaOnly?: boolean;
}

interface CommandFlagSurface {
  command: string;
  flags: CliFlagContract[];
}

export interface ContractsResult {
  schema_version: string | null;
  schema_id: string | null;
  selected: {
    action: string | null;
    command: string | null;
    schema_only: boolean;
  };
  actions: string[];
  commands: string[];
  schema: Record<string, unknown>;
  command_flags?: CommandFlagSurface[];
  commander_aliases?: Record<string, CommanderOptionAliasContract[]>;
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

function resolveCommandFlags(command: string): CliFlagContract[] {
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
  if (command === "contracts") {
    return CONTRACTS_FLAG_CONTRACTS;
  }
  if (LIST_COMMAND_NAMES.has(command)) {
    return LIST_FILTER_FLAG_CONTRACTS;
  }
  return GLOBAL_FLAG_CONTRACTS;
}

function buildCommandFlagSurface(commands: string[]): CommandFlagSurface[] {
  return commands
    .map((command) => ({
      command,
      flags: resolveCommandFlags(command),
    }))
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

export async function runContracts(options: ContractsCommandOptions, _global: GlobalOptions): Promise<ContractsResult> {
  const selectedAction = normalizeToken(options.action);
  const selectedCommand = normalizeToken(options.command);
  const schemaOnly = options.schemaOnly === true;

  if (selectedAction && !PM_TOOL_ACTIONS.includes(selectedAction as (typeof PM_TOOL_ACTIONS)[number])) {
    throw new PmCliError(`Unknown action: "${options.action}".`, EXIT_CODE.USAGE);
  }
  if (selectedCommand && !PM_CORE_COMMAND_NAMES.includes(selectedCommand as (typeof PM_CORE_COMMAND_NAMES)[number])) {
    throw new PmCliError(`Unknown command: "${options.command}".`, EXIT_CODE.USAGE);
  }

  const schema = PM_TOOL_PARAMETERS_SCHEMA as Record<string, unknown>;
  const filteredSchema = filterSchemaByAction(schema, selectedAction);
  const actions = selectedAction ? [selectedAction] : [...PM_TOOL_ACTIONS];
  const commands = selectedCommand ? [selectedCommand] : [...PM_CORE_COMMAND_NAMES];

  const result: ContractsResult = {
    schema_version: typeof schema["x-schema-version"] === "string" ? (schema["x-schema-version"] as string) : null,
    schema_id: typeof schema.$id === "string" ? (schema.$id as string) : null,
    selected: {
      action: selectedAction ?? null,
      command: selectedCommand ?? null,
      schema_only: schemaOnly,
    },
    actions,
    commands,
    schema: filteredSchema,
  };

  if (!schemaOnly) {
    result.command_flags = buildCommandFlagSurface(commands);
    result.commander_aliases = buildCommanderAliasSurface();
  }

  return result;
}
