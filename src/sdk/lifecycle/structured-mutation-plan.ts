/**
 * @module sdk/lifecycle/structured-mutation-plan
 *
 * Plans one atomic mutation document against a live workspace: resolves the
 * declared schema, reads existing items for keyed upsert, derives a stable
 * transaction id when the caller omits one, and returns the resolved batch
 * ready for `previewItemMutations` or `commitItemMutations`.
 */
import { resolveRuntimeFieldRegistry, runtimeFieldOptionTarget } from "../../core/schema/runtime-schema.js";
import { listUpsertKeyCandidates, previewItemMutations, resolveTransactionSchema, type ItemMutationPreviewValidation } from "../item-transaction.js";
import { readSettings } from "../../core/store/settings.js";
import { resolveCoreUpsertMetadataKey } from "./core-item-fields.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import type { PmSettings } from "../../types/index.js";
import {
  deriveMutationTransactionId,
  resolveItemMutationDocument,
  type ResolvedItemMutationDocument,
  type ResolvedItemMutationRow,
} from "../structured-mutations.js";

/** Inputs for planning one mutation document against a workspace. */
export interface PlanItemMutationDocumentOptions {
  /** Tracker root whose schema and items govern the plan. */
  pmRoot: string;
  /** Raw document text: JSON array, versioned envelope, single record, or JSON Lines. */
  input: string;
  /** Explicit stable transaction id; omitted ids derive from the document bytes. */
  transactionId?: string;
  /** Stored field key, declared field key or option target identifying existing items. Stored keys take precedence over aliases. */
  upsertKey?: string;
  /** Already-read settings, to avoid a second settings read on hot paths. */
  settings?: PmSettings;
}

/** Preview a resolved document and join lifecycle warnings to its source row indexes and aliases. */
export async function previewItemMutationDocument(options: {
  /** Tracker whose state and policy the disposable preview validates. */
  pmRoot: string;
  /** Actor used only within the disposable staged tracker. */
  author: string;
  /** SDK-resolved document with its transaction identity and ordered rows. */
  plan: PlannedItemMutationDocument;
}): Promise<{ validation: ItemMutationPreviewValidation; rows: ResolvedItemMutationRow[] }> {
  const { plan } = options;
  const validation = await previewItemMutations({ pmRoot: options.pmRoot, author: options.author, transactionId: plan.transaction_id, mutations: plan.mutations });
  const warnings = new Map(validation.warnings.map((entry) => [entry.index, entry.warnings]));
  const rows = plan.rows.map((row) => {
    const projected = { ...row };
    delete projected.warnings;
    const messages = warnings.get(row.index);
    if (messages !== undefined) projected.warnings = messages;
    return projected;
  });
  return { validation, rows };
}

/** Resolved plan plus the transaction identity the caller must reuse to resume. */
export interface PlannedItemMutationDocument extends ResolvedItemMutationDocument {
  /** Transaction id to pass to preview/commit; stable across replays of the same document. */
  transaction_id: string;
  /** Whether the transaction id came from the caller or was derived from the document. */
  transaction_id_source: "explicit" | "derived";
  /** Upsert key applied to create rows, when any. */
  upsert_key?: string;
}

/**
 * Resolve a mutation document against the workspace. Reads happen before the
 * writer lock; the returned batch is deterministic for the same document,
 * schema, and existing items, so interrupted or repeated imports replay
 * through the transaction journal instead of duplicating work. Create rows
 * left by keyed upsert carry a `unique` guard that the commit re-checks under
 * the lock, so a concurrent writer cannot slip a duplicate in after planning.
 */
export async function planItemMutationDocument(
  options: PlanItemMutationDocumentOptions,
): Promise<PlannedItemMutationDocument> {
  const suppliedKey = options.upsertKey?.trim();
  if (suppliedKey !== undefined && suppliedKey.length === 0) {
    throw new PmCliError("Upsert key must be a non-empty field name.", EXIT_CODE.USAGE);
  }
  const settings = options.settings ?? (await readSettings(options.pmRoot));
  const explicit = options.transactionId?.trim() ?? "";
  const transactionId =
    explicit.length > 0 ? explicit : deriveMutationTransactionId(options.input);
  const planSchema = await resolveTransactionSchema(options.pmRoot, settings);
  const runtimeFields = resolveRuntimeFieldRegistry(planSchema.schema).definitions;
  const declaredField = runtimeFields.find((field) => field.metadata_key === suppliedKey) ??
    runtimeFields.find((field) => field.key === suppliedKey || runtimeFieldOptionTarget(field) === suppliedKey);
  const upsertKey = declaredField?.metadata_key ?? resolveCoreUpsertMetadataKey(suppliedKey);
  const upsert =
    upsertKey === undefined
      ? undefined
      : {
          key: upsertKey,
          existing: await listUpsertKeyCandidates(options.pmRoot, settings, planSchema, upsertKey),
        };
  const resolved = resolveItemMutationDocument(options.input, {
    transactionId,
    idPrefix: settings.id_prefix,
    runtimeFields,
    ...(upsert === undefined ? {} : { upsert }),
  });
  return {
    ...resolved,
    transaction_id: transactionId,
    transaction_id_source: explicit.length > 0 ? "explicit" : "derived",
    ...(upsert === undefined ? {} : { upsert_key: upsert.key }),
  };
}
