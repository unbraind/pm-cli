/**
 * @module sdk/lifecycle/structured-mutation-plan
 *
 * Plans one atomic mutation document against a live workspace: resolves the
 * declared schema, reads existing items for keyed upsert, derives a stable
 * transaction id when the caller omits one, and returns the resolved batch
 * ready for `previewItemMutations` or `commitItemMutations`.
 */
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import {
  normalizeRuntimeSchemaSettings,
  resolveRuntimeFieldRegistry,
} from "../../core/schema/runtime-schema.js";
import { loadGuardedRuntimeSchema } from "../item-transaction.js";
import { listAllItemMetadataLight } from "../../core/store/item-store.js";
import {
  isConfigurationOnlySettingsRead,
  readSettings,
} from "../../core/store/settings.js";
import type { ItemMetadata, ItemTypeDefinition, PmSettings } from "../../types/index.js";
import {
  deriveMutationTransactionId,
  resolveItemMutationDocument,
  type ItemMutationUpsertCandidate,
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
  /** Item field whose value identifies an existing item to update instead of creating. */
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

/** Schema facts the plan needs, hydrated the same way whether or not the host scoped settings reads to configuration only. */
interface PlanSchemaContext {
  /** Runtime schema with statuses, fields, and workflows merged from their files. */
  schema: PmSettings["schema"];
  /** Custom item types declared in the types file, when the settings read skipped hydration. */
  typeDefinitionsFromFile: ItemTypeDefinition[];
}

/**
 * Resolve the runtime schema for planning. A preview host may scope settings
 * reads to inline configuration only (no schema hydration, no scaffolding), in
 * which case declared custom fields and types live solely in their schema
 * files; load them through the transaction preview's guarded reader (no
 * symlinks, special files, or out-of-root paths are ever opened in place) so
 * document rows still route through declared fields and upsert still scans
 * custom-type folders.
 */
async function resolvePlanSchema(
  pmRoot: string,
  settings: PmSettings,
): Promise<PlanSchemaContext> {
  if (!isConfigurationOnlySettingsRead(pmRoot)) {
    return { schema: normalizeRuntimeSchemaSettings(settings.schema), typeDefinitionsFromFile: [] };
  }
  const loaded = await loadGuardedRuntimeSchema(pmRoot, settings.schema);
  return { schema: loaded.schema, typeDefinitionsFromFile: loaded.type_definitions_from_file ?? [] };
}

/** Read the upsert key value from existing item metadata, covering core and declared custom keys. */
function readExistingUpsertValue(item: ItemMetadata, key: string): unknown {
  return (item as unknown as Record<string, unknown>)[key];
}

/** Collect every existing item that carries a value for the upsert key. */
async function listUpsertCandidates(
  pmRoot: string,
  settings: PmSettings,
  planSchema: PlanSchemaContext,
  key: string,
): Promise<ItemMutationUpsertCandidate[]> {
  const typeRegistry = resolveItemTypeRegistry(
    {
      ...settings,
      item_types: {
        ...settings.item_types,
        definitions: [
          ...(settings.item_types?.definitions ?? []),
          ...planSchema.typeDefinitionsFromFile,
        ],
      },
    },
    getActiveExtensionRegistrations(),
  );
  const items = await listAllItemMetadataLight(
    pmRoot,
    settings.item_format,
    typeRegistry.type_to_folder,
    undefined,
    planSchema.schema,
  );
  return items.flatMap((item) => {
    const value = readExistingUpsertValue(item, key);
    return value == null ? [] : [{ id: item.id, value }];
  });
}

/**
 * Resolve a mutation document against the workspace. Reads happen before the
 * writer lock; the returned batch is deterministic for the same document,
 * schema, and existing items, so interrupted or repeated imports replay
 * through the transaction journal instead of duplicating work.
 */
export async function planItemMutationDocument(
  options: PlanItemMutationDocumentOptions,
): Promise<PlannedItemMutationDocument> {
  const settings = options.settings ?? (await readSettings(options.pmRoot));
  const explicit = options.transactionId?.trim() ?? "";
  const transactionId =
    explicit.length > 0 ? explicit : deriveMutationTransactionId(options.input);
  const planSchema = await resolvePlanSchema(options.pmRoot, settings);
  const upsertKey = options.upsertKey?.trim();
  const upsert =
    upsertKey === undefined || upsertKey.length === 0
      ? undefined
      : {
          key: upsertKey,
          existing: await listUpsertCandidates(options.pmRoot, settings, planSchema, upsertKey),
        };
  const resolved = resolveItemMutationDocument(options.input, {
    transactionId,
    idPrefix: settings.id_prefix,
    runtimeFields: resolveRuntimeFieldRegistry(planSchema.schema).definitions,
    ...(upsert === undefined ? {} : { upsert }),
  });
  return {
    ...resolved,
    transaction_id: transactionId,
    transaction_id_source: explicit.length > 0 ? "explicit" : "derived",
    ...(upsert === undefined ? {} : { upsert_key: upsert.key }),
  };
}
