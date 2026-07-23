/**
 * @module sdk/schema-migration
 *
 * Plans deterministic, resumable schema evolution over item metadata. Storage
 * execution is layered on the item mutation and workspace transaction
 * primitives so every applied item keeps its normal lock, history, and index
 * guarantees.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  pathExists,
  readFileIfExists,
  writeFileAtomic,
} from "../core/fs/fs-utils.js";
import { appendWorkspaceHistoryChange } from "../core/history/workspace-history.js";
import { resolveItemTypeRegistry } from "../core/item/type-registry.js";
import {
  parseFieldsFile,
  serializeFieldsFile,
} from "../core/schema/fields-file.js";
import {
  parseItemTypesFile,
  serializeItemTypesFile,
} from "../core/schema/item-types-file.js";
import {
  DEFAULT_RUNTIME_SCHEMA_FILE_PATHS,
  filePathForSchemaSection,
  normalizeRuntimeSchemaSettings,
} from "../core/schema/runtime-schema.js";
import {
  parseStatusDefsFile,
  serializeStatusDefsFile,
} from "../core/schema/status-defs-file.js";
import { getActiveExtensionRegistrations } from "../core/extensions/index.js";
import {
  listAllItemMetadataLight,
  locateItem,
  mutateItem,
  readLocatedItem,
} from "../core/store/item-store.js";
import {
  getSettingsPath,
  resolvePmRoot,
} from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import { toErrorMessage } from "../core/shared/primitives.js";
import type { ItemMetadata, PmSettings } from "../types/index.js";
import {
  readItemMetadataDerivedIndexState,
  queryItemMetadataIndex,
} from "./item-metadata-index.js";
import {
  commitWorkspaceTransaction,
  type WorkspaceTransactionStep,
} from "./workspace-transaction.js";

/** Schema changes supported by the workspace migration planner. */
export type SchemaEvolutionMigrationRequest =
  | { kind: "rename-type"; from: string; to: string }
  | { kind: "rename-field"; from: string; to: string; type?: string }
  | { kind: "remap-status"; from: string; to: string };

/** One metadata change retained in plan and audit output. */
export interface SchemaEvolutionFieldChange {
  /** Metadata key changed by the migration. */
  field: string;
  /** Value before the migration. */
  before?: unknown;
  /** Value after the migration. */
  after?: unknown;
}

/** One affected item in a deterministic schema evolution plan. */
export interface SchemaEvolutionItemPlan {
  /** Stable item identifier. */
  id: string;
  /** Ordered metadata changes for this item. */
  changes: readonly SchemaEvolutionFieldChange[];
}

/** Complete migration evidence plus the pending resume window. */
export interface SchemaEvolutionMigrationPlan {
  /** Stable caller-provided migration identity. */
  migration_id: string;
  /** Normalized requested schema change. */
  request: SchemaEvolutionMigrationRequest;
  /** SHA-256 identity of the complete plan before resume filtering. */
  fingerprint: string;
  /** Total number of affected items in the complete plan. */
  affected_item_count: number;
  /** Number of item mutations still pending. */
  pending_item_count: number;
  /** Completed item mutations excluded from this resume attempt. */
  skipped_completed_count: number;
  /** Pending item mutations in stable item-id order. */
  items: readonly SchemaEvolutionItemPlan[];
  /** Candidate-selection path used to build the plan. */
  selection_source?: "derived_index" | "scan";
}

/** Options for deterministic schema evolution planning. */
export interface PlanSchemaEvolutionMigrationOptions {
  /** Stable idempotency key retained across retries. */
  migrationId: string;
  /** Schema change to plan. */
  request: SchemaEvolutionMigrationRequest;
  /** Item ids durably completed by a previous attempt. */
  completedItemIds?: Iterable<string>;
}

/** Runtime controls for planning or applying one schema migration. */
export interface RunSchemaEvolutionMigrationOptions {
  /** Stable idempotency key retained across retries. */
  migrationId: string;
  /** Attributable actor written to item and workspace history. */
  author?: string;
  /** Return the complete plan without writing schema or item state. */
  dryRun?: boolean;
  /** Override stale locks under the normal governance policy. */
  force?: boolean;
}

/** Result returned by a dry-run or committed schema migration. */
export interface SchemaEvolutionMigrationResult
  extends SchemaEvolutionMigrationPlan {
  /** Schema command action used by renderers and generic SDK consumers. */
  action: SchemaEvolutionMigrationRequest["kind"];
  /** Whether any authoritative state was written. */
  applied: boolean;
  /** Whether a durable interrupted transaction was resumed. */
  recovered: boolean;
  /** Number of item mutations committed by the transaction. */
  migrated_item_count: number;
  /** Workspace audit stream receiving the completion event. */
  workspace_history_path?: string;
}

