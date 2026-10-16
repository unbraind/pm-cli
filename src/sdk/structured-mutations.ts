/**
 * @module sdk/structured-mutations
 *
 * Parses agent-authored JSON mutation payloads into the public atomic item
 * transaction contract and normalizes full item documents for CLI round trips.
 */
import crypto from "node:crypto";
import { ITEM_MUTATION_FACET_OPTION_MAPPINGS } from "./lifecycle/mutation-facet-contracts.js";
import { normalizeItemId, normalizePrefix } from "../core/item/id.js";
import { preserveMutationStdinTokenLiterals } from "../core/item/parse.js";
import {
  EXIT_CODE,
  ITEM_PROJECT_CONTEXT_KEYS,
} from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { levenshteinDistanceWithinLimit } from "../core/shared/levenshtein.js";
import { describeUnknownError } from "./error-runtime.js";
import {
  CLOSE_FLAG_CONTRACTS,
  RELEASE_FLAG_CONTRACTS,
} from "./cli-contracts/flag-contracts.js";
import {
  CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS,
  UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS,
} from "./cli-contracts/commander-mutation-options.js";
import type { PmClientFullMutationOptions } from "./runtime.js";
import type { BulkItemMutation, BulkItemUniqueKey } from "./item-transaction.js";
import { runtimeFieldOptionTarget, type RuntimeFieldDefinitionResolved } from "../core/schema/runtime-schema.js";
import { readRuntimeFieldOptionValue } from "../core/schema/runtime-field-values.js";

const MUTATION_ROW_KEYS = ["op", "id", "reason", "options", "unique", "match"] as const;
const REFERENCED_MUTATION_ROW_KEYS = [
  ...MUTATION_ROW_KEYS,
  "ref",
] as const;
/** Row keys accepted before document rows are normalized into create options. */
const DOCUMENT_MUTATION_ROW_KEYS = [
  ...REFERENCED_MUTATION_ROW_KEYS,
  "item",
] as const;
const DERIVED_TRANSACTION_ID_PREFIX = "mutate-";
const SYNTHESIZED_REFERENCE_PREFIX = "row-";
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
  "collection_counts",
  "notes_count",
  "tests_count",
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

/** One existing workspace item considered by keyed upsert resolution. */
export interface ItemMutationUpsertCandidate {
  /** Canonical id of the existing item. */
  id: string;
  /** Current value of the upsert key field on that item. */
  value: unknown;
}

/** Keyed-upsert policy applied to create rows of one mutation document. */
export interface ItemMutationUpsertOptions {
  /** Item field (core or declared custom metadata key) whose value identifies an existing item. */
  key: string;
  /**
   * Existing items that carry a value for the key, read before the writer
   * lock. Items this very document would create (its deterministic create
   * ids) are never candidates, so a replay of a committed import keeps its
   * original create plan instead of mutating into updates.
   */
  existing: readonly ItemMutationUpsertCandidate[];
}

/** Controls for resolving one versioned mutation document. */
export interface ResolveItemMutationDocumentOptions {
  /** Stable transaction identity used to derive replay-safe create ids. */
  transactionId: string;
  /** Workspace item-id prefix. */
  idPrefix: string;
  /** Resolved schema fields that route document keys through declared option names. */
  runtimeFields?: readonly RuntimeFieldDefinitionResolved[];
  /** Optional keyed upsert: create rows matching one existing item become updates. */
  upsert?: ItemMutationUpsertOptions;
}

/** Input-ordered receipt row mapping one source record to its resolved mutation. */
export interface ResolvedItemMutationRow {
  /** Zero-based position of the source record in the document. */
  index: number;
  /** Batch-local alias when the row declared or received one. */
  ref?: string;
  /** Concrete item id the mutation targets. */
  id: string;
  /** Operation applied for this row after upsert resolution. */
  op: BulkItemMutation["op"];
  /** Whether keyed upsert turned a create row into an update of an existing item. */
  upserted?: true;
}

/** Fully validated mutation document ready for preview or commit. */
export interface ResolvedItemMutationDocument {
  /** Versioned structured-input contract. */
  schema_version: 1;
  /** Atomic mutations with every local reference replaced by a concrete id. */
  mutations: BulkItemMutation[];
  /** Batch-local alias to concrete-id receipt. */
  references: Record<string, string>;
  /** Input-ordered receipt mapping each source record to its resolved id and operation. */
  rows: ResolvedItemMutationRow[];
}

