/**
 * @module cli/commands/linked-test-entry
 *
 * Implements the pm linked test entry command surface and its agent-facing runtime behavior.
 */
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";

// Keys accepted inside a structured linked-test entry. `cmd` is an alias for
// `command`; everything else maps 1:1 to a LinkedTest field.
/** Public contract for structured linked test keys, shared by SDK and presentation-layer consumers. */
export const STRUCTURED_LINKED_TEST_KEYS = [
  "command",
  "cmd",
  "path",
  "scope",
  "timeout",
  "timeout_seconds",
  "pm_context_mode",
  "env_set",
  "env_clear",
  "shared_host_safe",
  "assert_stdout_contains",
  "assert_stdout_regex",
  "assert_stderr_contains",
  "assert_stderr_regex",
  "assert_stdout_min_lines",
  "assert_json_field_equals",
  "assert_json_field_gte",
  "note",
] as const;

const STRUCTURED_LINKED_TEST_KEY_SET = new Set<string>(
  STRUCTURED_LINKED_TEST_KEYS,
);
const STRUCTURED_LINKED_TEST_KEY_PATTERN = STRUCTURED_LINKED_TEST_KEYS.map(
  (key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
).join("|");
const STRUCTURED_LINKED_TEST_ENTRY_PATTERN = new RegExp(
  `^(?:[-*+]\\s+)?(?:${STRUCTURED_LINKED_TEST_KEY_PATTERN})\\s*[:=]`,
  "i",
);

/** Implements looks like structured linked test entry for the public runtime surface of this module. */
export function looksLikeStructuredLinkedTestEntry(raw: string): boolean {
  if (raw.startsWith("```") || raw.includes("\n")) {
    return true;
  }
  return STRUCTURED_LINKED_TEST_ENTRY_PATTERN.test(raw);
}

/** Implements normalize structured linked test entry for the public runtime surface of this module. */
export function normalizeStructuredLinkedTestEntry(
  kv: Record<string, string>,
  optionName: "--add" | "--test",
): Record<string, string> {
  const normalizedKv: Record<string, string> = {};
  const unknownKeys: string[] = [];
  for (const [key, value] of Object.entries(kv)) {
    const normalizedKey = key.toLowerCase();
    if (!STRUCTURED_LINKED_TEST_KEY_SET.has(normalizedKey)) {
      unknownKeys.push(key);
      continue;
    }
    normalizedKv[normalizedKey] = value;
  }
  if (unknownKeys.length > 0) {
    throw new PmCliError(
      `${optionName} does not recognize key${unknownKeys.length > 1 ? "s" : ""} ${unknownKeys
        .map((key) => `"${key}"`)
        .join(", ")}. Allowed keys: ${STRUCTURED_LINKED_TEST_KEYS.join(", ")}.`,
      EXIT_CODE.USAGE,
    );
  }
  if (normalizedKv.cmd !== undefined) {
    if (
      normalizedKv.command !== undefined &&
      normalizedKv.command.trim() !== normalizedKv.cmd.trim()
    ) {
      throw new PmCliError(
        `${optionName} command and cmd must match when both are provided`,
        EXIT_CODE.USAGE,
      );
    }
    const { cmd, ...rest } = normalizedKv;
    return { ...rest, command: rest.command ?? cmd };
  }
  return normalizedKv;
}