interface StoredSchemaEvolutionPlan {
  schema_version: 1;
  plan: SchemaEvolutionMigrationPlan;
  created_at: string;
}

interface SchemaFileSnapshot {
  exists: boolean;
  raw: string;
}

interface SchemaReferenceSnapshot {
  filePath: string;
  beforeRaw: string;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Schema migration ${field} must be non-empty`);
  }
  return value.trim();
}

function requiredMigrationId(value: unknown): string {
  const migrationId = requiredText(value, "migrationId");
  if (!/^[a-zA-Z0-9._-]+$/.test(migrationId)) {
    throw new TypeError(
      "Schema migration migrationId must match [a-zA-Z0-9._-]+",
    );
  }
  return migrationId;
}

function normalizedRequest(
  request: SchemaEvolutionMigrationRequest,
): SchemaEvolutionMigrationRequest {
  const normalizeToken = (value: string): string =>
    requiredText(value, "source or target")
      .toLowerCase()
      .replaceAll(/[\s-]+/g, "_");
  const normalized =
    request.kind === "rename-type"
      ? {
          kind: request.kind,
          from: requiredText(request.from, "source"),
          to: requiredText(request.to, "target"),
        }
      : request.kind === "rename-field"
        ? {
            kind: request.kind,
            from: normalizeToken(request.from),
            to: normalizeToken(request.to),
            ...(request.type === undefined
              ? {}
              : { type: requiredText(request.type, "type") }),
          }
        : {
            kind: request.kind,
            from: normalizeToken(request.from),
            to: normalizeToken(request.to),
          };
  if (normalized.from.toLowerCase() === normalized.to.toLowerCase()) {
    throw new TypeError("Schema migration source and target must differ");
  }
  return normalized;
}

function schemaSectionFor(
  request: SchemaEvolutionMigrationRequest,
): "types" | "fields" | "statuses" {
  return request.kind === "rename-type"
    ? "types"
    : request.kind === "rename-field"
      ? "fields"
      : "statuses";
}

function schemaPathFor(
  pmRoot: string,
  settings: PmSettings,
  request: SchemaEvolutionMigrationRequest,
): string {
  const schema = normalizeRuntimeSchemaSettings(settings.schema);
  const section = schemaSectionFor(request);
  return filePathForSchemaSection(
    pmRoot,
    schema.files[section],
    DEFAULT_RUNTIME_SCHEMA_FILE_PATHS[section],
  );
}

function planStoragePath(pmRoot: string, migrationId: string): string {
  return path.join(
    pmRoot,
    "transactions",
    "schema",
    `${migrationId}-plan.json`,
  );
}

function parseSchemaAuditValue(raw: string): unknown {
  return raw.length === 0 ? null : JSON.parse(raw);
}

async function readSchemaFileSnapshot(
  filePath: string,
): Promise<SchemaFileSnapshot> {
  const raw = await readFileIfExists(filePath);
  return { exists: raw !== null, raw: raw ?? "" };
}

async function restoreSchemaFileSnapshot(
  filePath: string,
  snapshot: SchemaFileSnapshot,
): Promise<void> {
  if (snapshot.exists) {
    await writeFileAtomic(filePath, snapshot.raw);
  } else {
    await fs.rm(filePath, { force: true });
  }
}

function mutateTypeDefinition(
  raw: string,
  request: Extract<SchemaEvolutionMigrationRequest, { kind: "rename-type" }>,
  phase: "stage" | "retire",
): string {
  const file = parseItemTypesFile(raw);
  const sourceIndex = file.definitions.findIndex(
    (definition) =>
      definition.name.trim().toLowerCase() === request.from.toLowerCase(),
  );
  const targetIndex = file.definitions.findIndex(
    (definition) =>
      definition.name.trim().toLowerCase() === request.to.toLowerCase(),
  );
  if (phase === "stage") {
    if (targetIndex >= 0) return serializeItemTypesFile(file);
    if (sourceIndex < 0)
      throw new TypeError(`Unknown custom type "${request.from}".`);
    file.definitions.push({
      ...file.definitions[sourceIndex],
      name: request.to,
    });
  } else if (sourceIndex >= 0) {
    file.definitions.splice(sourceIndex, 1);
  }
  return serializeItemTypesFile(file);
}

function mutateFieldDefinition(
  raw: string,
  request: Extract<SchemaEvolutionMigrationRequest, { kind: "rename-field" }>,
  phase: "stage" | "retire",
): string {
  const file = parseFieldsFile(raw);
  const sourceIndex = file.fields.findIndex(
    (definition) => definition.key === request.from,
  );
  const targetIndex = file.fields.findIndex(
    (definition) => definition.key === request.to,
  );
  if (phase === "stage") {
    if (targetIndex >= 0) return serializeFieldsFile(file);
    if (sourceIndex < 0)
      throw new TypeError(`Unknown custom field "${request.from}".`);
    const source = file.fields[sourceIndex];
    file.fields.push({
      ...source,
      key: request.to,
      metadata_key: request.to,
      front_matter_key: request.to,
      cli_flag: request.to.replaceAll("_", "-"),
    });
  } else if (sourceIndex >= 0) {
    file.fields.splice(sourceIndex, 1);
  }
  return serializeFieldsFile(file);
}

function mutateStatusDefinition(
  raw: string,
  request: Extract<SchemaEvolutionMigrationRequest, { kind: "remap-status" }>,
  phase: "stage" | "retire",
): string {
  const file = parseStatusDefsFile(raw);
  const sourceIndex = file.statuses.findIndex(
    (definition) => definition.id === request.from,
  );
  const targetIndex = file.statuses.findIndex(
    (definition) => definition.id === request.to,
  );
  if (phase === "stage") {
    if (targetIndex >= 0) return serializeStatusDefsFile(file);
    if (sourceIndex < 0)
      throw new TypeError(`Unknown custom status "${request.from}".`);
    file.statuses.push({ ...file.statuses[sourceIndex], id: request.to });
  } else if (sourceIndex >= 0) {
    file.statuses.splice(sourceIndex, 1);
  }
  return serializeStatusDefsFile(file);
}

function mutateSchemaDefinition(
  raw: string,
  request: SchemaEvolutionMigrationRequest,
  phase: "stage" | "retire",
): string {
  return request.kind === "rename-type"
    ? mutateTypeDefinition(raw, request, phase)
    : request.kind === "rename-field"
      ? mutateFieldDefinition(raw, request, phase)
      : mutateStatusDefinition(raw, request, phase);
}

function replaceMatchingToken(
  value: unknown,
  request: SchemaEvolutionMigrationRequest,
): unknown {
  return typeof value === "string" &&
    value.trim().toLowerCase() === request.from.toLowerCase()
    ? request.to
    : value;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function objectRecordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
        .map((candidate) => objectRecord(candidate))
        .filter(
          (candidate): candidate is Record<string, unknown> =>
            candidate !== undefined,
        )
    : [];
}

function mutateTypeReferences(
  parsed: Record<string, unknown>,
  request: Extract<SchemaEvolutionMigrationRequest, { kind: "rename-type" }>,
): void {
  for (const field of objectRecordList(parsed.fields)) {
    if (Array.isArray(field.required_types)) {
      field.required_types = field.required_types.map((value) =>
        replaceMatchingToken(value, request),
      );
    }
  }
  for (const workflow of objectRecordList(parsed.type_workflows)) {
    workflow.type = replaceMatchingToken(workflow.type, request);
  }
}

function mutateStatusReferences(
  parsed: Record<string, unknown>,
  request: Extract<SchemaEvolutionMigrationRequest, { kind: "remap-status" }>,
): void {
  for (const definition of objectRecordList(parsed.definitions)) {
    definition.default_status = replaceMatchingToken(
      definition.default_status,
      request,
    );
  }
  const workflow = objectRecord(parsed.workflow);
  if (workflow) {
    for (const [key, value] of Object.entries(workflow)) {
      workflow[key] = replaceMatchingToken(value, request);
    }
  }
  for (const typeWorkflow of objectRecordList(parsed.type_workflows)) {
    if (Array.isArray(typeWorkflow.allowed_transitions)) {
      typeWorkflow.allowed_transitions =
        typeWorkflow.allowed_transitions.map((pair) =>
          Array.isArray(pair)
            ? pair.map((value) => replaceMatchingToken(value, request))
            : pair,
        );
    }
  }
}

function mutateFieldReferences(
  parsed: Record<string, unknown>,
  request: Extract<SchemaEvolutionMigrationRequest, { kind: "rename-field" }>,
): void {
  for (const definition of objectRecordList(parsed.definitions)) {
    for (const key of [
      "required_create_fields",
      "required_create_repeatables",
    ]) {
      if (Array.isArray(definition[key])) {
        definition[key] = definition[key].map((value) =>
          replaceMatchingToken(value, request),
        );
      }
    }
    for (const key of ["options", "command_option_policies"]) {
      for (const option of objectRecordList(definition[key])) {
        const fieldKey = key === "options" ? "key" : "option";
        option[fieldKey] = replaceMatchingToken(option[fieldKey], request);
      }
    }
  }
}

function mutateTemplateReferences(
  parsed: Record<string, unknown>,
  request: SchemaEvolutionMigrationRequest,
): void {
  const options = objectRecord(parsed.options);
  if (!options) return;
  if (request.kind === "rename-field") {
    if (!Object.prototype.hasOwnProperty.call(options, request.from)) return;
    if (Object.prototype.hasOwnProperty.call(options, request.to)) {
      throw new TypeError(
        `Schema migration collision in saved template "${String(parsed.name ?? "unknown")}": target field "${request.to}" already exists.`,
      );
    }
    options[request.to] = options[request.from];
    delete options[request.from];
    return;
  }
  const key = request.kind === "rename-type" ? "type" : "status";
  options[key] = replaceMatchingToken(options[key], request);
}

function mutateSchemaReferences(
  raw: string,
  request: SchemaEvolutionMigrationRequest,
): string {
  const parsed = JSON.parse(raw) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return raw;
  }
  const record = parsed as Record<string, unknown>;
  if (request.kind === "rename-type") {
    mutateTypeReferences(record, request);
  } else if (request.kind === "rename-field") {
    mutateFieldReferences(record, request);
  } else {
    mutateStatusReferences(record, request);
  }
  mutateTemplateReferences(record, request);
  return `${JSON.stringify(record, null, 2)}\n`;
}

function schemaDefinitionState(
  raw: string,
  request: SchemaEvolutionMigrationRequest,
): { source: boolean; target: boolean } {
  if (request.kind === "rename-type") {
    const definitions = parseItemTypesFile(raw).definitions;
    return {
      source: definitions.some(
        (entry) =>
          entry.name.trim().toLowerCase() === request.from.toLowerCase(),
      ),
      target: definitions.some(
        (entry) => entry.name.trim().toLowerCase() === request.to.toLowerCase(),
      ),
    };
  }
  if (request.kind === "rename-field") {
    const definitions = parseFieldsFile(raw).fields;
    return {
      source: definitions.some((entry) => entry.key === request.from),
      target: definitions.some((entry) => entry.key === request.to),
    };
  }
  const definitions = parseStatusDefsFile(raw).statuses;
  return {
    source: definitions.some((entry) => entry.id === request.from),
    target: definitions.some((entry) => entry.id === request.to),
  };
}

function changedFieldsForItem(
  item: ItemMetadata,
  request: SchemaEvolutionMigrationRequest,
): string[] {
  const record = item as Record<string, unknown>;
  if (request.kind === "rename-type") {
    return item.type.toLowerCase() === request.to.toLowerCase() ? [] : ["type"];
  }
  if (request.kind === "remap-status") {
    return item.status.toLowerCase() === request.to.toLowerCase()
      ? []
      : ["status"];
  }
  return Object.prototype.hasOwnProperty.call(record, request.to) &&
    !Object.prototype.hasOwnProperty.call(record, request.from)
    ? []
    : [request.from, request.to];
}

function planItem(
  item: ItemMetadata,
  request: SchemaEvolutionMigrationRequest,
): SchemaEvolutionItemPlan | null {
  if (request.kind === "rename-type") {
    return item.type.toLowerCase() === request.from.toLowerCase()
      ? {
          id: item.id,
          changes: [{ field: "type", before: item.type, after: request.to }],
        }
      : null;
  }
  if (request.kind === "remap-status") {
    return item.status.toLowerCase() === request.from.toLowerCase()
      ? {
          id: item.id,
          changes: [
            { field: "status", before: item.status, after: request.to },
          ],
        }
      : null;
  }
  if (
    request.type !== undefined &&
    item.type.toLowerCase() !== request.type.toLowerCase()
  ) {
    return null;
  }
  const record = item as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, request.from)) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(record, request.to)) {
    throw new TypeError(
      `Schema migration collision on item "${item.id}": target field "${request.to}" already exists.`,
    );
  }
  return {
    id: item.id,
    changes: [
      { field: request.from, before: record[request.from], after: undefined },
      { field: request.to, before: undefined, after: record[request.from] },
    ],
  };
}

/**
 * Build a deterministic schema evolution plan without touching storage. Input
 * order never affects the fingerprint or item order. Completed ids filter only
 * the pending window, leaving complete-plan identity stable across retries.
 */
export function planSchemaEvolutionMigration(
  items: readonly ItemMetadata[],
  options: PlanSchemaEvolutionMigrationOptions,
): SchemaEvolutionMigrationPlan {
  const migrationId = requiredMigrationId(options.migrationId);
  const request = normalizedRequest(options.request);
  const completeItems = items
    .map((item) => planItem(item, request))
    .filter((entry): entry is SchemaEvolutionItemPlan => entry !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ migrationId, request, items: completeItems }))
    .digest("hex");
  const completed = new Set(
    [...(options.completedItemIds ?? [])]
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
  const pendingItems = completeItems.filter((entry) => !completed.has(entry.id));
  return Object.freeze({
    migration_id: migrationId,
    request,
    fingerprint,
    affected_item_count: completeItems.length,
    pending_item_count: pendingItems.length,
    skipped_completed_count: completeItems.length - pendingItems.length,
    items: Object.freeze(pendingItems),
  });
}

async function candidateItems(params: {
  pmRoot: string;
  settings: PmSettings;
  request: SchemaEvolutionMigrationRequest;
}): Promise<{
  items: ItemMetadata[];
  selectionSource: "derived_index" | "scan";
  typeToFolder: Record<string, string>;
}> {
  const typeRegistry = resolveItemTypeRegistry(
    params.settings,
    getActiveExtensionRegistrations(),
  );
  const folders = [...new Set(Object.values(typeRegistry.type_to_folder))];
  const indexState = await readItemMetadataDerivedIndexState(
    params.pmRoot,
    folders,
  );
  const query =
    params.request.kind === "rename-type"
      ? { types: [params.request.from] }
      : params.request.kind === "remap-status"
        ? { statuses: [params.request.from] }
        : {
            metadataKeys: [params.request.from],
            ...(params.request.type === undefined
              ? {}
              : { types: [params.request.type] }),
          };
  const indexed = indexState
    ? await queryItemMetadataIndex({
        pmRoot: params.pmRoot,
        expectedSourceCursor: indexState.source_cursor,
        query,
      })
    : null;
  if (indexed) {
    return {
      items: indexed.items,
      selectionSource: "derived_index",
      typeToFolder: typeRegistry.type_to_folder,
    };
  }
  return {
    items: await listAllItemMetadataLight(
      params.pmRoot,
      params.settings.item_format,
      typeRegistry.type_to_folder,
      [],
      params.settings.schema,
    ),
    selectionSource: "scan",
    typeToFolder: typeRegistry.type_to_folder,
  };
}

async function readStoredPlan(
  pmRoot: string,
  migrationId: string,
): Promise<SchemaEvolutionMigrationPlan | null> {
  const raw = await readFileIfExists(planStoragePath(pmRoot, migrationId));
  if (raw === null) return null;
  try {
    const stored = JSON.parse(raw) as StoredSchemaEvolutionPlan;
    if (
      stored.schema_version !== 1 ||
      stored.plan.migration_id !== migrationId ||
      !Array.isArray(stored.plan.items)
    ) {
      throw new TypeError("invalid plan envelope");
    }
    return stored.plan;
  } catch (error: unknown) {
    throw new PmCliError(
      `Stored schema migration plan "${migrationId}" is invalid: ${toErrorMessage(error)}`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
}

async function writeStoredPlan(
  pmRoot: string,
  plan: SchemaEvolutionMigrationPlan,
): Promise<void> {
  const target = planStoragePath(pmRoot, plan.migration_id);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const stored: StoredSchemaEvolutionPlan = {
    schema_version: 1,
    plan,
    created_at: new Date().toISOString(),
  };
  await writeFileAtomic(target, `${JSON.stringify(stored, null, 2)}\n`);
}

function requestsEqual(
  left: SchemaEvolutionMigrationRequest,
  right: SchemaEvolutionMigrationRequest,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readCurrentItem(params: {
  pmRoot: string;
  settings: PmSettings;
  typeToFolder: Record<string, string>;
  id: string;
}): Promise<ItemMetadata> {
  const located = await locateItem(
    params.pmRoot,
    params.id,
    params.settings.id_prefix,
    params.settings.item_format,
    params.typeToFolder,
  );
  if (!located) {
    throw new PmCliError(
      `Schema migration item "${params.id}" no longer exists.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  return (
    await readLocatedItem(located, { schema: params.settings.schema })
  ).document.metadata;
}

