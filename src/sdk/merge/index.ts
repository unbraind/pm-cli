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
  mergeRelationshipEventStreams,
  type HistoryMergeResult,
  type HistoryMergeStrategy,
  type ItemDocumentMergeResult,
  type JsonDocumentMergeResult,
  type ItemMergeConflictDecision,
  type MergePreferredSide,
  type RelationshipStreamMergeResult,
} from "./three-way.js";
export {
  inspectMergeReceiptEvidence,
  listMergeReceipts,
  markMergeReceiptReconciled,
  runMergeReceiptEvidenceReport,
  runMergeReceiptReport,
  summarizeMergeReceipt,
  type MergeDecisionReceipt,
  type MergeDecisionReceiptSummary,
  type MergeReceiptEvidenceReport,
  type MergeReceiptEvidenceScan,
  type MergeReceiptReport,
} from "./receipts.js";
export {
  MERGE_DRIVER_ARTIFACT_VALUES,
  runMergeDriver,
  type MergeDriverArtifact,
  type MergeDriverOptions,
  type MergeDriverResult,
} from "./driver.js";
export {
  auditMergeAttributeFence,
  auditMergeDriverConfiguration,
  buildMergeAttributePatterns,
  findGitWorkspaceRoot,
  PM_GITATTRIBUTES_END,
  PM_GITATTRIBUTES_START,
  PM_GITATTRIBUTES_V2_END,
  PM_GITATTRIBUTES_V2_START,
  refreshMergeAttributeFenceIfInstalled,
  resolveMergeInstallContext,
  runMergeInstall,
  type MergeFenceAuditResult,
  type MergeDriverConfigurationAuditResult,
  type MergeFenceRefreshOutcome,
  type MergeInstallOptions,
  type MergeInstallContextResolution,
  type MergeInstallResult,
} from "./install.js";
export {
  runMergeReconcile,
  type MergeReconcileOptions,
  type MergeReconcileResult,
} from "./reconcile.js";
