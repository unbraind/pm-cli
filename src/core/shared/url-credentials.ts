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

/**
 * Whether no URL parser can read userinfo anywhere in the token (GH-1707).
 * The authority runs from the slashes after the first `:` to the next `/`
 * (never `?` or `#`, which SSH-style parsers read as userinfo). Only an
 * authority with neither `:` nor `@`, followed by text with
 * no `:` (no nested URL, no port before a path `@`) and a token without the
 * tabs and line breaks parsers ignore, is provably public. Anything else keeps
 * the conservative span, so this exemption can only ever reveal text that
 * holds no credential, such as `/package/@scope/name` or a blob path.
 */
function provablyWithoutUserinfo(token: string, colon: number): boolean {
  if (/[\t\n\r]/u.test(token)) return false;
  let authority = colon + 1;
  while (token[authority] === "/" || token[authority] === "\\") authority += 1;
  // Only `/` ends the authority here: Git and OpenSSH read userinfo across `?` and `#`.
  const delimiter = token.indexOf("/", authority) - authority;
  if (delimiter < 0) return false;
  const authorityEnd = authority + delimiter;
  return !/[:@]/u.test(token.slice(authority, authorityEnd)) && !token.slice(authorityEnd).includes(":");
}

/** Start and end (exclusive, at the last `@`) of a token's possible userinfo span. */
function userinfoBounds(token: string): readonly [start: number, end: number] | undefined {
  const at = token.lastIndexOf("@");
  const colon = token.indexOf(":");
  if (at < 0 || colon < 0 || colon > at) return undefined;
  // Skip at most the two authority delimiters. A non-special scheme accepts
  // further backslashes as userinfo, and extra slashes after a special scheme
  // are only over-redacted.
  let start = colon + 1;
  while (start < at && start < colon + 3 && (token[start] === "/" || token[start] === "\\")) start += 1;
  return start === at || provablyWithoutUserinfo(token, colon) ? undefined : [start, at];
}

/**
 * Remove every span of one token that could be URL userinfo. Any URL a parser
 * accepts has a `:` after its scheme, and userinfo always ends at an `@`, so
 * userinfo lies inside the span between the token's first `:` and its last
 * `@`. Replacing that whole span (after any scheme slashes) is complete for
 * every spelling a parser normalizes: backslash authorities, tabs inside a
 * scheme, wrapper chains such as `git+https:` or `npm:`, inline `--flag=value`
 * tokens and single-label or `host:port` authorities. Only a token that
 * provably holds no userinfo is left alone, such as a scoped-package or blob
 * URL. The remaining cost is deliberate: prose such as `Reminder: ping @bob`
 * or `alias@npm:@scope/pkg@1.0.0` is treated as possible userinfo. Such a
 * token is redacted in refusal output, and its invocation's refusals withhold
 * executable retries. The rule is idempotent.
 */
export function redactUrlCredentialsInToken(token: string): string {
  const bounds = userinfoBounds(token);
  return bounds ? `${token.slice(0, bounds[0])}${URL_CREDENTIAL_PLACEHOLDER}${token.slice(bounds[1])}` : token;
}

/**
 * Remove URL userinfo from one identity value (author, assignee, claim
 * principal) judged as a whole, so whitespace inside the userinfo cannot split
 * it into harmless-looking words. An identity never needs a credential
 * (GH-1707).
 */
export function redactIdentityCredentials(identity: string): string {
  return redactUrlCredentialsInToken(identity);
}

/** Identity fields a write may set from runtime or registered field values. */
const IDENTITY_FIELDS = ["author", "assignee", "claim_principal"] as const;

/** Return a copy of field values with every string identity field redacted, so no field path can store URL userinfo. */
export function redactIdentityFields<T extends Record<string, unknown>>(values: T): T {
  const redacted: Record<string, unknown> = { ...values };
  for (const field of IDENTITY_FIELDS) {
    if (typeof redacted[field] === "string") redacted[field] = redactIdentityCredentials(redacted[field]);
  }
  return redacted as T;
}

/** Apply {@link redactIdentityCredentials} to a string option and pass any other value through unchanged. */
export function redactOptionalIdentityCredentials<T>(value: T): T {
  return (typeof value === "string" ? redactIdentityCredentials(value) : value) as T;
}

