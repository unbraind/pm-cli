/**
 * @module sdk/merge
 *
 * Public SDK surface for multi-branch tracker merge semantics: field-aware
 * three-way merge primitives, the git merge-driver runner, and the repository
 * merge-configuration installer. The CLI `pm merge` command is a shim over
 * this module so packages and hosts can reuse the same merge behavior.
 */
export {
  ITEM_LATEST_TIMESTAMP_FIELDS,
  ITEM_UNION_COLLECTION_FIELDS,
  mergeHistoryStreams,
  mergeItemDocuments,
  mergeJsonDocuments,
  type HistoryMergeResult,
  type HistoryMergeStrategy,
  type ItemDocumentMergeResult,
  type JsonDocumentMergeResult,
  type MergePreferredSide,
} from "./three-way.js";
export {
  MERGE_DRIVER_ARTIFACT_VALUES,
  runMergeDriver,
  type MergeDriverArtifact,
  type MergeDriverOptions,
  type MergeDriverResult,
} from "./driver.js";
export {
  PM_GITATTRIBUTES_END,
  PM_GITATTRIBUTES_START,
  runMergeInstall,
  type MergeInstallOptions,
  type MergeInstallResult,
} from "./install.js";
