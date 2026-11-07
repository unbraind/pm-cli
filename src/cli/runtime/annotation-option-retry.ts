/**
 * @module cli/runtime/annotation-option-retry
 *
 * Turns an annotation refusal for a swallowed source option (`pm comments <id>
 * --add --file note.md`, pm-y26mvc) into the caller's own invocation without
 * the text flag that took the option as its value. Removing that one token is
 * the whole repair: tracker scope, output controls, `--author`, `--message`
 * and every other typed token stay where they were, so the retry cannot
 * disagree with the parser about which token belongs to which option.
 */
import type { PmCliErrorRecoveryPayload } from "../../sdk/runtime-primitives.js";
import { ANNOTATION_FLAG_LIKE_VALUE_CODE } from "../../sdk/annotations.js";
import { findBootstrapCommandTokenIndex } from "../../sdk/cli-bootstrap.js";
import { renderPmCommand } from "../argv-utils.js";

/** Refusal whose retry this module owns: message-text inference must never rebuild one it withdrew. */
export const ANNOTATION_OPTION_REFUSAL_CODE = ANNOTATION_FLAG_LIKE_VALUE_CODE;

/** One typed spelling of the text flag followed by the swallowed option. */
interface SwallowingToken {
  /** Index of the text flag token. */
  index: number;
  /** Tokens the pair occupies: `--add --file` is 2, `--add=--file` is 1. */
  width: 1 | 2;
}

/** Locate every `<textFlag> <token>` or `<textFlag>=<token>` after the command token and before `--`. */
function findSwallowingTokens(argv: readonly string[], commandIndex: number, textFlag: string, token: string): SwallowingToken[] {
  const found: SwallowingToken[] = [];
  for (let index = commandIndex + 1; index < argv.length; index += 1) {
    const current = argv[index]!;
    if (current === "--") break;
    if (current === `${textFlag}=${token}`) {
      found.push({ index, width: 1 });
    } else if (current === textFlag && argv[index + 1] === token) {
      found.push({ index, width: 2 });
      index += 1;
    }
  }
  return found;
}

/**
 * Rewrite a swallowed-option refusal's retry as the caller's invocation with
 * the text flag removed. The producer offers a retry only when dropping the
 * flag leaves exactly one text source; it names the text flag as `field` and
 * the swallowed option as the first suggested flag. When the typed argv does
 * not hold exactly one such pair, the retry is withdrawn rather than replaced
 * by the producer's shorter command, which would drop the caller's options.
 */
export function repairAnnotationOptionRecovery(
  argv: readonly string[],
  code: string | undefined,
  field: string | undefined,
  recovery: PmCliErrorRecoveryPayload | undefined,
): PmCliErrorRecoveryPayload | undefined {
  const token = recovery?.suggested_flags?.[0];
  if (code !== ANNOTATION_OPTION_REFUSAL_CODE || field === undefined || token === undefined || recovery!.suggested_retry_args === undefined) return recovery;
  const withdrawn = { ...recovery, suggested_retry: undefined, suggested_retry_args: undefined };
  const commandIndex = findBootstrapCommandTokenIndex([...argv]);
  if (commandIndex === undefined) return withdrawn;
  const matches = findSwallowingTokens(argv, commandIndex, field, token);
  if (matches.length !== 1) return withdrawn;
  const { index, width } = matches[0]!;
  const retry = [...argv.slice(0, index), token, ...argv.slice(index + width)];
  return { ...recovery, suggested_retry: renderPmCommand(retry), suggested_retry_args: retry };
}
