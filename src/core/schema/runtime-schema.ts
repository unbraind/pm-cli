import path from "node:path";
import { pathExists, readFileIfExists, writeFileAtomic } from "../fs/fs-utils.js";
import {
  RUNTIME_FIELD_COMMAND_VALUES,
  RUNTIME_FIELD_TYPE_VALUES,
  RUNTIME_STATUS_ROLE_VALUES,
  RUNTIME_UNKNOWN_FIELD_POLICY_VALUES,
  STATUS_VALUES,
} from "../../types/index.js";
import type {
  ItemTypeDefinition,
  RuntimeFieldCommand,
  RuntimeFieldDefinition,
  RuntimeFieldType,
  RuntimeSchemaSettings,
  RuntimeStatusDefinition,
  RuntimeStatusRole,
  RuntimeWorkflowDefinition,
} from "../../types/index.js";

export type { RuntimeFieldCommand } from "../../types/index.js";

export const DEFAULT_RUNTIME_SCHEMA_FILE_PATHS = Object.freeze({
  types: "schema/types.json",
  statuses: "schema/statuses.json",
  fields: "schema/fields.json",
  workflows: "schema/workflows.json",
});

export const DEFAULT_RUNTIME_WORKFLOW: RuntimeWorkflowDefinition = Object.freeze({
  draft_status: "draft",
  open_status: "open",
  in_progress_status: "in_progress",
  blocked_status: "blocked",
  close_status: "closed",
  canceled_status: "canceled",
});

export const DEFAULT_RUNTIME_STATUS_DEFINITIONS: ReadonlyArray<RuntimeStatusDefinition> = Object.freeze([
  {
    id: "draft",
    roles: ["draft"],
  },
  {
    id: "open",
    roles: ["active", "default_open"],
  },
  {
    id: "in_progress",
    aliases: ["in-progress"],
    roles: ["active"],
  },
  {
    id: "blocked",
    roles: ["blocked"],
  },
  {
    id: "closed",
    roles: ["terminal", "terminal_done", "default_close"],
  },
  {
    id: "canceled",
    aliases: ["cancelled"],
    roles: ["terminal", "terminal_canceled", "default_cancel"],
  },
]);

const DEFAULT_RUNTIME_FIELD_COMMANDS: RuntimeFieldCommand[] = ["create", "update"];

export interface RuntimeStatusDefinitionResolved {
  id: string;
  aliases: string[];
  roles: RuntimeStatusRole[];
  description?: string;
  order: number;
}

export interface RuntimeFieldDefinitionResolved {
  key: string;
  metadata_key: string;
  cli_flag: string;
  cli_aliases: string[];
  description?: string;
  type: RuntimeFieldType;
  commands: RuntimeFieldCommand[];
  repeatable: boolean;
  required: boolean;
  required_on_create: boolean;
  required_types: string[];
  allow_unset: boolean;
}

export interface RuntimeStatusRegistry {
  definitions: RuntimeStatusDefinitionResolved[];
  by_id: Map<string, RuntimeStatusDefinitionResolved>;
  alias_to_id: Map<string, string>;
  terminal_statuses: Set<string>;
  terminal_done_statuses: Set<string>;
  terminal_canceled_statuses: Set<string>;
  active_statuses: Set<string>;
  blocked_statuses: Set<string>;
  draft_statuses: Set<string>;
  open_status: string;
  close_status: string;
  canceled_status: string;
}

export interface RuntimeFieldRegistry {
  definitions: RuntimeFieldDefinitionResolved[];
  by_key: Map<string, RuntimeFieldDefinitionResolved>;
  by_cli_token: Map<string, RuntimeFieldDefinitionResolved>;
  command_to_fields: Map<RuntimeFieldCommand, RuntimeFieldDefinitionResolved[]>;
}

export interface RuntimeSchemaFileBootstrapResult {
  created_paths: string[];
}

export interface LoadedRuntimeSchemaSections {
  schema: RuntimeSchemaSettings;
  type_definitions_from_file: ItemTypeDefinition[] | undefined;
  warnings: string[];
  created_paths: string[];
}

const RUNTIME_STATUS_ROLE_SET = new Set<string>(RUNTIME_STATUS_ROLE_VALUES);
const RUNTIME_FIELD_TYPE_SET = new Set<string>(RUNTIME_FIELD_TYPE_VALUES);
const RUNTIME_FIELD_COMMAND_SET = new Set<string>(RUNTIME_FIELD_COMMAND_VALUES);
const RUNTIME_UNKNOWN_FIELD_POLICY_SET = new Set<string>(RUNTIME_UNKNOWN_FIELD_POLICY_VALUES);

