/**
 * @module sdk/structured-mutations
 *
 * Parses agent-authored JSON mutation payloads into the public atomic item
 * transaction contract and normalizes full item documents for CLI round trips.
 */
import crypto from "node:crypto";
import { normalizeItemId, normalizePrefix } from "../core/item/id.js";
import {
  EXIT_CODE,
  ITEM_PROJECT_CONTEXT_KEYS,
} from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { levenshteinDistanceWithinLimit } from "../core/shared/levenshtein.js";
import {
  CLOSE_FLAG_CONTRACTS,
  RELEASE_FLAG_CONTRACTS,
} from "./cli-contracts/flag-contracts.js";
import {
  CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS,
  UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS,
} from "./cli-contracts/commander-mutation-options.js";
import type { PmClientFullMutationOptions } from "./runtime.js";
import type { BulkItemMutation } from "./item-transaction.js";

const MUTATION_ROW_KEYS = ["op", "id", "reason", "options"] as const;
const REFERENCED_MUTATION_ROW_KEYS = [
  ...MUTATION_ROW_KEYS,
  "ref",
] as const;
const MUTATION_DOCUMENT_KEYS = ["schema_version", "mutations"] as const;
const MUTATION_REFERENCE_SOURCE = "[a-z][a-z0-9._-]{0,63}";
const MUTATION_REFERENCE_PATTERN = new RegExp(
  `^${MUTATION_REFERENCE_SOURCE}$`,
  "u",
);
const MUTATION_DEPENDENCY_REFERENCE_PATTERN = new RegExp(
  `(^|,)id=@(${MUTATION_REFERENCE_SOURCE})(?=,|$)`,
  "gu",
);
const flagToOptionKey = (flag: string): string =>
  flag
    .slice(2)
    .replaceAll(/-([a-z])/gu, (_match, letter: string) =>
      letter.toUpperCase(),
    );
const ITEM_ENVELOPE_KEYS = [
  "item",
  "linked",
  "schedule",
  "claim_state",
  "children",
  "omission_receipt",
  "row_contract",
  "context_intent",
] as const;
const READ_ONLY_ITEM_KEYS = new Set([
  "created_at",
  "updated_at",
  "closed_at",
  "version",
  "format_version",
  "path",
  "author",
]);
const UPDATE_READ_ONLY_ITEM_KEYS = new Set([
  ...READ_ONLY_ITEM_KEYS,
  "completed_at",
  "id",
]);
const ITEM_FIELD_KEYS = new Set([
  "id",
  "title",
  "description",
  "type",
  "status",
  "priority",
  "tags",
  "body",
  "deadline",
  "estimated_minutes",
  "acceptance_criteria",
  "definition_of_ready",
  "order",
  "rank",
  "assignee",
  ...ITEM_PROJECT_CONTEXT_KEYS,
  "affected_version",
  "fixed_version",
  "component",
  "regression",
  "customer_impact",
  "close_reason",
  "completed_at",
  "dependencies",
  "comments",
  "notes",
  "learnings",
  "files",
  "tests",
  "docs",
  "reminders",
  "events",
  "type_options",
]);
const MUTATION_OPTION_KEYS: Readonly<
  Record<BulkItemMutation["op"], readonly string[]>
> = {
  create: CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS.map(
    (contract) => contract.target,
  ),
  update: UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS.map(
    (contract) => contract.target,
  ),
  close: CLOSE_FLAG_CONTRACTS.map((contract) =>
    flagToOptionKey(contract.flag),
  ).filter((key) => key !== "reason"),
  release: RELEASE_FLAG_CONTRACTS.map((contract) =>
    flagToOptionKey(contract.flag),
  ),
};

/** Controls for resolving one versioned mutation document. */
export interface ResolveItemMutationDocumentOptions {
  /** Stable transaction identity used to derive replay-safe create ids. */
  transactionId: string;
  /** Workspace item-id prefix. */
  idPrefix: string;
}

/** Fully validated mutation document ready for preview or commit. */
export interface ResolvedItemMutationDocument {
  /** Versioned structured-input contract. */
  schema_version: 1;
  /** Atomic mutations with every local reference replaced by a concrete id. */
  mutations: BulkItemMutation[];
  /** Batch-local alias to concrete-id receipt. */
  references: Record<string, string>;
}

