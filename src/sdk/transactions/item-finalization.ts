/**
 * @module sdk/transactions/item-finalization
 *
 * Applies a declared front-matter finalization to one item through the fenced
 * item store. It exists so an importer can write exact source fields (native
 * lifecycle clocks, extension fields) as a journaled transaction step instead
 * of an unowned write beside the transaction (GH-1656).
 */
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { collectRegisteredItemFieldNames } from "../../core/extensions/item-fields.js";
import { canonicalDocument, parseItemDocument, serializeItemDocument } from "../../core/item/item-format.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { stableStringify } from "../../core/shared/serialization.js";
import { pruneResolvedDeferredFields } from "../../core/item/deferred-fields.js";
import { mutateItem } from "../../core/store/item-store.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemMetadata } from "../../types/index.js";

/**
 * Fields a finalization can neither set nor remove. The item writer derives
 * `id`, `updated_at` and `pm_format_version` itself; `type` selects the item's
 * storage location and changes only through an `update` row.
 */
export const FINALIZATION_RESERVED_FIELDS: readonly string[] = ["id", "updated_at", "pm_format_version", "type"];

/**
 * History operation recorded for every finalization event: the native `import`
 * identity importers already use for source-fidelity writes, so existing
 * streams, readers and policies keyed on it see one vocabulary.
 */
export const FINALIZATION_HISTORY_OPERATION = "import";

/** Declared front-matter changes of one finalization. */
export interface ItemFinalizationPatch {
  /** Fields written exactly as given, after the store's normal canonicalization. */
  set?: Readonly<Record<string, unknown>>;
  /** Fields removed from the item. */
  unset?: readonly string[];
}

/** Refuse a field name the patch cannot address: malformed, inherited from Object, or derived by the writer. */
function assertFinalizationField(field: unknown, label: string): asserts field is string {
  if (typeof field !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/u.test(field) || field in Object.prototype) {
    throw new TypeError(`${label} names an invalid field ${JSON.stringify(field)}; use a front-matter field name of letters, digits and underscores`);
  }
  if (FINALIZATION_RESERVED_FIELDS.includes(field)) {
    throw new TypeError(`${label} cannot change "${field}"; the item writer derives it, or an update row owns it`);
  }
}

/**
 * Shape of a value, used to prove a declared value was stored as given: its
 * JSON kind, and for an array its entry count, because normalization drops
 * entries it cannot read (`tags: [1]` would otherwise store no tags).
 */
function storedShape(value: unknown): string {
  return Array.isArray(value) ? `array of ${value.length}` : typeof value;
}

/** Own keys history patches and JSON readers treat as prototype access; a journaled value cannot carry them. */
const UNSAFE_VALUE_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/** True for a plain data record: the only object shape the journal retains unchanged. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

/** True for a value the transaction journal can retain and replay unchanged. */
export function isJournalValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  // Array.from turns a sparse hole into undefined, which is not a journal value.
  if (Array.isArray(value)) return Array.from(value).every(isJournalValue);
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).every(([key, nested]) => !UNSAFE_VALUE_KEYS.includes(key) && isJournalValue(nested));
}

/**
 * Validate a finalization's shape before any journal or lock work. `label`
 * names the row in the refusal. A patch must declare at least one change, and
 * a field cannot be both set and removed.
 */
export function assertValidItemFinalization(patch: ItemFinalizationPatch, label: string): void {
  const { set, unset } = patch;
  if (set !== undefined && !isPlainRecord(set)) {
    throw new TypeError(`${label} set must be a plain object of front-matter fields`);
  }
  if (unset !== undefined && !Array.isArray(unset)) {
    throw new TypeError(`${label} unset must be an array of front-matter field names`);
  }
  const setFields = Object.keys(set ?? {});
  const unsetFields: readonly unknown[] = unset ?? [];
  if (setFields.length + unsetFields.length === 0) {
    throw new TypeError(`${label} requires at least one field in set or unset`);
  }
  for (const field of setFields) {
    assertFinalizationField(field, label);
    if (set![field] === null || !isJournalValue(set![field])) {
      throw new TypeError(`${label} set "${field}" must be a non-null JSON value (no undefined, non-finite number, sparse array, class instance, or __proto__/constructor/prototype key); remove a field with unset`);
    }
  }
  for (const field of unsetFields) {
    assertFinalizationField(field, label);
    // The item format keeps these beside the front matter, so removing them from it would change nothing.
    if (field === "body" || field === "front_matter") throw new TypeError(`${label} cannot unset "${field}"; the item format reserves that name`);
    if (setFields.includes(field)) throw new TypeError(`${label} both sets and unsets "${field}"`);
  }
  if (new Set(unsetFields).size !== unsetFields.length) throw new TypeError(`${label} unset repeats a field`);
}