/**
 * Derive a stable transaction id from the exact document bytes so that
 * re-running an identical import resumes or replays the same journal instead
 * of duplicating items. Any change to the document yields a new id.
 */
export function deriveMutationTransactionId(input: string): string {
  const digest = crypto.createHash("sha256").update(input).digest("hex");
  return `${DERIVED_TRANSACTION_ID_PREFIX}${digest.slice(0, 24)}`;
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

/**
 * Refuse undeclared core and extension option targets before SDK dispatch.
 * Keep an absent options bag absent so operation-specific defaults still apply.
 */
function validateMutationOptions(
  options: unknown,
  op: BulkItemMutation["op"],
  index: number,
  runtimeFields: readonly RuntimeFieldDefinitionResolved[],
): Record<string, unknown> | undefined {
  if (options === undefined) return undefined;
  if (!isPlainObject(options)) {
    throw new PmCliError(
      `Mutation ${index + 1} options must be an object.`,
      EXIT_CODE.USAGE,
    );
  }
  const allowed = [
    ...MUTATION_OPTION_KEYS[op],
    ...runtimeFieldOptionKeys(op, runtimeFields),
  ];
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      throw unknownKeyError(
        `mutation ${index + 1} ${op} options`,
        key,
        allowed,
      );
    }
  }
  return options;
}

/** Workspace schema context that widens the option keys a batch row may carry. */
export interface ParseItemMutationBatchOptions {
  /** Declared schema fields whose option targets create/update rows may set. */
  runtimeFields?: readonly RuntimeFieldDefinitionResolved[];
}

/** Validate an optional key guard (`unique` on create rows, `match` on update rows): it needs a non-empty key and a present value. */
function validateMutationKeyGuard(
  value: unknown,
  op: BulkItemMutation["op"],
  index: number,
  field: "unique" | "match",
): BulkItemUniqueKey | undefined {
  if (value === undefined) return undefined;
  const allowedOp = field === "unique" ? "create" : "update";
  if (op !== allowedOp) {
    throw new PmCliError(
      `Mutation ${index + 1} ${field} is only valid for ${allowedOp} operations.`,
      EXIT_CODE.USAGE,
    );
  }
  const key = isPlainObject(value) && typeof value.key === "string" ? value.key.trim() : "";
  if (!isPlainObject(value) || key.length === 0 || value.value === undefined || value.value === null) {
    throw new PmCliError(
      `Mutation ${index + 1} ${field} must be an object with a non-empty key and a value.`,
      EXIT_CODE.USAGE,
    );
  }
  return { key, value: value.value };
}

function validateMutationRow(
  value: unknown,
  index: number,
  runtimeFields: readonly RuntimeFieldDefinitionResolved[],
): BulkItemMutation {
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
  const options = validateMutationOptions(mutation.options, op, index, runtimeFields);
  const unique = validateMutationKeyGuard(mutation.unique, op, index, "unique");
  const match = validateMutationKeyGuard(mutation.match, op, index, "match");
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
    ...(unique === undefined ? {} : { unique }),
    ...(match === undefined ? {} : { match }),
  };
}

