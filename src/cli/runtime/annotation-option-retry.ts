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

/**
 * Locate every `<textFlag> <token>` or `<textFlag>=<token>` after the
 * annotation command's own token and before `--`. A pair before it was
 * consumed by a namespace parent (`pm item --add=--stdin comments ...`), where
 * the option alone would not dispatch the annotation command.
 */
function findSwallowingTokens(argv: readonly string[], commandIndex: number, collection: string, textFlag: string, token: string): SwallowingToken[] {
  const found: SwallowingToken[] = [];
  const leafIndex = argv.indexOf(collection, commandIndex);
  if (leafIndex < 0) return found;
  for (let index = leafIndex + 1; index < argv.length; index += 1) {
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
  const producerRetry = recovery!.suggested_retry_args!;
  const matches = findSwallowingTokens(argv, commandIndex, producerRetry[0]!, field, token);
  if (matches.length !== 1) return withdrawn;
  const { index, width } = matches[0]!;
  const retry = [...argv.slice(0, index), token, ...argv.slice(index + width)];
  return bindsAsProducerIntended(retry, index, field, token, producerRetry) ? { ...recovery, suggested_retry: renderPmCommand(retry), suggested_retry_args: retry } : withdrawn;
}

/**
 * Whether the rewritten argv binds the option the way the producer intended.
 * The producer's retry ends with the option and, for `--file`, the path it
 * reads: that operand must now follow the option, or dropping the text flag
 * moved a positional (`pm item comments --add --file pm-one pm-two` would
 * read the file `pm-one` into item `pm-two`). The text flag must not appear
 * again either: Commander kept only its last value, so an earlier `--add
 * hello` would become a second text source.
 */
function bindsAsProducerIntended(
  retry: readonly string[],
  index: number,
  field: string,
  token: string,
  producerRetry: readonly string[],
): boolean {
  const start = producerRetry.lastIndexOf(token);
  if (start < 0 || producerRetry.slice(start).some((entry, offset) => retry[index + offset] !== entry)) return false;
  return !retry.some((entry, position) => position !== index && (entry === field || entry.startsWith(`${field}=`)));
}
