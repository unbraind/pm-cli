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
export {
  runReindex,
  type ReindexOptions,
  type ReindexResult,
} from "./governance/reindex.js";
export * from "./governance/stale-work.js";
export * from "./governance/storage-integrity.js";
export * from "./governance/status-role-diagnostics.js";
export * from "./governance/workspace-position.js";
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
export * from "./author-attribution.js";
export * from "./mutation-guard.js";
export * from "./governance/provenance-health.js";
export * from "./similarity.js";
