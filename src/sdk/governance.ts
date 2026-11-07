/**
 * @module sdk/governance
 *
 * Provides validation, health, integrity, and mutation-policy primitives.
 */
export * from "./governance/gc.js";
export * from "./governance/health.js";
export * from "./governance/extension-host-version.js";
export * from "./governance/assurance.js";
export * from "./governance/assurance-action.js";
export * from "./governance/assurance-mutation-error.js";
export * from "./governance/assurance-presets.js";
export * from "./governance/assurance-runtime.js";
export * from "./governance/boundary-fixtures.js";
export * from "./governance/defect-recurrence.js";
export * from "./governance/defect-recurrence-coverage.js";
export {
  runReindex,
  type ReindexOptions,
  type ReindexResult,
} from "./governance/reindex.js";
export * from "./governance/stale-work.js";
export * from "./governance/storage-integrity.js";
export * from "./governance/status-role-diagnostics.js";
export * from "./governance/workspace-position.js";
export * from "./governance/workflow-policy.js";
export {
  runUpgrade,
  type UpgradeCliResult,
  type UpgradeCommandOptions,
  type UpgradeCommandRunner,
  type UpgradeCommandRunnerResult,
  type UpgradePackageResult,
  type UpgradeResult,
} from "./governance/upgrade.js";
export * from "./governance/validate.js";
export * from "./governance/closure-timestamps.js";
export * from "./governance/linked-file-report.js";
export * from "./author-attribution.js";
export * from "./mutation-guard.js";
export * from "./governance/provenance-health.js";
export * from "./governance/reliability.js";
export * from "./governance/artifact-ledgers.js";
export * from "./similarity.js";
export * from "./history/maintenance.js";
export * from "./history/attestation.js";
export * from "./history/attestation-command.js";
export * from "../core/history/digest.js";

// Types named by this entrypoint's exported function signatures, so consumers can import them (pm-gh1667).
export type { LoadedExtension } from "../core/extensions/extension-types.js";
export type { RuntimeStatusRegistry } from "../core/schema/runtime-schema.js";
export type { GlobalOptions } from "../core/shared/command-types.js";
export type { ValidateFixRecord } from "../core/validate/fix-planning.js";
export type { OwnerItemMetadata, StaleLinkOwnerInput } from "../core/validate/missing-link-owners.js";
export type { ClassifiedStaleLinkedPath } from "../core/validate/stale-file-classification.js";
export type { HistoryEntry, ItemDocument, ItemMetadata } from "../types.js";
export type { ValidateItem } from "./governance/validate-item-reader.js";