/** Validated transaction controls shared by atomic CLI and MCP adapters. */
export interface AtomicMutationControls {
  /** Compensation policy applied to created items when a later step fails. */
  createCompensation?: "close" | "delete";
  /** Workspace transaction lock lifetime in seconds. */
  lockTtlSeconds?: number;
  /** Maximum time to wait for the workspace transaction lock. */
  lockWaitMs?: number;
}

/** Validate and normalize atomic transaction controls at every transport boundary. */
export function parseAtomicMutationControls(
  value: Record<string, unknown>,
): AtomicMutationControls {
  const controls: AtomicMutationControls = {};
  const compensation = value.createCompensation;
  if (compensation !== undefined) {
    if (compensation !== "close" && compensation !== "delete") {
      throw new PmCliError(
        "createCompensation must be close or delete.",
        EXIT_CODE.USAGE,
      );
    }
    controls.createCompensation = compensation;
  }
  for (const key of ["lockTtlSeconds", "lockWaitMs"] as const) {
    const raw = value[key];
    if (raw === undefined) continue;
    const parsed =
      typeof raw === "number" ||
      (typeof raw === "string" && raw.trim().length > 0)
        ? Number(raw)
        : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new PmCliError(
        `${key} must be a positive safe integer.`,
        EXIT_CODE.USAGE,
      );
    }
    controls[key] = parsed;
  }
  return controls;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nearestKey(
  key: string,
  candidates: readonly string[],
): string | undefined {
  const limit = Math.max(1, Math.min(3, Math.floor(key.length / 4) + 1));
  let best: { key: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = levenshteinDistanceWithinLimit(key, candidate, limit);
    if (distance !== null && (best === undefined || distance < best.distance)) {
      best = { key: candidate, distance };
    }
  }
  return best?.key;
}

function unknownKeyError(
  scope: string,
  key: string,
  candidates: readonly string[],
): PmCliError {
  const suggestion = nearestKey(key, candidates);
  return new PmCliError(
    suggestion === undefined
      ? `${scope} does not recognize key "${key}". Allowed keys: ${candidates.join(", ")}.`
      : `${scope} does not recognize key "${key}". Did you mean "${suggestion}"?`,
    EXIT_CODE.USAGE,
    {
      code: "stdin_json_unknown_key",
      required: `Use documented ${scope} keys only.`,
      why: "Strict structured input prevents silent typos from creating incomplete or unintended mutations.",
      nextSteps: [
        suggestion === undefined
          ? `Remove or correct "${key}".`
          : `Replace "${key}" with "${suggestion}".`,
      ],
    },
  );
}

function parseJsonValue(input: string, label: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PmCliError(
      `${label} must be valid JSON: ${detail}`,
      EXIT_CODE.USAGE,
      {
        code: "stdin_json_invalid",
        required: `Pipe one valid JSON ${label.toLowerCase()} into stdin.`,
        why: "Structured mutation input must parse deterministically before any tracker write begins.",
      },
    );
  }
}

function validateMutationObject(
  value: unknown,
  index: number,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new PmCliError(
      `Mutation ${index + 1} must be an object.`,
      EXIT_CODE.USAGE,
    );
  }
  for (const key of Object.keys(value)) {
    if (
      !MUTATION_ROW_KEYS.includes(key as (typeof MUTATION_ROW_KEYS)[number])
    ) {
      throw unknownKeyError(`mutation ${index + 1}`, key, MUTATION_ROW_KEYS);
    }
  }
  return value;
}

function validateMutationOptions(
  options: unknown,
  op: BulkItemMutation["op"],
  index: number,
): Record<string, unknown> | undefined {
  if (options === undefined) return undefined;
  if (!isPlainObject(options)) {
    throw new PmCliError(
      `Mutation ${index + 1} options must be an object.`,
      EXIT_CODE.USAGE,
    );
  }
  for (const key of Object.keys(options)) {
    if (!MUTATION_OPTION_KEYS[op].includes(key)) {
      throw unknownKeyError(
        `mutation ${index + 1} ${op} options`,
        key,
        MUTATION_OPTION_KEYS[op],
      );
    }
  }
  return options;
}