function applyItemRequest(
  document: { metadata: ItemMetadata },
  request: SchemaEvolutionMigrationRequest,
  direction: "forward" | "reverse",
): string[] {
  const source = direction === "forward" ? request.from : request.to;
  const target = direction === "forward" ? request.to : request.from;
  if (request.kind === "rename-type") {
    if (document.metadata.type.toLowerCase() === target.toLowerCase()) return [];
    if (document.metadata.type.toLowerCase() !== source.toLowerCase()) {
      throw new TypeError(
        `Schema migration expected type "${source}" on item "${document.metadata.id}".`,
      );
    }
    document.metadata.type = target;
    return ["type"];
  }
  if (request.kind === "remap-status") {
    if (document.metadata.status.toLowerCase() === target.toLowerCase())
      return [];
    if (document.metadata.status.toLowerCase() !== source.toLowerCase()) {
      throw new TypeError(
        `Schema migration expected status "${source}" on item "${document.metadata.id}".`,
      );
    }
    document.metadata.status = target;
    return ["status"];
  }
  const record = document.metadata as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(record, target) &&
    !Object.prototype.hasOwnProperty.call(record, source)
  ) {
    return [];
  }
  if (
    !Object.prototype.hasOwnProperty.call(record, source) ||
    Object.prototype.hasOwnProperty.call(record, target)
  ) {
    throw new TypeError(
      `Schema migration field state changed concurrently on item "${document.metadata.id}".`,
    );
  }
  record[target] = record[source];
  delete record[source];
  return [source, target];
}

