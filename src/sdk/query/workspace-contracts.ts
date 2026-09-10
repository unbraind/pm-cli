/**
 * @module sdk/query/workspace-contracts
 *
 * Loads live workspace customization contracts with cached extension registrations.
 * Extracted for pm-eq4x to keep public client dispatch separate from schema discovery.
 */
import path from "node:path";
import { activateExtensions, deactivateExtensions, loadExtensions, type ExtensionRegistrationRegistry } from "../../core/extensions/index.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { resolveRuntimeFieldRegistry, resolveRuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { readSettings } from "../../core/store/settings.js";
import type { WorkspaceContracts, WorkspaceContractsOptions } from "../runtime-public-contracts.js";
import { buildWorkspaceExtensionCommandContracts, buildWorkspaceFieldContracts } from "../workspace-contracts.js";
import { memoizeWorkspaceExtensionRegistrations } from "../workspace-contracts-cache.js";

/**
 * Process-lifetime memo of activated extension registrations, keyed by resolved
 * pm root + cwd + extension settings. `getWorkspaceContracts` is frequently
 * called by importers and package runtimes that cannot thread a registry
 * through; without the memo each call re-discovers, re-imports, and re-activates
 * every extension.
 *
 * Invalidation story: entries are size-bounded and otherwise live until cleared.
 * One-shot CLI processes are trivially correct. Long-lived hosts (e.g. the MCP
 * server) must either pass `options.extensionRegistrations` (which bypasses the
 * memo) or call {@link clearWorkspaceContractsCache} after installing/removing/
 * toggling extensions or editing settings. Settings themselves are re-read on
 * every call — only the extension load+activate step is memoized.
 */
function buildWorkspaceExtensionRegistrationsCacheKey(
  pmRoot: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  cwd?: string,
): string {
  return JSON.stringify([
    path.resolve(pmRoot),
    path.resolve(cwd ?? process.cwd()),
    settings.extensions.enabled,
    settings.extensions.disabled,
    settings.extensions.policy,
  ]);
}

/** Reuse cached activation results for the exact workspace and extension settings. */
async function resolveWorkspaceExtensionRegistrations(
  pmRoot: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  cwd?: string,
): Promise<ExtensionRegistrationRegistry | null> {
  const cacheKey = buildWorkspaceExtensionRegistrationsCacheKey(
    pmRoot,
    settings,
    cwd,
  );
  return memoizeWorkspaceExtensionRegistrations(cacheKey, () =>
    loadWorkspaceExtensionRegistrations(pmRoot, settings, cwd),
  );
}

/** Read current types, statuses, fields, and activated extension commands for a workspace. */
export async function getWorkspaceContracts(
  pmRoot: string,
  options: WorkspaceContractsOptions = {},
): Promise<WorkspaceContracts> {
  const settings = await readSettings(pmRoot);
  const extensionRegistrations =
    options.extensionRegistrations ??
    (options.noExtensions === true
      ? null
      : await resolveWorkspaceExtensionRegistrations(
          pmRoot,
          settings,
          options.cwd,
        ));
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    extensionRegistrations,
  );
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const fieldRegistry = resolveRuntimeFieldRegistry(settings.schema);

  return {
    types: [...typeRegistry.types],
    statuses: statusRegistry.definitions.map((definition) => definition.id),
    openStatus: statusRegistry.open_status,
    closeStatus: statusRegistry.close_status,
    canceledStatus: statusRegistry.canceled_status,
    fields: buildWorkspaceFieldContracts(fieldRegistry.definitions),
    extensionCommands: buildWorkspaceExtensionCommandContracts(
      extensionRegistrations?.commands ?? [],
    ),
  };
}

/** Load and activate registrations, always attempting extension resource cleanup. */
async function loadWorkspaceExtensionRegistrations(
  pmRoot: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  cwd?: string,
): Promise<ExtensionRegistrationRegistry | null> {
  const loadResult = await loadExtensions({
    pmRoot,
    settings,
    cwd: cwd ?? process.cwd(),
    noExtensions: false,
  });
  const activationResult = await activateExtensions(loadResult);
  try {
    return activationResult.registrations;
  } finally {
    try {
      await deactivateExtensions(loadResult, activationResult);
    } catch {
      // Workspace contract reads should stay best-effort even if teardown itself fails.
    }
  }
}
