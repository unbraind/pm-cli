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
 * Return the supplied guard (top level first, then nested; `expectHash` before
 * `expect_hash`) and the arguments with every placement removed. A supplied
 * `null` counts as supplied, so validation can refuse it.
 */
export function splitExpectHashInput(args: Record<string, unknown>): { expectHash: unknown; dispatchArgs: Record<string, unknown> } {
  const { expectHash, expect_hash: alias, ...rest } = args;
  const options = isPlainRecord(rest.options) ? rest.options : {};
  const { expectHash: nested, expect_hash: nestedAlias, ...nestedRest } = options;
  const supplied = [expectHash, alias, nested, nestedAlias].find((candidate) => candidate !== undefined);
  return { expectHash: supplied, dispatchArgs: "options" in rest ? { ...rest, options: isPlainRecord(rest.options) ? nestedRest : rest.options } : rest };
}
