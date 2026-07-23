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

/** Return whether a shorthand token resembles a misspelled schema subcommand. */
export function looksLikeSchemaSubcommandTypo(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  return (
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
