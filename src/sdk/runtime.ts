export {
  getActiveExtensionRegistrations,
  runActiveOnReadHooks,
  runActiveOnWriteHooks,
} from "../core/extensions/index.js";
export { pathExists, removeFileIfExists, writeFileAtomic } from "../core/fs/fs-utils.js";
export { appendHistoryEntry, createHistoryEntry } from "../core/history/history.js";
export { generateItemId, normalizeItemId, normalizeRawItemId } from "../core/item/id.js";
export {
  canonicalDocument,
  normalizeFrontMatter,
  serializeItemDocument,
  splitFrontMatter,
} from "../core/item/item-format.js";
export { parseTags } from "../core/item/parse.js";
export { normalizeStatusInput } from "../core/item/status.js";
export { resolveItemTypeRegistry } from "../core/item/type-registry.js";
export { acquireLock } from "../core/lock/lock.js";
export { EXIT_CODE } from "../core/shared/constants.js";
export { PmCliError } from "../core/shared/errors.js";
export { isTimestampLiteral, nowIso } from "../core/shared/time.js";
export { listAllFrontMatter, locateItem, readLocatedItem } from "../core/store/item-store.js";
export { getHistoryPath, getItemPath, getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
export { readSettings } from "../core/store/settings.js";
export {
  CONFIDENCE_TEXT_VALUES,
  DEPENDENCY_KIND_VALUES,
  ISSUE_SEVERITY_VALUES,
  RISK_VALUES,
} from "../types/index.js";
export type { GlobalOptions } from "../core/shared/command-types.js";
export type {
  Dependency,
  ItemDocument,
  ItemMetadata,
  ItemStatus,
  ItemType,
  LinkedDoc,
  LinkedFile,
  LinkedTest,
  LogNote,
  PmSettings,
} from "../types/index.js";