/** Parse a JSON array, or an object containing `mutations`, into an atomic mutation batch. */
export function parseItemMutationBatch(
  input: string,
  parseOptions: ParseItemMutationBatchOptions = {},
): BulkItemMutation[] {
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
  const runtimeFields = parseOptions.runtimeFields ?? [];
  return rows.map((row, index) => {
    const mutation = validateMutationRow(row, index, runtimeFields);
    if (mutation.options !== undefined) {
      preserveMutationStdinTokenLiterals(mutation.options);
    }
    return mutation;
  });
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

/** Retain original create aliases in the graph even after keyed upsert converts their rows to updates. */
function assertAcyclicCreateReferences(
  rows: ReadonlyArray<Record<string, unknown>>,
  inputReferences: ReadonlyArray<string | undefined>,
): void {
  const graph = new Map<string, string[]>();
  for (const [index, row] of rows.entries()) {
    const reference = inputReferences[index];
    if (reference === undefined) continue;
    const mutationOptions = isPlainObject(row.options) ? row.options : {};
    const dependencies = Array.isArray(mutationOptions.dep)
      ? mutationOptions.dep
      : mutationOptions.dep === undefined
        ? []
        : [mutationOptions.dep];
    graph.set(
      reference,
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

/**
 * Parse JSON Lines: one JSON object per non-empty line. Returns null when the
 * input is not line-delimited so the caller can report the whole-document
 * JSON error instead of a misleading per-line one.
 */
function parseJsonLinesRows(input: string): unknown[] | null {
  const lines = input.split(/\r?\n/u);
  const candidates = lines
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter((entry) => entry.line.length > 0);
  if (candidates.length < 2) return null;
  const parsed = candidates.map((entry) => {
    try {
      return { ...entry, ok: true as const, value: JSON.parse(entry.line) as unknown };
    } catch (error: unknown) {
      return { ...entry, ok: false as const, error };
    }
  });
  const first = parsed[0]!;
  // A standalone opener or closing wrapper identifies formatted JSON; an
  // independently complete object row otherwise establishes JSON Lines.
  if (!first.ok && (first.line.startsWith("[") || first.line === "{" || parsed.at(-1)!.line === "}")) return null;
  if (!parsed.some((entry) => entry.ok && isPlainObject(entry.value))) return null;
  const rows: unknown[] = [];
  for (const entry of parsed) {
    if (!entry.ok) {
      throw new PmCliError(
        `Mutation document line ${entry.number} must be one valid JSON object: ${describeUnknownError(entry.error)}`,
        EXIT_CODE.USAGE,
        {
          code: "stdin_json_invalid",
          required: "Provide one JSON object per line (JSON Lines), a JSON array, or a {schema_version, mutations} document.",
          why: "Structured mutation input must parse deterministically before any tracker write begins.",
        },
      );
    }
    if (!isPlainObject(entry.value)) {
      throw new PmCliError(
        `Mutation document line ${entry.number} must be a JSON object.`,
        EXIT_CODE.USAGE,
      );
    }
    rows.push(entry.value);
  }
  return rows;
}

/** Whether a parsed object is a versioned envelope rather than a single record. */
function isMutationEnvelope(value: Record<string, unknown>): boolean {
  return Object.hasOwn(value, "mutations") || Object.hasOwn(value, "schema_version");
}

/** Parse the raw document into its envelope, accepting arrays, envelopes, single records, and JSON Lines. */
function parseMutationDocumentEnvelope(input: string): unknown {
  let parsed: unknown;
  try {
    parsed = parseJsonValue(input, "Mutation document");
  } catch (error: unknown) {
    const rows = parseJsonLinesRows(input);
    if (rows === null) throw error;
    return { schema_version: 1, mutations: rows };
  }
  if (Array.isArray(parsed)) return { schema_version: 1, mutations: parsed };
  if (isPlainObject(parsed) && !isMutationEnvelope(parsed)) {
    return { schema_version: 1, mutations: [parsed] };
  }
  return parsed;
}

/**
 * Normalize one source record into the `op`-keyed row grammar. A record
 * without `op` is a create document whose remaining keys are item fields; a
 * create row may also carry the document under `item` instead of `options`.
 */
function normalizeDocumentRow(
  row: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  const normalized = Object.hasOwn(row, "op")
    ? validateOperationRow(row, index)
    : normalizeCreateDocumentRow(row, index);
  if (normalized.op === "create" && normalized.id === undefined && isPlainObject(normalized.item) && normalized.item.id !== undefined) {
    if (typeof normalized.item.id !== "string") {
      throw new PmCliError(`Mutation ${index + 1} item id must be a string.`, EXIT_CODE.USAGE);
    }
    normalized.id = normalized.item.id;
  }
  return normalized;
}

/** Validate an explicit `op` row, allowing `item` only on create rows and never beside `options`. */
function validateOperationRow(
  row: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  for (const key of Object.keys(row)) {
    if (
      !DOCUMENT_MUTATION_ROW_KEYS.includes(
        key as (typeof DOCUMENT_MUTATION_ROW_KEYS)[number],
      )
    ) {
      throw unknownKeyError(
        `mutation ${index + 1}`,
        key,
        DOCUMENT_MUTATION_ROW_KEYS,
      );
    }
  }
  if (row.item !== undefined && row.op !== "create") {
    throw new PmCliError(
      `Mutation ${index + 1} item documents are only valid for create operations.`,
      EXIT_CODE.USAGE,
    );
  }
  if (row.item !== undefined && row.options !== undefined) {
    throw new PmCliError(
      `Mutation ${index + 1} must declare either item or options, not both.`,
      EXIT_CODE.USAGE,
    );
  }
  return { ...row };
}

/** Lift an op-less record into a create row carrying its document under `item`. */
function normalizeCreateDocumentRow(
  row: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  const { ref, id, item, ...fields } = row;
  const document = item !== undefined ? item : fields;
  if (item !== undefined && Object.keys(fields).length > 0) {
    throw new PmCliError(
      `Mutation ${index + 1} must not mix item document keys with top-level fields.`,
      EXIT_CODE.USAGE,
    );
  }
  if (!isPlainObject(document)) {
    throw new PmCliError(
      `Mutation ${index + 1} item document must be an object.`,
      EXIT_CODE.USAGE,
    );
  }
  return {
    op: "create",
    ...(ref === undefined ? {} : { ref }),
    ...(id === undefined ? {} : { id }),
    item: document,
  };
}

/**
 * Normalize accepted input through the shared envelope before resolving IDs.
 * Reject unsupported versions and malformed rows before transaction planning.
 */
function parseMutationDocumentRows(
  input: string,
): Array<Record<string, unknown>> {
  const envelope = parseMutationDocumentEnvelope(input);
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
    return normalizeDocumentRow(row, index);
  });
}

/**
 * Drop candidates whose id this document itself would create (explicit create
 * ids and ids derived from the stable transaction id), so a replay of an
 * already committed import resolves to the same create plan and the journal
 * recovers it instead of refusing a mutated plan.
 */
function excludeOwnCreateIds(
  upsert: ItemMutationUpsertOptions,
  rows: ReadonlyArray<Record<string, unknown>>,
  options: ResolveItemMutationDocumentOptions,
): ItemMutationUpsertOptions {
  const ownIds = new Set(Object.values(collectMutationReferences(rows, options, Object.create(null) as Record<string, string>)));
  for (const row of rows) {
    if (row.op === "create" && typeof row.id === "string" && row.id.trim().length > 0) {
      ownIds.add(normalizeItemId(row.id, options.idPrefix));
    }
  }
  return {
    ...upsert,
    existing: upsert.existing.filter((candidate) => !ownIds.has(candidate.id)),
  };
}

/** Give every create row an alias so omitted ids derive deterministically and the receipt can name each record. */
function synthesizeMissingReferences(
  rows: Array<Record<string, unknown>>,
): void {
  const declared = new Set(rows.map((row) => row.ref).filter((ref): ref is string => typeof ref === "string"));
  for (const [index, row] of rows.entries()) {
    if (row.op !== "create" || row.ref !== undefined) continue;
    if (typeof row.id === "string" && row.id.trim().length > 0) continue;
    const synthesized = `${SYNTHESIZED_REFERENCE_PREFIX}${index + 1}`;
    if (declared.has(synthesized)) {
      // Without this check the collision surfaces later as a duplicate ref the document never declared twice.
      throw new PmCliError(
        `Mutation ${index + 1} receives the synthesized ref "${synthesized}", but another row declares that ref. Rename it or give mutation ${index + 1} its own ref; ${SYNTHESIZED_REFERENCE_PREFIX}<n> aliases are reserved for rows without one.`,
        EXIT_CODE.USAGE,
      );
    }
    row.ref = synthesized;
  }
}

/** Convert one create document into batch-ready create or update options. Declared schema fields keep their option targets (`externalId`), which the batch validator admits for the matching operation. */
function itemDocumentToBatchOptions(
  item: Record<string, unknown>,
  mode: "create" | "update",
  runtimeFields: readonly RuntimeFieldDefinitionResolved[],
): Record<string, unknown> {
  const converted = itemDocumentToMutationOptions(JSON.stringify(item), mode, {}, runtimeFields);
  delete converted.stdinJson;
  delete converted.documentAnnotationSnapshot;
  return converted;
}

/** Option keys the declared schema adds to one operation's batch options. */
function runtimeFieldOptionKeys(
  op: BulkItemMutation["op"],
  runtimeFields: readonly RuntimeFieldDefinitionResolved[],
): string[] {
  if (op !== "create" && op !== "update") return [];
  return runtimeFields
    .filter((definition) => definition.commands.includes(op))
    .map((definition) => runtimeFieldOptionTarget(definition));
}

/** Replace `item` documents on create rows with the equivalent create options. */
function convertItemDocumentRows(
  rows: Array<Record<string, unknown>>,
  runtimeFields: readonly RuntimeFieldDefinitionResolved[],
): void {
  for (const row of rows) {
    if (!isPlainObject(row.item)) continue;
    row.options = itemDocumentToBatchOptions(row.item, "create", runtimeFields);
    delete row.item;
  }
}

/** Read the upsert key value from a create row's document or options. A declared field whose metadata key differs from its option name is read through its option target. */
function readUpsertKeyValue(
  row: Record<string, unknown>,
  key: string,
  runtimeFields: readonly RuntimeFieldDefinitionResolved[],
): unknown {
  if (isPlainObject(row.item) && row.item[key] !== undefined) return row.item[key];
  const options = isPlainObject(row.options) ? row.options : {};
  const declared = runtimeFields.find((field) => field.metadata_key === key);
  if (declared !== undefined && options[runtimeFieldOptionTarget(declared)] !== undefined) {
    return options[runtimeFieldOptionTarget(declared)];
  }
  const camel = key.replaceAll(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
  if (options[key] !== undefined) return options[key];
  if (options[camel] !== undefined) return options[camel];
  const fields = Array.isArray(options.field) ? options.field : [];
  const assignment = fields.map(String).find((entry) => entry.startsWith(`${key}=`));
  return assignment?.slice(key.length + 1);
}

/** Total, locale-independent order for the distinct keys of one object: code-unit comparison never reports two of them as equal, unlike collation. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : 1;
}

/** Sort plain-object keys recursively so equivalent object values serialize identically regardless of insertion order; arrays keep their order. */
function canonicalizeUpsertValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeUpsertValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, nested]) => [key, canonicalizeUpsertValue(nested)]),
  );
}

