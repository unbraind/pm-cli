/**
 * @module core/item/dependency-reference
 *
 * Classifies dependency locators that intentionally resolve outside the local
 * tracker so scheduling and graph governance do not confuse them with typos.
 */

/** Return whether a dependency target is an explicit cross-system locator rather than a local pm item id. */
export function isExternalDependencyReference(
  target: string | undefined,
): boolean {
  const normalized = target?.trim() ?? "";
  return (
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(normalized) ||
    /^(?:github|gitlab|jira|linear):/iu.test(normalized)
  );
}

/** Return whether dependency provenance explicitly places a target outside the local workspace. */
export function isExternalDependencySourceKind(
  sourceKind: string | undefined,
): boolean {
  const normalized = sourceKind?.trim().toLowerCase();
  return normalized === "global" || normalized === "external";
}
