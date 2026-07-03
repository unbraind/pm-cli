/**
 * @module core/schema/status-defs-file
 *
 * Resolves configurable schema, fields, statuses, and workflows for Status Defs File.
 */
import { RUNTIME_STATUS_ROLE_VALUES } from "../../types/index.js";
import type { RuntimeStatusDefinition, RuntimeStatusRole } from "../../types/index.js";
import { DEFAULT_RUNTIME_STATUS_DEFINITIONS } from "./runtime-schema.js";
import { evictOldestMemoEntries } from "../shared/memo.js";

export type { RuntimeStatusDefinition, RuntimeStatusRole } from "../../types/index.js";

/**
 * Pure logic for the `pm schema add-status` / `pm schema remove-status`
 * commands. The CLI command file (schema.ts) owns IO/governance; everything
 * testable and side-effect-free lives here so it can be coverage-gated to 100%.
 *
 * Statuses persist at `.agents/pm/schema/statuses.json` under the shape
 * `{ statuses: RuntimeStatusDefinition[] }`. When the file is absent the runtime
 * merge layer (src/core/store/settings.ts) still supplies the built-in defaults
 * from DEFAULT_RUNTIME_STATUS_DEFINITIONS, so this module never duplicates them
 * into the persisted file.
 */

const RUNTIME_STATUS_ROLE_SET = new Set<string>(RUNTIME_STATUS_ROLE_VALUES);

/**
 * Memo for {@link normalizeStatusToken}. Status ranking inside sort comparators
 * normalizes the same handful of status strings O(n log n) times per corpus scan, and
 * the trim/lowercase/regex pipeline shows up in list/next/context profiles. The cap
 * bounds memory in long-lived hosts against unbounded arbitrary inputs; half-eviction keeps the
 * newest-inserted half when the cap is hit. Declared before
 * BUILTIN_STATUS_IDS, whose module-level initializer already normalizes tokens.
 */
const STATUS_TOKEN_MEMO_MAX_ENTRIES = 2_000;
const statusTokenMemo = new Map<string, string>();

/**
 * The 5 lifecycle status ids that ship as built-in defaults and may never be
 * removed (their normalized ids match DEFAULT_RUNTIME_STATUS_DEFINITIONS:
 * open/in_progress/blocked/closed/canceled). `draft` is also a default but the
 * acceptance criteria enumerate the 5 terminal/active ids explicitly, so the
 * guard derives the full set from the canonical defaults to stay in sync.
 */
export const BUILTIN_STATUS_IDS: ReadonlySet<string> = new Set(
  DEFAULT_RUNTIME_STATUS_DEFINITIONS.map((definition) => normalizeStatusToken(definition.id)).filter(
    (id) => id.length > 0,
  ),
);

/**
 * The shape persisted at `.agents/pm/schema/statuses.json`.
 */
export interface StatusDefsFile {
  statuses: RuntimeStatusDefinition[];
}

/**
 * Documents the raw add status input payload exchanged by command, SDK, and package integrations.
 */
export interface RawAddStatusInput {
  id: string | undefined;
  roles?: string[];
  aliases?: string[];
  description?: string;
  order?: number;
}

/**
 * Documents the normalized add status input payload exchanged by command, SDK, and package integrations.
 */
export interface NormalizedAddStatusInput {
  id: string;
  /**
   * Normalized roles, or `undefined` when the raw input did not supply a roles
   * field at all. `undefined` means "leave existing roles untouched" on upsert;
   * an explicit empty array means "clear roles". This distinction is what keeps
   * `add-status review --description x` from wiping a previously-set role.
   */
  roles?: RuntimeStatusRole[];
  /** Same omitted-vs-explicit-empty semantics as `roles`. */
  aliases?: string[];
  description?: string;
  order?: number;
}

/**
 * Documents the upsert status def result payload exchanged by command, SDK, and package integrations.
 */
export interface UpsertStatusDefResult {
  file: StatusDefsFile;
  /** The definition as stored after the upsert (existing fields preserved). */
  definition: RuntimeStatusDefinition;
  /** True when an existing definition with the same (normalized) id was replaced. */
  replaced: boolean;
}

/**
 * Documents the remove status def result payload exchanged by command, SDK, and package integrations.
 */
export interface RemoveStatusDefResult {
  file: StatusDefsFile;
  /** True when a matching definition existed and was dropped from the file. */
  removed: boolean;
  /** The removed definition, when one matched the requested id. */
  definition?: RuntimeStatusDefinition;
}

/**
 * Normalizes a status token using the same rules as runtime-schema.ts: lowercase
 * and collapse any run of whitespace/hyphens into a single underscore.
 */
