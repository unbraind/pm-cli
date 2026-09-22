/**
 * @module cli/commands/workspace/merge
 *
 * Presentation compatibility shim for the public SDK tracker merge
 * primitives. The SDK owns the three-way merge semantics, the git merge
 * driver runner, and the repository merge-configuration installer.
 */
export {
  MERGE_DRIVER_ARTIFACT_VALUES,
  runMergeDriver,
  runMergeInstall,
  runMergeReceiptEvidenceReport,
  runMergeReconcile,
} from "../../../sdk/merge/index.js";
