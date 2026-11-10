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
 * deliberate: a scoped package name, or prose such as `Reminder: ping @bob`,
 * is treated as possible userinfo too. Such a token is redacted in refusal
 * output, and its invocation's refusals withhold executable retries. The
 * rule is idempotent.
 */
export function redactUrlCredentialsInToken(token: string): string {
  const bounds = userinfoBounds(token);
  return bounds ? `${token.slice(0, bounds[0])}${URL_CREDENTIAL_PLACEHOLDER}${token.slice(bounds[1])}` : token;
}

/**
 * Length of the secret fragments the registry matches. A producer that cuts
 * a secret into pieces (at a comma, at whitespace, by truncation) can expose
 * at most this many minus one consecutive characters of it. Six keeps
 * ordinary guidance words from colliding with dictionary-like passwords.
 */
const FRAGMENT_LENGTH = 6;
/** Beyond this many fragments the text rule falls back to its whole-string form. */
const MAX_REGISTERED_FRAGMENTS = 65_536;

interface InvocationCredentials {
  carried: boolean;
  /** Lower-cased fragments of every userinfo secret and its escaped spellings. */
  fragments: ReadonlySet<string>;
  /** Secrets shorter than one fragment that the word rule cannot reach because they contain whitespace. */
  shortSpellings: readonly string[];
  overflow: boolean;
}

const NO_INVOCATION: InvocationCredentials = { carried: false, fragments: new Set(), shortSpellings: [], overflow: false };
// Overlapping in-process invocations each keep their own registration.
const invocations = new AsyncLocalStorage<InvocationCredentials>();

/** Lower-case per UTF-16 unit so indexes stay aligned with the original text. */
function lowerPreservingLength(text: string): string {
  const lowered = text.toLowerCase();
  if (lowered.length === text.length) return lowered;
  let result = "";
  for (const unit of text) {
    const lower = unit.toLowerCase();
    result += lower.length === unit.length ? lower : unit;
  }
  return result;
}

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

/** The secret part of a userinfo: the password, or the whole userinfo when it is a bare token; a username is not. */
function userinfoSecret(userinfo: string): string {
  const colon = userinfo.indexOf(":");
  return colon >= 0 && colon < userinfo.length - 1 ? userinfo.slice(colon + 1) : userinfo;
}

/** Record one spelling's fragments, or the whole spelling when it is shorter than one fragment. */
function registerSpelling(spelling: string, fragments: Set<string>, shortSpellings: Set<string>): void {
  const lowered = lowerPreservingLength(spelling);
  if (lowered.length >= FRAGMENT_LENGTH) {
    for (let index = 0; index + FRAGMENT_LENGTH <= lowered.length; index += 1) {
      fragments.add(lowered.slice(index, index + FRAGMENT_LENGTH));
    }
  } else if (/\s/u.test(lowered)) {
    // A short whitespace-free secret is whole inside one word, where the word rule removes it.
    shortSpellings.add(lowered);
  }
}

function describeInvocation(argv: readonly string[]): InvocationCredentials {
  const fragments = new Set<string>();
  const shortSpellings = new Set<string>();
  let carried = false;
  for (const token of argv) {
    const bounds = userinfoBounds(token);
    if (!bounds) continue;
    carried = true;
    for (const spelling of spanSpellings(userinfoSecret(token.slice(bounds[0], bounds[1])))) {
      registerSpelling(spelling, fragments, shortSpellings);
    }
  }
  const overflow = fragments.size > MAX_REGISTERED_FRAGMENTS;
  return { carried, fragments: overflow ? new Set() : fragments, shortSpellings: [...shortSpellings], overflow };
}

/** Replace every maximal run covered by a registered fragment or short spelling with the placeholder. */
function removeRegisteredFragments(text: string, invocation: InvocationCredentials): string {
  const lowered = lowerPreservingLength(text);
  const covered = new Uint8Array(text.length);
  let found = false;
  for (let index = 0; index + FRAGMENT_LENGTH <= lowered.length; index += 1) {
    if (invocation.fragments.has(lowered.slice(index, index + FRAGMENT_LENGTH))) {
      covered.fill(1, index, index + FRAGMENT_LENGTH);
      found = true;
    }
  }
  for (const spelling of invocation.shortSpellings) {
    for (let index = lowered.indexOf(spelling); index >= 0; index = lowered.indexOf(spelling, index + 1)) {
      covered.fill(1, index, index + spelling.length);
      found = true;
    }
  }
  if (!found) return text;
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    if (!covered[index]) result += text[index];
    else if (index === 0 || !covered[index - 1]) result += URL_CREDENTIAL_PLACEHOLDER;
  }
  return result;
}

/**
 * Run one invocation with its URL userinfo registered. Producers may echo a
 * userinfo split at whitespace or commas, truncated, re-cased or escaped,
 * and the word rule only sees whole tokens. So inside this scope the text
 * rule also removes every run of text that shares a six-character fragment
 * with a registered secret (the password, or a bare token's whole userinfo)
 * or its shell or JSON escaping. Whatever a producer does, at most five
 * consecutive secret characters can survive.
 * The registration is invisible outside the scope.
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
 * of free text, after removing the running invocation's registered
 * fragments. When more fragments were registered than the bound allows, any
 * text with a `:` before an `@` loses the whole span between its first `:`
 * and last `@` instead, which over-redacts but cannot miss a whole one.
 */
export function redactUrlCredentialsInText(text: string): string {
  const invocation = invocations.getStore() ?? NO_INVOCATION;
  let redacted = text;
  if (invocation.overflow) {
    const bounds = userinfoBounds(redacted);
    if (bounds) redacted = `${redacted.slice(0, bounds[0])}${URL_CREDENTIAL_PLACEHOLDER}${redacted.slice(bounds[1])}`;
  } else if (invocation.carried) {
    redacted = removeRegisteredFragments(redacted, invocation);
  }
  return redacted.includes("@") ? redacted.replaceAll(/\S+/gu, redactUrlCredentialsInToken) : redacted;
}