/** Canonical comparison form of an upsert key value: trimmed strings, otherwise key-sorted JSON. Shared by the planner and the lock-held commit guard. */
export function stableUpsertValue(value: unknown): string {
  return typeof value === "string"
    ? value.trim()
    : JSON.stringify(canonicalizeUpsertValue(value));
}

/**
 * Turn create rows whose upsert key matches exactly one existing item into
 * update rows. Ambiguous matches and duplicate keys inside the batch refuse
 * before any write so a re-run import never duplicates or overwrites blindly.
 */
function applyKeyedUpsert(
  rows: Array<Record<string, unknown>>,
  upsert: ItemMutationUpsertOptions,
  idPrefix: string,
  runtimeFields: readonly RuntimeFieldDefinitionResolved[],
  references: Record<string, string>,
): Set<number> {
  const key = upsert.key.trim();
  if (key.length === 0) {
    throw new PmCliError("Upsert key must be a non-empty field name.", EXIT_CODE.USAGE);
  }
  const existingByValue = indexUpsertCandidates(upsert.existing);
  const seen = new Map<string, number>();
  const upserted = new Set<number>();
  for (const [index, row] of rows.entries()) {
    if (row.op !== "create") continue;
    const stable = readStableUpsertKey(row, key, index, seen, runtimeFields);
    const match = resolveUpsertMatch(existingByValue.get(stable) ?? [], key, stable);
    if (match === undefined) {
      // No match before the lock: the commit re-checks this key under the lock.
      row.unique = { key, value: readUpsertKeyValue(row, key, runtimeFields) };
      continue;
    }
    const id = normalizeItemId(match, idPrefix);
    if (typeof row.ref === "string") {
      // Later rows may still address this record as @ref; it now names the matched item.
      references[row.ref] = id;
    }
    convertRowToUpsertUpdate(row, id, runtimeFields, { key, value: readUpsertKeyValue(row, key, runtimeFields) });
    upserted.add(index);
  }
  return upserted;
}

