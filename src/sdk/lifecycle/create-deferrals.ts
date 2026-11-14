/**
 * @module sdk/lifecycle/create-deferrals
 *
 * Create-time parsing for auditable strict-field deferrals (GH-1713). A caller
 * that cannot know a strict-required scalar yet names it with `--defer <field>`
 * (SDK `defer`) and explains why with `--defer-reason` (SDK `deferReason`).
 * The deferred field then satisfies the strict create contract, and the item
 * records the deferral as typed `deferred_fields` metadata. Close validation
 * keeps refusing the item until each deferred field holds a value.
 */
import {
  DEFERRABLE_ITEM_FIELDS,
  normalizeDeferredFields,
  resolveDeferrableItemField,
  type DeferrableItemField,
} from "../../core/item/deferred-fields.js";
import { mutationOptionLabel, type MutationInputAudience } from "../../core/item/literal-mutation-input.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import type { ItemDeferredField } from "../../types/index.js";

/** Deferrals a create request declared, resolved to canonical fields. */
export interface ResolvedCreateDeferrals {
  /** Deferred fields in canonical order, without duplicates. */
  fields: DeferrableItemField[];
  /** Trimmed reason shared by every deferred field, or undefined when nothing is deferred. */
  reason: string | undefined;
  /** Create option keys the deferral satisfies in the strict required-option check. */
  optionKeys: ReadonlySet<string>;
}

/** Comma-separated canonical names of the deferrable fields, for refusal guidance. */
function deferrableFieldList(): string {
  return DEFERRABLE_ITEM_FIELDS.map((entry) => entry.field).join(", ");
}

const NO_DEFERRALS: ResolvedCreateDeferrals = Object.freeze({ fields: [], reason: undefined, optionKeys: new Set<string>() });

/** Split repeated and comma-separated `defer` tokens; native option validation has already typed them as strings. */
function readDeferTokens(raw: readonly string[] | undefined): string[] {
  return (raw ?? []).flatMap((value) => value.split(",")).map((token) => token.trim()).filter((token) => token.length > 0);
}

/**
 * Resolve the `defer` and `deferReason` options. Refuses an unknown field, a
 * deferral without a reason, and a reason without a deferral, so a deferral is
 * never silent and a reason never dangles.
 */
export function resolveCreateDeferrals(
  options: { defer?: readonly string[]; deferReason?: string },
  audience: MutationInputAudience,
): ResolvedCreateDeferrals {
  const deferLabel = mutationOptionLabel(audience, "defer");
  const reasonLabel = mutationOptionLabel(audience, "defer-reason");
  const tokens = readDeferTokens(options.defer);
  const reason = options.deferReason?.trim();
  if (tokens.length === 0) {
    if (reason !== undefined && reason.length > 0) {
      throw new PmCliError(`${reasonLabel} needs ${deferLabel}: name the fields whose values are not known yet.`, EXIT_CODE.USAGE, {
        code: "create_deferral_fields_required",
        required: `Pass ${deferLabel} with ${reasonLabel}, or drop ${reasonLabel}.`,
        nextSteps: [`Deferrable fields: ${deferrableFieldList()}.`],
      });
    }
    return NO_DEFERRALS;
  }
  const fields = new Map<string, DeferrableItemField>();
  for (const token of tokens) {
    const field = resolveDeferrableItemField(token);
    if (field === undefined) {
      throw new PmCliError(`${deferLabel} cannot defer "${token}". Deferrable fields: ${deferrableFieldList()}.`, EXIT_CODE.USAGE, {
        code: "create_deferral_field_unsupported",
        required: `Defer only ${deferrableFieldList()}; supply every other field, or clear a repeatable option with its --clear-* flag.`,
      });
    }
    fields.set(field.field, field);
  }
  if (reason === undefined || reason.length === 0) {
    throw new PmCliError(`${deferLabel} requires ${reasonLabel}: record why the deferred values are not known yet.`, EXIT_CODE.USAGE, {
      code: "create_deferral_reason_required",
      required: `Pass ${reasonLabel} "<why>", for example the system the record was imported from.`,
    });
  }
  const ordered = DEFERRABLE_ITEM_FIELDS.filter((entry) => fields.has(entry.field));
  return { fields: ordered, reason, optionKeys: new Set(ordered.map((entry) => entry.option)) };
}

/**
 * Refuse a deferral of a field the same create also gives a value or clears:
 * either the value is known or it is not, so the request is contradictory.
 */
export function assertNoCreateDeferralConflicts(
  deferrals: ResolvedCreateDeferrals,
  options: Record<string, unknown>,
  unsetKeys: ReadonlySet<string>,
  audience: MutationInputAudience,
): void {
  const conflicts = deferrals.fields.filter((entry) => {
    const value = options[entry.option];
    // Native option validation types these options as strings and folds typed nulls into unsets (GH-1655).
    const supplied = typeof value === "string" && value.trim().length > 0;
    return supplied || unsetKeys.has(entry.field);
  });
  if (conflicts.length === 0) return;
  const deferLabel = mutationOptionLabel(audience, "defer");
  const names = conflicts.map((entry) => entry.field).join(", ");
  throw new PmCliError(`Cannot both defer and set ${names}: ${deferLabel} records a value as not known yet.`, EXIT_CODE.USAGE, {
    code: "create_deferral_conflict",
    required: `Drop ${deferLabel} for ${names}, or drop the value (or unset) you supplied for it.`,
  });
}

/** The stored `deferred_fields` entries for a create, or undefined when nothing is deferred. */
export function buildCreateDeferredFieldEntries(deferrals: ResolvedCreateDeferrals): ItemDeferredField[] | undefined {
  if (deferrals.fields.length === 0) return undefined;
  return normalizeDeferredFields(deferrals.fields.map((entry) => ({ field: entry.field, reason: deferrals.reason! })));
}

/**
 * Option keys a deferral removes from a template's defaults: like an explicit
 * unset, a deferral states that the value is not known, so a template value
 * must not fill it in. Malformed tokens are ignored here; the strict parse
 * refuses them afterwards.
 */
export function deferredTemplateOverrideKeys(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return values
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => value.split(","))
    .map((token) => resolveDeferrableItemField(token)?.option)
    .filter((option): option is DeferrableItemField["option"] => option !== undefined);
}