function schemaStep(params: {
  id: "stage-schema" | "retire-source";
  filePath: string;
  request: SchemaEvolutionMigrationRequest;
  phase: "stage" | "retire";
}): WorkspaceTransactionStep {
  return {
    id: params.id,
    inspect: async () => {
      const snapshot = await readSchemaFileSnapshot(params.filePath);
      const state = schemaDefinitionState(snapshot.raw, params.request);
      const applied =
        params.phase === "stage"
          ? state.source && state.target
          : !state.source && state.target;
      return {
        state: applied ? "applied" : "pending",
        ...(applied ? { result: { phase: params.phase } } : {}),
      };
    },
    prepareCompensation: async () => {
      const snapshot = await readSchemaFileSnapshot(params.filePath);
      return { exists: snapshot.exists, raw: snapshot.raw };
    },
    apply: async () => {
      const snapshot = await readSchemaFileSnapshot(params.filePath);
      await writeFileAtomic(
        params.filePath,
        mutateSchemaDefinition(snapshot.raw, params.request, params.phase),
      );
      return { phase: params.phase };
    },
    compensate: async (data) => {
      if (
        typeof data !== "object" ||
        data === null ||
        Array.isArray(data) ||
        typeof data.exists !== "boolean" ||
        typeof data.raw !== "string"
      ) {
        throw new TypeError(
          `Missing schema snapshot for ${params.id} compensation.`,
        );
      }
      await restoreSchemaFileSnapshot(params.filePath, {
        exists: data.exists,
        raw: data.raw,
      });
    },
  };
}