function validateMutationRow(value: unknown, index: number): BulkItemMutation {
  const mutation = validateMutationObject(value, index);
  const { op, id, reason } = mutation;
  if (
    op !== "create" &&
    op !== "update" &&
    op !== "close" &&
    op !== "release"
  ) {
    throw new PmCliError(
      `Mutation ${index + 1} op must be create, update, close, or release.`,
      EXIT_CODE.USAGE,
    );
  }
  const options = validateMutationOptions(mutation.options, op, index);
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new PmCliError(
      `Mutation ${index + 1} requires a non-empty id.`,
      EXIT_CODE.USAGE,
    );
  }
  const normalizedId = id.trim();
  if (op === "close") {
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new PmCliError(
        `Mutation ${index + 1} close requires a non-empty reason.`,
        EXIT_CODE.USAGE,
      );
    }
    return {
      op,
      id: normalizedId,
      reason: reason.trim(),
      ...(options === undefined
        ? {}
        : { options: options as PmClientFullMutationOptions }),
    };
  }
  if (op === "release") {
    return {
      op,
      id: normalizedId,
      ...(options === undefined
        ? {}
        : { options: options as PmClientFullMutationOptions }),
    };
  }
  if (!isPlainObject(options)) {
    throw new PmCliError(
      `Mutation ${index + 1} ${op} requires an options object.`,
      EXIT_CODE.USAGE,
    );
  }
  return {
    op,
    id: normalizedId,
    options: options as PmClientFullMutationOptions,
  };
}

/** Parse a JSON array, or an object containing `mutations`, into an atomic mutation batch. */
export function parseItemMutationBatch(input: string): BulkItemMutation[] {
  const parsed = parseJsonValue(input, "Mutation batch");
  const rows = Array.isArray(parsed)
    ? parsed
    : isPlainObject(parsed) && Array.isArray(parsed.mutations)
      ? parsed.mutations
      : undefined;
  if (rows === undefined || rows.length === 0) {
    throw new PmCliError(
      "Mutation batch must be a non-empty JSON array or an object with a non-empty mutations array.",
      EXIT_CODE.USAGE,
    );
  }
  return rows.map((row, index) => validateMutationRow(row, index));
}

function deriveReferencedItemId(
  transactionId: string,
  reference: string,
  idPrefix: string,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(transactionId)
    .update("\0")
    .update(reference)
    .digest("hex");
  const token = BigInt(`0x${digest.slice(0, 16)}`)
    .toString(36)
    .padStart(13, "0")
    .slice(-12);
  return `${normalizePrefix(idPrefix)}${token}`;
}

function replaceExactMutationReference(
  value: unknown,
  references: Readonly<Record<string, string>>,
): unknown {
  if (typeof value !== "string" || !value.startsWith("@")) {
    return value;
  }
  const reference = value.slice(1);
  const resolved = references[reference];
  if (resolved === undefined) {
    throw new PmCliError(
      `Unknown mutation reference "${value}".`,
      EXIT_CODE.USAGE,
    );
  }
  return resolved;
}

function replaceDependencyReference(
  value: unknown,
  references: Readonly<Record<string, string>>,
): unknown {
  if (typeof value !== "string") return value;
  const resolvedValue = value.replace(
    MUTATION_DEPENDENCY_REFERENCE_PATTERN,
    (_match, prefix: string, reference: string) => {
      const resolved = references[reference];
      if (resolved === undefined) {
        throw new PmCliError(
          `Unknown mutation reference "@${reference}".`,
          EXIT_CODE.USAGE,
        );
      }
      return `${prefix}id=${resolved}`;
    },
  );
  if (/(^|,)id=@/u.test(resolvedValue)) {
    throw new PmCliError(
      `Malformed mutation reference in dependency "${value}".`,
      EXIT_CODE.USAGE,
    );
  }
  return resolvedValue;
}

function referencedAliases(value: unknown): string[] {
  if (typeof value !== "string") return [];
  if (value.startsWith("@")) return [value.slice(1)];
  return [...value.matchAll(MUTATION_DEPENDENCY_REFERENCE_PATTERN)]
    .map((match) => match[1])
    .filter((reference): reference is string => reference !== undefined);
}

