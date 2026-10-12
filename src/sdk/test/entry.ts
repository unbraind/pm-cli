/**
 * @module sdk/test/entry
 *
 * Implements the pm linked test entry command surface and its agent-facing runtime behavior.
 */
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { looksLikeStructuredKeyValueEntry } from "../../core/item/parse.js";
import type { LinkedTest } from "../../types/index.js";
import { renderPmCommand } from "../command-line.js";

/** Refuse an unbound tracker context before a linked-test mutation can persist it. */
export function assertLinkedTestContext(test: LinkedTest): void {
  if (test.pm_context_mode !== "none" ||
      test.workspace_context_mode === "isolated" ||
      test.workspace_context_mode === "snapshot") return;
  throw new PmCliError(
    "pm_context_mode=none requires workspace_context_mode=isolated or snapshot so implicit tracker discovery cannot reach the source workspace.",
    EXIT_CODE.USAGE,
    {
      code: "linked_test_context_invalid",
      required: "Set workspace_context_mode to isolated or snapshot when pm_context_mode is none.",
      examples: [renderPmCommand([
        "test", "<id>", "--add-json",
        JSON.stringify({ command: test.command, pm_context_mode: "none", workspace_context_mode: "isolated" }),
      ])],
    },
  );
}

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
  "workspace_context_mode",
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
/** Classify linked-test plaintext through the shared structured-entry grammar. */
export function looksLikeStructuredLinkedTestEntry(raw: string): boolean {
  return looksLikeStructuredKeyValueEntry(raw, STRUCTURED_LINKED_TEST_KEYS);
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
    if (Object.hasOwn(normalizedKv, normalizedKey)) {
      throw new PmCliError(
        `${optionName} provides key "${key}" more than once after case normalization`,
        EXIT_CODE.USAGE,
      );
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