/** Group existing item ids by their stable upsert key value, skipping items without one. */
function indexUpsertCandidates(
  existing: readonly ItemMutationUpsertCandidate[],
): Map<string, string[]> {
  const existingByValue = new Map<string, string[]>();
  for (const candidate of existing) {
    if (candidate.value === undefined || candidate.value === null) continue;
    const stable = stableUpsertValue(candidate.value);
    existingByValue.set(stable, [...(existingByValue.get(stable) ?? []), candidate.id]);
  }
  return existingByValue;
}

/** Read one create row's upsert key, refusing a missing value or a value already used by an earlier row. */
function readStableUpsertKey(
  row: Record<string, unknown>,
  key: string,
  index: number,
  seen: Map<string, number>,
  runtimeFields: readonly RuntimeFieldDefinitionResolved[],
): string {
  const value = readUpsertKeyValue(row, key, runtimeFields);
  if (value === undefined || value === null || value === "") {
    throw new PmCliError(
      `Mutation ${index + 1} is missing the upsert key "${key}".`,
      EXIT_CODE.USAGE,
      {
        code: "upsert_key_missing",
        required: `Every create record must carry a non-empty "${key}" value when --upsert-key ${key} is set.`,
        why: "Keyed upsert identifies existing items by that field; a record without it cannot be matched or safely created.",
      },
    );
  }
  const stable = stableUpsertValue(value);
  const previous = seen.get(stable);
  if (previous !== undefined) {
    throw new PmCliError(
      `Mutations ${previous + 1} and ${index + 1} share the upsert key value ${JSON.stringify(stable)} for "${key}".`,
      EXIT_CODE.USAGE,
      {
        code: "upsert_key_duplicate",
        required: "Each record must carry a distinct upsert key value within one batch.",
        why: "Two records with the same key would race for the same existing item.",
      },
    );
  }
  seen.set(stable, index);
  return stable;
}

