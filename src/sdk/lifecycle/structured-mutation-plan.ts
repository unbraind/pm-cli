/**
 * @module sdk/lifecycle/structured-mutation-plan
 *
 * Plans one atomic mutation document against a live workspace: resolves the
 * declared schema, reads existing items for keyed upsert, derives a stable
 * transaction id when the caller omits one, and returns the resolved batch
 * ready for `previewItemMutations` or `commitItemMutations`.
 */
import { resolveRuntimeFieldRegistry, runtimeFieldOptionTarget } from "../../core/schema/runtime-schema.js";
import { listUpsertKeyCandidates, resolveTransactionSchema } from "../item-transaction.js";
import { readSettings } from "../../core/store/settings.js";
import type { PmSettings } from "../../types/index.js";
import {
  deriveMutationTransactionId,
  resolveItemMutationDocument,
  type ResolvedItemMutationDocument,
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
  const settings = options.settings ?? (await readSettings(options.pmRoot));
  const explicit = options.transactionId?.trim() ?? "";
  const transactionId =
    explicit.length > 0 ? explicit : deriveMutationTransactionId(options.input);
  const planSchema = await resolveTransactionSchema(options.pmRoot, settings);
  const runtimeFields = resolveRuntimeFieldRegistry(planSchema.schema).definitions;
  const suppliedKey = options.upsertKey?.trim();
  const declaredField = runtimeFields.find((field) => field.metadata_key === suppliedKey) ??
    runtimeFields.find((field) => field.key === suppliedKey || runtimeFieldOptionTarget(field) === suppliedKey);
  const upsertKey = declaredField?.metadata_key ??
    suppliedKey?.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
  const upsert =
    upsertKey === undefined || upsertKey.length === 0
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