function assertAcyclicCreateReferences(
  rows: ReadonlyArray<Record<string, unknown>>,
): void {
  const graph = new Map<string, string[]>();
  for (const row of rows) {
    if (row.op !== "create" || typeof row.ref !== "string") continue;
    const mutationOptions = isPlainObject(row.options) ? row.options : {};
    const dependencies = Array.isArray(mutationOptions.dep)
      ? mutationOptions.dep
      : mutationOptions.dep === undefined
        ? []
        : [mutationOptions.dep];
    graph.set(
      row.ref,
      [mutationOptions.parent, mutationOptions.blockedBy, ...dependencies]
        .flatMap(referencedAliases),
    );
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (reference: string): void => {
    if (visiting.has(reference)) {
      throw new PmCliError(
        `Mutation reference cycle includes "@${reference}".`,
        EXIT_CODE.USAGE,
      );
    }
    if (visited.has(reference)) return;
    visiting.add(reference);
    for (const dependency of graph.get(reference)!) {
      if (graph.has(dependency)) visit(dependency);
    }
    visiting.delete(reference);
    visited.add(reference);
  };
  for (const reference of graph.keys()) visit(reference);
}

function parseMutationDocumentRows(
  input: string,
): Array<Record<string, unknown>> {
  const parsed = parseJsonValue(input, "Mutation document");
  const envelope = Array.isArray(parsed)
    ? { schema_version: 1, mutations: parsed }
    : parsed;
  if (!isPlainObject(envelope)) {
    throw new PmCliError(
      "Mutation document must be a JSON array or object.",
      EXIT_CODE.USAGE,
    );
  }
  for (const key of Object.keys(envelope)) {
    if (
      !MUTATION_DOCUMENT_KEYS.includes(
        key as (typeof MUTATION_DOCUMENT_KEYS)[number],
      )
    ) {
      throw unknownKeyError("mutation document", key, MUTATION_DOCUMENT_KEYS);
    }
  }
  if (
    envelope.schema_version !== undefined &&
    envelope.schema_version !== 1
  ) {
    throw new PmCliError(
      "Mutation document schema_version must be 1.",
      EXIT_CODE.USAGE,
    );
  }
  if (!Array.isArray(envelope.mutations) || envelope.mutations.length === 0) {
    throw new PmCliError(
      "Mutation document requires a non-empty mutations array.",
      EXIT_CODE.USAGE,
    );
  }
  return envelope.mutations.map((row, index) => {
    if (!isPlainObject(row)) {
      throw new PmCliError(
        `Mutation ${index + 1} must be an object.`,
        EXIT_CODE.USAGE,
      );
    }
    for (const key of Object.keys(row)) {
      if (
        !REFERENCED_MUTATION_ROW_KEYS.includes(
          key as (typeof REFERENCED_MUTATION_ROW_KEYS)[number],
        )
      ) {
        throw unknownKeyError(
          `mutation ${index + 1}`,
          key,
          REFERENCED_MUTATION_ROW_KEYS,
        );
      }
    }
    return { ...row };
  });
}

function collectMutationReferences(
  rows: ReadonlyArray<Record<string, unknown>>,
  options: ResolveItemMutationDocumentOptions,
): Record<string, string> {
  const references = Object.create(null) as Record<string, string>;
  for (const [index, row] of rows.entries()) {
    if (row.ref === undefined) continue;
    if (row.op !== "create") {
      throw new PmCliError(
        `Mutation ${index + 1} ref is only valid for create operations.`,
        EXIT_CODE.USAGE,
      );
    }
    if (
      typeof row.ref !== "string" ||
      !MUTATION_REFERENCE_PATTERN.test(row.ref)
    ) {
      throw new PmCliError(
        `Mutation ${index + 1} ref must match ${MUTATION_REFERENCE_PATTERN.source}.`,
        EXIT_CODE.USAGE,
      );
    }
    if (references[row.ref] !== undefined) {
      throw new PmCliError(
        `Duplicate mutation ref "${row.ref}".`,
        EXIT_CODE.USAGE,
      );
    }
    references[row.ref] =
      typeof row.id === "string" && row.id.trim().length > 0
        ? normalizeItemId(row.id, options.idPrefix)
        : deriveReferencedItemId(
            options.transactionId,
            row.ref,
            options.idPrefix,
          );
  }
  return references;
}

/**
 * Resolve a versioned heterogeneous mutation document. Create rows may declare
 * a unique `ref`; omitted ids are derived deterministically from the stable
 * transaction id, and `@ref` forward references are supported in target ids,
 * parent/blocked-by options, and dependency entries.
 */
export function resolveItemMutationDocument(
  input: string,
  options: ResolveItemMutationDocumentOptions,
): ResolvedItemMutationDocument {
  const rows = parseMutationDocumentRows(input);
  const references = collectMutationReferences(rows, options);
  assertAcyclicCreateReferences(rows);

  const resolvedRows = rows.map((row) => {
    const resolved = { ...row };
    const reference = typeof resolved.ref === "string" ? resolved.ref : undefined;
    delete resolved.ref;
    if (reference !== undefined) {
      resolved.id = references[reference];
    } else {
      resolved.id = replaceExactMutationReference(resolved.id, references);
    }
    if (isPlainObject(resolved.options)) {
      const mutationOptions = { ...resolved.options };
      for (const key of ["parent", "blockedBy"] as const) {
        if (mutationOptions[key] !== undefined) {
          mutationOptions[key] = replaceExactMutationReference(
            mutationOptions[key],
            references,
          );
        }
      }
      if (Array.isArray(mutationOptions.dep)) {
        mutationOptions.dep = mutationOptions.dep.map((entry) =>
          replaceDependencyReference(entry, references),
        );
      } else if (mutationOptions.dep !== undefined) {
        mutationOptions.dep = replaceDependencyReference(
          mutationOptions.dep,
          references,
        );
      }
      resolved.options = mutationOptions;
    }
    return resolved;
  });
  const mutations = parseItemMutationBatch(JSON.stringify(resolvedRows));
  const createIds = mutations
    .filter((mutation) => mutation.op === "create")
    .map((mutation) => mutation.id);
  if (new Set(createIds).size !== createIds.length) {
    throw new PmCliError(
      "Duplicate resolved create id in mutation document.",
      EXIT_CODE.USAGE,
    );
  }
  return { schema_version: 1, mutations, references };
}

function serializePairs(
  value: Record<string, unknown>,
  keys: readonly string[],
): string {
  return keys
    .filter((key) => value[key] !== undefined && value[key] !== null)
    .map((key) => {
      const rendered = String(value[key]);
      return `${key}=${/[",\n\r\\]/u.test(rendered) ? JSON.stringify(rendered) : rendered}`;
    })
    .join(",");
}

function serializeObjectArray(
  value: unknown,
  keys: readonly string[],
  label: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isPlainObject)) {
    throw new PmCliError(
      `${label} must be an array of objects.`,
      EXIT_CODE.USAGE,
    );
  }
  return value.map((entry) => serializePairs(entry, keys));
}