function normalizeStringList(values: string[] | undefined): string[] {
  const candidates = Array.isArray(values) ? values : [];
  return [...new Set(candidates.map((value) => (typeof value === "string" ? value.trim() : "")).filter((value) => value.length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function normalizeStatusToken(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replaceAll(/[\s-]+/g, "_") : "";
}

function normalizeStatusId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const normalized = normalizeStatusToken(value);
  return normalized.length > 0 ? normalized : undefined;
}

function stripFlagPrefix(value: string): string {
  return value.startsWith("--") ? value.slice(2) : value;
}

function normalizeCliToken(value: unknown): string {
  return typeof value === "string" ? stripFlagPrefix(value.trim().toLowerCase().replaceAll(/[\s_]+/g, "-")) : "";
}

function keyToDefaultCliFlag(value: string): string {
  return value.replaceAll("_", "-");
}

function toCamelCase(input: string): string {
  const segments = input
    .replaceAll(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
  if (segments.length === 0) {
    return input;
  }
  const [first, ...rest] = segments;
  return `${first}${rest.map((segment) => `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`).join("")}`;
}

function normalizeRuntimeStatusDefinition(
  definition: RuntimeStatusDefinition,
  fallbackOrder: number,
): RuntimeStatusDefinitionResolved | null {
  const id = normalizeStatusId(definition.id);
  if (!id) {
    return null;
  }
  const aliases = normalizeStringList(definition.aliases).map((value) => normalizeStatusToken(value)).filter((value) => value !== id);
  const roles = normalizeStringList(definition.roles).filter((value): value is RuntimeStatusRole => RUNTIME_STATUS_ROLE_SET.has(value));
  const description = definition.description?.trim();
  const order = typeof definition.order === "number" && Number.isFinite(definition.order) ? definition.order : fallbackOrder;
  return {
    id,
    aliases,
    roles,
    description: description && description.length > 0 ? description : undefined,
    order,
  };
}

function normalizeRuntimeWorkflow(workflow: RuntimeWorkflowDefinition | undefined): RuntimeWorkflowDefinition {
  return {
    draft_status: normalizeStatusId(workflow?.draft_status),
    open_status: normalizeStatusId(workflow?.open_status),
    in_progress_status: normalizeStatusId(workflow?.in_progress_status),
    blocked_status: normalizeStatusId(workflow?.blocked_status),
    close_status: normalizeStatusId(workflow?.close_status),
    canceled_status: normalizeStatusId(workflow?.canceled_status),
  };
}

function normalizeRuntimeFieldDefinition(definition: RuntimeFieldDefinition): RuntimeFieldDefinitionResolved | null {
  const key = normalizeStatusToken(definition.key ?? "");
  if (!key) {
    return null;
  }
  const metadataKey = normalizeStatusToken(definition.metadata_key ?? definition.front_matter_key ?? key);
  const cliFlag = normalizeCliToken(definition.cli_flag ?? keyToDefaultCliFlag(key));
  if (!cliFlag) {
    return null;
  }
  const cliAliases = normalizeStringList(definition.cli_aliases)
    .map((value) => normalizeCliToken(value))
    .filter((value) => value.length > 0 && value !== cliFlag);
  const typeCandidate = typeof definition.type === "string" ? definition.type.trim().toLowerCase() : "string";
  const type = RUNTIME_FIELD_TYPE_SET.has(typeCandidate) ? (typeCandidate as RuntimeFieldType) : "string";
  const commands = (() => {
    const normalized = normalizeStringList(definition.commands).filter((value): value is RuntimeFieldCommand =>
      RUNTIME_FIELD_COMMAND_SET.has(value),
    );
    if (normalized.length > 0) {
      return normalized;
    }
    return [...DEFAULT_RUNTIME_FIELD_COMMANDS];
  })();
  const description = definition.description?.trim();
  const requiredTypes = normalizeStringList(definition.required_types);
  return {
    key,
    metadata_key: metadataKey,
    cli_flag: cliFlag,
    cli_aliases: cliAliases,
    description: description && description.length > 0 ? description : undefined,
    type,
    commands,
    repeatable: definition.repeatable === true || type === "string_array",
    required: definition.required === true,
    required_on_create: definition.required_on_create === true,
    required_types: requiredTypes,
    allow_unset: definition.allow_unset !== false,
  };
}

export function normalizeRuntimeSchemaSettings(schema: Partial<RuntimeSchemaSettings> | undefined): RuntimeSchemaSettings {
  const files = {
    ...DEFAULT_RUNTIME_SCHEMA_FILE_PATHS,
    ...(schema?.files ?? {}),
  };
  const statusesSource = schema?.statuses && schema.statuses.length > 0 ? schema.statuses : DEFAULT_RUNTIME_STATUS_DEFINITIONS;
  const normalizedStatuses = (() => {
    const dedupedById = new Map<string, RuntimeStatusDefinitionResolved>();
    for (const [index, definition] of statusesSource.entries()) {
      const normalized = normalizeRuntimeStatusDefinition(definition, index);
      if (!normalized) {
        continue;
      }
      dedupedById.set(normalized.id, normalized);
    }
    const values = [...dedupedById.values()].sort((left, right) =>
      left.order === right.order ? left.id.localeCompare(right.id) : left.order - right.order,
    );
    if (values.length > 0) {
      return values;
    }
    return DEFAULT_RUNTIME_STATUS_DEFINITIONS.map((definition, index) =>
      normalizeRuntimeStatusDefinition(definition, index),
    ).filter((definition): definition is RuntimeStatusDefinitionResolved => definition !== null);
  })();
  const normalizedFields = (() => {
    const dedupedByKey = new Map<string, RuntimeFieldDefinitionResolved>();
    for (const definition of schema?.fields ?? []) {
      const normalized = normalizeRuntimeFieldDefinition(definition);
      if (!normalized) {
        continue;
      }
      dedupedByKey.set(normalized.key, normalized);
    }
    return [...dedupedByKey.values()].sort((left, right) => left.key.localeCompare(right.key));
  })();
  const unknownFieldPolicyCandidate =
    typeof schema?.unknown_field_policy === "string" ? schema.unknown_field_policy.trim().toLowerCase() : "allow";
  const unknownFieldPolicy = RUNTIME_UNKNOWN_FIELD_POLICY_SET.has(unknownFieldPolicyCandidate)
    ? unknownFieldPolicyCandidate
    : "allow";
  return {
    version: typeof schema?.version === "number" && Number.isFinite(schema.version) ? Math.floor(schema.version) : 1,
    files,
    statuses: normalizedStatuses.map((definition) => ({
      id: definition.id,
      aliases: definition.aliases.length > 0 ? [...definition.aliases] : undefined,
      roles: definition.roles.length > 0 ? [...definition.roles] : undefined,
      description: definition.description,
      order: definition.order,
    })),
    fields: normalizedFields.map((definition) => ({
      key: definition.key,
      metadata_key: definition.metadata_key !== definition.key ? definition.metadata_key : undefined,
      cli_flag: definition.cli_flag !== keyToDefaultCliFlag(definition.key) ? definition.cli_flag : undefined,
      cli_aliases: definition.cli_aliases.length > 0 ? [...definition.cli_aliases] : undefined,
      description: definition.description,
      type: definition.type,
      commands: [...definition.commands],
      repeatable: definition.repeatable === true ? true : undefined,
      required: definition.required === true ? true : undefined,
      required_on_create: definition.required_on_create === true ? true : undefined,
      required_types: definition.required_types.length > 0 ? [...definition.required_types] : undefined,
      allow_unset: definition.allow_unset === false ? false : undefined,
    })),
    workflow: {
      ...DEFAULT_RUNTIME_WORKFLOW,
      ...normalizeRuntimeWorkflow(schema?.workflow),
    },
    unknown_field_policy: unknownFieldPolicy as RuntimeSchemaSettings["unknown_field_policy"],
  };
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function buildTypesFileSeed(): unknown {
  return {
    definitions: [],
  };
}

function buildStatusesFileSeed(): unknown {
  return {
    statuses: DEFAULT_RUNTIME_STATUS_DEFINITIONS,
  };
}

function buildFieldsFileSeed(): unknown {
  return {
    fields: [],
  };
}

function buildWorkflowsFileSeed(): unknown {
  return {
    workflow: DEFAULT_RUNTIME_WORKFLOW,
  };
}

function parseOptionalJson(raw: string, warningKey: string, warnings: string[]): unknown | undefined {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    warnings.push(warningKey);
    return undefined;
  }
}

function readTypeDefinitionsFromSchemaFile(parsed: unknown): ItemTypeDefinition[] | undefined {
  if (Array.isArray(parsed)) {
    return parsed as ItemTypeDefinition[];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.definitions)) {
    return record.definitions as ItemTypeDefinition[];
  }
  if (typeof record.item_types === "object" && record.item_types !== null) {
    const itemTypesRecord = record.item_types as Record<string, unknown>;
    if (Array.isArray(itemTypesRecord.definitions)) {
      return itemTypesRecord.definitions as ItemTypeDefinition[];
    }
  }
  return undefined;
}

function readStatusesFromSchemaFile(parsed: unknown): RuntimeStatusDefinition[] | undefined {
  if (Array.isArray(parsed)) {
    return parsed as RuntimeStatusDefinition[];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.statuses)) {
    return record.statuses as RuntimeStatusDefinition[];
  }
  if (Array.isArray(record.definitions)) {
    return record.definitions as RuntimeStatusDefinition[];
  }
  return undefined;
}

function readFieldsFromSchemaFile(parsed: unknown): RuntimeFieldDefinition[] | undefined {
  if (Array.isArray(parsed)) {
    return parsed as RuntimeFieldDefinition[];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.fields)) {
    return record.fields as RuntimeFieldDefinition[];
  }
  if (Array.isArray(record.definitions)) {
    return record.definitions as RuntimeFieldDefinition[];
  }
  return undefined;
}

function readWorkflowFromSchemaFile(parsed: unknown): RuntimeWorkflowDefinition | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.workflow === "object" && record.workflow !== null && !Array.isArray(record.workflow)) {
    return record.workflow as RuntimeWorkflowDefinition;
  }
  if (typeof record.workflows === "object" && record.workflows !== null && !Array.isArray(record.workflows)) {
    return record.workflows as RuntimeWorkflowDefinition;
  }
  return record as RuntimeWorkflowDefinition;
}

