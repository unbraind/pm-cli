/**
 * @module sdk/dependency-provenance
 *
 * Defines the public provenance contract for dependency seeds that reference
 * items outside the current workspace.
 */
import { normalizeItemId } from "../core/item/id.js";

/** Provenance value declaring that a dependency id belongs to another workspace. */
export const EXTERNAL_DEPENDENCY_SOURCE_KIND = "global";

/** Return whether a dependency provenance value identifies an external workspace target. */
export function isExternalDependencySourceKind(
  sourceKind: string | undefined,
): boolean {
  return sourceKind?.trim().toLowerCase() === EXTERNAL_DEPENDENCY_SOURCE_KIND;
}

/**
 * Normalize a dependency seed id without corrupting cross-workspace identity.
 * Local and legacy seeds retain normal workspace-prefix behavior; explicitly
 * global seeds preserve the caller-provided id verbatim (apart from trimming).
 */
export function normalizeDependencySeedId(
  id: string,
  prefix: string,
  sourceKind: string | undefined,
): string {
  const trimmed = id.trim();
  return isExternalDependencySourceKind(sourceKind)
    ? trimmed
    : normalizeItemId(trimmed, prefix);
}
