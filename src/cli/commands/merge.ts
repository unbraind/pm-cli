/**
 * @module cli/commands/merge
 *
 * Presentation compatibility shim for the public SDK tracker merge
 * primitives. The SDK owns the three-way merge semantics, the git merge
 * driver runner, and the repository merge-configuration installer.
 */
export {
  MERGE_DRIVER_ARTIFACT_VALUES,
  mergeHistoryStreams,
  mergeItemDocuments,
  mergeJsonDocuments,
  runMergeDriver,
  runMergeInstall,
  type MergeDriverArtifact,
  type MergeDriverOptions,
  type MergeDriverResult,
  type MergeInstallOptions,
  type MergeInstallResult,
} from "../../sdk/merge/index.js";
