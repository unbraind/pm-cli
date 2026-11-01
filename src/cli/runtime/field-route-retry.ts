/**
 * @module cli/runtime/field-route-retry
 *
 * Turns a refused `--field <key>=<value>` assignment for a project-schema key
 * into the executable retry that uses the key's declared flag (pm-wftvem). The
 * repair is a minimal edit of the caller's own invocation: every other token,
 * including tracker scope and output controls, stays where it was.
 */
import type { PmCliErrorRecoveryPayload } from "../../sdk/runtime-primitives.js";
import { renderPmCommand } from "../argv-utils.js";

const SCHEMA_FIELD_REFUSAL_CODE = "project_schema_field_requires_declared_flag";

/** One `--field` assignment located in the invocation. */
interface FieldAssignmentToken {
  /** Index of the `--field` (or `--field=...`) token. */
  index: number;
  /** Number of argv tokens the assignment occupies. */
  width: 1 | 2;
  /** Raw `key=value` assignment text. */
  assignment: string;
}

/** Locate `--field` assignments before any `--` terminator. */
function findFieldAssignments(argv: readonly string[]): FieldAssignmentToken[] {
  const found: FieldAssignmentToken[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") break;
    if (token.startsWith("--field=")) {
      found.push({ index, width: 1, assignment: token.slice("--field=".length) });
    } else if (token === "--field" && index + 1 < argv.length) {
      found.push({ index, width: 2, assignment: argv[index + 1]! });
      index += 1;
    }
  }
  return found;
}

/**
 * Attach an executable retry to a project-schema field refusal when exactly
 * one `--field` assignment names the refused key; otherwise keep the
 * producer's recovery unchanged rather than guess.
 */
export function repairSchemaFieldRecovery(
  argv: readonly string[],
  code: string | undefined,
  field: string | undefined,
  recovery: PmCliErrorRecoveryPayload | undefined,
): PmCliErrorRecoveryPayload | undefined {
  const flag = recovery?.suggested_flags?.[0];
  if (code !== SCHEMA_FIELD_REFUSAL_CODE || field === undefined || flag === undefined) return recovery;
  const matches = findFieldAssignments(argv).filter(
    ({ assignment }) => assignment.split("=", 1)[0]!.trim() === field && assignment.includes("="),
  );
  if (matches.length !== 1) return recovery;
  const [match] = matches;
  const value = match!.assignment.slice(match!.assignment.indexOf("=") + 1);
  const corrected = [
    ...argv.slice(0, match!.index),
    flag,
    value,
    ...argv.slice(match!.index + match!.width),
  ];
  return { ...recovery, suggested_retry: renderPmCommand(corrected), suggested_retry_args: corrected };
}