function filePathForSchemaSection(pmRoot: string, configuredPath: string | undefined, fallbackPath: string): string {
  const normalized = configuredPath?.trim() || fallbackPath;
  if (path.isAbsolute(normalized)) {
    return normalized;
  }
  return path.join(pmRoot, normalized);
}

export async function ensureRuntimeSchemaFileScaffold(
  pmRoot: string,
  schema: RuntimeSchemaSettings,
): Promise<RuntimeSchemaFileBootstrapResult> {
  const normalizedSchema = normalizeRuntimeSchemaSettings(schema);
  const specs: Array<{ path: string; seed: unknown }> = [
    {
      path: filePathForSchemaSection(pmRoot, normalizedSchema.files.types, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.types),
      seed: buildTypesFileSeed(),
    },
    {
      path: filePathForSchemaSection(pmRoot, normalizedSchema.files.statuses, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.statuses),
      seed: buildStatusesFileSeed(),
    },
    {
      path: filePathForSchemaSection(pmRoot, normalizedSchema.files.fields, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.fields),
      seed: buildFieldsFileSeed(),
    },
    {
      path: filePathForSchemaSection(pmRoot, normalizedSchema.files.workflows, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.workflows),
      seed: buildWorkflowsFileSeed(),
    },
  ];
  const createdPaths: string[] = [];
  for (const spec of specs) {
    if (await pathExists(spec.path)) {
      continue;
    }
    await writeFileAtomic(spec.path, serializeJson(spec.seed));
    createdPaths.push(spec.path);
  }
  return {
    created_paths: createdPaths,
  };
}

