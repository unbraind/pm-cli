/**
 * @module core/item/deferred-fields
 *
 * Auditable deferral of strict-required create fields (GH-1713). An importer
 * that mirrors a record from another system often cannot know its deadline,
 * assignee, acceptance criteria or estimate. Strict create therefore accepts an
 * explicit, reasoned deferral instead of an invented value. The deferral is a
 * typed metadata entry, so the create history entry records it. `pm validate`
 * lists it as curation work, and close validation keeps refusing to finish the
 * item until every deferred field holds a concrete value. Giving a deferred
 * field a value resolves its entry on the same write.
 */
import type { ItemDeferredField, ItemMetadata } from "../../types/index.js";

/** One field that strict create may defer, with its create option key and CLI spelling. */
export interface DeferrableItemField {
  /** Canonical item metadata key. */
  field: "deadline" | "assignee" | "acceptance_criteria" | "estimated_minutes";
  /** Create option key used by type `required_create_fields` policies and the SDK. */
  option: "deadline" | "assignee" | "acceptanceCriteria" | "estimatedMinutes";
  /** Primary CLI flag that supplies the value later. */
  flag: string;
  /** Accepted `--defer` spellings, all lower-case. */
  aliases: readonly string[];
}

/**
 * Declared set of deferrable fields: scalar strict-required create fields that
 * have no truthful empty value and are routinely unknown when a record is
 * mirrored from another system. Repeatable options are not listed because they
 * already accept an explicit empty set (`--clear-*`).
 */
export const DEFERRABLE_ITEM_FIELDS: readonly DeferrableItemField[] = [
  { field: "acceptance_criteria", option: "acceptanceCriteria", flag: "--acceptance-criteria", aliases: ["acceptance_criteria", "acceptance-criteria", "acceptancecriteria", "ac"] },
  { field: "assignee", option: "assignee", flag: "--assignee", aliases: ["assignee"] },
  { field: "deadline", option: "deadline", flag: "--deadline", aliases: ["deadline"] },
  { field: "estimated_minutes", option: "estimatedMinutes", flag: "--estimate", aliases: ["estimated_minutes", "estimated-minutes", "estimatedminutes", "estimate"] },
];

const DEFERRABLE_BY_FIELD = new Map(DEFERRABLE_ITEM_FIELDS.map((entry) => [entry.field as string, entry]));
const DEFERRABLE_BY_ALIAS = new Map(
  DEFERRABLE_ITEM_FIELDS.flatMap((entry) => entry.aliases.map((alias) => [alias, entry] as const)),
);

/** Resolve a `--defer` spelling or canonical key to its deferrable field, or undefined when it cannot be deferred. */
export function resolveDeferrableItemField(input: string): DeferrableItemField | undefined {
  return DEFERRABLE_BY_ALIAS.get(input.trim().toLowerCase());
}

/** Look up a deferrable field by its canonical metadata key. */
export function deferrableItemFieldByKey(field: string): DeferrableItemField | undefined {
  return DEFERRABLE_BY_FIELD.get(field);
}

/** True when the metadata holds a concrete (non-empty) value for the field. */
export function hasConcreteItemFieldValue(metadata: Partial<ItemMetadata>, field: string): boolean {
  const value = (metadata as Record<string, unknown>)[field];
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  return value !== undefined && value !== null;
}

/** Deferred entries whose field still has no concrete value: the curation work an item carries. */
export function outstandingDeferredFields(metadata: Partial<ItemMetadata>): ItemDeferredField[] {
  return (metadata.deferred_fields ?? []).filter((entry) => !hasConcreteItemFieldValue(metadata, entry.field));
}

/**
 * Drop deferred entries whose field now holds a concrete value. Returns true
 * when an entry was resolved, so the caller records `deferred_fields` as a
 * changed field on the same write.
 */
export function pruneResolvedDeferredFields(metadata: ItemMetadata): boolean {
  const entries = metadata.deferred_fields;
  if (entries === undefined || entries.length === 0) return false;
  const outstanding = outstandingDeferredFields(metadata);
  if (outstanding.length === entries.length) return false;
  if (outstanding.length === 0) delete metadata.deferred_fields;
  else metadata.deferred_fields = outstanding;
  return true;
}

/** Reasons why a stored `deferred_fields` value is malformed, or undefined when it is valid. */
export function describeInvalidDeferredFields(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return "deferred_fields must be an array";
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return `deferred_fields[${index}] must be an object`;
    }
    const { field, reason } = entry as Record<string, unknown>;
    if (typeof field !== "string" || !DEFERRABLE_BY_FIELD.has(field)) {
      return `deferred_fields[${index}].field must be one of ${DEFERRABLE_ITEM_FIELDS.map((item) => item.field).join(", ")}`;
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      return `deferred_fields[${index}].reason must be a non-empty string`;
    }
    if (seen.has(field)) return `deferred_fields lists ${field} more than once`;
    seen.add(field);
  }
  return undefined;
}

/** Canonical stored form: trimmed reasons ordered by field; an empty list is absent. */
export function normalizeDeferredFields(values: readonly ItemDeferredField[] | undefined): ItemDeferredField[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  return values
    .map((entry) => ({ field: entry.field, reason: entry.reason.trim() }))
    .sort((left, right) => left.field.localeCompare(right.field));
}
