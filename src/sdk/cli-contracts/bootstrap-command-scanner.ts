/**
 * @module sdk/cli-contracts/bootstrap-command-scanner
 *
 * Resolves command position from shell-free argv without loading CLI runtime
 * normalization, error, filesystem, or item-addressing dependencies.
 */

/** Global options that consume a following value when one is present. */
export const GLOBAL_VALUE_CONSUMING_FLAGS = new Set<string>([
  "--pm-path",
  "--path",
  "--author",
  "--output-include",
  "--output-limit",
  "--output-budget",
  "--output-format",
  "--output-session",
  "--output-cursor",
]);

/** Boolean global options ignored while locating the command token. */
export const BOOTSTRAP_BOOLEAN_FLAGS = new Set([
  "--no-extensions",
  "--no-pager",
  "--json",
  "--quiet",
  "--lean",
  "--token-accounting",
  "--output-row-contract",
  "--all",
]);

/** Whether a global value-consuming flag uses its inline `--flag=value` form. */
export function isInlineGlobalValueToken(token: string): boolean {
  const equalsIndex = token.indexOf("=");
  return (
    equalsIndex > 0 &&
    GLOBAL_VALUE_CONSUMING_FLAGS.has(token.slice(0, equalsIndex))
  );
}

/** Whether a bootstrap value flag consumes its following token. */
export function consumesBootstrapValue(
  flag: string,
  next: string | undefined,
): boolean {
  if (typeof next !== "string") return false;
  return flag === "--path" || flag === "--pm-path" || !next.startsWith("-");
}

/**
 * Locate the first command token after global flags and their values.
 *
 * A leading `--` terminates command discovery. Unknown flags are ignored so
 * later command-specific validation can return the canonical diagnostic.
 */
export function findBootstrapCommandTokenIndex(
  argv: readonly string[],
): number | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      return undefined;
    }
    if (GLOBAL_VALUE_CONSUMING_FLAGS.has(token)) {
      index += consumesBootstrapValue(token, argv[index + 1]) ? 1 : 0;
      continue;
    }
    if (
      isInlineGlobalValueToken(token) ||
      BOOTSTRAP_BOOLEAN_FLAGS.has(token) ||
      token === "--profile" ||
      token === "--id-only" ||
      token === "--explain"
    ) {
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return index;
  }
  return undefined;
}

/** Resolve the normalized command name from shell-free invocation arguments. */
export function parseBootstrapCommandName(
  argv: readonly string[],
): string | undefined {
  const index = findBootstrapCommandTokenIndex(argv);
  return index === undefined ? undefined : argv[index].trim().toLowerCase();
}