/** Select the single existing item for a key value; several matches refuse, none means create. */
function resolveUpsertMatch(
  matches: readonly string[],
  key: string,
  stable: string,
): string | undefined {
  if (matches.length > 1) {
    throw new PmCliError(
      `Upsert key "${key}" value ${JSON.stringify(stable)} matches ${matches.length} existing items: ${matches.join(", ")}.`,
      EXIT_CODE.CONFLICT,
      {
        code: "upsert_key_ambiguous",
        required: "Resolve the duplicate existing items or choose a key that is unique per item.",
        why: "An ambiguous key cannot select one item to update without guessing.",
      },
    );
  }
  return matches[0];
}

/** Rewrite a matched create row in place as an update of the existing item. */
function convertRowToUpsertUpdate(
  row: Record<string, unknown>,
  id: string,
  runtimeFields: readonly RuntimeFieldDefinitionResolved[],
  match: BulkItemUniqueKey,
): void {
  // readUpsertKeyValue found the key, so the row carries either an item document or an options object.
  const updateKeys = new Set([
    ...MUTATION_OPTION_KEYS.update,
    ...runtimeFieldOptionKeys("update", runtimeFields),
  ]);
  const options = isPlainObject(row.item)
    ? itemDocumentToBatchOptions(row.item, "update", runtimeFields)
    : Object.fromEntries(
        Object.entries(row.options as Record<string, unknown>).filter(([optionKey]) =>
          updateKeys.has(optionKey),
        ),
      );
  delete row.item;
  delete row.ref;
  row.op = "update";
  row.id = id;
  row.options = options;
  // The commit re-reads this key under the lock before updating the selected item.
  row.match = match;
}

/**
 * Register create aliases before resolving links, including forward references.
 * Each alias keeps an explicit normalized ID or a transaction-derived stable ID;
 * duplicate aliases and aliases on other operations are refused before writes.
 */