export async function loadRuntimeSchemaFromOptionalFiles(
  pmRoot: string,
  schema: RuntimeSchemaSettings,
): Promise<LoadedRuntimeSchemaSections> {
  const normalizedSchema = normalizeRuntimeSchemaSettings(schema);
  const warnings: string[] = [];
  const typeFilePath = filePathForSchemaSection(pmRoot, normalizedSchema.files.types, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.types);
  const statusFilePath = filePathForSchemaSection(
    pmRoot,
    normalizedSchema.files.statuses,
    DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.statuses,
  );
  const fieldsFilePath = filePathForSchemaSection(pmRoot, normalizedSchema.files.fields, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.fields);
  const workflowsFilePath = filePathForSchemaSection(
    pmRoot,
    normalizedSchema.files.workflows,
    DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.workflows,
  );

  const typeDefinitionsFromFile = (() => {
    return undefined as ItemTypeDefinition[] | undefined;
  })();
  let loadedTypeDefinitions = typeDefinitionsFromFile;
  let loadedStatuses: RuntimeStatusDefinition[] | undefined;
  let loadedFields: RuntimeFieldDefinition[] | undefined;
  let loadedWorkflow: RuntimeWorkflowDefinition | undefined;

  const readAndParse = async (targetPath: string, warningKey: string): Promise<unknown | undefined> => {
    const raw = await readFileIfExists(targetPath);
    if (raw === null) {
      return undefined;
    }
    return parseOptionalJson(raw, warningKey, warnings);
  };

  const parsedTypes = await readAndParse(typeFilePath, "runtime_schema_types_invalid_json");
  if (parsedTypes !== undefined) {
    loadedTypeDefinitions = readTypeDefinitionsFromSchemaFile(parsedTypes);
    if (loadedTypeDefinitions === undefined) {
      warnings.push("runtime_schema_types_invalid_shape");
    }
  }

  const parsedStatuses = await readAndParse(statusFilePath, "runtime_schema_statuses_invalid_json");
  if (parsedStatuses !== undefined) {
    loadedStatuses = readStatusesFromSchemaFile(parsedStatuses);
    if (loadedStatuses === undefined) {
      warnings.push("runtime_schema_statuses_invalid_shape");
    }
  }

  const parsedFields = await readAndParse(fieldsFilePath, "runtime_schema_fields_invalid_json");
  if (parsedFields !== undefined) {
    loadedFields = readFieldsFromSchemaFile(parsedFields);
    if (loadedFields === undefined) {
      warnings.push("runtime_schema_fields_invalid_shape");
    }
  }

  const parsedWorkflow = await readAndParse(workflowsFilePath, "runtime_schema_workflows_invalid_json");
  if (parsedWorkflow !== undefined) {
    loadedWorkflow = readWorkflowFromSchemaFile(parsedWorkflow);
    if (loadedWorkflow === undefined) {
      warnings.push("runtime_schema_workflows_invalid_shape");
    }
  }

  const mergedSchema = normalizeRuntimeSchemaSettings({
    ...normalizedSchema,
    statuses: [...normalizedSchema.statuses, ...(loadedStatuses ?? [])],
    fields: [...normalizedSchema.fields, ...(loadedFields ?? [])],
    workflow: {
      ...normalizedSchema.workflow,
      ...(loadedWorkflow ?? {}),
    },
  });

  return {
    schema: mergedSchema,
    type_definitions_from_file: loadedTypeDefinitions,
    warnings,
    created_paths: [],
  };
}