function schemaReferenceStep(params: {
  filePath: string;
  request: SchemaEvolutionMigrationRequest;
  stepId: string;
}): WorkspaceTransactionStep {
  return {
    id: params.stepId,
    inspect: async () => {
      const snapshot = await readSchemaFileSnapshot(params.filePath);
      return {
        state:
          mutateSchemaReferences(snapshot.raw, params.request) === snapshot.raw
            ? "applied"
            : "pending",
      };
    },
    prepareCompensation: async () => {
      const snapshot = await readSchemaFileSnapshot(params.filePath);
      return { exists: snapshot.exists, raw: snapshot.raw };
    },
    apply: async () => {
      const snapshot = await readSchemaFileSnapshot(params.filePath);
      await writeFileAtomic(
        params.filePath,
        mutateSchemaReferences(snapshot.raw, params.request),
      );
      return { file: params.filePath };
    },
    compensate: async (data) => {
      if (
        typeof data !== "object" ||
        data === null ||
        Array.isArray(data) ||
        typeof data.exists !== "boolean" ||
        typeof data.raw !== "string"
      ) {
        throw new TypeError(
          `Missing schema reference snapshot for ${params.stepId} compensation.`,
        );
      }
      await restoreSchemaFileSnapshot(params.filePath, {
        exists: data.exists,
        raw: data.raw,
      });
    },
  };
}

