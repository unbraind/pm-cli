/**
 * @module core/shared/url-credentials
 * One conservative URL-userinfo redactor for every outbound surface: CLI
 * refusal envelopes, telemetry events and Sentry payloads (pm-nhauur,
 * pm-5htunt).
 */
import { AsyncLocalStorage } from "node:async_hooks";
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

/** Beyond this many spellings the text rule falls back to its whole-string form instead of scanning each one. */
const MAX_REGISTERED_SPELLINGS = 32;

interface InvocationCredentials {
  carried: boolean;
  /** Case-insensitive alternation of every registered span and its escaped spellings, longest first. */
  pattern: RegExp | undefined;
  overflow: boolean;
}

const NO_INVOCATION: InvocationCredentials = { carried: false, pattern: undefined, overflow: false };
// Overlapping in-process invocations each keep their own registration.
const invocations = new AsyncLocalStorage<InvocationCredentials>();

/** Every spelling a span takes in raw text, in both shells' quoting and in a JSON string. */
function spanSpellings(span: string): string[] {
  return [
    span,
    span.replaceAll(/(["\\$`])/gu, "\\$1"),
    // A span always precedes the token's `@`, so no trailing backslash doubling applies.
    quoteWindowsCommandArg(`${span}@`).slice(1, -2),
    JSON.stringify(span).slice(1, -1),
  ];
}

function describeInvocation(argv: readonly string[]): InvocationCredentials {
  const spellings = new Set<string>();
  let carried = false;
  for (const token of argv) {
    const bounds = userinfoBounds(token);
    if (!bounds) continue;
    carried = true;
    const span = token.slice(bounds[0], bounds[1]);
    // The word rule already removes a whitespace-free span in every word layout.
    if (!/\s/u.test(span)) continue;
    for (const spelling of spanSpellings(span)) spellings.add(spelling);
  }
  const overflow = spellings.size > MAX_REGISTERED_SPELLINGS;
  const ordered = [...spellings].sort((left, right) => right.length - left.length);
  const pattern = overflow || ordered.length === 0
    ? undefined
    : new RegExp(ordered.map((spelling) => spelling.replaceAll(/[\\^$.*+?()[\]{}|/-]/gu, "\\$&")).join("|"), "gi");
  return { carried, pattern, overflow };
}

/**
 * Run one invocation with its URL userinfo registered. A span that contains
 * whitespace splits into several words, which the word rule cannot
 * reassemble, so inside this scope the text rule also removes each such span,
 * case-insensitively and in its shell and JSON escaping, wherever a producer
 * echoed it. The registration is invisible outside the scope.
 */
export function runWithUrlCredentialInvocation<T>(argv: readonly string[], run: () => T): T {
  return invocations.run(describeInvocation(argv), run);
}

/** Whether the running invocation carried any possible URL userinfo. */
export function invocationCarriesUrlCredentials(): boolean {
  return (invocations.getStore() ?? NO_INVOCATION).carried;
}

/**
 * Apply {@link redactUrlCredentialsInToken} to every whitespace-delimited word
 * of free text, after removing the running invocation's registered spans.
 * When more spellings were registered than the bounded scan allows, any text with a `:`
 * before an `@` loses the whole span between its first `:` and last `@`,
 * which over-redacts but cannot miss one.
 */
export function redactUrlCredentialsInText(text: string): string {
  const invocation = invocations.getStore() ?? NO_INVOCATION;
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