function preferredStatusForRole(
  definitions: RuntimeStatusDefinitionResolved[],
  role: RuntimeStatusRole,
  fallbackValues: string[],
): string | undefined {
  const withRole = definitions.filter((definition) => definition.roles.includes(role));
  if (withRole.length > 0) {
    return withRole[0].id;
  }
  for (const value of fallbackValues) {
    const normalized = normalizeStatusId(value);
    if (!normalized) {
      continue;
    }
    if (definitions.some((definition) => definition.id === normalized)) {
      return normalized;
    }
  }
  return definitions[0]?.id;
}

export function resolveRuntimeStatusRegistry(schema: RuntimeSchemaSettings): RuntimeStatusRegistry {
  const normalizedSchema = normalizeRuntimeSchemaSettings(schema);
  const definitions = normalizedSchema.statuses.map((definition, index) =>
    normalizeRuntimeStatusDefinition(definition, index),
  ).filter((definition): definition is RuntimeStatusDefinitionResolved => definition !== null);
  const aliasToId = new Map<string, string>();
  const byId = new Map<string, RuntimeStatusDefinitionResolved>();
  for (const definition of definitions) {
    byId.set(definition.id, definition);
    aliasToId.set(definition.id, definition.id);
    aliasToId.set(definition.id.replaceAll("_", "-"), definition.id);
    aliasToId.set(definition.id.replaceAll("_", " "), definition.id);
    for (const alias of definition.aliases) {
      aliasToId.set(alias, definition.id);
      aliasToId.set(alias.replaceAll("_", "-"), definition.id);
      aliasToId.set(alias.replaceAll("_", " "), definition.id);
    }
  }
  const terminalStatuses = new Set<string>();
  const terminalDoneStatuses = new Set<string>();
  const terminalCanceledStatuses = new Set<string>();
  const activeStatuses = new Set<string>();
  const blockedStatuses = new Set<string>();
  const draftStatuses = new Set<string>();
  for (const definition of definitions) {
    const roles = new Set(definition.roles);
    if (roles.has("terminal") || roles.has("terminal_done") || roles.has("terminal_canceled")) {
      terminalStatuses.add(definition.id);
    }
    if (roles.has("terminal_done")) {
      terminalDoneStatuses.add(definition.id);
    }
    if (roles.has("terminal_canceled")) {
      terminalCanceledStatuses.add(definition.id);
    }
    if (roles.has("active")) {
      activeStatuses.add(definition.id);
    }
    if (roles.has("blocked")) {
      blockedStatuses.add(definition.id);
    }
    if (roles.has("draft")) {
      draftStatuses.add(definition.id);
    }
  }
  const workflow = normalizedSchema.workflow;
  const openStatus =
    normalizeStatusId(workflow.open_status) ??
    preferredStatusForRole(definitions, "default_open", ["open", "in_progress", STATUS_VALUES[0] ?? "open"]);
  const closeStatus =
    normalizeStatusId(workflow.close_status) ??
    preferredStatusForRole(definitions, "default_close", ["closed", "done", "complete"]);
  const canceledStatus =
    normalizeStatusId(workflow.canceled_status) ??
    preferredStatusForRole(definitions, "default_cancel", ["canceled", "cancelled"]);

  return {
    definitions,
    by_id: byId,
    alias_to_id: aliasToId,
    terminal_statuses: terminalStatuses,
    terminal_done_statuses: terminalDoneStatuses,
    terminal_canceled_statuses: terminalCanceledStatuses,
    active_statuses: activeStatuses,
    blocked_statuses: blockedStatuses,
    draft_statuses: draftStatuses,
    open_status: openStatus ?? definitions[0]?.id ?? "open",
    close_status: closeStatus ?? definitions[0]?.id ?? "closed",
    canceled_status: canceledStatus ?? definitions[0]?.id ?? "canceled",
  };
}

