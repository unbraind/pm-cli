/**
 * @module sdk/item-metadata-index
 *
 * Exposes the rebuildable item-metadata index projection transaction used by
 * SDK hosts that commit authoritative item documents outside the stock CLI.
 * The lock may return a no-op release below
 * `DEFAULT_DERIVED_INDEX_MINIMUM_ITEMS` or when the manifest is absent. Hosts
 * must surface warning tokens returned by the refresh operation, including
 * invalid-path and refresh-failure diagnostics.
 */
export {
  acquireItemMetadataDerivedIndexLock,
  DEFAULT_DERIVED_INDEX_MINIMUM_ITEMS,
  readItemMetadataDerivedIndexState,
  refreshItemMetadataDerivedIndex,
  type ItemMetadataDerivedIndexState,
  type ItemMetadataDerivedIndexMutation,
} from "../core/store/item-metadata-cache.js";
export {
  queryItemMetadataIndex,
  type ItemMetadataIndexQuery,
  type ItemMetadataIndexQueryResult,
} from "../core/store/item-metadata-query-index.js";
