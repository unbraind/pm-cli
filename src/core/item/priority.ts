import { PmCliError } from "../shared/errors.js";
import { EXIT_CODE } from "../shared/constants.js";

export type Priority = 0 | 1 | 2 | 3 | 4;

/**
 * Canonical mapping from named priority levels to numeric values. Agents and
 * humans frequently write words ("high") instead of numbers, so both create and
 * update accept either form. This single map is the source of truth so the two
 * commands cannot drift apart.
 */
export const PRIORITY_NAME_TO_VALUE: Readonly<Record<string, Priority>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  minimal: 4,
};

const PRIORITY_NAME_LIST = Object.keys(PRIORITY_NAME_TO_VALUE);

/**
 * Human-readable description of every accepted priority form. Reused in error
 * messages so the wording stays consistent across commands.
 */
export const PRIORITY_ACCEPTED_FORMS_HINT =
  "numbers 0..4 (0=critical, 1=high, 2=medium, 3=low, 4=minimal) or names " +
  `(${PRIORITY_NAME_LIST.join(", ")}), case-insensitive`;

function priorityUsageError(raw: string): PmCliError {
  return new PmCliError(
    `Invalid priority "${raw}". Accepted values: ${PRIORITY_ACCEPTED_FORMS_HINT}.`,
    EXIT_CODE.USAGE,
  );
}

/**
 * Resolve a raw `--priority` option value to a numeric 0..4 priority.
 *
 * Accepts:
 *   - numeric strings 0,1,2,3,4 (unchanged from prior behavior)
 *   - named levels (critical/high/medium/low/minimal), case-insensitive
 *   - native numbers 0..4 (arrives via MCP tool calls that JSON-encode priority as a number)
 *
 * Throws a USAGE error listing BOTH accepted forms for anything else.
 */
export function resolvePriority(raw: string | number): Priority {
  if (typeof raw === "number") {
    if (Number.isInteger(raw) && raw >= 0 && raw <= 4) {
      return raw as Priority;
    }
    throw priorityUsageError(String(raw));
  }
  if (typeof raw !== "string") {
    throw priorityUsageError(String(raw));
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw priorityUsageError(raw);
  }

  const normalizedName = trimmed.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PRIORITY_NAME_TO_VALUE, normalizedName)) {
    return PRIORITY_NAME_TO_VALUE[normalizedName as keyof typeof PRIORITY_NAME_TO_VALUE];
  }

  // Numeric form: only exact integers 0..4 are valid. Number() would accept
  // forms like "1.0" or " 2 ", but we already trimmed and require an integer
  // match so the contract stays tight.
  if (/^[0-4]$/.test(trimmed)) {
    return Number(trimmed) as Priority;
  }

  throw priorityUsageError(raw);
}