function scalarItemOption(key: string, value: unknown): unknown {
  if (
    key === "tags" &&
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return value;
}

function appendFacetOptions(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  skipPersistedAnnotations = false,
): void {
  const mappings: ReadonlyArray<readonly [string, string, readonly string[]]> =
    [
      [
        "dependencies",
        "dep",
        ["id", "kind", "created_at", "author", "source_kind"],
      ],
      ["comments", "comment", ["text", "created_at", "author"]],
      ["notes", "note", ["text", "created_at", "author"]],
      ["learnings", "learning", ["text", "created_at", "author"]],
      ["files", "file", ["path", "scope", "note"]],
      ["tests", "test", ["command", "scope", "timeout_seconds"]],
      ["docs", "doc", ["path", "scope", "note"]],
      ["reminders", "reminder", ["at", "text", "created_at"]],
      ["events", "event", ["start_at", "end_at", "title", "location"]],
      ["type_options", "typeOption", ["key", "value"]],
    ];
  for (const [sourceKey, targetKey, keys] of mappings) {
    const sourceValue = source[sourceKey];
    const serialized = serializeObjectArray(
      skipPersistedAnnotations &&
        ["comments", "notes", "learnings"].includes(sourceKey) &&
        Array.isArray(sourceValue)
        ? sourceValue.filter(
            (entry) => !isPlainObject(entry) || entry.created_at === undefined,
          )
        : sourceValue,
      keys,
      sourceKey,
    );
    if (serialized !== undefined && serialized.length > 0)
      target[targetKey] = serialized;
  }
}

function validateItemDocumentKeys(
  parsed: Record<string, unknown>,
  envelope: boolean,
): void {
  for (const key of Object.keys(parsed)) {
    if (envelope) {
      if (
        !ITEM_ENVELOPE_KEYS.includes(key as (typeof ITEM_ENVELOPE_KEYS)[number])
      )
        throw unknownKeyError("item envelope", key, ITEM_ENVELOPE_KEYS);
      continue;
    }
    if (
      !ITEM_FIELD_KEYS.has(key) &&
      nearestKey(key, [...ITEM_FIELD_KEYS]) === undefined &&
      nearestKey(key, ITEM_ENVELOPE_KEYS) === "item"
    )
      throw unknownKeyError("item envelope", key, ITEM_ENVELOPE_KEYS);
  }
}

function resolveItemDocument(parsed: Record<string, unknown>): {
  item: Record<string, unknown>;
  linked?: Record<string, unknown>;
} {
  const envelope = Object.hasOwn(parsed, "item");
  validateItemDocumentKeys(parsed, envelope);
  const item = envelope ? parsed.item : parsed;
  if (!isPlainObject(item)) {
    throw new PmCliError(
      "Item document item must be an object.",
      EXIT_CODE.USAGE,
    );
  }
  return {
    item,
    ...(envelope && isPlainObject(parsed.linked)
      ? { linked: parsed.linked }
      : {}),
  };
}

function appendItemDocumentEntry(
  documentOptions: Record<string, unknown>,
  key: string,
  value: unknown,
  mode: "create" | "update",
): void {
  const readOnlyKeys =
    mode === "update" ? UPDATE_READ_ONLY_ITEM_KEYS : READ_ONLY_ITEM_KEYS;
  if (readOnlyKeys.has(key)) return;
  if (!ITEM_FIELD_KEYS.has(key)) {
    const suggestion = nearestKey(key, [...ITEM_FIELD_KEYS]);
    if (suggestion !== undefined)
      throw unknownKeyError("item document", key, [...ITEM_FIELD_KEYS]);
    const fields = Array.isArray(documentOptions.field)
      ? (documentOptions.field as string[])
      : [];
    fields.push(
      serializePairs(
        {
          key,
          value: typeof value === "string" ? value : JSON.stringify(value),
        },
        ["key", "value"],
      ),
    );
    documentOptions.field = fields;
    return;
  }
  if (
    [
      "dependencies",
      "comments",
      "notes",
      "learnings",
      "files",
      "tests",
      "docs",
      "reminders",
      "events",
      "type_options",
    ].includes(key)
  )
    return;
  documentOptions[
    key.replaceAll(/_([a-z])/gu, (_match, letter: string) =>
      letter.toUpperCase(),
    )
  ] = scalarItemOption(key, value);
}

/**
 * Convert a direct item JSON document or `pm get --json` envelope into the
 * create/update option shape. Explicit CLI flags override document values.
 */
export function itemDocumentToMutationOptions(
  input: string,
  mode: "create" | "update",
  explicitOptions: Record<string, unknown> = {},
): Record<string, unknown> {
  const parsed = parseJsonValue(input, "Item document");
  if (!isPlainObject(parsed)) {
    throw new PmCliError(
      "Item document must be a JSON object.",
      EXIT_CODE.USAGE,
    );
  }
  const { item, linked } = resolveItemDocument(parsed);
  const documentOptions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    appendItemDocumentEntry(documentOptions, key, value, mode);
  }
  appendFacetOptions(documentOptions, item, mode === "update");
  if (linked !== undefined) appendFacetOptions(documentOptions, linked);
  return {
    ...documentOptions,
    ...Object.fromEntries(
      Object.entries(explicitOptions).filter(
        ([, value]) => value !== undefined,
      ),
    ),
    stdinJson: undefined,
  };
}

/** Validate an already-decoded MCP mutation array through the same strict parser as CLI stdin. */
export function validateItemMutationRows(value: unknown): BulkItemMutation[] {
  return parseItemMutationBatch(JSON.stringify(value));
}
