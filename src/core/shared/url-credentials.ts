/**
 * @module core/shared/url-credentials
 * One conservative URL-userinfo redactor for every outbound surface: CLI
 * refusal envelopes, telemetry events and Sentry payloads (pm-nhauur,
 * pm-5htunt).
 */
import { quoteWindowsCommandArg } from "./command-line.js";

/** Written where a possible userinfo span was removed. */
export const URL_CREDENTIAL_PLACEHOLDER = "[redacted]";

/** Start and end (exclusive, at the last `@`) of a token's possible userinfo span. */
function userinfoBounds(token: string): readonly [start: number, end: number] | undefined {
  const at = token.lastIndexOf("@");
  const colon = token.indexOf(":");
  if (at < 0 || colon < 0 || colon > at) return undefined;
  let start = colon + 1;
  while (start < at && (token[start] === "/" || token[start] === "\\")) start += 1;
  return start === at ? undefined : [start, at];
}

/**
 * Remove every span of one token that could be URL userinfo. Any URL a parser
 * accepts has a `:` after its scheme, and userinfo always ends at an `@`, so
 * userinfo lies inside the span between the token's first `:` and its last
 * `@`. Replacing that whole span (after any scheme slashes) is complete for
 * every spelling a parser normalizes: backslash authorities, tabs inside a
 * scheme, wrapper chains such as `git+https:` or `npm:`, inline `--flag=value`
 * tokens and single-label or `host:port` authorities. The cost is
 * deliberate: a scoped package name or an `@mention` after a colon is hidden
 * too. The rule is idempotent.
 */
export function redactUrlCredentialsInToken(token: string): string {
  const bounds = userinfoBounds(token);
  return bounds ? `${token.slice(0, bounds[0])}${URL_CREDENTIAL_PLACEHOLDER}${token.slice(bounds[1])}` : token;
}

/** Shorter whitespace-bearing spans are left to the word rule; matching them as text would erase ordinary words. */
const MIN_REGISTERED_SPAN_LENGTH = 4;
/** Beyond this many spans the text rule falls back to its whole-string form instead of scanning each span. */
const MAX_REGISTERED_SPANS = 32;

interface InvocationCredentials {
  carried: boolean;
  /** Case-insensitive alternation of every registered span and its shell-escaped spellings, longest first. */
  pattern: RegExp | undefined;
  overflow: boolean;
}

let invocation: InvocationCredentials = { carried: false, pattern: undefined, overflow: false };

/**
 * Record the running invocation's URL userinfo. A host process runs one
 * invocation at a time, and each registration replaces the last. A span that
 * contains whitespace splits into several words, which the word rule cannot
 * reassemble, so the text rule also removes each such span, case-insensitively
 * and in both shells' escaping, wherever a producer echoed it.
 */
export function registerUrlCredentialInvocation(argv: readonly string[]): void {
  const spans = new Set<string>();
  let carried = false;
  for (const token of argv) {
    const bounds = userinfoBounds(token);
    if (!bounds) continue;
    carried = true;
    const span = token.slice(bounds[0], bounds[1]);
    // The word rule already removes a whitespace-free span in every word layout.
    if (span.length < MIN_REGISTERED_SPAN_LENGTH || !/\s/u.test(span)) continue;
    // Both shells' escaping of a span that a non-quote, non-final character follows.
    for (const spelling of [span, span.replaceAll(/(["\\$`])/gu, "\\$1"), quoteWindowsCommandArg(`${span}@`).slice(1, -2)]) {
      spans.add(spelling);
    }
  }
  const overflow = spans.size > MAX_REGISTERED_SPANS;
  const ordered = [...spans].sort((left, right) => right.length - left.length);
  const pattern = overflow || ordered.length === 0
    ? undefined
    : new RegExp(ordered.map((spelling) => spelling.replaceAll(/[\\^$.*+?()[\]{}|/-]/gu, "\\$&")).join("|"), "gi");
  invocation = { carried, pattern, overflow };
}

/** Whether the registered invocation carried any possible URL userinfo. */
export function invocationCarriesUrlCredentials(): boolean {
  return invocation.carried;
}

/**
 * Apply {@link redactUrlCredentialsInToken} to every whitespace-delimited word
 * of free text, after removing the registered invocation's spans. When more
 * spans were registered than the bounded scan allows, any text with a `:`
 * before an `@` loses the whole span between its first `:` and last `@`,
 * which over-redacts but cannot miss one.
 */
export function redactUrlCredentialsInText(text: string): string {
  let redacted = text;
  if (invocation.overflow) {
    const bounds = userinfoBounds(redacted);
    if (bounds) redacted = `${redacted.slice(0, bounds[0])}${URL_CREDENTIAL_PLACEHOLDER}${redacted.slice(bounds[1])}`;
  } else if (invocation.pattern) {
    // A replacer function keeps `$` sequences in the placeholder literal.
    redacted = redacted.replace(invocation.pattern, () => URL_CREDENTIAL_PLACEHOLDER);
  }
  return redacted.includes("@") ? redacted.replaceAll(/\S+/gu, redactUrlCredentialsInToken) : redacted;
}