function itemStep(params: {
  pmRoot: string;
  id: string;
  request: SchemaEvolutionMigrationRequest;
  author: string;
  force: boolean;
}): WorkspaceTransactionStep {
  return {
    id: `item-${params.id}`,
    inspect: async () => {
      const settings = await readSettings(params.pmRoot);
      const typeToFolder = resolveItemTypeRegistry(
        settings,
        getActiveExtensionRegistrations(),
      ).type_to_folder;
      const item = await readCurrentItem({
        pmRoot: params.pmRoot,
        settings,
        typeToFolder,
        id: params.id,
      });
      const applied = changedFieldsForItem(item, params.request).length === 0;
      return {
        state: applied ? "applied" : "pending",
        ...(applied ? { result: { item_id: params.id } } : {}),
      };
    },
    apply: async () => {
      const settings = await readSettings(params.pmRoot);
      const typeToFolder = resolveItemTypeRegistry(
        settings,
        getActiveExtensionRegistrations(),
      ).type_to_folder;
      const result = await mutateItem({
        pmRoot: params.pmRoot,
        settings,
        typeToFolder,
        id: params.id,
        op: `schema_${params.request.kind.replaceAll("-", "_")}`,
        author: params.author,
        message: `Schema migration ${params.request.kind}: ${params.request.from} -> ${params.request.to}`,
        force: params.force,
        skipNoop: true,
        mutate(document) {
          return {
            changedFields: applyItemRequest(
              document,
              params.request,
              "forward",
            ),
          };
        },
      });
      return {
        item_id: params.id,
        changed_fields: result.changedFields,
      };
    },
    compensate: async () => {
      const settings = await readSettings(params.pmRoot);
      const typeToFolder = resolveItemTypeRegistry(
        settings,
        getActiveExtensionRegistrations(),
      ).type_to_folder;
      await mutateItem({
        pmRoot: params.pmRoot,
        settings,
        typeToFolder,
        id: params.id,
        op: `schema_${params.request.kind.replaceAll("-", "_")}_compensate`,
        author: params.author,
        message: `Compensate schema migration ${params.request.kind}: ${params.request.to} -> ${params.request.from}`,
        force: true,
        skipNoop: true,
        mutate(document) {
          return {
            changedFields: applyItemRequest(
              document,
              params.request,
              "reverse",
            ),
          };
        },
      });
    },
  };
}