function collectMutationReferences(
  rows: ReadonlyArray<Record<string, unknown>>,
  options: ResolveItemMutationDocumentOptions,
  references: Record<string, string>,
): Record<string, string> {
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
  synthesizeMissingReferences(rows);
  // Keyed upsert converts a matched create row to an update and drops its alias, so the receipt reads the aliases first.
  const inputReferences = rows.map((row) => (typeof row.ref === "string" ? row.ref : undefined));
  const references = Object.create(null) as Record<string, string>;
  const upserted =
    options.upsert === undefined
      ? new Set<number>()
      : applyKeyedUpsert(
          rows,
          excludeOwnCreateIds(options.upsert, rows, options),
          options.idPrefix,
          options.runtimeFields ?? [],
          references,
        );
  convertItemDocumentRows(rows, options.runtimeFields ?? []);
  collectMutationReferences(rows, options, references);
  assertAcyclicCreateReferences(rows, inputReferences);

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
  const mutations = parseItemMutationBatch(JSON.stringify(resolvedRows), {
    runtimeFields: options.runtimeFields ?? [],
  });
  const createIds = mutations
    .filter((mutation) => mutation.op === "create")
    .map((mutation) => mutation.id);
  if (new Set(createIds).size !== createIds.length) {
    throw new PmCliError(
      "Duplicate resolved create id in mutation document.",
      EXIT_CODE.USAGE,
    );
  }
  const receiptRows = mutations.map((mutation, index): ResolvedItemMutationRow => {
    const reference = inputReferences[index];
    return {
      index,
      ...(typeof reference === "string" ? { ref: reference } : {}),
      id: mutation.id,
      op: mutation.op,
      ...(upserted.has(index) ? { upserted: true as const } : {}),
    };
  });
  return { schema_version: 1, mutations, references, rows: receiptRows };
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
  for (const [sourceKey, targetKey, keys] of ITEM_MUTATION_FACET_OPTION_MAPPINGS) {
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
  runtimeFields: readonly RuntimeFieldDefinitionResolved[],
  explicitOptions: Record<string, unknown>,
): void {
  const readOnlyKeys =
    mode === "update" ? UPDATE_READ_ONLY_ITEM_KEYS : READ_ONLY_ITEM_KEYS;
  if (readOnlyKeys.has(key)) return;
  const definition = runtimeFields.find((field) => field.metadata_key === key && field.commands.includes(mode));
  if (definition !== undefined) {
    const explicitValue = readRuntimeFieldOptionValue(explicitOptions, definition);
    documentOptions[runtimeFieldOptionTarget(definition)] = explicitValue !== undefined
      ? explicitValue
      : definition.type === "array" || definition.type === "object"
        ? JSON.stringify(value)
        : value;
    return;
  }
  if (!ITEM_FIELD_KEYS.has(key)) {
    const suggestion = nearestKey(key, [...ITEM_FIELD_KEYS]);
    if (suggestion !== undefined)
      throw unknownKeyError("item document", key, [...ITEM_FIELD_KEYS]);
    const fields = Array.isArray(documentOptions.field)
      ? (documentOptions.field as string[])
      : [];
    fields.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
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
 * Supply the workspace's resolved schema fields to route metadata keys through
 * declared option names and aliases. Extension assignments retain raw strings
 * and JSON containers, with explicit assignments applied after document values.
 */
export function itemDocumentToMutationOptions(
  input: string,
  mode: "create" | "update",
  explicitOptions: Record<string, unknown> = {},
  runtimeFields: readonly RuntimeFieldDefinitionResolved[] = [],
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
    appendItemDocumentEntry(documentOptions, key, value, mode, runtimeFields, explicitOptions);
  }
  appendFacetOptions(documentOptions, item, mode === "update");
  if (linked !== undefined) appendFacetOptions(documentOptions, linked);
  if (mode === "update") {
    const annotations = Object.fromEntries(
      (["comments", "notes", "learnings"] as const)
        .filter((key) => Object.hasOwn(item, key))
        .map((key) => [
          key,
          (item[key] as unknown[]).filter(
            (entry) => isPlainObject(entry) && entry.created_at !== undefined,
          ),
        ]),
    );
    if (Object.keys(annotations).length > 0) {
      documentOptions.documentAnnotationSnapshot = annotations;
    }
  }
  return {
    ...documentOptions,
    ...Object.fromEntries(
      Object.entries(explicitOptions).filter(
        ([, value]) => value !== undefined,
      ),
    ),
    ...(Array.isArray(documentOptions.field) && Array.isArray(explicitOptions.field)
      ? { field: [...documentOptions.field, ...explicitOptions.field] }
      : {}),
    stdinJson: undefined,
  };
}

/** Validate an already-decoded MCP mutation array through the same strict parser as CLI stdin. */
export function validateItemMutationRows(value: unknown): BulkItemMutation[] {
  return parseItemMutationBatch(JSON.stringify(value));
}
