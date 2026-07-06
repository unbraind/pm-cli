/**
 * @module sdk/workspace-contracts-cache
 *
 * Maintains the workspace contracts extension-registration memo used by runtime callers.
 */
import type { ExtensionRegistrationRegistry } from "../core/extensions/index.js";

const WORKSPACE_CONTRACTS_CACHE_LIMIT = 50;
const workspaceExtensionRegistrationsCache = new Map<string, Promise<ExtensionRegistrationRegistry | null>>();

/**
 * Drop all memoized workspace extension registrations so the next
 * `getWorkspaceContracts` call re-loads and re-activates extensions from disk.
 * Long-lived hosts should call this after any extension or settings mutation.
 */
export function clearWorkspaceContractsCache(): void {
  workspaceExtensionRegistrationsCache.clear();
}

/**
 * Memoize one workspace extension-registration load and evict rejected entries
 * so transient activation failures do not poison long-lived embedding hosts.
 */
export function memoizeWorkspaceExtensionRegistrations(
  cacheKey: string,
  loadRegistrations: () => Promise<ExtensionRegistrationRegistry | null>,
): Promise<ExtensionRegistrationRegistry | null> {
  const cached = workspaceExtensionRegistrationsCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  if (workspaceExtensionRegistrationsCache.size >= WORKSPACE_CONTRACTS_CACHE_LIMIT) {
    const oldestKey = workspaceExtensionRegistrationsCache.keys().next().value!;
    workspaceExtensionRegistrationsCache.delete(oldestKey);
  }
  const registrations = loadRegistrations().catch((error: unknown) => {
    if (workspaceExtensionRegistrationsCache.get(cacheKey) === registrations) {
      workspaceExtensionRegistrationsCache.delete(cacheKey);
    }
    throw error;
  });
  workspaceExtensionRegistrationsCache.set(cacheKey, registrations);
  return registrations;
}