export function normalizeStatusToken(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const memoized = statusTokenMemo.get(value);
  if (memoized !== undefined) {
    return memoized;
  }
  const normalized = value.trim().toLowerCase().replaceAll(/[\s-]+/g, "_");
  if (statusTokenMemo.size >= STATUS_TOKEN_MEMO_MAX_ENTRIES) {
    evictOldestMemoEntries(statusTokenMemo);
  }
  statusTokenMemo.set(value, normalized);
  return normalized;
}

function dedupeTokens(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const token = normalizeStatusToken(value);
    if (token.length > 0) {
      seen.add(token);
    }
  }
  return [...seen].sort((left, right) => left.localeCompare(right));
}

/**
 * Validates and normalizes raw add-status CLI input. Throws a plain Error with a
 * stable message when the id is missing/empty or a role is not one of
 * RUNTIME_STATUS_ROLE_VALUES; the CLI layer maps these to PmCliError exit codes.
 *
 * Omitted vs explicit-empty is preserved end-to-end: when `raw.roles`/`raw.aliases`
 * is `undefined` (flag not supplied) the normalized field is `undefined` so the
 * upsert leaves the existing value untouched; when supplied (even an empty array)
 * the field is normalized to an array so the upsert can apply an explicit clear.
 */
export function normalizeAddStatusInput(raw: RawAddStatusInput): NormalizedAddStatusInput {
  const id = normalizeStatusToken(raw.id);
  if (id.length === 0) {
    throw new Error("Status id must not be empty.");
  }
  // Built-in lifecycle statuses are reserved and cannot be overridden: an
  // add-status override would change reserved metadata yet remove-status refuses
  // to delete a built-in id, leaving no CLI path to undo it. Reject up front,
  // symmetric with removeStatusDef.
  if (BUILTIN_STATUS_IDS.has(id)) {
    throw new Error(
      `Cannot add-status the built-in status "${id}". Built-in statuses are reserved: ${[...BUILTIN_STATUS_IDS].join(", ")}.`,
    );
  }
  let roles: RuntimeStatusRole[] | undefined;
  if (raw.roles !== undefined) {
    roles = [];
    const seenRoles = new Set<string>();
    for (const rawRole of raw.roles) {
      const role = typeof rawRole === "string" ? rawRole.trim().toLowerCase() : "";
      if (role.length === 0) {
        continue;
      }
      if (!RUNTIME_STATUS_ROLE_SET.has(role)) {
        throw new Error(
          `Invalid status role "${rawRole}". Allowed roles: ${RUNTIME_STATUS_ROLE_VALUES.join(", ")}.`,
        );
      }
      if (!seenRoles.has(role)) {
        seenRoles.add(role);
        roles.push(role as RuntimeStatusRole);
      }
    }
  }
  const aliases =
    raw.aliases === undefined ? undefined : dedupeTokens(raw.aliases).filter((alias) => alias !== id);
  const description = raw.description?.trim();
  const order =
    typeof raw.order === "number" && Number.isFinite(raw.order) ? Math.trunc(raw.order) : undefined;
  return {
    id,
    roles,
    aliases,
    description: description && description.length > 0 ? description : undefined,
    order,
  };
}

function selectStatusesArray(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.statuses)) {
    return record.statuses;
  }
  if (Array.isArray(record.definitions)) {
    return record.definitions;
  }
  return undefined;
}

function extractStatusDefinitions(parsed: unknown): RuntimeStatusDefinition[] {
  const candidate = selectStatusesArray(parsed);
  if (!candidate) {
    return [];
  }
  const definitions: RuntimeStatusDefinition[] = [];
  for (const entry of candidate) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.trim().length === 0) {
      continue;
    }
    definitions.push(record as unknown as RuntimeStatusDefinition);
  }
  return definitions;
}

/**
 * Coerces an arbitrary parsed value from statuses.json into a StatusDefsFile.
 * Accepts the canonical `{ statuses: [...] }` shape, a bare array of
 * definitions, or a `{ definitions: [...] }` form, and tolerates a
 * missing/invalid file by returning an empty statuses list.
 */
