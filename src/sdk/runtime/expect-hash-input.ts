/**
 * @module sdk/runtime/expect-hash-input
 *
 * Separates the `expectHash` precondition (pm-gh1576) from action arguments.
 * The strict tool schema declares it both at the top level and inside the
 * nested `options` object, so dispatch reads every placement: a guard supplied
 * in either place is enforced, never silently dropped.
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Return every supplied guard and the arguments with all placements removed.
 * One placement passes through unchanged (so its validation message names it
 * exactly); several are merged into one token list, so no placement is
 * dropped, and a conflicting hash for one id still refuses at binding with
 * `expected_revision_duplicate`. A supplied `null` counts as supplied, so
 * validation can refuse it.
 */
export function splitExpectHashInput(args: Record<string, unknown>): { expectHash: unknown; dispatchArgs: Record<string, unknown> } {
  const { expectHash, expect_hash: alias, ...rest } = args;
  const options = isPlainRecord(rest.options) ? rest.options : {};
  const { expectHash: nested, expect_hash: nestedAlias, ...nestedRest } = options;
  const supplied = [expectHash, alias, nested, nestedAlias].filter((candidate) => candidate !== undefined);
  const merged = supplied.length > 1 ? supplied.flatMap((candidate) => (Array.isArray(candidate) ? candidate : [candidate])) : supplied[0];
  return { expectHash: merged, dispatchArgs: "options" in rest ? { ...rest, options: isPlainRecord(rest.options) ? nestedRest : rest.options } : rest };
}