/** Inputs for one fenced finalization write. */
export interface ApplyItemFinalizationParams extends ItemFinalizationPatch {
  /** Tracker root that owns the item. */
  pmRoot: string;
  /** Canonical item id. */
  id: string;
  /** Actor recorded on the history event. */
  author: string;
  /** History message recorded on the event. */
  message: string;
  /** Override the assignee-ownership check, as `force` does for an update. */
  force?: boolean;
}

/** Outcome of one finalization write. */
export interface ApplyItemFinalizationResult {
  /** Item front matter after the write. */
  item: ItemMetadata;
  /** Fields whose canonical value changed; empty when the event records an unchanged document. */
  changedFields: string[];
}

/**
 * Apply a finalization under the item lock. The patched document must load
 * through the item reader under the workspace schema before it is written, so
 * a finalization can never store an item the tracker cannot read back. Every
 * finalization appends its event, even when no field changes: the event is the
 * durable proof recovery reads, so a row is never re-evaluated against state a
 * later row produced.
 */
export async function applyItemFinalization(params: ApplyItemFinalizationParams): Promise<ApplyItemFinalizationResult> {
  assertValidItemFinalization(params, `Finalization of ${params.id}`);
  const settings = await readSettings(params.pmRoot);
  const format = { schema: settings.schema, extensionFieldNames: collectRegisteredItemFieldNames(getActiveExtensionRegistrations()) };
  const result = await mutateItem({
    pmRoot: params.pmRoot,
    settings,
    id: params.id,
    op: FINALIZATION_HISTORY_OPERATION,
    author: params.author,
    message: params.message,
    force: params.force === true,
    extensionFieldNames: format.extensionFieldNames,
    mutate: (document) => {
      const before = structuredClone(document.metadata) as unknown as Record<string, unknown>;
      const metadata = document.metadata as unknown as Record<string, unknown>;
      for (const [field, value] of Object.entries(params.set ?? {})) metadata[field] = structuredClone(value);
      for (const field of params.unset ?? []) delete metadata[field];
      let after: Record<string, unknown>;
      try {
        // The store prunes resolved deferrals after this callback, so the candidate is judged in that final form.
        pruneResolvedDeferredFields(document.metadata);
        const canonical = canonicalDocument(document, format);
        const reread = canonicalDocument(parseItemDocument(serializeItemDocument(canonical, format), format), format);
        // A field the format reserves (an envelope or body key) would make the reader return another document.
        if (stableStringify(reread) !== stableStringify(canonical)) throw new TypeError("the stored item reads back as a different document; a set field collides with a name the item format reserves");
        after = canonical.metadata as unknown as Record<string, unknown>;
        // Canonicalization may tidy a value, but it must not drop it or store another shape in its place.
        const lost = Object.entries(params.set ?? {}).find(([field, value]) => storedShape(after[field]) !== storedShape(value));
        if (lost !== undefined) throw new TypeError(`set "${lost[0]}" is not stored as declared (${storedShape(lost[1])} normalizes to ${after[lost[0]] === undefined ? "an absent field" : storedShape(after[lost[0]])})`);
      } catch (cause: unknown) {
        throw new PmCliError(
          `Finalization of ${params.id} would not store a readable item with the declared fields: ${(cause as Error).message}`,
          EXIT_CODE.USAGE,
          {
            code: "finalization_invalid_document",
            item_id: params.id,
            required: "Declare set and unset fields that leave a valid item under the workspace schema, with each set value in the shape its field stores.",
            why: "A finalization writes front-matter fields exactly, so the patched document is read back through the item reader, and each declared value is checked against what would be stored, before anything is written.",
            nextSteps: [`Run pm get ${params.id} --json to compare the current fields with the finalization, then correct the patch and retry the transaction.`],
          },
        );
      }
      const changedFields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((field) => Object.hasOwn(before, field) !== Object.hasOwn(after, field) || stableStringify(before[field]) !== stableStringify(after[field]))
        .sort((left, right) => left.localeCompare(right));
      return { changedFields };
    },
  });
  return { item: result.item, changedFields: result.changedFields };
}