/**
 * Shortest secret fragment the registry matches. A producer that cuts a
 * secret into pieces (at a comma, at whitespace, by truncation) can expose at
 * most this many minus one consecutive characters of it. Six keeps ordinary
 * guidance words from colliding with dictionary-like passwords.
 */
const MIN_FRAGMENT_LENGTH = 6;
/**
 * Upper bound on registered fragments. A longer secret is registered at
 * aligned positions with a wider fragment instead, so its protection
 * degrades by a bounded number of characters rather than being dropped.
 */
const MAX_REGISTERED_FRAGMENTS = 65_536;

interface InvocationCredentials {
  carried: boolean;
  /** Lower-cased fragments of every userinfo secret and its escaped spellings. */
  fragments: ReadonlySet<string>;
  /** Width of every registered fragment and of the matching window. */
  fragmentLength: number;
  /** Secrets shorter than one fragment that the word rule cannot reach because they contain whitespace. */
  shortSpellings: readonly string[];
}

const NO_INVOCATION: InvocationCredentials = { carried: false, fragments: new Set(), fragmentLength: MIN_FRAGMENT_LENGTH, shortSpellings: [] };
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

function describeInvocation(argv: readonly string[]): InvocationCredentials {
  const unique = new Set<string>();
  let carried = false;
  for (const token of argv) {
    const bounds = userinfoBounds(token);
    if (!bounds) continue;
    carried = true;
    for (const spelling of spanSpellings(userinfoSecret(token.slice(bounds[0], bounds[1])))) {
      unique.add(lowerPreservingLength(spelling));
    }
  }
  const spellings = [...unique];
  // Fragments start every `stride` positions and are at least `stride` wide, so
  // consecutive matches still chain across any echoed run. A run then exposes
  // at most fragmentLength + stride - 2 characters, which is 5 for stride 1.
  // Each spelling also adds one tail fragment, counted so the cap holds exactly.
  const positions = spellings.reduce((total, spelling) => total + Math.max(0, spelling.length - MIN_FRAGMENT_LENGTH + 1) + 1, 0);
  const stride = Math.max(1, Math.ceil(positions / MAX_REGISTERED_FRAGMENTS));
  const fragmentLength = Math.max(MIN_FRAGMENT_LENGTH, stride);
  const fragments = new Set<string>();
  const shortSpellings = new Set<string>();
  for (const spelling of spellings) {
    if (spelling.length < fragmentLength) {
      // A secret shorter than MIN_FRAGMENT_LENGTH without whitespace is whole inside
      // one word, where the word rule removes it; anything longer, or containing
      // whitespace, is matched whole even after the stride widened the fragments.
      if (spelling.length >= MIN_FRAGMENT_LENGTH || /\s/u.test(spelling)) shortSpellings.add(spelling);
      continue;
    }
    for (let index = 0; index + fragmentLength <= spelling.length; index += stride) {
      fragments.add(spelling.slice(index, index + fragmentLength));
    }
    fragments.add(spelling.slice(-fragmentLength));
  }
  return { carried, fragments, fragmentLength, shortSpellings: [...shortSpellings] };
}

/** Replace every maximal run covered by a registered fragment or short spelling with the placeholder. */
function removeRegisteredFragments(text: string, invocation: InvocationCredentials): string {
  const lowered = lowerPreservingLength(text);
  const covered = new Uint8Array(text.length);
  let found = false;
  const width = invocation.fragmentLength;
  for (let index = 0; index + width <= lowered.length; index += 1) {
    if (invocation.fragments.has(lowered.slice(index, index + width))) {
      covered.fill(1, index, index + width);
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
 * consecutive secret characters can survive while the invocation's secrets
 * fit the fragment budget; beyond it the bound widens to
 * fragmentLength + stride - 2.
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
 * fragments.
 */
export function redactUrlCredentialsInText(text: string): string {
  const invocation = invocations.getStore() ?? NO_INVOCATION;
  const redacted = invocation.carried ? removeRegisteredFragments(text, invocation) : text;
  return redacted.includes("@") ? redacted.replaceAll(/\S+/gu, redactUrlCredentialsInToken) : redacted;
}
