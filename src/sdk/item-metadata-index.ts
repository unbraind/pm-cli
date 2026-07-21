/**
 * @module sdk/item-metadata-index
 *
 * Exposes the rebuildable item-metadata index projection transaction used by
 * SDK hosts that commit authoritative item documents outside the stock CLI.
 */
export {
  acquireItemMetadataDerivedIndexLock,
  refreshItemMetadataDerivedIndex,
  type ItemMetadataDerivedIndexMutation,
} from "../core/store/item-metadata-cache.js";