export function normalizeStatusInputWithRegistry(value: string, registry: RuntimeStatusRegistry): string | undefined {
  const normalized = normalizeStatusToken(value);
  if (!normalized) {
    return undefined;
  }
  return registry.alias_to_id.get(normalized);
}

export function resolveRuntimeFieldRegistry(schema: RuntimeSchemaSettings): RuntimeFieldRegistry {
  const normalizedSchema = normalizeRuntimeSchemaSettings(schema);
  const dedupedByKey = new Map<string, RuntimeFieldDefinitionResolved>();
  for (const definition of normalizedSchema.fields) {
    const normalized = normalizeRuntimeFieldDefinition(definition);
    if (!normalized) {
      continue;
    }
    dedupedByKey.set(normalized.key, normalized);
  }
  const definitions = [...dedupedByKey.values()].sort((left, right) => left.key.localeCompare(right.key));
  const byKey = new Map<string, RuntimeFieldDefinitionResolved>();
  const byCliToken = new Map<string, RuntimeFieldDefinitionResolved>();
  const commandToFields = new Map<RuntimeFieldCommand, RuntimeFieldDefinitionResolved[]>();
  for (const definition of definitions) {
    byKey.set(definition.key, definition);
    byCliToken.set(definition.cli_flag, definition);
    for (const alias of definition.cli_aliases) {
      byCliToken.set(alias, definition);
    }
    for (const command of definition.commands) {
      const existing = commandToFields.get(command) ?? [];
      existing.push(definition);
      commandToFields.set(command, existing);
    }
  }
  for (const [command, fieldDefinitions] of commandToFields.entries()) {
    fieldDefinitions.sort((left, right) => left.key.localeCompare(right.key));
    commandToFields.set(command, fieldDefinitions);
  }
  return {
    definitions,
    by_key: byKey,
    by_cli_token: byCliToken,
    command_to_fields: commandToFields,
  };
}

export function runtimeFieldOptionTarget(field: RuntimeFieldDefinitionResolved): string {
  return toCamelCase(field.key);
}

export function statusIsTerminal(status: string, registry: RuntimeStatusRegistry): boolean {
  const normalized = normalizeStatusInputWithRegistry(status, registry);
  if (!normalized) {
    return false;
  }
  return registry.terminal_statuses.has(normalized);
}