export function parseStatusDefsFile(raw: string | null | undefined): StatusDefsFile {
  if (raw === null || raw === undefined || raw.trim().length === 0) {
    return { statuses: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("schema/statuses.json contains invalid JSON.");
  }
  return { statuses: extractStatusDefinitions(parsed) };
}

/**
 * Serializes the status definitions file with a trailing newline (matches the
 * rest of the schema scaffold files written by pm).
 */
export function serializeStatusDefsFile(file: StatusDefsFile): string {
  return `${JSON.stringify({ statuses: file.statuses }, null, 2)}\n`;
}

/**
 * Idempotent UPSERT of a status definition into the parsed file. Matching is by
 * normalized id. When a definition already exists, fields supplied in `input`
 * override the previous values (roles/aliases replace when a non-empty array is
 * given, clear when an explicit empty array is given, and are left UNTOUCHED
 * when the field is `undefined` — i.e. the add-status flag was omitted);
 * description/order override when provided. Fields not addressed by add-status
 * flags are preserved untouched, so `add-status <id> --description x` keeps any
 * previously-set roles/aliases.
 */
export function upsertStatusDef(
  file: StatusDefsFile,
  input: NormalizedAddStatusInput,
  baseDefinition?: RuntimeStatusDefinition,
): UpsertStatusDefResult {
  const statuses = file.statuses.slice();
  const existingIndex = statuses.findIndex(
    (definition) => normalizeStatusToken(definition.id) === input.id,
  );
  // A file-backed definition is the primary seed; when the status is not yet in
  // statuses.json fall back to `baseDefinition` (the resolved settings-backed
  // definition) so omitting --role/--alias preserves metadata that lives in
  // settings.schema.statuses rather than the file.
  const existing = existingIndex >= 0 ? statuses[existingIndex] : baseDefinition;

  const next: RuntimeStatusDefinition = {
    ...existing,
    id: input.id,
  };
  if (input.roles !== undefined) {
    if (input.roles.length > 0) {
      next.roles = [...input.roles];
    } else if (next.roles !== undefined) {
      delete next.roles;
    }
  }
  if (input.aliases !== undefined) {
    if (input.aliases.length > 0) {
      next.aliases = [...input.aliases];
    } else if (next.aliases !== undefined) {
      delete next.aliases;
    }
  }
  if (input.description !== undefined) {
    next.description = input.description;
  }
  if (input.order !== undefined) {
    next.order = input.order;
  }

  if (existingIndex >= 0) {
    statuses[existingIndex] = next;
  } else {
    statuses.push(next);
  }

  return {
    file: { statuses },
    definition: next,
    // "replaced" reflects whether the status already existed effectively (in the
    // file OR in resolved settings), so the CLI reports "Updated" vs "Registered"
    // correctly even when the prior definition lived only in settings.
    replaced: existing !== undefined,
  };
}

/**
 * Removes a status definition from the parsed file by id (normalized). Throws a
 * plain Error when `id` is empty or matches a reserved built-in default status
 * (those are never stored in the file and must never be deletable). Returns
 * `removed: false` when no matching definition exists so the CLI layer can treat
 * the call as an idempotent no-op.
 */
export function removeStatusDef(file: StatusDefsFile, id: string | undefined): RemoveStatusDefResult {
  const normalizedId = normalizeStatusToken(id);
  if (normalizedId.length === 0) {
    throw new Error("Status id must not be empty.");
  }
  if (BUILTIN_STATUS_IDS.has(normalizedId)) {
    throw new Error(
      `Cannot remove built-in status "${normalizedId}". Built-in statuses are reserved: ${[...BUILTIN_STATUS_IDS].join(", ")}.`,
    );
  }
  const statuses = file.statuses.slice();
  const existingIndex = statuses.findIndex(
    (definition) => normalizeStatusToken(definition.id) === normalizedId,
  );
  if (existingIndex < 0) {
    return { file: { statuses }, removed: false };
  }
  const [definition] = statuses.splice(existingIndex, 1);
  return { file: { statuses }, removed: true, definition };
}

/**
 * Throws when the new status id or any explicitly-supplied alias collides with a
 * DIFFERENT existing status's id/alias. `resolvedAliasToId` maps a normalized
 * token to its owning status id (the runtime status registry's alias_to_id map,
 * which stores ids and aliases in one namespace). Re-adding the same status
 * (matching id) is allowed — only cross-status collisions throw. This prevents a
 * custom status from shadowing a built-in lifecycle token (for example
 * `add-status review --alias open`, or a custom id `cancelled` that aliases the
 * built-in `canceled`), which would make `pm update --status open` resolve to the
 * wrong status. The CLI layer maps the thrown Error to a USAGE exit code.
 */
export function assertStatusTokensAvailable(
  input: { id: string; aliases?: string[] },
  resolvedAliasToId: ReadonlyMap<string, string>,
): void {
  const candidates = [input.id, ...(input.aliases ?? [])];
  for (const candidate of candidates) {
    const token = normalizeStatusToken(candidate);
    if (token.length === 0) {
      continue;
    }
    const owner = resolvedAliasToId.get(token);
    if (owner !== undefined && owner !== input.id) {
      throw new Error(
        `Status token "${token}" already belongs to status "${owner}". Choose a different id/alias to avoid shadowing it.`,
      );
    }
  }
}
