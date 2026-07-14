/**
 * @module cli/argv-utils
 *
 * Provides CLI runtime support for Argv Utils.
 */
/** Normalizes a raw long-option token into the canonical flag spelling used by CLI bootstrap parsing. */
export function normalizeLongFlag(flag: string): string {
  return `--${flag
    .replace(/^--?/, "")
    .replace(/_/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()}`;
}

/** Implements normalize long option flag for the public runtime surface of this module. */
export function normalizeLongOptionFlag(token: string): string | undefined {
  if (!token.startsWith("--")) {
    return undefined;
  }
  const key = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
  return normalizeLongFlag(key);
}

/** Implements extract provided option flags for the public runtime surface of this module. */
export function extractProvidedOptionFlags(argv: string[]): string[] {
  const provided = new Set<string>();
  const ordered: string[] = [];
  for (const token of argv) {
    const normalized = normalizeLongOptionFlag(token);
    if (normalized) {
      if (!provided.has(normalized)) {
        ordered.push(normalized);
      }
      provided.add(normalized);
    }
  }
  return ordered;
}

export { quoteCommandArg, renderPmCommand } from "../sdk/command-line.js";
