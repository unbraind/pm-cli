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

/** Preserve actionable usage refusals while certifying admission failed before linked-test writes. */
export function admitLinkedTestRequest<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (!(error instanceof PmCliError) || error.exitCode !== EXIT_CODE.USAGE) throw error;
    throw new PmCliError(`${error.message} No changes were made.`, EXIT_CODE.USAGE, {
      ...error.context, code: error.code === "linked_test_command_not_executable" ? error.code : "invalid_argument_value", reason: "test_option_invalid", changed: false,
      required: error.context.required ?? error.message,
    });
  }
}

/** Skip one quoted literal, declining command substitutions that may execute a real test. */
function quotedAssignmentValueEnd(input: string, start: number): number | undefined {
  if (input[start] === "'") {
    const closing = input.indexOf("'", start + 1);
    return closing < 0 ? undefined : closing + 1;
  }
  for (let offset = start + 1; offset < input.length; offset += 1) {
    if (input[offset] === '"') return offset + 1;
    if (input[offset] === "\\") {
      offset += 1;
      continue;
    }
    if (input[offset] === "`" || input.startsWith("$(", offset)) return undefined;
  }
  return undefined;
}

/** Scan one assignment value without expanding it or interpreting compound shell programs. */
function assignmentValueEnd(input: string, start: number): number | undefined {
  let offset = start;
  while (offset < input.length) {
    const character = input[offset];
    if (/\s/u.test(character)) return offset;
    if (character === "\\") {
      offset += 2;
      continue;
    }
    if (character === "'" || character === '"') {
      const end = quotedAssignmentValueEnd(input, offset);
      if (end === undefined) return undefined;
      offset = end;
      continue;
    }
    if (";&|<>()`".includes(character)) return undefined;
    offset += 1;
  }
  return offset === input.length ? offset : undefined;
}

/** Skip whitespace and shell comments between assignment words without swallowing later commands. */
function skipAssignmentTrivia(input: string, start: number): number {
  let offset = start;
  while (offset < input.length) {
    if (/\s/u.test(input[offset]!)) {
      offset += 1;
      continue;
    }
    if (input[offset] !== "#") return offset;
    const newline = input.indexOf("\n", offset);
    if (newline < 0) return input.length;
    offset = newline + 1;
  }
  return offset;
}

/** Recognize assignment/comment-only programs while preserving later-line executables. */
function isAssignmentOnlyCommand(command: string): boolean {
  const input = command.trim();
  let offset = skipAssignmentTrivia(input, 0);
  if (input.length === 0) return false;
  while (offset < input.length) {
    if (!/[A-Za-z_]/u.test(input[offset]!)) return false;
    let nameEnd = offset + 1;
    while (nameEnd < input.length && /[A-Za-z0-9_]/u.test(input[nameEnd]!)) nameEnd += 1;
    if (input[nameEnd] !== "=") return false;
    const end = assignmentValueEnd(input, nameEnd + 1);
    if (end === undefined) return false;
    offset = skipAssignmentTrivia(input, end);
  }
  return true;
}

/** Refuse commands consisting solely of assignments or comments before registration or execution. */
export function assertLinkedTestCommand(command: string | undefined): void {
  if (command === undefined || !isAssignmentOnlyCommand(command)) return;
  throw new PmCliError(
    "Linked-test command contains only variable assignments or comments and has no executable command.",
    EXIT_CODE.USAGE,
    {
      code: "linked_test_command_not_executable",
      required: 'Supply an actual test command with --add "command=<actual command>" or --add-json. Environment assignments may precede that command.',
      examples: ['pm test <id> --add "command=node --version"'],
      nextSteps: ["Remove any already-stored assignment-only entry with --remove-index, then register the actual test command."],
    },
  );
}

/** Refuse invalid command or tracker context before a linked-test mutation can persist it. */
export function assertLinkedTestContext(test: LinkedTest): void {
  assertLinkedTestCommand(test.command);
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