async function resolveMigrationPlan(params: {
  pmRoot: string;
  settings: PmSettings;
  migrationId: string;
  request: SchemaEvolutionMigrationRequest;
}): Promise<{ plan: SchemaEvolutionMigrationPlan; stored: boolean }> {
  const storedPlan = await readStoredPlan(params.pmRoot, params.migrationId);
  if (storedPlan) {
    if (!requestsEqual(storedPlan.request, params.request)) {
      throw new PmCliError(
        `Schema migration id "${params.migrationId}" already belongs to a different request.`,
        EXIT_CODE.CONFLICT,
      );
    }
    return { plan: storedPlan, stored: true };
  }
  const candidates = await candidateItems({
    pmRoot: params.pmRoot,
    settings: params.settings,
    request: params.request,
  });
  return {
    plan: {
      ...planSchemaEvolutionMigration(candidates.items, {
        migrationId: params.migrationId,
        request: params.request,
      }),
      selection_source: candidates.selectionSource,
    },
    stored: false,
  };
}

async function validateAndStoreMigrationPlan(params: {
  pmRoot: string;
  schemaPath: string;
  request: SchemaEvolutionMigrationRequest;
  plan: SchemaEvolutionMigrationPlan;
}): Promise<void> {
  const definitionState = schemaDefinitionState(
    (await readFileIfExists(params.schemaPath)) ?? "",
    params.request,
  );
  if (!definitionState.source) {
    throw new PmCliError(
      `Schema migration source "${params.request.from}" is not a custom definition.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  if (definitionState.target) {
    throw new PmCliError(
      `Schema migration target "${params.request.to}" already exists.`,
      EXIT_CODE.CONFLICT,
    );
  }
  await writeStoredPlan(params.pmRoot, params.plan);
}

async function collectSchemaReferenceState(params: {
  pmRoot: string;
  schemaPath: string;
  settings: PmSettings;
  request: SchemaEvolutionMigrationRequest;
}): Promise<{
  paths: string[];
  snapshots: SchemaReferenceSnapshot[];
}> {
  const normalizedSchema = normalizeRuntimeSchemaSettings(
    params.settings.schema,
  );
  const paths = [
    ...new Set(
      (
        [
          ["types", DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.types],
          ["fields", DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.fields],
          ["workflows", DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.workflows],
        ] as const
      )
        .map(([section, fallback]) =>
          filePathForSchemaSection(
            params.pmRoot,
            normalizedSchema.files[section],
            fallback,
          ),
        )
        .filter((filePath) => filePath !== params.schemaPath),
    ),
  ];
  try {
    const templatesPath = path.join(params.pmRoot, "templates");
    const templateEntries = await fs.readdir(templatesPath, {
      withFileTypes: true,
    });
    paths.push(
      ...templateEntries
        .filter(
          (entry) =>
            entry.isFile() && entry.name.toLowerCase().endsWith(".json"),
        )
        .map((entry) => path.join(templatesPath, entry.name)),
    );
  } catch (error: unknown) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  paths.sort((left, right) => left.localeCompare(right));
  const snapshots: SchemaReferenceSnapshot[] = [];
  for (const filePath of paths) {
    const beforeRaw = await readFileIfExists(filePath);
    if (
      beforeRaw !== null &&
      mutateSchemaReferences(beforeRaw, params.request) !== beforeRaw
    ) {
      snapshots.push({ filePath, beforeRaw });
    }
  }
  return { paths, snapshots };
}

async function appendSchemaReferenceHistory(params: {
  pmRoot: string;
  author: string;
  settings: PmSettings;
  request: SchemaEvolutionMigrationRequest;
  plan: SchemaEvolutionMigrationPlan;
  snapshots: readonly SchemaReferenceSnapshot[];
}): Promise<void> {
  for (const reference of params.snapshots) {
    const afterRaw = await fs.readFile(reference.filePath, "utf8");
    const relativePath = path
      .relative(params.pmRoot, reference.filePath)
      .replaceAll("\\", "/");
    await appendWorkspaceHistoryChange({
      pmRoot: params.pmRoot,
      author: params.author,
      documentPath: relativePath,
      before: parseSchemaAuditValue(reference.beforeRaw),
      after: parseSchemaAuditValue(afterRaw),
      op: "schema_migration_reference",
      idempotencyKey: `${params.plan.migration_id}:${params.plan.fingerprint}:${relativePath}`,
      message: `${params.request.kind}: ${params.request.from} -> ${params.request.to}`,
      lockTtlSeconds: params.settings.locks.ttl_seconds,
      lockWaitMs: params.settings.locks.wait_ms,
    });
  }
}

/**
 * Plan or execute one lossless schema evolution. The complete plan is persisted
 * before writes and reused verbatim after interruptions. Execution stages the
 * target definition, mutates each item through the canonical item store, then
 * retires the source definition in one crash-recoverable transaction.
 */
export async function runSchemaEvolutionMigration(
  requestInput: SchemaEvolutionMigrationRequest,
  options: RunSchemaEvolutionMigrationOptions,
  global: GlobalOptions,
): Promise<SchemaEvolutionMigrationResult> {
  const migrationId = requiredMigrationId(options.migrationId);
  const request = normalizedRequest(requestInput);
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const settings = await readSettings(pmRoot);
  const author = (
    options.author ??
    process.env.PM_AUTHOR ??
    settings.author_default
  ).trim() || "unknown";
  const resolvedPlan = await resolveMigrationPlan({
    pmRoot,
    settings,
    migrationId,
    request,
  });
  const plan = resolvedPlan.plan;
  if (options.dryRun === true) {
    return {
      ...plan,
      action: request.kind,
      applied: false,
      recovered: false,
      migrated_item_count: 0,
    };
  }
  const schemaPath = schemaPathFor(pmRoot, settings, request);
  const schemaBefore = await fs.readFile(schemaPath, "utf8");
  if (!resolvedPlan.stored) {
    await validateAndStoreMigrationPlan({
      pmRoot,
      schemaPath,
      request,
      plan,
    });
  }
  const references = await collectSchemaReferenceState({
    pmRoot,
    schemaPath,
    settings,
    request,
  });
  const steps: WorkspaceTransactionStep[] = [
    schemaStep({
      id: "stage-schema",
      filePath: schemaPath,
      request,
      phase: "stage",
    }),
    ...references.paths.map((filePath, index) =>
      schemaReferenceStep({
        filePath,
        request,
        stepId: `reference-${String(index + 1).padStart(4, "0")}`,
      }),
    ),
    ...plan.items.map((entry) =>
      itemStep({
        pmRoot,
        id: entry.id,
        request,
        author,
        force: options.force === true,
      }),
    ),
    schemaStep({
      id: "retire-source",
      filePath: schemaPath,
      request,
      phase: "retire",
    }),
  ];
  const committed = await commitWorkspaceTransaction({
    pmRoot,
    transactionId: `schema-${migrationId}`,
    author,
    steps,
    lockTtlSeconds: Math.max(settings.locks.ttl_seconds, 300),
    lockWaitMs: settings.locks.wait_ms,
  });
  const schemaAfter = await fs.readFile(schemaPath, "utf8");
  const { historyPath } = await appendWorkspaceHistoryChange({
    pmRoot,
    author,
    documentPath: path.relative(pmRoot, schemaPath).replaceAll("\\", "/"),
    before: parseSchemaAuditValue(schemaBefore),
    after: parseSchemaAuditValue(schemaAfter),
    op: "schema_migration",
    idempotencyKey: `${plan.migration_id}:${plan.fingerprint}`,
    message: `${request.kind}: ${request.from} -> ${request.to}; affected=${plan.affected_item_count}`,
    lockTtlSeconds: settings.locks.ttl_seconds,
    lockWaitMs: settings.locks.wait_ms,
  });
  await appendSchemaReferenceHistory({
    pmRoot,
    author,
    settings,
    request,
    plan,
    snapshots: references.snapshots,
  });
  return {
    ...plan,
    action: request.kind,
    applied: true,
    recovered: committed.recovered,
    migrated_item_count: plan.affected_item_count,
    workspace_history_path: historyPath,
  };
}

/** Render a compact human summary for a schema migration plan or execution. */
export function formatSchemaEvolutionMigrationHuman(
  result: SchemaEvolutionMigrationResult,
): string {
  const mode = result.applied ? "applied" : "dry-run";
  const recovery = result.recovered ? " (recovered)" : "";
  return [
    `${result.action}: ${result.request.from} -> ${result.request.to} [${mode}${recovery}]`,
    `migration_id: ${result.migration_id}`,
    `affected: ${result.affected_item_count}`,
    `pending: ${result.pending_item_count}`,
    `fingerprint: ${result.fingerprint}`,
  ].join("\n");
}

/** Internal pure helpers exposed only for exhaustive behavioral unit tests. */
export const schemaMigrationTestOnly = {
  normalizedRequest,
  parseSchemaAuditValue,
  readSchemaFileSnapshot,
  mutateSchemaDefinition,
  mutateSchemaReferences,
  changedFieldsForItem,
  applyItemRequest,
  schemaStep,
  schemaReferenceStep,
  validateAndStoreMigrationPlan,
};
