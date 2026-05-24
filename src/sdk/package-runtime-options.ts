/**
 * Pure option-parsing helpers shared by bundled pm package runtimes.
 *
 * Bundled packages (pm-beads, pm-todos, pm-guide-shell, pm-governance-audit,
 * pm-linked-test-adapters, pm-search-advanced, ...) are standalone-installable
 * and may only depend on the public SDK runtime surface that they already load
 * via `PM_CLI_PACKAGE_ROOT`. These helpers are dependency-free string/boolean
 * coercion utilities; centralizing them here removes copy-pasted helper bodies
 * from each package runtime while staying on the SDK surface those packages are
 * permitted to import.
 */

const BOOLEAN_TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const BOOLEAN_FALSE_VALUES = new Set(["false", "0", "no", "off"]);

/**
 * Returns the first non-empty string value found for `key` or any alias.
 */
export function readStringOption(
  options: Record<string, unknown>,
  key: string,
  aliases: string[] = [],
): string | undefined {
  const keys = [key, ...aliases];
  for (const candidate of keys) {
    const value = options[candidate];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Coerces the first defined value found for `key` or any alias into a boolean.
 *
 * Accepts native booleans and the canonical truthy/falsy string literals; any
 * other value is ignored so a later alias can still match.
 */
export function readBooleanOption(
  options: Record<string, unknown>,
  key: string,
  aliases: string[] = [],
): boolean | undefined {
  const keys = [key, ...aliases];
  for (const candidate of keys) {
    const value = options[candidate];
    if (value === undefined) {
      continue;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (BOOLEAN_TRUE_VALUES.has(normalized)) {
        return true;
      }
      if (BOOLEAN_FALSE_VALUES.has(normalized)) {
        return false;
      }
    }
  }
  return undefined;
}

/**
 * Splits a comma-separated string option into trimmed, non-empty entries.
 */
export function readCsvListOption(
  options: Record<string, unknown>,
  key: string,
  aliases: string[] = [],
): string[] {
  const value = readStringOption(options, key, aliases);
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
