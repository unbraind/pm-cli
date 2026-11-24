/**
 * @module core/shared/url-credentials
 * One conservative URL-userinfo redactor for every outbound surface: CLI
 * refusal envelopes, telemetry events and Sentry payloads (pm-nhauur,
 * pm-5htunt).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { quoteWindowsCommandArg } from "./command-line.js";
import { EXIT_CODE } from "./constants.js";
import { PmCliError } from "./errors.js";

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
  // Only WHATWG special schemes end the authority at `/`; OpenSSH reads
  // `ssh://a/b@host` as user `a/b`, so other schemes keep the conservative span.
  if (!/(?:^|[^A-Za-z0-9+.-])(?:https?|wss?|ftp)$/iu.test(token.slice(0, colon))) return false;
  let authority = colon + 1;
  while (token[authority] === "/" || token[authority] === "\\") authority += 1;
  // Only `/` ends the authority here: Git and OpenSSH read userinfo across `?` and `#`.
  const delimiter = token.indexOf("/", authority) - authority;
  if (delimiter < 0) return false;
  const authorityEnd = authority + delimiter;
  // A percent escape may decode to `@` or `:` (Git decodes `%40`), so it is never provably public.
  // The rest must hold no nested URL: no scheme (`:`), no scheme-relative
  // authority (`//`) and no percent escape that could decode to either.
  return !/[:@%]/u.test(token.slice(authority, authorityEnd)) && !/[:%]|[/\\][/\\]/u.test(token.slice(authorityEnd));
}

/** Start and end (exclusive, at the last `@`) of a token's possible userinfo span. */
function userinfoBounds(token: string): readonly [start: number, end: number] | undefined {
  // Git decodes `%40` in an authority, so an encoded at sign ends userinfo too.
  const at = Math.max(token.lastIndexOf("@"), token.toLowerCase().lastIndexOf("%40"));
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

/** Return a copy of a record with every string identity field redacted, for echoing data an older version stored. */
export function redactIdentityFields<T extends object>(values: T): T {
  const redacted: Record<string, unknown> = { ...(values as Record<string, unknown>) };
  for (const field of IDENTITY_FIELDS) {
    if (typeof redacted[field] === "string") redacted[field] = redactIdentityCredentials(redacted[field]);
  }
  return redacted as T;
}

/**
 * Refuse an identity that carries URL userinfo before anything is stored
 * (GH-1707). An identity never needs a credential, and stripping it would
 * collapse distinct identities that differ only in userinfo into one
 * principal. The refusal names the source but never echoes the value.
 */
export function assertIdentityWithoutUrlCredentials(identity: unknown, source: string): void {
  if (typeof identity !== "string" || userinfoBounds(identity.trim()) === undefined) return;
  throw new PmCliError(
    `${source} must not carry URL credentials: an identity is a name, never a credential.`,
    EXIT_CODE.USAGE,
    {
      code: "invalid_argument_value",
      field: source,
      // No credential-shaped sample here: redaction would rewrite it and report a removed credential.
      required: `Set ${source} to a plain name such as agent-a, with no URL userinfo (no user, password or token before the host).`,
      nextSteps: [`Rerun with ${source} set to a plain name.`],
      url_credentials_rejected: { source },
    },
  );
}

/** Parse an identity a structured entry asserts (`author=` in a seed), refusing URL userinfo. */
export function parseIdentityOption(value: string | undefined, source: string): string | undefined {
  assertIdentityWithoutUrlCredentials(value, source);
  return value;
}

/**
 * The identities item metadata records inside built-in collections, as
 * collection key plus entry path (pm-ziv9yb). Only these locations are read as
 * principals; an `author` key anywhere else, such as in a linked test's
 * `assert_json_field_equals` map, is ordinary data and is never judged.
 */
const NESTED_IDENTITY_PATHS: readonly (readonly [string, ...string[]])[] = [
  ["comments", "author"],
  ["notes", "author"],
  ["learnings", "author"],
  ["dependencies", "author"],
  ["plan_decisions", "author"],
  ["plan_discoveries", "author"],
  ["plan_steps", "owner"],
  ["tests", "provenance", "author"],
  ["tests", "updated_by"],
];

/** Deepest nesting walked inside a non-string value stored at an identity location. */
const IDENTITY_VALUE_DEPTH = 4;

/** Judge an identity location; a container stored there is identity data throughout, to a bounded depth. */
function assertIdentityValueWithoutUrlCredentials(value: unknown, source: string, depth = 0): void {
  if (typeof value === "string") {
    assertIdentityWithoutUrlCredentials(value, source);
    return;
  }
  if (depth >= IDENTITY_VALUE_DEPTH || typeof value !== "object" || value === null) return;
  for (const entry of Object.values(value)) assertIdentityValueWithoutUrlCredentials(entry, source, depth + 1);
}

/** Read one entry path, or undefined when any segment is absent or not a record. */
function readEntryPath(entry: unknown, path: readonly string[]): unknown {
  let node = entry;
  for (const key of path) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * Refuse URL userinfo at every identity location of item metadata or runtime
 * and registered field values: the top-level identity fields and the declared
 * entry paths of built-in collections, such as a runtime array field mapped
 * onto `comments` (pm-ziv9yb).
 */
export function assertIdentityFieldsWithoutUrlCredentials(values: object): void {
  const record = values as Record<string, unknown>;
  for (const field of IDENTITY_FIELDS) assertIdentityValueWithoutUrlCredentials(record[field], field);
  for (const [collection, ...path] of NESTED_IDENTITY_PATHS) {
    const entries = record[collection];
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, index) => {
      assertIdentityValueWithoutUrlCredentials(readEntryPath(entry, path), `${collection}[${index}].${path.join(".")}`);
    });
  }
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

/** Most words after the opening word that one whitespace-bearing userinfo may span. */
const SPACED_USERINFO_MAX_WORDS = 16;
/** Code units after the opening word within which the separator of a whitespace-bearing userinfo must start. */
const SPACED_USERINFO_MAX_LENGTH = 512;
/** A `host:port` authority of a dotted host or `localhost`, never userinfo; read only for a DNS-length head. */
const HOST_PORT = /^(?:(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+|localhost):\d+$/iu;
/** Longest head judged as a host and port: a DNS name, a colon and a port. */
const HOST_PORT_MAX_LENGTH = 260;
/** The delimiter that closes a URL a quote, backtick, angle bracket, parenthesis or square bracket opened in prose. */
const URL_CLOSERS: Readonly<Record<string, string>> = { "\"": "\"", "'": "'", "`": "`", "<": ">", "(": ")", "[": "]" };

/** An opening of a whitespace-bearing userinfo: its kind, the delimiter that closes its URL, and whether its scheme is special. */
interface SpacedOpening {
  kind: "user" | "label" | "pending";
  closer: string | undefined;
  /** A WHATWG special scheme, whose authority a `/` or `\\` ends; any other (`ssh:`) reads userinfo across them, as OpenSSH does. */
  special: boolean;
}

/** WHATWG special schemes, whose authority ends at a slash or backslash. */
const SPECIAL_SCHEMES = new Set(["http", "https", "ws", "wss", "ftp", "file"]);

/**
 * How a word opens a URL authority whose userinfo may go on past whitespace
 * (GH-1773), or undefined. The scheme separator is the last `:` that
 * authority slashes follow (any number, as special schemes normalize them),
 * so a compact JSON field name before it (`{"url":"https://…`) is skipped and
 * a URL nested in another one's query is the one judged. When a quote,
 * backtick, angle bracket, parenthesis or square bracket directly precedes the
 * scheme (a Markdown link destination), its closing delimiter ends the URL;
 * any other quote is data
 * (`https://ci:O'Brian Pass@host`). The authority after the slashes must hold
 * no path, no closing delimiter and be no bracketed IPv6 host. It opens with
 * `user` when the authority, up to a query or fragment, holds a `:` and is no
 * dotted or `localhost` `host:port` (`https://user:pass`, `https://ci:123456`,
 * `https://ci:pa%40ss`). It opens with `label` when that part holds no `:`,
 * `@` or `%40` (`https://service`, `https://jane.doe`, `https://build%2Dteam`):
 * a spaced username, whose password colon must come in a later word. A colon
 * only inside a query (`https://example.com?t=12:30`) never makes a `user`
 * opening, and a word that ends with its slashes is `pending`: its authority
 * starts in the next word (`https://` then a tab).
 */
function spacedUserinfoOpening(word: string, droppedBlankAfter = false): SpacedOpening | undefined {
  // The last scheme in the word, so a URL nested in another one's query (`…?next=https://u:p`) is judged.
  const colon = lastSchemeSeparator(word);
  if (colon < 0) return undefined;
  const schemeStart = schemeStartBefore(word, colon);
  // A one-letter scheme is a Windows drive (`C:/Temp`), never a URL.
  if (colon - schemeStart < 2) return undefined;
  const closer = URL_CLOSERS[word[schemeStart - 1] ?? ""];
  const special = SPECIAL_SCHEMES.has(word.slice(schemeStart, colon).toLowerCase());
  let start = colon + 1;
  while (start < word.length && (word[start] === "/" || word[start] === "\\")) start += 1;
  if (start === word.length) return { kind: "pending", closer, special };
  const authority = word.slice(start);
  // A special scheme's authority ends at a path, query or fragment, so no later word can hold its userinfo.
  if (authority.startsWith("[") || (special && /[/\\?#]/u.test(authority)) || closingDelimiterAt(authority, closer) >= 0) return undefined;
  // A special scheme's authority with a query or fragment was refused above; OpenSSH reads userinfo across them.
  const kind = authorityOpening(authority, droppedBlankAfter);
  return kind === undefined ? undefined : { kind, closer, special };
}

/** Closers that only end a URL at the end of a word, after which only punctuation or emphasis follows; inside a word they are data (`pa)ss`). */
const WORD_END_CLOSERS = new Set([")", "]"]);

/**
 * Where the delimiter that closes a URL stands in text, or -1. A quote,
 * backtick or angle bracket closes it wherever it stands; a parenthesis or
 * square bracket only at the end of the text, followed by nothing but
 * punctuation or Markdown emphasis (`(https://example.invalid).`,
 * `**[docs](https://example.invalid)**`), so a password that holds one
 * (`(https://ci:pa)ss words@host)`) is still read.
 */
function closingDelimiterAt(text: string, closer: string | undefined): number {
  if (closer === undefined) return -1;
  if (!WORD_END_CLOSERS.has(closer)) return unescapedIndexOf(text, closer);
  let end = text.length;
  while (end > 0 && /[.,;:!?*_~`]/u.test(text[end - 1]!)) end -= 1;
  return end > 0 && text[end - 1] === closer ? end - 1 : -1;
}

/** Where the first occurrence of `character` stands that no backslash escapes (`pa\\"ss` holds none), or -1. */
function unescapedIndexOf(text: string, character: string): number {
  for (let index = text.indexOf(character); index >= 0; index = text.indexOf(character, index + 1)) {
    let backslashes = 0;
    while (index - backslashes > 0 && text[index - backslashes - 1] === "\\") backslashes += 1;
    if (backslashes % 2 === 0) return index;
  }
  return -1;
}

/**
 * The scheme separator a word opens its URL at: the last `:` that an authority
 * slash or backslash follows and whose scheme starts the word or follows a
 * query, fragment or opening character (`…?next=https://u:p`, `{"url":"https://…`),
 * so a URL nested in another one's query is judged; otherwise the first such
 * `:`, so a `:/` inside userinfo (`ssh://ci:pa:/ss`) is that userinfo's text.
 * Returns -1 when the word has none.
 */
function lastSchemeSeparator(word: string): number {
  let first = -1;
  for (let index = word.length - 2; index >= 0; index -= 1) {
    if (word[index] !== ":" || (word[index + 1] !== "/" && word[index + 1] !== "\\")) continue;
    const start = schemeStartBefore(word, index);
    if (start === 0 || /[=?&#"'`(<[{,]/u.test(word[start - 1]!)) return index;
    first = index;
  }
  return first;
}

/** Where the scheme that ends at `colon` starts, read back over scheme characters. */
function schemeStartBefore(word: string, colon: number): number {
  let start = colon;
  while (start > 0 && /[A-Za-z0-9+.-]/u.test(word[start - 1]!)) start -= 1;
  return start;
}

/**
 * How a non-empty authority head opens a whitespace-bearing userinfo. A
 * `host:port` head is public only when a space follows the word: after a tab
 * or line break, which URL parsers drop, it may be a dotted username and a
 * digit-led password (`https://jane.doe:1234` then a tab then `…@host`).
 */
function authorityOpening(head: string, droppedBlankAfter: boolean): "user" | "label" | undefined {
  if (head.includes(":")) return !droppedBlankAfter && head.length <= HOST_PORT_MAX_LENGTH && HOST_PORT.test(head) ? undefined : "user";
  return /@|%40/iu.test(head) ? undefined : "label";
}

/**
 * Where a whitespace-bearing userinfo opened by the word ending at `from`
 * ends: after the later word that holds its last `@` or `%40` separator, or
 * -1 when none does. The search reads words across any whitespace (URL
 * parsers drop tabs and line breaks), takes the last separator that starts
 * within the word and length bounds, as a parser takes the authority's last
 * `@`, and stops at a word that starts another URL or holds a path delimiter,
 * or the opening's closing delimiter, before any separator, which ends the
 * authority. A `label` opening also needs a password colon before its
 * separator: a `:` with text after it in the same word, or one that a tab or
 * line break follows, and never a clock time (`09:30`); a `:` that a space
 * follows counts only when the separator's host goes on into a path
 * (`account: secret@host/x`, never `support: ops@example.org`). The word that holds the
 * separator may run past the length bound (a long query), and each opening
 * reads at most that word and the bounded span before it.
 */
function spacedUserinfoEnd(text: string, from: number, opening: SpacedOpening, seed = -1): number {
  const limit = Math.min(text.length, from + SPACED_USERINFO_MAX_LENGTH);
  let index = from;
  let end = seed;
  let colonSeen = opening.kind === "user";
  // A colon that a space follows (`account: secret`) is weaker evidence, because prose writes `support: me@x`.
  let spacedColonSeen = false;
  for (let words = 0; words < SPACED_USERINFO_MAX_WORDS && index < limit; words += 1) {
    const bounds = nextWord(text, index, limit);
    if (bounds === undefined) break;
    // Two code units past the bound complete a `%40` that starts inside it.
    const read = readAuthorityWord(text.slice(bounds[0], Math.min(bounds[1], limit + 2)), limit - bounds[0], opening);
    if (read.startsUrl) break;
    if (endsUserinfo(read, colonSeen, spacedColonSeen)) end = bounds[1];
    const dropped = /[\t\r\n]/u.test(text[bounds[1]] ?? "");
    colonSeen ||= read.colon || (read.trailingColon && dropped);
    spacedColonSeen ||= read.trailingColon;
    if (read.endsAuthority) break;
    index = bounds[1];
  }
  return end;
}

/**
 * Whether a later word's separator ends the userinfo: a password colon came
 * before it, or a colon that a space follows did and the separator's host goes
 * on into a path, as a URL's does and an email's never does, or the delimiter
 * that opened the URL closes it there.
 */
function endsUserinfo(read: ReturnType<typeof readAuthorityWord>, colonSeen: boolean, spacedColonSeen: boolean): boolean {
  if (!read.separator) return false;
  return colonSeen || read.colonBeforeSeparator || (spacedColonSeen && (read.hasPath || read.closedByOpener));
}

/** The next word that starts at or after `index` and before `limit`, as its start and end, or undefined. */
function nextWord(text: string, index: number, limit: number): readonly [start: number, end: number] | undefined {
  let start = index;
  while (start < limit && /\s/u.test(text[start]!)) start += 1;
  if (start === limit) return undefined;
  let end = start;
  while (end < text.length && !/\s/u.test(text[end]!)) end += 1;
  return [start, end];
}

/**
 * Whether text holds a `:` that can separate a username from its password:
 * the first `:` has text after it and the text is no clock time (`09:30`), so
 * prose such as `support: ops@example.org` or `at 09:30` never holds one, while
 * a numeric username part (`123:pass`) does.
 */
function hasPasswordColon(text: string): boolean {
  const colon = text.indexOf(":");
  return colon >= 0 && colon < text.length - 1 && !CLOCK_TIME.test(text);
}

/** A clock time written as one word (`09:30`, `12:30Z`, `9:30pm,`), never a username and password. */
const CLOCK_TIME = /^\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[AaPp][Mm])?[.,;:!?)]*$/u;

/**
 * How one later word reads inside an authority, up to its first path delimiter
 * or the opening's closing delimiter, either of which ends the authority. Its
 * separator is the last `@` or `%40` that starts before `maxStart`. The word
 * starts another URL when the text before its first path delimiter ends with
 * a scheme and its `:` (`https://…`), read back from that `:` so a long word
 * costs one pass.
 */
function readAuthorityWord(word: string, maxStart: number, opening: SpacedOpening): {
  startsUrl: boolean;
  separator: boolean;
  colonBeforeSeparator: boolean;
  colon: boolean;
  trailingColon: boolean;
  hasPath: boolean;
  closedByOpener: boolean;
  endsAuthority: boolean;
} {
  // Only a special scheme's authority ends at a path, query or fragment delimiter; OpenSSH reads
  // `ssh://a/b@host` as user `a/b`.
  const delimiter = opening.special ? word.search(/[/\\?#]/u) : -1;
  const beforePath = delimiter < 0 ? word : word.slice(0, delimiter);
  const closed = closingDelimiterAt(beforePath, opening.closer);
  const scheme = word.search(/:[/\\]/u);
  const authority = closed < 0 ? beforePath : beforePath.slice(0, closed);
  const last = Math.min(authority.length, maxStart) - 1;
  const separator = last < 0 ? -1 : Math.max(authority.lastIndexOf("@", last), authority.toLowerCase().lastIndexOf("%40", last));
  return {
    startsUrl: scheme >= 0 && closed < 0 && startsWithScheme(word.slice(0, scheme + 1)),
    separator: separator >= 0,
    // A colon right before the separator is an empty password (`deploy-token:@host`).
    colonBeforeSeparator: separator > 0 && (hasPasswordColon(authority.slice(0, separator)) || authority[separator - 1] === ":"),
    colon: hasPasswordColon(authority),
    trailingColon: authority.endsWith(":"),
    // Whether the separator's host goes on into a path, judged apart from whether a slash ends the search.
    hasPath: closed < 0 && separator >= 0 && /[/\\]/u.test(word.slice(separator + 1)),
    closedByOpener: closed >= 0,
    endsAuthority: delimiter >= 0 || closed >= 0,
  };
}

/**
 * Whether text, which ends with a `:`, is a URL scheme and that `:`, optionally after one opening
 * quote, backtick, parenthesis or bracket: the start of another URL
 * (`https://…`, `(https://…`). A scheme inside a query (`…?next=https://…`)
 * is part of the current URL, not a new one. Read back from the end, so a
 * long word costs one pass.
 */
function startsWithScheme(text: string): boolean {
  // The caller passes the text up to and including a scheme separator's `:`.
  const start = schemeStartBefore(text, text.length - 1);
  // A one-letter scheme is a Windows drive (`C:/Temp`), never another URL.
  return start < text.length - 2 && /[A-Za-z]/u.test(text[start]!) && (start === 0 || (start === 1 && /["'`(<[]/u.test(text[0]!)));
}

/**
 * The opening a word makes for a whitespace-bearing userinfo, where its scan
 * starts, and the end its own words already reach, or undefined. A `pending`
 * word's authority starts in the next word, judged as if the blank between them
 * were dropped; a special scheme's authority there ends at its path, which the
 * opening judges apart (`https://` then a tab then `token:x@host/repo`). When
 * that word holds the separator, the join reaches at least its end, and when
 * the word goes on into a path the authority has ended there (`final`).
 */
function openingAt(text: string, word: string, from: number): { opening: SpacedOpening; from: number; seed: number; final: boolean } | undefined {
  const opening = spacedUserinfoOpening(word, /[\t\r\n]/u.test(text.charAt(from)));
  if (opening?.kind !== "pending") return opening === undefined ? undefined : { opening, from, seed: -1, final: false };
  const next = nextWord(text, from, Math.min(text.length, from + SPACED_USERINFO_MAX_LENGTH));
  if (next === undefined) return undefined;
  const nextText = text.slice(next[0], next[1]);
  // The rest of the authority slashes may follow the blank too (`https:/` tab `/u:pass`).
  const slashes = /^[/\\]*/u.exec(nextText)![0];
  const body = nextText.slice(slashes.length);
  const pathless = opening.special ? body.split(/[/\\?#]/u, 1)[0]! : body;
  // The delimiter that opened a quoted URL closes its authority too (`"https://` tab `token:x@host"`).
  const closed = closingDelimiterAt(pathless, opening.closer);
  const authorityWord = `${slashes}${closed < 0 ? pathless : pathless.slice(0, closed)}`;
  const holdsSeparator = /@|%40/iu.test(authorityWord);
  // A separator after a dropped blank is userinfo whatever its head holds (`https://` tab `token@host`).
  const joined = holdsSeparator ? { ...opening, kind: "user" as const } : spacedUserinfoOpening(`${word}${authorityWord}`);
  if (joined === undefined || joined.kind === "pending") return undefined;
  const seed = holdsSeparator ? next[1] : -1;
  // A path, query, fragment or closing delimiter in that word already ended the authority, so later prose is never searched.
  return { opening: joined, from: next[1], seed, final: authorityWord.length < nextText.length };
}

/**
 * Join each URL whose userinfo holds blanks into one word before the word
 * rule runs, so `https://user:pass words%40host/path` loses its whole userinfo
 * instead of being judged as harmless-looking words (GH-1773). The joined span
 * is redacted by {@link redactUrlCredentialsInToken}, so the blanks inside it
 * fall in the removed span, exactly as for a single argv token.
 */
function redactSpacedUserinfo(text: string): string {
  if (!/:[/\\]/u.test(text)) return text;
  const word = /\S+/gu;
  let result = "";
  let cursor = 0;
  for (let match = word.exec(text); match !== null; match = word.exec(text)) {
    const opened = openingAt(text, match[0], match.index + match[0].length);
    if (opened === undefined) continue;
    const end = opened.final ? opened.seed : spacedUserinfoEnd(text, opened.from, opened.opening, opened.seed);
    if (end === -1) continue;
    result += `${text.slice(cursor, match.index)}${redactUrlCredentialsInToken(text.slice(match.index, end))}`;
    cursor = end;
    word.lastIndex = end;
  }
  return cursor === 0 ? text : `${result}${text.slice(cursor)}`;
}

/**
 * Apply {@link redactUrlCredentialsInToken} to every whitespace-delimited word
 * of free text, after removing the running invocation's registered fragments
 * and joining each URL userinfo that holds blanks into one word.
 */
export function redactUrlCredentialsInText(text: string): string {
  const invocation = invocations.getStore() ?? NO_INVOCATION;
  const redacted = invocation.carried ? removeRegisteredFragments(text, invocation) : text;
  return /@|%40/iu.test(redacted) ? redactSpacedUserinfo(redacted).replaceAll(/\S+/gu, redactUrlCredentialsInToken) : redacted;
}
