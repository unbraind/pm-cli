/**
 * Helpers for deciding whether a CLI option alias is a pure snake_case
 * underscore-duplicate of an existing kebab-case flag.
 *
 * Mutation commands historically register every `--foo-bar` flag together with
 * a `--foo_bar` alias so agents are never blocked by a snake/kebab mismatch.
 * Those underscore duplicates roughly double the option list of every
 * `--help` and waste agent context. We keep them functional as parse-time
 * aliases but hide them from the rendered `--help` text.
 *
 * The rule is intentionally narrow: an alias is hidden ONLY when its long flag
 * is exactly the underscore form of an existing kebab flag (for example
 * `--create_mode` is the `-`→`_` form of `--create-mode`). Semantically-distinct
 * aliases (for example `--fail-on-warn` for `--strict-exit`, `--local` for
 * `--project`, `--ac` for `--acceptance-criteria`) are NOT snake duplicates and
 * stay visible.
 */

/**
 * Extract every long flag (for example `--create-mode`) from a commander flag
 * spec that may include short aliases and a value placeholder. A spec can list
 * more than one long flag, for example `"--estimate, --estimated-minutes
 * <value>"` → `["--estimate", "--estimated-minutes"]`.
 */
export function extractLongFlags(flagSpec: string): string[] {
  return flagSpec
    .split(/[\s,|]+/)
    .map((token) => token.trim())
    .filter((token) => token.startsWith("--"));
}

/**
 * Extract the first long flag from a commander flag spec, or null when none is
 * present.
 */
export function extractLongFlag(flagSpec: string): string | null {
  return extractLongFlags(flagSpec)[0] ?? null;
}

/**
 * Returns true when `aliasFlagSpec` differs from `canonicalFlagSpec` ONLY by
 * substituting one or more interior hyphens with underscores — i.e. it is a
 * pure snake_case underscore-duplicate of the canonical kebab flag.
 *
 * Examples that match (alias hidden):
 *   --create-mode            <- --create_mode
 *   --filter-assignee-filter <- --filter-assignee_filter
 *
 * Examples that do NOT match (alias stays visible):
 *   --acceptance-criteria    <- --ac      (different identifier)
 *   --order                  <- --rank    (different identifier)
 *   --strict-exit            <- --fail-on-warn (semantically distinct)
 */
export function isPureSnakeCaseAlias(canonicalFlagSpec: string, aliasFlagSpec: string): boolean {
  const aliasLong = extractLongFlag(aliasFlagSpec);
  if (aliasLong === null) {
    return false;
  }
  const normalize = (long: string): string => long.slice(2).replaceAll("-", "_");
  // The canonical spec may declare multiple long flags (e.g.
  // "--estimate, --estimated-minutes <value>"); the alias is hidden when it is
  // the underscore form of ANY of them.
  return extractLongFlags(canonicalFlagSpec).some((canonicalLong) => {
    if (!canonicalLong.slice(2).includes("-")) {
      // No interior hyphen to convert, so there is no kebab form to snake-duplicate.
      return false;
    }
    if (aliasLong === canonicalLong) {
      // Identical flags are not aliases of one another.
      return false;
    }
    // Reachable from the canonical purely by hyphen→underscore substitution.
    return normalize(aliasLong) === normalize(canonicalLong);
  });
}
