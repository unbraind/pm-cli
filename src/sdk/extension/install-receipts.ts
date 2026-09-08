/** @module sdk/extension/install-receipts Summarizes bundled install outcomes without repeating full package diagnostics. */
import type { ExtensionCommandResult } from "../extension.js";

/** Preserve per-package evidence while distinguishing planned and completed bundled installs. */
export function buildBundledInstallReceipt(
  packages: ReadonlyArray<{ alias: string; result: ExtensionCommandResult }>,
  dryRun: boolean,
): Record<string, unknown> {
  const succeeded = packages.filter((entry) => entry.result.ok).length;
  return {
    installed_all: !dryRun && succeeded === packages.length,
    installed_count: dryRun ? 0 : succeeded,
    ...(dryRun ? { dry_run: true, planned_count: succeeded } : {}),
    failed_count: packages.length - succeeded,
    packages: packages.map(({ alias, result }) => {
      const details = result.details;
      return {
        alias,
        ok: result.ok,
        extension: details.extension,
        source: details.source,
        source_resolution: details.source_resolution,
        install_plan: details.install_plan,
        dry_run: details.dry_run,
        destination_path: details.destination_path,
        activated: details.activated,
        settings_changed: details.settings_changed,
        command_paths: details.command_paths,
        action_paths: details.action_paths,
        command_discovery: details.command_discovery,
        verification: details.verification,
        runtime_activation_status: details.runtime_activation_status,
        activation_diagnostics: details.activation_diagnostics,
        warnings: result.warnings,
      };
    }),
  };
}
