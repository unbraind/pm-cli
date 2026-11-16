/**
 * @module cli/runtime/invocation-rewrites
 *
 * Bare `key=value` / `key:value` tokens the current CLI invocation promoted to
 * canonical flags before Commander parsed it. A refusal can then name the
 * rewrite and suggest an explicit flag instead of repeating the command the
 * caller just ran (GH-1741).
 */

/** One positional token the bootstrap normalizer promoted to a flag. */
export interface PromotedInvocationToken {
  /** The token exactly as the caller supplied it. */
  from: string;
  /** The canonical flag it became, such as `--doc`. */
  flag: string;
}

let currentPromotions: readonly PromotedInvocationToken[] = [];

/** Record the current invocation's bare-key promotions; each invocation replaces the previous record. */
export function recordInvocationPromotions(trace: ReadonlyArray<{ from: unknown; to: unknown; reason: string }>): void {
  currentPromotions = trace.flatMap((event) =>
    event.reason === "bare_key_value" && typeof event.from === "string" && Array.isArray(event.to) && typeof event.to[0] === "string"
      ? [{ from: event.from, flag: event.to[0].split("=")[0]! }]
      : []);
}

/** The bare-key promotions of the current invocation, empty outside a CLI invocation. */
export function currentInvocationPromotions(): readonly PromotedInvocationToken[] {
  return currentPromotions;
}
