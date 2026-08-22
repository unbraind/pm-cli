/**
 * @module cli/schema-registration-helpers
 *
 * Pure parsing and typo-detection helpers shared by schema command
 * registration and its focused contract tests.
 */
import {
  EXIT_CODE,
  PmCliError,
  isPureSnakeCaseAlias,
} from "../sdk/runtime-primitives.js";

const SCHEMA_SHORTHAND_RESERVED_PREFIXES = [
  "add-",
  "apply-",
  "list-",
  "remove-",
  "show-",
] as const;
const SCHEMA_SHORTHAND_RESERVED_TOKENS = new Set([
  "field",
  "fields",
  "help",
  "status",
  "statuses",
  "type",
  "types",
]);

/**
 * Return whether a token must remain on the schema-action refusal path.
 *
 * Bare custom-type shorthand is intentionally limited to PascalCase names.
 * Lowercase tokens occupy the action namespace, so a misspelling such as
 * `pm schema nonsense` cannot silently register a new type. Explicit
 * `pm schema add-type <name>` remains available for every valid type name.
 */
export function looksLikeSchemaSubcommandTypo(value: string): boolean {
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  return (
    trimmed[0] === normalized[0] ||
    SCHEMA_SHORTHAND_RESERVED_TOKENS.has(normalized) ||
    SCHEMA_SHORTHAND_RESERVED_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix),
    )
  );
}

/**
 * Parse the integer `--order` value accepted by `pm schema add-status`.
 *
 * Undefined and blank values remain absent, while explicitly invalid values
 * fail with the same usage error as other schema registration parsing.
 */
export function parseSchemaOrderOption(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) {
      throw new PmCliError(
        "--order must be a finite integer.",
        EXIT_CODE.USAGE,
      );
    }
    return raw;
  }
  if (typeof raw === "string") {
    if (raw.trim().length === 0) {
      return undefined;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) {
      throw new PmCliError(
        "--order must be a finite integer.",
        EXIT_CODE.USAGE,
      );
    }
    return parsed;
  }
  throw new PmCliError("--order must be a finite integer.", EXIT_CODE.USAGE);
}

export { isPureSnakeCaseAlias };
