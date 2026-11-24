/**
 * @module core/shared/secret-rules
 * Single credential and private-context detector inventory for mutation preflight
 * and repository scanning. Diagnostics must never include matched text.
 */
/** Safe transformation identities; neither original nor decoded values escape. */
export type SecretNormalizationKind = "percent_decode" | "json_unescape" | "unicode_fold";

/** Original source location and optional inspection provenance. */
export interface SecretRuleMatch {
  /** UTF-16 source offset; normalized detections point to the original line start. */
  index: number;
  /** Safe transformations used to reveal a coordinate. */
  normalizations?: SecretNormalizationKind[];
  /** Remaining encoded text requires review after the finite pass budget. */
  normalization_incomplete?: true;
}

const COMPONENT = "[^\\s/\\\\<>\"'\\x60()\\[\\]{},;?=:#*]+";
const SEPARATOR = "[/\\\\]+";
const ACCOUNT = "[\\p{L}\\p{N}._@-]+";
const ACCOUNT_PATH = ACCOUNT + "(?:" + SEPARATOR + COMPONENT + ")*";
const ROOT_HOME = "(?:(?:home|users)" + SEPARATOR + ACCOUNT_PATH + "|root" + SEPARATOR + ACCOUNT_PATH + ")";
const UNIX_HOME = "[/\\\\]" + ROOT_HOME;
const MULTI_ROOT_HOME = "[/\\\\]{2,}" + ROOT_HOME;
const WINDOWS_HOME = "/?[a-z]:" + SEPARATOR + "users" + SEPARATOR + ACCOUNT_PATH;
const SHARE_COMPONENT = COMPONENT + "(?: +" + COMPONENT + ")*";
const SHARED_PROFILE = "(?:" + SHARE_COMPONENT + SEPARATOR + ")?users" + SEPARATOR + ACCOUNT_PATH;
const UNC_HOME = "[/\\\\]{2,}" + COMPONENT + SEPARATOR + SHARED_PROFILE;
const DEVICE_VOLUME = "(?:[a-z]:|volume\\{[a-f0-9-]+\\}|" + COMPONENT + ")";
const DEVICE_HOME = "[/\\\\]{2}[?.]" + SEPARATOR + "(?:unc" + SEPARATOR + COMPONENT + SEPARATOR
  + SHARED_PROFILE + "|" + DEVICE_VOLUME + SEPARATOR + "users" + SEPARATOR + ACCOUNT_PATH + ")";
const FILE_HOME = "file:(?:" + DEVICE_HOME + "|(?:[/\\\\](?![/\\\\])|[/\\\\]{3,}|[/\\\\]{2}localhost" + SEPARATOR + ")"
  + "(?:" + ROOT_HOME + "|[a-z]:" + SEPARATOR + "users" + SEPARATOR + ACCOUNT_PATH + ")"
  + "|[/\\\\]{2}(?:[a-z]:" + SEPARATOR + "users" + SEPARATOR + ACCOUNT_PATH
  + "|" + COMPONENT + SEPARATOR + "(?:" + ROOT_HOME + "|" + SHARED_PROFILE + ")))";

/** URI schemes cannot masquerade as native UNC roots; explicit file URLs remain supported. */
export const PRIVATE_HOME_PATH_PATTERN = new RegExp(
  "(?:^|[^\\p{L}\\p{N}_./\\\\~])(?:" + UNIX_HOME + "|" + WINDOWS_HOME + "|" + FILE_HOME + ")"
    + "|(?:^|[^\\p{L}\\p{N}_:./\\\\~])(?:" + MULTI_ROOT_HOME + "|" + UNC_HOME + "|" + DEVICE_HOME + ")",
  "giu",
);

const MAX_NORMALIZATION_PASSES = 4;
const REMAINING_ENCODING = /%[a-f0-9]{2}|\\(?:u[a-f0-9]{4}|x[a-f0-9]{2}|\/)/iu;
const utf8 = new TextDecoder("utf-8");

/** Decode byte runs independently so malformed neighboring bytes cannot hide a path. */
function percentView(value: string): string {
  return value.replace(/(?:%[a-f0-9]{2})+/giu, (run) => utf8.decode(
    Uint8Array.from(run.matchAll(/%([a-f0-9]{2})/giu), (match) => Number.parseInt(match[1], 16)),
  )).replace(/%(?![a-f0-9]{2})[a-z0-9]{0,2}/giu, "\ufffd");
}

/** Interpret serialized slashes and character escapes without executing the payload. */
function escapedView(value: string): string {
  // Consume an entire backslash run even without a recognized suffix. Retrying
  // a required suffix at every position in an unmatched run would be quadratic.
  return value.replace(/\\+(?:u([a-f0-9]{4})|x([a-f0-9]{2})|(\/))?/giu,
    (match, unicode: string | undefined, byte: string | undefined, slash: string | undefined) => {
      const code = unicode ?? byte;
      return code === undefined ? slash ?? match : String.fromCharCode(Number.parseInt(code, 16));
    });
}

/** Fold documented path disguises; this is a heuristic, not filesystem canonicalization. */
function unicodeView(value: string): string {
  return value.normalize("NFKC")
    .replace(/[\p{Bidi_Control}\u200b-\u200f\u2060-\u206f\ufeff]/gu, "")
    .replace(/[\u2215\u2044]/gu, "/")
    .replace(/[\u043e\u041e]/gu, "o")
    .replace(/[\u0455\u0405]/gu, "s");
}

/** Apply each view once and retain transformation identities in first-use order. */
function nextNormalizedView(view: string, steps: SecretNormalizationKind[]): string {
  for (const [kind, transform] of [
      ["percent_decode", percentView], ["json_unescape", escapedView], ["unicode_fold", unicodeView],
    ] as const) {
    const transformed = transform(view);
    if (transformed !== view && !steps.includes(kind)) steps.push(kind);
    view = transformed;
  }
  return view;
}

/** Inspect the full line budget even after a coordinate is found; emit coordinates only once per view. */
function* normalizedHomePathMatches(line: string, regex: RegExp, detected: boolean): Generator<SecretRuleMatch> {
  let view = line;
  const steps: SecretNormalizationKind[] = [];
  for (let pass = 0; pass < MAX_NORMALIZATION_PASSES; pass += 1) {
    const previous = view;
    view = nextNormalizedView(view, steps);
    if (!detected) {
      regex.lastIndex = 0;
      for (const _match of view.matchAll(regex)) {
        detected = true;
        yield { index: 0, normalizations: [...steps] };
      }
    }
    if (view === previous) break;
    if (pass === MAX_NORMALIZATION_PASSES - 1 && REMAINING_ENCODING.test(view)) {
      yield { index: 0, normalizations: [...steps], normalization_incomplete: true };
    }
  }
}

/** Native matches keep exact offsets; canonical matches retain their original source line. */
export function* findPrivateHomePathMatches(content: string, regex: RegExp): Generator<SecretRuleMatch> {
  let offset = 0;
  for (const line of content.split("\n")) {
    regex.lastIndex = 0;
    let rawFound = false;
    for (const match of line.matchAll(regex)) {
      rawFound = true;
      yield { index: offset + match.index! };
    }
    for (const match of normalizedHomePathMatches(line, regex, rawFound)) yield { ...match, index: offset };
    offset += line.length + 1;
  }
}

/**
 * Structured spellings of a key/value rule: a quoted key (JSON, YAML flow,
 * Python dict), every quoted string nested in an array or object under the
 * key, and optionally `<key>value</key>` element content. Each candidate value
 * is judged by the rule's own value grammar, so quoting the key or nesting the
 * value never changes the verdict.
 */
export interface SecretStructuredSpelling {
  /** Case-insensitive key alternation (regular-expression source). */
  keys: string;
  /** Value grammar (regular-expression source) applied at each candidate value start. */
  value: string;
  /** Also inspect element content such as `<password>value</password>`. */
  element?: true;
  /** Judge element content with the value grammar and entropy predicate instead of length alone. */
  elementValue?: true;
}

/**
 * What a detector protects: `credential` for secrets that grant access,
 * `network` for private infrastructure addresses and `path` for local
 * filesystem paths that reveal an account. A policy can decide a whole family
 * at once, so a new rule inherits its category's decision (pm-gh1749). The set
 * is part of the public SDK contract: a new rule joins an existing category,
 * and a new category is a declared contract change.
 */
export type SecretRuleCategory = "credential" | "network" | "path";

/** One detector and any explicit repository-only scope exception. */
export interface SecretRule {
  /** Repository diagnostic identifier. */
  name: string;
  /** Compatible SDK diagnostic identifier. */
  mutationRule: string;
  /** Stable family of the detector; see {@link SecretRuleCategory}. */
  category: SecretRuleCategory;
  /** Global pattern; consumers reset lastIndex before each scan. */
  regex: RegExp;
  /** Repository paths with deliberate fixture exemptions. */
  excludeFiles?: RegExp;
  /** Repository paths eligible for this rule. */
  includeFiles?: RegExp;
  /** Why the repository gate deliberately omits this mutation heuristic. */
  mutationOnlyReason?: string;
  /** Minimum Shannon entropy of the first capture group, when applicable. */
  minimumEntropy?: number;
  /** Case-sensitive shape of a captured value that is a reference, never a credential. */
  rejectValue?: RegExp;
  /** Case-sensitive shape of an unquoted captured value that is a reference when a `;` ends its statement. */
  rejectStatementReference?: RegExp;
  /** Quoted-key, nested-container and element spellings judged by the same value grammar. */
  structured?: SecretStructuredSpelling;
  /**
   * Minimum length of the literal left in the captured value once every
   * run-time reference expands to nothing (see {@link literalAfterReferences}).
   * A reference is a placeholder only when it is the whole value. The literal,
   * not the captured text, is then judged by the entropy and value predicates.
   */
  minimumLiteralLength?: number;
  /**
   * Sticky grammar that the literal a captured value spells must match whole,
   * read as one double-quoted literal, when the captured text holds a
   * reference opener or a quote (see {@link acceptsSecretMatch}). It lets a
   * referenced value be judged by the same grammar as a reference-free one.
   */
  literalValue?: RegExp;
  /**
   * A narrower reading scanned as well: its own flat pattern and structured
   * value grammar, with the same keys, judged on the captured text by the
   * rule's value and entropy predicates but without the literal minimum or
   * literal grammar, as the narrower rule always judged it. A value is a
   * finding when either reading reports it, so widening `regex` and
   * `structured.value` never drops a finding the narrower rule made, and
   * every key the narrower scan visits is still visited (pm-hw00c2).
   */
  baseline?: SecretRuleReading;
}

/** A flat pattern and the structured value grammar that go with it. */
export interface SecretRuleReading {
  /** Global flat pattern, as {@link SecretRule.regex}. */
  regex: RegExp;
  /** Structured value grammar (regular-expression source), as {@link SecretStructuredSpelling.value}. */
  value: string;
}

const PASSWORD_KEYS = "password|passphrase";
// Unquoted configuration reads with an empty fallback contain no literal
// credential only when they end the expression, including bounded trailing
// comments. A block comment cannot consume code beyond its first closing
// delimiter; composed, continued and nonempty fallbacks remain detectable.
//
// GH-1699 follow-up (pm-ycgb5g): the value is captured whole and the rule's
// minimumLiteralLength judges what is left once run-time references
// (`${...}`, `$(...)`, `<...>`) expand to nothing. A bare reference stays a
// placeholder, while a literal before or after one (`${EMPTY}"<literal>"`,
// `$VAR"<literal>"`, `<literal>${VAR}`) is still a credential.
//
// One `$NAME` policy for every key-named rule (pm-hw00c2): a `$NAME` reference
// expands to nothing when NAME is CONSTANT_CASE, the environment-variable
// convention (`$DB_PASSWORD`, `$API_KEY`), and nothing literal comes before it
// in its word (`$VAR"<literal>"`), or when it is the whole value (a bare
// `$password`). Any other `$` text is literal, so a credential that merely
// contains `$` (`abc$XYZ…`, an escaped `\$`) keeps its characters.
//
// A value is a run of references, literal characters and up to
// PASSWORD_QUOTED_PIECES whitespace-free quoted pieces, as a shell
// concatenates `$VAR"<literal>"` or `"${EMPTY}"<literal>`. A quoted piece must
// be whitespace-free because in code the quote after a value usually closes
// the enclosing string literal, and the text up to the next quote is code,
// not part of the value. A quoted value that holds whitespace (a passphrase)
// is that quoted literal alone, as in JSON or YAML. Bounding the quoted pieces
// keeps every scan local: a quoted key sits in a quoted piece, so one value
// scan reaches at most a fixed number of later keys, and the structured pass
// stays linear. A reference may nest one level (`${PW:-${FALLBACK}}`).
const PASSWORD_QUOTED_PIECES = 4;
// Every repeated group runs over character runs and is bounded, so no value
// length can exhaust the regex backtrack stack (a group repeated once per
// character overflows it near 16 million characters); a reference or value
// longer than the bound is read in part.
const PASSWORD_REPEAT_BOUND = 4096;
// A reference skips quoted spans, so a quoted `)` or `}` inside it
// (`$(printf ')')`, `${PW:?'}'}`) never ends it early, as in
// expandRuntimeReferences. A literal `$` never starts a reference the grammar
// cannot follow, so an over-nested reference is never half-read as literal.
// Each run is maximal (a negative lookahead forbids its own class next), so no
// run can be split across iterations and a failed reference never backtracks
// into exponentially many splits.
const maximalRun = (characterClass: string): string => `${characterClass}+(?!${characterClass})`;
const PASSWORD_QUOTED_SPAN = String.raw`'[^'\r\n]*'|"[^"\\\r\n]*(?:\\.[^"\\\r\n]*){0,${PASSWORD_REPEAT_BOUND}}"`;
const PASSWORD_REFERENCE = String.raw`\$\{(?:${maximalRun(String.raw`[^{}$'"\\\r\n]`)}|\\[^\r\n]|${PASSWORD_QUOTED_SPAN}|\$(?!\{)|\$\{[^{}\r\n]*\}){0,${PASSWORD_REPEAT_BOUND}}\}`
  + String.raw`|\$\((?:${maximalRun(String.raw`[^()$'"\\\r\n]`)}|\\[^\r\n]|${PASSWORD_QUOTED_SPAN}|\$(?!\()|\$\([^()\r\n]*\)){0,${PASSWORD_REPEAT_BOUND}}\)`;
const PASSWORD_PIECE = String.raw`${PASSWORD_REFERENCE}|<[^<>\r\n]*>|${maximalRun(String.raw`[A-Za-z0-9!@#%^&*._+\-=]`)}|\$(?![{(])`;
// A quoted piece ends at its first closing quote, even inside a reference
// (`"$(op read "item")"` captures `"$(op read "`); a reference that opens the
// piece and is cut there contributes nothing (see literalAfterReferences).
const PASSWORD_QUOTED = String.raw`"[^"]*"|'[^']*'`;
const PASSWORD_QUOTED_PIECE = String.raw`(?:"[^"\s]*"|'[^'\s]*')(?:${PASSWORD_PIECE}){0,${PASSWORD_REPEAT_BOUND}}`;
const PASSWORD_VALUE = new RegExp(
  String.raw`(?!config\.auth\.password\s*(?:\|\|\s*(?:''|"")|\?\s*unescape\(encodeURIComponent\(config\.auth\.password\)\)\s*:\s*(?:''|""))(?=[ \t]*(?:\/\*(?:[^*]|\*(?!\/))*\*\/[ \t]*)*(?:;|$|\/\/[^\r\n\u2028\u2029]*(?:\r\n)?$)))`
    + `((?:${PASSWORD_PIECE}){1,${PASSWORD_REPEAT_BOUND}}(?:${PASSWORD_QUOTED_PIECE}){0,${PASSWORD_QUOTED_PIECES}}`
    + `|(?:${PASSWORD_QUOTED_PIECE}){1,${PASSWORD_QUOTED_PIECES}}|${PASSWORD_QUOTED})`,
);
const PASSWORD_MINIMUM_LITERAL_LENGTH = 8;
const HIGH_ENTROPY_KEYS = "token|secret|password|passwd|api[_-]?key";
// GH-1704: any key whose last word names a credential, including compound
// keys (`DB_PASSWORD`, `aws_secret_access_key`, `GITHUB_TOKEN`). A compound
// key consumes its prefix from a word boundary, so `token_budget`,
// `max_tokens` and `output_token_budget` never match. Plain and hyphenated
// password keys stay with password_assignment, so one value is reported once.
// The lookbehind starts a key only at the beginning of an identifier, never
// after `word-`, so a long hyphenated run is scanned once (linear time) while
// `--token=` still matches.
const CREDENTIAL_KEYS =
  "(?<![a-z0-9_]|[a-z0-9_]-)(?:(?:[a-z0-9]+_)+(?:password|passphrase)|(?:[a-z0-9]+[_-])*(?:secret|token|(?:api|secret|private|access)[_-]?key|client[_-]?secret|passwd|pwd))";
// A whitespace-free value of eight or more characters (a quoted value must be
// whitespace-free up to its closing quote, so quoted prose never counts) that
// is not a placeholder (`<...>`, `${...}`, `$(...)`, `$VAR`, `%VAR%`,
// `[scrubbed]`), a filesystem path (`pwd=/usr/local/bin`, `certs/client.key`,
// `C:/keys/x.pem`), a URL, a
// letters-only or hyphenated word (`not-configured`), a dotted member path or a call. A quoted value (or
// an element body) is captured whole up to its closing quote. Unquoted, `?`,
// `:` and `|` read as code
// such as `process.env.API_KEY||""` or `options?.token`, except directly after
// `=` (`CLIENT_SECRET=q7!A?9#z`), where the exclusions below still catch code.
// An unquoted CONSTANT_CASE name ending a statement (`= DEFAULT_TOKEN;`) is
// rejected afterwards by a case-sensitive check (rejectStatementReference). A quoted value is a
// member path only when the whole literal is one (`"process.env.TOKEN"`), so
// `"svc.app:secretX09"` still counts. Entropy then rejects masks.
// Every repeated group in the exclusions below is bounded: a group repeated per
// segment grows the regex stack, so a value of millions of member, word or path
// segments threw and the guard failed open. A longer chain is simply not
// excluded, so it fails closed.
const EXCLUSION_REPEAT_BOUND = 4096;
// The quote that opens a reference-free value, or none (see CREDENTIAL_PLAIN).
// Every "at least eight" count on a negated class is spelled `{8}` then `*`:
// V8 compiles `[^\s"]{8,}` with a backtrack entry per character, so a value of
// millions of characters overflowed the stack and the guard failed open.
const CREDENTIAL_OPEN = String.raw`"(?=[^"\s]{8}[^"\s]*")|'(?=[^'\s]{8}[^'\s]*')|(?!["'])`;
const CREDENTIAL_PLAIN =
  String.raw`(?![<[$/]|~\/|\.\.?\/|[A-Za-z][\w+.-]*:\/\/|%[A-Za-z_]\w*%(?=$|[\s"',;)}\]<>&|\\])|[A-Za-z]:[\\/]|(?<=")(?:(?:[A-Za-z_]\w*\.){1,${EXCLUSION_REPEAT_BOUND}}[A-Za-z_]\w*|[A-Za-z]+(?:-[A-Za-z]+){0,${EXCLUSION_REPEAT_BOUND}}|(?:[\w.-]+\/){1,${EXCLUSION_REPEAT_BOUND}}[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,4})"|(?<=')(?:(?:[A-Za-z_]\w*\.){1,${EXCLUSION_REPEAT_BOUND}}[A-Za-z_]\w*|[A-Za-z]+(?:-[A-Za-z]+){0,${EXCLUSION_REPEAT_BOUND}}|(?:[\w.-]+\/){1,${EXCLUSION_REPEAT_BOUND}}[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,4})'|(?<!["'])[A-Za-z]+(?:-[A-Za-z]+){0,${EXCLUSION_REPEAT_BOUND}}(?![\w!@#$%^&*.+\-=/~])|(?<!["'])(?:[A-Za-z_]\w*\.){1,${EXCLUSION_REPEAT_BOUND}}[A-Za-z_]\w*(?![\w!@#$%^&*.+\-=/~])|(?<!["'])(?:[\w.-]+\/){1,${EXCLUSION_REPEAT_BOUND}}[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,4}(?=[\s,;)}\]]|$)|(?<!["'])[\w$.]+\()(?:(?<=")[^\s"]{8}[^\s"]*|(?<=')[^\s']{8}[^\s']*|(?<==)[A-Za-z0-9!@#$%^&*._+\-=/~?:|]{8,}|(?<!["'=])[A-Za-z0-9!@#$%^&*._+\-=/~]{8,})`;
// The grammar a reference-free value is judged by. A referenced value's literal
// is judged by it too, read as one double-quoted literal (literalValue).
const CREDENTIAL_LITERAL_VALUE = new RegExp(`(?:${CREDENTIAL_OPEN})(${CREDENTIAL_PLAIN})`, "iy");
const CREDENTIAL_MINIMUM_LITERAL_LENGTH = 8;
// pm-hw00c2: a value that holds a run-time reference (`${...}`, `$(...)`,
// `$NAME`, `<...>`), or that opens with a quoted piece concatenated to more
// text as a shell concatenates `"${EMPTY}"<literal>`, is captured whole, and
// the literal it spells once references expand is judged by
// CREDENTIAL_LITERAL_VALUE as data. So `${EMPTY}"<literal>"`, `$VAR"<literal>"`,
// `<x><literal>`, `ab${VAR}<literal>` and the literal default
// `${KEY:-<literal>}` are credentials, while a bare `${API_KEY}`, `$(cmd)`,
// `<placeholder>` or empty default spells nothing. A short literal (at most
// CREDENTIAL_LEADING_LITERAL characters) may come before the first reference;
// a longer one is judged as a reference-free value. References and quoted
// pieces are whitespace-free, as every credential value is, so a spaced
// command substitution is never read as one value, and every repeated group
// is bounded as in the password grammar.
// The shell control operators `|`, `||` and `&&` (`$(get_key)||fallback`,
// `${X}&&next`) end a referenced value, and so do `?` and `:`, which after a
// reference are code (`$TOKEN?.x`, `$TOKEN??fallback`). A single `&` is data
// (`${EMPTY}ab&cd…` in YAML), read as its own piece so every literal run stays
// one character class: a run repeated through an alternation grows the regex
// stack per character and a long value would make the guard fail open. A
// reference-free value keeps reading all of them through the baseline grammar.
const CREDENTIAL_RUN = String.raw`[A-Za-z0-9!@#%^*._+\-=/~]`;
/** A single `&`, which is data; `&&` is a control operator. */
const CREDENTIAL_AMPERSAND = String.raw`&(?!&)`;
const CREDENTIAL_LEADING_LITERAL = 64;
const CREDENTIAL_REFERENCE_SPAN = String.raw`'[^'\s]*'|"[^"\\\s]*(?:\\\S[^"\\\s]*){0,${PASSWORD_REPEAT_BOUND}}"`;
const CREDENTIAL_REFERENCE = String.raw`\$\{(?:${maximalRun(String.raw`[^{}$'"\\\s]`)}|\\\S|${CREDENTIAL_REFERENCE_SPAN}|\$(?!\{)|\$\{[^{}\s]*\}){0,${PASSWORD_REPEAT_BOUND}}\}`
  + String.raw`|\$\((?:${maximalRun(String.raw`[^()$'"\\\s]`)}|\\\S|${CREDENTIAL_REFERENCE_SPAN}|\$(?!\()|\$\([^()\s]*\)){0,${PASSWORD_REPEAT_BOUND}}\)`
  + String.raw`|<[^<>\s]*>|\$[A-Za-z_]\w*(?!\w)`;
const credentialPiece = (run: string): string => String.raw`${CREDENTIAL_REFERENCE}|${maximalRun(run)}|${CREDENTIAL_AMPERSAND}|\$(?![{(A-Za-z_])`;
const credentialQuotedPiece = (run: string): string =>
  String.raw`(?:"[^"\s]*"|'[^'\s]*')(?:${credentialPiece(run)}){0,${PASSWORD_REPEAT_BOUND}}`;
const credentialReferenced = (run: string): string =>
  String.raw`(?:(?:${run}|${CREDENTIAL_AMPERSAND}){1,${CREDENTIAL_LEADING_LITERAL}}(?=[$<]))?(?:${CREDENTIAL_REFERENCE})`
  + String.raw`(?:${credentialPiece(run)}){0,${PASSWORD_REPEAT_BOUND}}(?:${credentialQuotedPiece(run)}){0,${PASSWORD_QUOTED_PIECES}}`;
const credentialConcatenated = (run: string): string => String.raw`(?:${credentialQuotedPiece(run)}){1,${PASSWORD_QUOTED_PIECES}}`;
/** An unquoted value grammar: one that does not start right after a quote. */
const credentialUnquoted = (build: (run: string) => string): string => String.raw`(?<!["'])(?:${build(CREDENTIAL_RUN)})`;
// A quoted piece opens a concatenation when a reference or another quoted
// piece follows it directly, or when it holds a reference and a letter, digit
// or non-operator symbol (`_ @ # ~`, or a `!` that no operator, member
// access or call follows) follows. A quoted piece followed by an operator is
// code (`"<literal>".trim()`, `"${KEY}".toUpperCase()`, `"${KEY}"!.length`,
// `"${KEY}"^mask`, `"Bearer"+value`) and stays a quoted value.
const CREDENTIAL_CONCATENATION_CONTINUES = String.raw`(?:[\w@#~]|!(?![.+\-*/%=^!(]))`;
const CREDENTIAL_CONCATENATION_OPEN = String.raw`(?=(?:"[^"\s]*"|'[^'\s]*')[$<"']`
  + String.raw`|"(?=[^"\s]*[$<])[^"\s]*"${CREDENTIAL_CONCATENATION_CONTINUES}|'(?=[^'\s]*[$<])[^'\s]*'${CREDENTIAL_CONCATENATION_CONTINUES})`;
// A quoted body that holds a reference opener is captured whole up to its closing quote.
const CREDENTIAL_QUOTED_REFERENCED = String.raw`(?<=")(?=[^"\s]*[$<])[^"\s]+|(?<=')(?=[^'\s]*[$<])[^'\s]+`;
const CREDENTIAL_VALUE = new RegExp(
  `(?:${CREDENTIAL_CONCATENATION_OPEN}|${CREDENTIAL_OPEN})`
    + `((?=["'])(?:${credentialUnquoted(credentialConcatenated)})|${CREDENTIAL_QUOTED_REFERENCED}`
    + `|${credentialUnquoted(credentialReferenced)}|${CREDENTIAL_PLAIN})`,
);
const HIGH_ENTROPY_VALUE = /["']?([A-Za-z0-9+/=_-]{24,})/;

/** Canonical patterns; repository exemptions never exempt mutation payloads. */
export const SECRET_RULES = [
  { name: "private-key", mutationRule: "private_key", category: "credential", regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  { name: "github-token", mutationRule: "github_token", category: "credential", regex: /\b(?:gh[opsru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: "npm-token", mutationRule: "npm_token", category: "credential", regex: /\bnpm_[A-Za-z0-9]{20,}\b/g },
  { name: "aws-access-key", mutationRule: "aws_access_key", category: "credential", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "google-api-key", mutationRule: "google_api_key", category: "credential", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "slack-token", mutationRule: "slack_token", category: "credential", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "anthropic-api-key", mutationRule: "anthropic_api_key", category: "credential", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  // Matches bare sk-, sk-proj-, and sk-svcacct- OpenAI key formats. A prefix
  // alternation would be redundant here: the prefixes' characters are a subset
  // of the payload class, so backtracking makes them absorbable either way.
  { name: "openai-api-key", mutationRule: "openai_api_key", category: "credential", regex: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
  // Dot included for GitLab's newer routable PAT format (glpat-<base64>.<len>.<crc>).
  { name: "gitlab-token", mutationRule: "gitlab_token", category: "credential", regex: /\bglpat-[A-Za-z0-9_.-]{20,}\b/g },
  { name: "jwt-like-token", mutationRule: "jwt_like_token", category: "credential", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "npm-auth-token-assignment", mutationRule: "npm_auth_token_assignment", category: "credential", regex: /_authToken\s*=\s*\S+/g },
  { name: "sentry-user-token", mutationRule: "sentry_user_token", category: "credential", regex: /\bsntryu_[A-Za-z0-9]{20,}\b/g },
  { name: "sentry-org-token", mutationRule: "sentry_org_token", category: "credential", regex: /\bsntrys_[A-Za-z0-9_-]{20,}\b/g },
  {
    name: "private-ip", mutationRule: "private_ip", category: "network",
    regex:
      /\b(?:10\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|172\.(?:1[6-9]|2\d|3[01])\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|192\.168\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d))\b/g,
  },
  {
    name: "private-ssh-target", mutationRule: "private_ssh_target", category: "network",
    regex:
      /\b(?:ssh|scp|rsync)\s+[A-Za-z0-9._-]+@(?:10\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|172\.(?:1[6-9]|2\d|3[01])\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|192\.168\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d))\b/g,
  },
  { name: "sshpass-inline-password", mutationRule: "sshpass_inline_password", category: "credential", regex: /\bsshpass\s+-p\s+["'][^"']{6,}["']/g },
  {
    name: "password-assignment", mutationRule: "password_assignment", category: "credential",
    regex: new RegExp(String.raw`\b(?:${PASSWORD_KEYS})\s*[:=]\s*` + PASSWORD_VALUE.source, "gi"),
    structured: { keys: PASSWORD_KEYS, value: PASSWORD_VALUE.source, element: true },
    minimumLiteralLength: PASSWORD_MINIMUM_LITERAL_LENGTH,
  },
  {
    name: "absolute-home-path", mutationRule: "absolute_home_path", category: "path",
    regex: PRIVATE_HOME_PATH_PATTERN,
    excludeFiles: /^(?:tests\/|examples\/)/,
  },
  {
    name: "user-at-private-host", mutationRule: "user_at_private_host", category: "network",
    // The local part starts only where a run of local-part characters starts,
    // never at a `\b` inside it: every `-` or `.` in a long run would otherwise
    // restart the greedy run and make the scan quadratic. A run that starts
    // with a dot or hyphen (`-user@...`) is still matched from its first
    // character.
    regex:
      /(?<![A-Za-z0-9._-])[A-Za-z0-9._-]+@(?:10\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|172\.(?:1[6-9]|2\d|3[01])\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|192\.168\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d))\b/g,
    excludeFiles: /^(?:tests\/|examples\/)/,
  },
  {
    name: "high-entropy-assignment", mutationRule: "high_entropy_assignment", category: "credential",
    regex: new RegExp(String.raw`\b(?:${HIGH_ENTROPY_KEYS})\s*[:=]\s*` + HIGH_ENTROPY_VALUE.source, "gi"),
    structured: { keys: HIGH_ENTROPY_KEYS, value: HIGH_ENTROPY_VALUE.source },
    mutationOnlyReason: "Generic assignments in source code are not credentials; preserve the existing mutation heuristic without treating source identifiers as secrets.",
    minimumEntropy: 3.5,
  },
  {
    name: "credential-key-assignment", mutationRule: "credential_key_assignment", category: "credential",
    regex: new RegExp(String.raw`\b(?:${CREDENTIAL_KEYS})\s*[:=]\s*` + CREDENTIAL_VALUE.source, "gi"),
    structured: { keys: CREDENTIAL_KEYS, value: CREDENTIAL_VALUE.source, element: true, elementValue: true },
    mutationOnlyReason: "Key-named assignments in source code and test fixtures are identifiers and synthetic data; repository scans keep the token-format rules, which recognize real credentials there.",
    minimumEntropy: 3,
    minimumLiteralLength: CREDENTIAL_MINIMUM_LITERAL_LENGTH,
    literalValue: CREDENTIAL_LITERAL_VALUE,
    // The reference-free grammar is scanned too, so the referenced reading only adds findings.
    baseline: {
      regex: new RegExp(String.raw`\b(?:${CREDENTIAL_KEYS})\s*[:=]\s*` + CREDENTIAL_LITERAL_VALUE.source, "gi"),
      value: CREDENTIAL_LITERAL_VALUE.source,
    },
    // SSH key-file names (`keys/id_ed25519`) are references, never credentials.
    rejectValue: /^(?:[\w.-]+\/)*id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:\.pub)?$/u,
    // `= DEFAULT_TOKEN;` names a constant; `"ZQVNKR_LMPWXYAB"` or `KEY=ZQVNKR_LMPWXYAB` may be a literal.
    rejectStatementReference: /^[A-Z]+(?:_[A-Z]+)+$/u,
  },
] as const satisfies readonly SecretRule[];

/** Share matching and normalization, returning locations rather than matched values. */
export function* findSecretRuleMatches(rule: SecretRule, content: string): Generator<SecretRuleMatch> {
  if (rule.mutationRule === "absolute_home_path") {
    yield* findPrivateHomePathMatches(content, rule.regex);
    return;
  }
  for (const reading of ruleReadings(rule)) {
    yield* flatMatches(reading, content);
    if (reading.structured) yield* findStructuredSpellingMatches(reading, reading.structured, content);
  }
}

/** Baseline readings derived once per rule. */
const baselineRules = new WeakMap<SecretRule, SecretRule>();

/**
 * The rule itself, then the rule that judges its baseline reading. The
 * baseline judges captured text exactly as the narrower grammar always did:
 * with the rule's keys, value and entropy predicates, but without the literal
 * minimum or literal grammar that read references, so its findings are the
 * narrower rule's findings.
 */
function ruleReadings(rule: SecretRule): readonly SecretRule[] {
  const baseline = rule.baseline;
  if (baseline === undefined) return [rule];
  let judged = baselineRules.get(rule);
  if (judged === undefined) {
    judged = { ...rule, regex: baseline.regex, minimumLiteralLength: undefined, literalValue: undefined, baseline: undefined };
    if (rule.structured) judged.structured = { ...rule.structured, value: baseline.value };
    baselineRules.set(rule, judged);
  }
  return [rule, judged];
}

/** Whether `index` starts the parameter name of a braced reference: `${NAME`, `${#NAME` or `${!NAME`. */
function isParameterName(content: string, index: number): boolean {
  const name = content[index - 1] === "#" || content[index - 1] === "!" ? index - 1 : index;
  return content[name - 1] === "{" && content[name - 2] === "$";
}

/** Inner matches in shell context: inside a command substitution and outside its quoted text. */
const INNER_SHELL_MATCHES = new WeakSet<RegExpMatchArray>();

/** For a match the rescan found inside a rejected reference value, where that reference's own closer stands. */
const INNER_CLOSE_AT = new WeakMap<RegExpMatchArray, number>();

/** One `${...}` or `$(...)` reference inside a captured value, by absolute offsets. */
interface ReferenceSpan {
  open: number;
  close: number;
  /** A command substitution `$(...)`, where shell syntax applies; a braced reference's word is plain text. */
  command: boolean;
  /** Quoted ranges `[start, end]` directly inside this reference (not inside a nested one), in order. */
  quoted: Array<[number, number]>;
}

/** Characters searched past a captured value for the closer of a reference the value grammar cut short. */
const CUT_REFERENCE_BOUND = 4096;

/**
 * The braced and command references in a captured value, in opening order,
 * found in one linear walk. Inside a reference, quoted spans and escapes
 * never close it (`$(printf ")"; …)`). A reference the value grammar cut short (a quoted
 * piece ends at its first closing quote, so a command substitution holding a
 * quoted argument is cut there) closes where the text closes it, searched a
 * bounded distance; otherwise it extends to the end of the value.
 */
function referenceSpans(content: string, offset: number, text: string): ReferenceSpan[] {
  const spans: ReferenceSpan[] = [];
  const open: OpenReference[] = [];
  const end = offset + text.length;
  walkReferences(content, offset, end, open, spans);
  // References the value grammar cut short close where the following text
  // closes them; one shared, bounded continuation resolves all of them.
  walkReferences(content, end, Math.min(content.length, end + CUT_REFERENCE_BOUND), open);
  return spans;
}

/**
 * Walk `content` from `start` to `end`, opening and closing references on the
 * `open` stack. A reference opened while `spans` is given is recorded there;
 * an unclosed one keeps the end of the value as its close. Stops early once
 * every reference opened by a recording walk has closed.
 */
function walkReferences(content: string, start: number, end: number, open: OpenReference[], spans?: ReferenceSpan[]): void {
  for (let index = start; index < end && (spans !== undefined || open.length > 0); index += 1) {
    const frame = open.at(-1);
    if (content[index] === "$" && (content[index + 1] === "{" || content[index + 1] === "(") && frame?.quoted !== "'") {
      // A span opened by the continuation is never recorded; only its pairing matters.
      const span: ReferenceSpan = { open: index, close: end, command: content[index + 1] === "(", quoted: [] };
      spans?.push(span);
      open.push({ span, closer: content[index + 1] === "{" ? "}" : ")" });
      index += 1;
    } else if (frame !== undefined) {
      index = referenceStep(content, index, open);
    }
  }
}

/** One reference still open during the span walk, with the quote it is inside of, if any. */
interface OpenReference {
  span: ReferenceSpan;
  closer: string;
  quoted?: "\"" | "'";
  /** Where the current quoted range started. */
  quoteStart?: number;
}

/**
 * Advance the span walk inside the innermost open reference by one character
 * (two for an escape). As in the expansion walker, quotes inside a reference
 * hide its closer: a single-quoted span is inert, and a double-quoted span
 * still opens nested references (`"$(get …)"`) but never closes this one.
 */
function referenceStep(text: string, index: number, open: OpenReference[]): number {
  const frame = open.at(-1)!;
  const character = text[index];
  if (character === "\\" && frame.quoted !== "'") return index + 1;
  if (frame.quoted !== undefined) {
    if (character === frame.quoted) {
      frame.span.quoted.push([frame.quoteStart!, index]);
      frame.quoted = undefined;
    }
  } else if (character === "'" || character === "\"") {
    frame.quoted = character;
    frame.quoteStart = index;
  } else if (character === frame.closer) {
    open.pop()!.span.close = index;
  }
  return index;
}

/**
 * A lookup of the innermost reference enclosing each position, for positions
 * asked in increasing order: one sweep over the spans, so the rescan stays
 * linear. Returns that reference, or undefined.
 */
function enclosingCloser(spans: readonly ReferenceSpan[]): (position: number) => ReferenceSpan | undefined {
  const active: ReferenceSpan[] = [];
  let next = 0;
  return (position) => {
    for (; next < spans.length && spans[next]!.open < position; next += 1) {
      while (active.length > 0 && active.at(-1)!.close < spans[next]!.open) active.pop();
      active.push(spans[next]!);
    }
    while (active.length > 0 && active.at(-1)!.close < position) active.pop();
    return active.at(-1);
  };
}

/** Whether `position` lies in one of a reference's own quoted ranges (sorted, disjoint); a binary search. */
function insideQuotedRange(span: ReferenceSpan, position: number): boolean {
  let low = 0;
  let high = span.quoted.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = span.quoted[middle]!;
    if (position < start) high = middle - 1;
    else if (position > end) low = middle + 1;
    else return true;
  }
  return false;
}

/** A reference or placeholder opener inside a captured value. */
const VALUE_REFERENCE = /\$[({A-Za-z_]|</u;
/** For a flat match whose value sits in a string, where that string's closing quote ends it (see enclosingStringClose). */
const ENCLOSING_STRING_CLOSE = new WeakMap<RegExpMatchArray, number>();

/**
 * Flat matches of one reading. A rule with a literal minimum also judges the
 * keys inside a rejected referenced value, because a whole-value reference
 * hides them from a scan that resumes after the match (pm-bn3ppf); see
 * rescanDepth for how far it reaches while staying linear.
 */
function* flatMatches(rule: SecretRule, content: string): Generator<SecretRuleMatch> {
  // Every scan owns its cursor, so a scan suspended at a yield never moves another one's.
  const regex = new RegExp(rule.regex);
  const rescan = rescanDepth(rule);
  // A scanner for keys inside rejected values, created on first use; every scan owns its own cursor.
  let inner: RegExp | undefined;
  // Only a rule with a literal minimum reads quoted pieces after a value, so only it ends
  // a value at the string it sits in (GH-1775); the lexer is created on first use.
  let lexer: StringLexer | undefined;
  for (let found = regex.exec(content); found !== null; found = regex.exec(content)) {
    let match = found;
    if (rule.minimumLiteralLength !== undefined) {
      lexer ??= createStringLexer(content);
      const end = found.index + found[0].length;
      const valueStart = end - found[1]!.length;
      const close = enclosingStringClose(lexer, valueStart, end);
      // A value is never cut at its own first character: a quote there may be the value's own
      // opening quote after a stray apostrophe, so the grammar's reading is kept.
      if (close > valueStart) {
        if (close < end) {
          match = truncateMatch(found, close);
          // Resume at the closing quote, so keys in the members the grammar read past are still scanned.
          regex.lastIndex = close;
        }
        ENCLOSING_STRING_CLOSE.set(match, close);
      }
    }
    if (acceptsSecretMatch(rule, match)) {
      yield { index: match.index! };
    } else if (rescan !== undefined && VALUE_REFERENCE.test(match[1])) {
      inner ??= new RegExp(regex);
      yield* keysInsideRejectedValue(rule, inner, content, match, rescan === "deep");
    }
  }
}

/**
 * How a rule rescans a rejected referenced value. A rule whose only predicate
 * is its literal minimum enters rejected inner values too ("deep"): its
 * rejected value spells fewer literal characters than any of its keys with a
 * separator, so every key inside sits in a reference body, and bodies nest a
 * bounded number of levels. Any other rule with a literal minimum judges each
 * inner key once and resumes after it ("shallow"), so each character is read
 * at most twice; its baseline reading covers keys the narrower grammar visits.
 * A shallow rescan reaches one level: a referenced credential nested inside a
 * rejected inner value two references deep is not judged by the referenced
 * reading (a recorded limit; the reference-free grammar never judged it).
 */
function rescanDepth(rule: SecretRule): "deep" | "shallow" | undefined {
  if (rule.minimumLiteralLength === undefined) return undefined;
  const literalOnly = rule.minimumEntropy === undefined && rule.literalValue === undefined && rule.rejectValue === undefined;
  return literalOnly ? "deep" : "shallow";
}

/**
 * Judge each key that starts inside a rejected value (`password=$(echo
 * password=…)`). With `deep`, a rejected inner value that holds a reference is
 * entered in turn, so a deeper assignment is reached too; each key is judged
 * once.
 */
function* keysInsideRejectedValue(
  rule: SecretRule,
  inner: RegExp,
  content: string,
  match: RegExpMatchArray,
  deep: boolean,
): Generator<SecretRuleMatch> {
  const end = match.index! + match[0].length;
  inner.lastIndex = end - match[1].length;
  // Matches arrive in increasing order, so one sweep finds each one's innermost
  // enclosing reference; the spans are walked only once a key is found inside.
  let closerAt: ((position: number) => ReferenceSpan | undefined) | undefined;
  for (let found = inner.exec(content); found !== null && found.index < end; found = inner.exec(content)) {
    // A key word that names a braced reference's parameter (`${PASSWORD:OFFSET:8}`) is not an
    // assignment, but its word may hold one (`${PASSWORD:-$(echo password=…)}`): scan on from the key.
    if (isParameterName(content, found.index)) {
      inner.lastIndex = found.index + 1;
      continue;
    }
    closerAt ??= enclosingCloser(referenceSpans(content, end - match[1].length, match[1]));
    const span = closerAt(found.index);
    if (span !== undefined) {
      INNER_CLOSE_AT.set(found, span.close);
      // Shell syntax applies only in a command substitution, outside its quoted text.
      if (span.command && !insideQuotedRange(span, found.index)) INNER_SHELL_MATCHES.add(found);
    }
    if (acceptsSecretMatch(rule, found)) yield { index: found.index };
    else if (deep && VALUE_REFERENCE.test(found[1])) inner.lastIndex = found.index + found[0].length - found[1].length;
  }
}

interface CompiledSpelling {
  key: RegExp;
  value: RegExp;
  element?: CompiledElement;
}

/** Element spelling patterns: the opening tag, and sticky closing-tag and markup-span patterns for the body scan. */
interface CompiledElement {
  open: RegExp;
  close: RegExp;
  span: RegExp;
}

const compiledSpellings = new Map<string, CompiledSpelling>();
const LINE_BREAK = /[\r\n\u2028\u2029]/u;

/** Compile once per distinct spelling; repository scans clone rules but share spellings. */
function compileSpelling(spelling: SecretStructuredSpelling): CompiledSpelling {
  const cacheKey = `${spelling.keys}\u0000${spelling.value}\u0000${spelling.element === true}`;
  let compiled = compiledSpellings.get(cacheKey);
  if (!compiled) {
    compiled = {
      key: new RegExp(String.raw`\b(?:${spelling.keys})(["']?)\s*[:=]\s*`, "gi"),
      // `d` records capture offsets, so a decoded literal's original span can be judged.
      value: new RegExp(spelling.value, "iyd"),
      // An element body may hold placeholder or markup spans such as `<x>`
      // (`<password><x>literal</password>`), never another element of the
      // same keys, so the body still ends at the first closing credential tag.
      // The body is scanned in code (elementBodyEnd), never by a repeated
      // regex group, so its length cannot exhaust the regex backtrack stack.
      ...(spelling.element
        ? {
          element: {
            open: new RegExp(String.raw`<(?:${spelling.keys})(?:\s[^<>]*)?>`, "gi"),
            close: new RegExp(String.raw`<\/(?:${spelling.keys})\s*>`, "iy"),
            span: new RegExp(String.raw`<(?!\/?(?:${spelling.keys})\b)[^<>]*>`, "iy"),
          },
        }
        : {}),
    };
    compiledSpellings.set(cacheKey, compiled);
  }
  return compiled;
}

/** The index after a quoted string, honoring backslash escapes; an unterminated string ends the input. */
function scanQuoted(content: string, start: number): { end: number; terminated: boolean } {
  const quote = content[start];
  for (let index = start + 1; index < content.length; index += 1) {
    const character = content[index];
    if (character === "\\") index += 1;
    else if (character === quote) return { end: index + 1, terminated: true };
  }
  return { end: content.length, terminated: false };
}

function endOfQuoted(content: string, start: number): number {
  return scanQuoted(content, start).end;
}

/** An object member's value takes the member judgment; an array element the element judgment. */
function judgeFor(closers: readonly string[], accepts: (at: number) => boolean, acceptsMember: (at: number) => boolean): (at: number) => boolean {
  return closers.at(-1) === "}" ? acceptsMember : accepts;
}

/**
 * Walk one array/object once, testing every quoted string in value position.
 * Keys, bare tokens and placeholders such as `[scrubbed]` are never judged.
 * An array element is judged by `accepts`. An object member's value is judged
 * by `acceptsMember`, because a member such as `"description"` in a JSON
 * Schema holds prose, not a credential.
 */
function walkContainer(
  content: string,
  start: number,
  accepts: (at: number) => boolean,
  acceptsMember: (at: number) => boolean = accepts,
): { found: boolean; end: number } {
  const closers: string[] = [];
  let expectKey = false;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    switch (character) {
      case "[":
      case "{":
        closers.push(character === "[" ? "]" : "}");
        expectKey = character === "{";
        break;
      case "]":
      case "}":
        if (closers.pop() !== character || closers.length === 0) return { found: false, end: index + 1 };
        expectKey = false;
        break;
      case ",":
        expectKey = closers.at(-1) === "}";
        break;
      case ":":
        expectKey = false;
        break;
      case "\"":
      case "'":
        if (!expectKey && judgeFor(closers, accepts, acceptsMember)(index)) return { found: true, end: index };
        index = endOfQuoted(content, index) - 1;
        break;
      default:
        break;
    }
  }
  return { found: false, end: content.length };
}

/** One complete escape sequence in a JSON, Python or YAML string literal. */
const ESCAPE_SEQUENCE = /\\(?:U[0-9a-fA-F]{8}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[0-7]{1,3}|[\s\S])/gu;
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" };

/**
 * Decode a quoted literal (JSON, YAML and Python escapes, including
 * eight-digit `\\U` code points and octal escapes) so the value grammar judges what it represents:
 * its length, whitespace, placeholder prefix and entropy. In the grammar's
 * reading a decoded quote of the literal's own kind becomes the other quote
 * and a line break produced by an escape becomes a space; the original keeps
 * both. The caller rejects raw line breaks first.
 */
function decodeQuotedLiteral(literal: string, terminated: boolean): DecodedLiteral {
  const quote = literal[0]!;
  const body = literal.slice(1, terminated ? -1 : undefined).replaceAll(ESCAPE_SEQUENCE, (sequence) => {
    const kind = sequence[1]!;
    // An incomplete `\\u` or `\\x` (too few hex digits) falls back to its letter below.
    if ((kind === "u" || kind === "x") && sequence.length > 2) return String.fromCharCode(Number.parseInt(sequence.slice(2), 16));
    // Python octal escapes; `\\0` alone is the NUL character as in JSON5 and C.
    if (/^[0-7]$/u.test(kind)) return String.fromCharCode(Number.parseInt(sequence.slice(1), 8));
    if (kind === "U" && sequence.length === 10) {
      // YAML and Python eight-digit escapes; an out-of-range code point stays one opaque character.
      const codePoint = Number.parseInt(sequence.slice(2), 16);
      return codePoint <= 0x10_ffff ? String.fromCodePoint(codePoint) : "\ufffd";
    }
    return SIMPLE_ESCAPES[kind] ?? kind;
  });
  const neutral = body.replaceAll(quote, quote === "\"" ? "'" : "\"").replaceAll(/[\r\n\u2028\u2029]/gu, " ");
  const close = terminated ? quote : "";
  return { reading: `${quote}${neutral}${close}`, ...literalBody(`${quote}${body}${close}`, terminated) };
}

/** A literal read as written: its delimiters are syntax and everything between them is data. */
function literalBody(original: string, terminated: boolean): Omit<DecodedLiteral, "reading"> {
  return { original, bodyStart: 1, bodyEnd: original.length - (terminated ? 1 : 0) };
}

/**
 * A decoded quoted literal. The value grammar reads `reading`, whose own-kind
 * quotes and line breaks are neutralized so they cannot end it early; every
 * replacement is one character for one, so a capture's offsets also locate the
 * decoded `original`, which the rule's predicates judge (pm-jcz7qz).
 */
interface DecodedLiteral {
  /** Neutralized reading for the value grammar. */
  reading: string;
  /** Decoded literal with its own quote characters and line breaks. */
  original: string;
  /** Offset of the first data character, after the opening delimiter. */
  bodyStart: number;
  /** Offset after the last data character, before the closing delimiter when there is one. */
  bodyEnd: number;
}
/** Longest prefix scanned back to the opening quote of a prefixed quoted key. */
const MAX_KEY_PREFIX = 64;

/**
 * Classify the key that ends at `index`: `exact` when the key word is the
 * whole key, `prefixed` when other key text precedes it (`db_password`,
 * `"reset-password"`), and `malformed` for a closing quote with no opening
 * quote on the same line within a bounded prefix.
 */
function keyShape(content: string, index: number, quote: string): "exact" | "prefixed" | "malformed" {
  const previous = content[index - 1];
  if (!quote) return previous !== undefined && /[\p{L}\p{N}_.-]/u.test(previous) ? "prefixed" : "exact";
  if (previous === quote) return "exact";
  const floor = Math.max(0, index - MAX_KEY_PREFIX);
  for (let cursor = index - 1; cursor >= floor; cursor -= 1) {
    const character = content[cursor];
    if (character === quote) return "prefixed";
    if (character === "\n" || character === "\r" || character === "\"" || character === "'") return "malformed";
  }
  return "malformed";
}

interface ValueJudge {
  /** The flat grammar matches at `at`; for an unquoted key that is the flat rule's finding. */
  direct(at: number): boolean;
  /** A literal with escapes at `at` matches in its decoded length. */
  escaped(at: number): boolean;
  /** Judge one value; a prefixed key's value must also be whitespace-free. */
  accepts(compact: boolean): (at: number) => boolean;
}

/**
 * Bind a rule's value grammar to one content string. With `alwaysDecode`, a
 * quoted literal is judged as decoded data even when it holds no escape, as
 * for a serialized payload string, which is always complete.
 */
function createValueJudge(rule: SecretRule, value: RegExp, content: string, alwaysDecode = false): ValueJudge {
  // A JSON, Python or YAML-flow string literal never spans a raw line break, so
  // a structured value that does is a host-language artifact, not a credential.
  // With an `original`, the grammar reads `text` but the predicates judge the
  // same span of the decoded original (see DecodedLiteral).
  const valueMatch = (text: string, at: number, decoded?: DecodedLiteral): RegExpExecArray | null => {
    value.lastIndex = at;
    const match = value.exec(text);
    if (match === null || LINE_BREAK.test(match[0])) return null;
    const span = match.indices?.[1];
    if (decoded !== undefined && span !== undefined) {
      // The literal's own delimiters are syntax; every decoded character
      // between them, quotes included, is data.
      match[1] = decoded.original.slice(Math.max(span[0], decoded.bodyStart), Math.min(span[1], decoded.bodyEnd));
      DECODED_DATA_MATCHES.add(match);
    }
    return acceptsSecretMatch(rule, match) ? match : null;
  };
  // The value grammar is quote-blind, so a literal with escapes is judged in
  // its decoded form. Every common format decodes escapes in double quotes; in
  // single quotes TOML and YAML keep backslashes literally while Python and
  // JavaScript decode them, so a single-quoted value is judged under both
  // readings. Undefined means no escaped literal starts here.
  const escapedMatches = (at: number): RegExpExecArray[] | undefined => {
    if (content[at] !== "\"" && content[at] !== "'") return undefined;
    const { end, terminated } = scanQuoted(content, at);
    const literal = content.slice(at, end);
    if (!alwaysDecode && !literal.includes("\\")) return undefined;
    // A raw line break is a host-language artifact before any escape is decoded.
    if (LINE_BREAK.test(literal)) return [];
    const decoded = decodeQuotedLiteral(literal, terminated);
    const readings = content[at] === "'" ? [decoded, { reading: literal, ...literalBody(literal, terminated) }] : [decoded];
    return readings.map((reading) => valueMatch(reading.reading, 0, reading)).filter((match): match is RegExpExecArray => match !== null);
  };
  const valuesAt = (at: number): RegExpExecArray[] => {
    const escaped = escapedMatches(at);
    if (escaped !== undefined) return escaped;
    const match = valueMatch(content, at);
    return match === null ? [] : [match];
  };
  return {
    direct: (at) => valueMatch(content, at) !== null,
    escaped: (at) => (escapedMatches(at)?.length ?? 0) > 0,
    // A prefixed key (`reset-password`, `"New password"`) labels prose as often
    // as it holds a credential, so only a whitespace-free reading counts for it.
    // A rule judged by its literal checks the literal, so whitespace inside a
    // reference such as `$(op read pw)` never hides a compact credential.
    accepts: (compact) => (at) => valuesAt(at).some((match) => !(compact && /\s/u.test(compactReading(rule, match)))),
  };
}

/** The text a prefixed key's whitespace check reads: the literal for literal-judged rules, else the whole match. */
function compactReading(rule: SecretRule, match: RegExpExecArray): string {
  return rule.minimumLiteralLength === undefined ? match[0] : judgedLiteral(match);
}

/** Matches whose capture is a decoded literal's data, judged without shell quote removal. */
const DECODED_DATA_MATCHES = new WeakSet<RegExpMatchArray>();

/**
 * The literal a matched value spells. Text quotes delimit quoted pieces, but a
 * decoded literal's characters are all data (`"ab\"cdefg"` spells eight), and
 * so is the body of a quoted value whose quotes the grammar read outside the
 * capture (a credential-key value), so only their references expand.
 */
function judgedLiteral(match: RegExpMatchArray): string {
  // Inside a command substitution, the inner value ends at its first shell operator (`$PW&&next`).
  // A quoted value's body is data, never shell syntax, so only an unquoted inner value is cut.
  const word = INNER_SHELL_MATCHES.has(match) && !isQuote(captureOpener(match)) ? shellWordPrefix(match[1]) : undefined;
  const text = word ?? match[1];
  if (word === undefined && isWholePercentReference(match, text)) return "";
  const variables = word !== undefined || wordComplete(match);
  return DECODED_DATA_MATCHES.has(match) || isQuote(captureOpener(match))
    ? expandRuntimeReferences(text, variables)
    : literalAfterReferences(text, variables);
}

/** A Windows `%NAME%` reference with nothing around it, as an element body. */
const BARE_PERCENT_REFERENCE = /^%[A-Za-z_]\w*%$/u;
/** A Windows `%NAME%` reference, bare or in one pair of quotes, as a whole value. */
const PERCENT_REFERENCE = /^(["']?)%[A-Za-z_]\w*%\1$/u;

/**
 * Whether a captured value is one whole Windows `%NAME%` reference, which
 * spells no literal (GH-1775). `cmd.exe` reads `set NAME=value` to the end of
 * the line, so an unquoted text value is whole only when nothing but blanks
 * follows it on its line, or when it ends at the string it sits in (see
 * enclosingStringClose); a decoded literal is whole by construction, and a
 * quoted structured value (a quoted key's, or an array element) is whole when
 * structure follows its closing quote. A percent reference that more words follow on its
 * `set` line therefore keeps its literal reading.
 */
function isWholePercentReference(match: RegExpMatchArray, text: string): boolean {
  if (!PERCENT_REFERENCE.test(text)) return false;
  if (DECODED_DATA_MATCHES.has(match)) return true;
  const input = match.input!;
  const end = match.index! + match[0].length;
  if (ENCLOSING_STRING_CLOSE.get(match) === end) return true;
  let index = end;
  while (index < input.length && (input[index] === " " || input[index] === "\t")) index += 1;
  if (index === input.length || LINE_BREAK.test(input[index]!)) return true;
  // A quoted structured value (a quoted key's, or an array element) is whole when structure ends it,
  // padded or not (`{"password":"%X%" , …}`); a `set` line keeps whatever follows its quote.
  return isQuote(text[0]) && /[,;)}\]]/u.test(input[index]!) && isStructuredQuotedValue(match);
}

/** A quoted key and its separator right before a value, after the text's start, a blank or a bracket; never a quoted shell option (`--'password'=`). */
const LEADING_QUOTED_KEY_BEFORE = /(?:^|[\s{,[])(["'])[^"'\r\n]{1,256}\1\s*[:=]\s*$/u;

/**
 * Whether a quoted value is structured data: an array element, a quoted key's
 * value even at the start of the text, or a value after a `:` separator (JSON,
 * YAML flow `{password: "…", other: ok}`). A value after `=` is an assignment
 * (`set NAME="…"`, shell, dotenv), whose line goes on after its quote.
 */
function isStructuredQuotedValue(match: RegExpMatchArray): boolean {
  if (structuredContext(match, false) !== undefined) return true;
  const input = match.input!;
  const valueStart = match.index! + match[0].length - match[1].length;
  const before = input.slice(Math.max(0, valueStart - STRUCTURED_LOOK_BACK), valueStart);
  return LEADING_QUOTED_KEY_BEFORE.test(before) || /:[ \t]*$/u.test(before);
}

/**
 * The part of a value before its first unquoted shell operator (`|`, `&`,
 * `;`, `<`, `>`) outside nested references, or undefined when it has none.
 * Read only for a key inside a command substitution, where shell syntax
 * applies; one linear pass.
 */
function shellWordPrefix(text: string): string | undefined {
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    // A captured value holds no top-level backslash: quoted pieces and references are skipped whole.
    if (character === "'" || character === "\"") index = quotedSpanEnd(text, index);
    else if (character === "$" && (text[index + 1] === "{" || text[index + 1] === "(")) index = Math.max(index, referenceEnd(text, index) - 1);
    else if (/[|&;<>]/u.test(character)) return text.slice(0, index);
  }
  return undefined;
}

/** A bounded run of structure after a value (`;` `,` `)` `}` `]`); only ASCII is read, so positions are exact. */
const STRUCTURE_RUN = /^[;,)}\]]{0,64}/u;

/**
 * Whether the value grammar read the whole word. An unquoted value did when
 * whitespace or the end of the text follows it, optionally after structure
 * such as `;` or `)` (`password=$PW;`). A value the grammar read as quoted
 * (its capture ends with the closing quote, or its opening quote precedes the
 * capture and the closing quote follows it) did as well when structure and
 * then the next member or element follows (`"$PW","x"`, `"$PW"},{"y"`), as in
 * compact JSON; a brace or bracket counts only when structure, not word text,
 * comes after it. Any other text after the match (`$PW:literal`, `$PW[literal`,
 * `$PW,"literal"`, `"$PW""literal"`) is part of the same word. So is a quote
 * after an unquoted value, which may open a concatenated piece
 * (`$PW" spaced literal"`) as well as close an enclosing string, unless the
 * lexical string states show that it closes the string the value sits in and
 * a word end follows (see enclosingStringClose). In either case the value is
 * not known to be a bare or leading variable, and its
 * `$NAME` text stays literal. The look-ahead is bounded, so judging stays
 * linear.
 */
function wordComplete(match: RegExpMatchArray): boolean {
  const input = match.input!;
  const end = match.index! + match[0].length;
  const closed = isQuote(captureOpener(match)) && isQuote(input[end]) ? end + 1 : isQuote(match[0].at(-1)) ? end : -1;
  const start = closed === -1 ? end : closed;
  const structure = STRUCTURE_RUN.exec(input.slice(start, start + WORD_END_BOUND))![0].length;
  const after = start + structure;
  if (after === input.length || /\s/u.test(input[after]!)) return true;
  if (endsAtRecordedCloser(match, start, end)) return true;
  if (closed === -1) return false;
  // The next-member shortcut holds only in structured text, where the value's
  // own key is quoted (`{"password":"$PW","x":…}`); after an unquoted key a
  // comma and a quoted piece continue the shell word (`password="$PW","…"`).
  if (structure === 0) return false;
  const context = structuredContext(match, closed === end + 1);
  const next = input.slice(after, after + 40);
  // A bare scalar sibling (`,1`) is structure only after an actual array element; after a quoted
  // key alone (`--'password'="$PW",1,…` in a shell) it continues the word.
  // After a closing brace or bracket the value's container has closed, so a bare scalar is the parent's next element.
  const closedContainer = /[}\]]/u.test(input.slice(start, after));
  return context !== undefined && (NEXT_MEMBER.test(next) || ((context === "element" || closedContainer) && BARE_SCALAR_MEMBER.test(next)));
}

/**
 * Whether a match's word ends at a closer the scan recorded for it. Inside a
 * rejected reference value, the closer of the reference the match sat in ends
 * its word whatever follows (`"$(get --password=$PW)${SUFFIX}"`); any other
 * parenthesis or brace, and one at the top level, is literal data
 * (`${A:?password=$PW)literal}`). Inside a command substitution, shell control
 * operators and redirections end a word too (`--password=$PW|filter`,
 * `$PW>/dev/null`); the caller has already handled the end of the input, so a
 * character stands at `start`. And the quote that closes the string a flat
 * match's value sits in ends its word (see enclosingStringClose).
 */
function endsAtRecordedCloser(match: RegExpMatchArray, start: number, end: number): boolean {
  if (INNER_CLOSE_AT.get(match) === start) return true;
  if (INNER_SHELL_MATCHES.has(match) && /[|&;<>]/u.test(match.input![start]!)) return true;
  return ENCLOSING_STRING_CLOSE.get(match) === end;
}

/**
 * Whether the value sits in structured text, looking back a bounded distance:
 * "element" for an array element (after `[` or `,`), "key" when its key ends
 * with a quote, as in JSON, YAML flow or a Python dict, or undefined.
 */
function structuredContext(match: RegExpMatchArray, openerOutsideCapture: boolean): "key" | "element" | undefined {
  const input = match.input!;
  const valueStart = match.index! + match[0].length - match[1].length - (openerOutsideCapture ? 1 : 0);
  const before = input.slice(Math.max(0, valueStart - STRUCTURED_LOOK_BACK), valueStart);
  if (ARRAY_ELEMENT_BEFORE.test(before)) return "element";
  return QUOTED_KEY_BEFORE.test(before) ? "key" : undefined;
}

/** How far back the structured context of a value is read: room for a long quoted key and pretty-printed indentation. */
const STRUCTURED_LOOK_BACK = 512;
/** An object member's quoted key (after `{` or `,`) and its separator directly before a value; a quoted shell option (`--'password'=`) is not one. */
const QUOTED_KEY_BEFORE = /[{,]\s*(["'])[^"'\r\n]{1,256}\1\s*[:=]\s*$/u;
/** An array's `[` or `,` directly before a value. */
const ARRAY_ELEMENT_BEFORE = /[[,]\s*$/u;

/**
 * The start of the next JSON member or element: a quote, or `{` / `[` that
 * opens structure or a complete JSON scalar (a number, `true`, `false`,
 * `null`) that a delimiter ends; never word text (`][literal`,
 * `][trueSecret`). A value longer than the bounded look-ahead is not
 * recognized.
 */
const NEXT_MEMBER = /^(?:["'`]|[{[](?:[\s"'`{[\]}]|$|(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)[\s,\]}]))/u;
/** A bare JSON scalar that a delimiter ends, the next element of an array (`["$PW",1]`). */
const BARE_SCALAR_MEMBER = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)[\s,\]}]/u;

/** Code units of structure read after a value before its word is taken as cut short. */
const WORD_END_BOUND = 64;
/** The lexical string states: no string open, a double-quoted one, a single-quoted one. */
const NO_STRING = 0;
const DOUBLE_STRING = 1;
const SINGLE_STRING = 2;

/** A letter, digit or underscore, after which a quote never opens a string (see StringLexer). */
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/** Whether a UTF-16 code unit is a line feed or carriage return, which end every string in the lexical pass. */
function isNewlineCode(code: number): boolean {
  return code === 0x0a || code === 0x0d;
}

/**
 * A forward-only lexical string scanner over one content string (GH-1775). A
 * quote opens a string of its kind when none is open and closes the open
 * string of its kind; a quote of the other kind inside a string is data; a
 * quote right after a letter, digit or underscore never opens one (in prose it
 * is an apostrophe such as `customer's` or a unit mark, and a code prefix such
 * as `f"…"` just keeps main's reading); a backslash escapes the next
 * character, except inside a single-quoted string a shell word opened (there
 * it is literal, as in the shell; a single-quoted container member, as in a
 * Python repr, keeps escapes); and a line feed or carriage return ends every string, as JSON,
 * Python and shell strings on one line read (U+2028 and U+2029 are data inside
 * a JSON string). Each flat scan owns one lexer and only ever moves it
 * forward, to the start of each value it judges and through a value that sits
 * in a string, so a scan reads each character at most once more.
 */
interface StringLexer {
  readonly content: string;
  /** Next position to read. */
  index: number;
  /** The string state before `index`. */
  state: number;
  /** Where the open string's opening quote stands, when one is open. */
  opener: number;
  /** Whether a backslash escapes inside the open string: always in a double-quoted one, in a single-quoted one only as a container member. */
  escapes: boolean;
}

function createStringLexer(content: string): StringLexer {
  return { content, index: 0, state: NO_STRING, opener: -1, escapes: true };
}

/** Read one character (two for an escape); returns the position of a quote that closed the open string, or -1. */
function lexStep(lexer: StringLexer): number {
  const { content } = lexer;
  const index = lexer.index;
  const code = content.charCodeAt(index);
  lexer.index = index + 1;
  if (isNewlineCode(code)) {
    lexer.state = NO_STRING;
    return -1;
  }
  if (code === 0x5c) {
    // A backslash is literal inside a shell single-quoted string (`note='C:\'`), but escapes in a
    // Python or JavaScript one that is a container member (`{'title': 'can\'t …'}`).
    if (lexer.escapes && index + 1 < content.length && !isNewlineCode(content.charCodeAt(index + 1))) lexer.index = index + 2;
    return -1;
  }
  if (code !== 0x22 && code !== 0x27) return -1;
  const kind = code === 0x22 ? DOUBLE_STRING : SINGLE_STRING;
  if (lexer.state === kind) {
    lexer.state = NO_STRING;
    return index;
  }
  if (lexer.state === NO_STRING && !(index > 0 && WORD_CHARACTER.test(content[index - 1]!))) {
    lexer.state = kind;
    lexer.opener = index;
    lexer.escapes = kind === DOUBLE_STRING || stringOpening(content, index).inContainer;
  }
  return -1;
}

/** Move the lexer to `position`; an escape that straddles it leaves the same state, since an escaped character never changes it. */
function advanceLexer(lexer: StringLexer, position: number): void {
  while (lexer.index < position) lexStep(lexer);
}

/** Where the string a value sits in opened: as a container member or element, or as an attribute value. */
interface StringOpening {
  inContainer: boolean;
  attribute: boolean;
}

/**
 * How the string that opened at `opener` sits. It is a member or element of a
 * container when its quote follows `[`, `{`, `,` or `:` and optional
 * whitespace, as in JSON, YAML flow or a Python repr; a string a command word
 * or prose opened (`echo "…"`, `Use "…"`) is a shell word or a quotation
 * instead. It is an attribute value when its quote follows `=` and optional
 * whitespace inside an open start tag (`<setting value="…"/>`,
 * `<setting value = "…"`, also across attribute lines), so only then does `>`
 * after its closing quote end it.
 */
function stringOpening(content: string, opener: number): StringOpening {
  let index = opener - 1;
  // JSON allows any whitespace, line breaks included, between a separator and a value, and XML
  // allows blanks around an attribute's `=` (`value = "…"`).
  while (index >= 0 && /\s/u.test(content[index]!)) index -= 1;
  const before = content[index];
  return { inContainer: before !== undefined && /[[{,:]/u.test(before), attribute: before === "=" && insideStartTag(content, index) };
}

/** Code units read back from an attribute's `=` for the start tag it sits in. */
const START_TAG_LOOK_BACK = 8192;

/**
 * Whether the `=` at `equals` sits inside an open XML or HTML start tag: read
 * back, skipping earlier quoted attribute values whole (a `>` inside one is
 * data), the first unquoted `<` that opens a tag name comes before any
 * unquoted `>` (`<setting value=`, also across attribute lines). An `=`
 * outside any tag (`x="…"`, a shell or dotenv assignment) opens no attribute
 * value, so `>` after its closing quote never ends the value there. The read
 * is bounded, and each `=` reads its own tag once.
 */
function insideStartTag(content: string, equals: number): boolean {
  const floor = Math.max(0, equals - START_TAG_LOOK_BACK);
  for (let index = equals - 1; index >= floor; index -= 1) {
    const character = content[index]!;
    if (character === ">") return false;
    if (character === "<") return /[A-Za-z]/u.test(content.charAt(index + 1));
    if (character === "\"" || character === "'") {
      const open = content.lastIndexOf(character, index - 1);
      if (open < floor) return false;
      index = open;
    }
  }
  return false;
}

/** Structure that may follow a closing quote before the next member, element or statement. */
const STRUCTURE_AFTER_STRING = /[,:;)}\]]/u;

/**
 * Whether the word a closing quote at `at` ends is complete: whitespace or the
 * end of the text follows it, or a bounded run of structure, optional blanks
 * and then a line break, the end of the text, or the next member or element
 * (`","x"`, `"},{"y"`, `"], "z"`, `");`, an unquoted YAML flow key) when the
 * string is a member or element of a container, or the end of an XML tag
 * (`"/>`, `">`) when the string is an attribute value (see stringOpening). Any other text after the quote,
 * such as another quote (`""…`) or a word (`"…`), continues a shell word.
 */
function endsWordAfterQuote(content: string, at: number, opening: StringOpening): boolean {
  let index = at + 1;
  if (endsRightAfterQuote(content, index, opening)) return true;
  const structureEnd = Math.min(content.length, index + WORD_END_BOUND);
  while (index < structureEnd && STRUCTURE_AFTER_STRING.test(content[index]!)) index += 1;
  if (index === at + 1) return false;
  // Blanks after the structure are padding, however many (each closing quote is read once).
  while (index < content.length && (content[index] === " " || content[index] === "\t")) index += 1;
  if (index === content.length || LINE_BREAK.test(content[index]!)) return true;
  // The next member or element after the structure ends the word only for a string in a container;
  // after a shell word's closing quote, `,"…"` is more of the same word (`echo "…${EMPTY}","…"`).
  if (!opening.inContainer) return false;
  // Read enough of the next token to see a long scalar or flow key whole (bounded, once per closer).
  const next = content.slice(index, index + NEXT_TOKEN_BOUND);
  return NEXT_MEMBER.test(next) || BARE_SCALAR_MEMBER.test(next) || YAML_FLOW_KEY.test(next);
}

/** Whether the text at `index`, right after a closing quote, ends the word: whitespace, the end, or an attribute value's tag end. */
function endsRightAfterQuote(content: string, index: number, opening: StringOpening): boolean {
  if (index === content.length || /\s/u.test(content[index]!)) return true;
  // An XML attribute value (`value="…"`) ends its tag (`"/>`, `">`).
  return opening.attribute && (content[index] === ">" || content.startsWith("/>", index));
}

/** Code units of the next member read after a closing quote's structure. */
const NEXT_TOKEN_BOUND = 512;
/** An unquoted YAML flow key and its separator, the next member of `{title: "…", updated: ok}`. */
const YAML_FLOW_KEY = /^[A-Za-z_][\w.-]{0,480}:(?:\s|$)/u;

/**
 * Where the string that a value starting at `valueStart` sits in closes, when
 * its closing quote lies inside the captured value or directly after it
 * (`end`) and ends the word there; -1 otherwise (GH-1775). In serialized JSON
 * text such as `{"title":"api_key: ${API_KEY}","updated":…}` the value sits in
 * the title string, whose closing quote ends it, so `","` and the next member
 * are never read as quoted pieces concatenated to it. A value outside every
 * string keeps its own quoted pieces (`password="$PW","…"`), and a closing
 * quote that another quote or a word follows (`"…${EMPTY}""…"`) continues the
 * shell word, as before. Each scan reads the value once.
 */
function enclosingStringClose(lexer: StringLexer, valueStart: number, end: number): number {
  advanceLexer(lexer, valueStart);
  const kind = lexer.state;
  if (kind === NO_STRING) return -1;
  const { content } = lexer;
  const opener = lexer.opener;
  const other = kind === DOUBLE_STRING ? "'" : "\"";
  // Whether the value opened a quoted span of the other kind that is still open: a closer there is
  // that span's data (`password: "v7'>…"` after a stray apostrophe), never the enclosing string's end.
  const own: OwnQuoteState = { open: false, placeholder: false, references: [] };
  const last = Math.min(end, content.length - 1);
  while (lexer.index <= last) {
    trackOwnQuote(own, content, lexer.index, other);
    const closed = lexStep(lexer);
    if (closed !== -1) {
      const insideOwnText = own.open || own.placeholder || own.references.length > 0;
      return closesValueAt(content, closed, end, insideOwnText) && endsWordAfterQuote(content, closed, stringOpening(content, opener)) ? closed : -1;
    }
    // A line break ended the string before any closing quote.
    if (lexer.state !== kind) return -1;
  }
  return -1;
}

/** A complete angle placeholder at the start of the text: no blank or other angle bracket before its `>`. */
const COMPLETE_PLACEHOLDER = /^<[^<>\s]{0,254}>/u;
/** Code units read ahead for a complete placeholder. */
const PLACEHOLDER_BOUND = 256;

/** The value's own quoted span state while the lexer walks it, whether an angle placeholder is open, and the references open there. */
interface OwnQuoteState {
  open: boolean;
  placeholder: boolean;
  /** Closers of the `${…}` and `$(…)` references open at the walk, innermost last. */
  references: string[];
}

/**
 * Read one character of a value for its own quote state. Quotes inside an
 * angle placeholder (`<team-'s-password>`) are its text and never open or
 * close the value's own span. A reference keeps its quotes, because the shell
 * reads them (`${X:-"…"}` holds a quoted default), and while one is open any
 * quote of the enclosing kind is its text too (`${X:-a'…'}`), so no closer
 * there ends the value. Elsewhere a quote of the other kind opens or closes
 * the span (see opensOwnQuote).
 */
function trackOwnQuote(own: OwnQuoteState, content: string, index: number, other: string): void {
  const character = content[index];
  if (own.open) {
    if (character === other) own.open = false;
  } else if (own.placeholder) {
    if (character === ">") own.placeholder = false;
  } else if (character === "$" && (content[index + 1] === "{" || content[index + 1] === "(")) {
    own.references.push(content[index + 1] === "{" ? "}" : ")");
  } else if (character === own.references.at(-1)) {
    own.references.pop();
  } else if (character === "<" && COMPLETE_PLACEHOLDER.test(content.slice(index, index + PLACEHOLDER_BOUND))) {
    // Only a complete placeholder (`<team-'s-password>`), never a redirection (`$(cat <file)`).
    own.placeholder = true;
  } else if (character === other) {
    own.open = opensOwnQuote(content, index);
  }
}

/**
 * Whether a quote of the other kind at `index`, outside any open span, opens
 * the value's own quoted span. An apostrophe right after a letter, digit or
 * underscore is prose and never opens one; a double quote there opens a shell
 * piece (`a"b…"`).
 */
function opensOwnQuote(content: string, index: number): boolean {
  // A value always follows its key, so a character stands before `index`.
  return content[index] === "\"" || !WORD_CHARACTER.test(content[index - 1]!);
}

/**
 * Whether the enclosing string's closing quote at `closed` may end the value.
 * Inside the capture, a quote inside the value's own quoted text or inside an
 * open angle placeholder (another quote kind or a placeholder still open, or a
 * blank after it, which the grammar reads only there) was a stray
 * apostrophe's, so the grammar's reading is kept.
 */
function closesValueAt(content: string, closed: number, end: number, insideOwnText: boolean): boolean {
  return closed >= end || !(insideOwnText || /\s/u.test(content.charAt(closed + 1)));
}

/** A copy of a flat match whose value ends at `end`, as if the grammar had stopped there. */
function truncateMatch(match: RegExpExecArray, end: number): RegExpExecArray {
  const valueStart = match.index + match[0].length - match[1]!.length;
  const captures: [string, string] = [match.input.slice(match.index, end), match.input.slice(valueStart, end)];
  return Object.assign(captures, { index: match.index, input: match.input, groups: undefined });
}

/** A call's opening parenthesis, after at most a short run of whitespace (`getToken ()`). */
const CALL_AFTER = /^\s{0,16}\(/u;
/** An assignment's `=` (not `==`) and blanks directly before a value. */
const ASSIGNED_BEFORE = /(?<![=!<>])=[ \t]{0,16}$/u;


/**
 * The character just before the value capture. Every match handed to a judge
 * comes from exec or matchAll, so index and input are set, and the value
 * capture always ends the match, so it starts `length` back.
 */
function captureOpener(match: RegExpMatchArray): string | undefined {
  return match.input![match.index! + match[0].length - match[1].length - 1];
}

function isQuote(character: string | undefined): character is "\"" | "'" {
  return character === "\"" || character === "'";
}

/** Captured text that a reference, a placeholder or a quoted piece can make spell something else. */
const SPELLING_SENSITIVE = /[$<"']/u;

/**
 * Whether unquoted source text that starts with a reference is code rather
 * than a literal concatenated to the reference. It is code when an operator
 * follows the leading references (`$TOKEN.length`, `$TOKEN+suffix`,
 * `${X}*2`), when a call's parenthesis follows the value
 * (`<string>getToken()`), and, after `=`, when an angle span leads it (a
 * TypeScript type assertion or generic, or a shell redirection, never a
 * placeholder; after `:` in YAML or prose `<x>literal` is still judged). A
 * quoted value, payload data, a value that starts with literal text
 * (`.ab${X}cd`) and a reference followed by a letter, digit or quoted piece
 * (`${EMPTY}literal`, `$VAR"literal"`) are never code.
 */
function isCodeAfterReference(match: RegExpMatchArray): boolean {
  if (DECODED_DATA_MATCHES.has(match) || isQuote(captureOpener(match)) || !/^[$<]/u.test(match[1])) return false;
  const end = match.index! + match[0].length;
  const valueStart = end - match[1].length;
  const after = match.input!.slice(end, end + 18);
  if (match[1][0] === "<") {
    // An angle span that holds a TypeScript type is a type assertion, whatever follows (`<string>name as T`).
    if (isTypeAssertion(match[1])) return true;
    if (ASSIGNED_BEFORE.test(match.input!.slice(Math.max(0, valueStart - 18), valueStart))) return true;
    // In an object property or argument, a type assertion is followed by expression code (`{ token: <T>name ?? x }`).
    if (EXPRESSION_AFTER.test(after)) return true;
  }
  // A postfix `!` (a TypeScript non-null assertion) passes over to the operator after it (`$TOKEN!.x`).
  const lead = leadingReferencesEnd(match[1]);
  const operator = match[1][lead] === "!" ? match[1][lead + 1] : match[1][lead];
  return CODE_OPERATOR.test(operator ?? "") || CALL_AFTER.test(after);
}

/**
 * Where the references that lead a value end (`$($(cmd))`, `${A:-${B}}`,
 * `$NAME`, `<x>`). An iterative scan, so no reference length can exhaust the
 * regex backtrack stack and make the guard fail open; each character is read
 * once.
 */
function leadingReferencesEnd(text: string): number {
  let index = 0;
  for (let next = referenceEnd(text, index); next !== -1; next = referenceEnd(text, index)) index = next;
  return index;
}

/** The index after the reference that starts at `start`, or -1 when none starts there or it never closes. */
function referenceEnd(text: string, start: number): number {
  const opener = text[start];
  if (opener === "<") return angleSpanEnd(text, start);
  if (opener !== "$") return -1;
  const bracket = text[start + 1];
  if (bracket === "{" || bracket === "(") return bracketedEnd(text, start + 1, bracket);
  VARIABLE_REFERENCE.lastIndex = start;
  const variable = VARIABLE_REFERENCE.exec(text)?.[0];
  return variable === undefined ? -1 : start + variable.length;
}

/** The index after the `>` that closes the `<` at `start`, or -1 when another `<` or the end comes first. */
function angleSpanEnd(text: string, start: number): number {
  const close = text.indexOf(">", start + 1);
  const reopen = text.indexOf("<", start + 1);
  return close !== -1 && (reopen === -1 || close < reopen) ? close + 1 : -1;
}

/**
 * The index after the delimiter that closes the `{` or `(` at `start`,
 * following nesting; quoted spans and escapes never open or close it, as in
 * the expansion walker (`$('(')`). Returns -1 when it never closes.
 */
function bracketedEnd(text: string, start: number, bracket: "{" | "("): number {
  const closer = bracket === "{" ? "}" : ")";
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") index += 1;
    else if (character === "'" || character === "\"") index = quotedSpanEnd(text, index);
    else if (character === bracket) depth += 1;
    else if (character === closer && --depth === 0) return index + 1;
  }
  return -1;
}

/** The index of the quote that closes the span opened at `start` (honoring backslashes in double quotes), or the end of the text. */
function quotedSpanEnd(text: string, start: number): number {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === quote) return index;
    if (quote === "\"" && text[index] === "\\") index += 1;
  }
  return text.length;
}

/** The text of a TypeScript type expression, as one captured angle piece holds it (no nesting, no whitespace). */
const TYPE_TEXT = /^[\w$.[\]|&,{}:;?]+$/u;
/** A TypeScript literal type, or a union that starts with one (`<"bearer">`, `<1|2>`, `<"a"|undefined>`). */
// Each member alternative starts with a different character (quote, digit or sign, letter), so no member can be read two ways.
const LITERAL_TYPE = /^(?:"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?)(?:\|(?:"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?|[A-Za-z_$][\w$.]*))*$/u;

/** A TypeScript primitive type keyword. */
const PRIMITIVE_TYPE = /\b(?:string|number|boolean|bigint|symbol|any|unknown|object|never|void|undefined|null)\b/u;

/**
 * Whether a value starts with an angle span that holds a TypeScript type: a
 * primitive keyword, a qualified name (`<auth.Token>`), a union or
 * intersection (`<string|undefined>`), a type parameter (`<T>`), a generic or
 * array type, or a capitalized name that holds a lowercase letter
 * (`<Record>`, `<APIKey>`). A lowercase word (`<x>`, `<credential>`) and an
 * ALL-CAPS name (`<TOKEN>`, `<API_KEY>`) are placeholders by convention.
 */
function isTypeAssertion(value: string): boolean {
  // An angle-led capture starts with one closed `<...>` piece of the value grammar.
  const type = value.slice(1, value.indexOf(">"));
  if (LITERAL_TYPE.test(type)) return true;
  if (!TYPE_TEXT.test(type)) return false;
  // Two independent linear checks: a capitalized name, and a lowercase letter in it or a single letter.
  // A structural type (`<{value:string}>`, `<Token&{}>`) holds an object type literal.
  return PRIMITIVE_TYPE.test(type) || /[.|&[{]/u.test(type) || (/^[A-Z][\w$]*$/u.test(type) && (type.length === 1 || /[a-z]/u.test(type)));
}

/** A binary operator or member access that continues an expression after a reference (`&` is bitwise AND there); `! @ # ~` stay literal data. */
const CODE_OPERATOR = /[.+\-*/%=^&]/u;
/** Expression code after a value: an optional chain, a nullish or logical operator, or a call or index; a delimiter alone may end YAML data. */
const EXPRESSION_AFTER = /^\s{0,16}(?:\?\.|\?\?|\|\||&&|[([])/u;

/**
 * Whether the literal a referenced value spells matches the rule's literal
 * grammar whole. The literal is data, as a program receives it, so it is read
 * as one double-quoted literal whose own `"` characters become `'`, as an
 * element body is: every non-space character counts, and the grammar's path,
 * URL, word and member-path exclusions judge it whole. Code after a reference
 * (see isCodeAfterReference) spells no literal.
 */
function literalMatches(grammar: RegExp, literal: string, code: boolean): boolean {
  if (code) return false;
  const body = literal.replaceAll("\"", "'");
  grammar.lastIndex = 0;
  return grammar.exec(`"${body}"`)?.[1] === body;
}

/**
 * How a structured key spelling `"<name>":` reads for a key-named rule:
 * `exact` when the key word is the whole name, `prefixed` when other key text
 * precedes it, and undefined when the name does not end with one of the rule's
 * keys. The same key pattern and shape check judge quoted keys in text, so a
 * payload property and its JSON spelling read alike.
 */
export function structuredKeyShape(rule: SecretRule, name: string): "exact" | "prefixed" | undefined {
  if (!rule.structured) return undefined;
  const content = `${JSON.stringify(name)}:`;
  // The shared key pattern is used synchronously here, so resetting its cursor is safe.
  const key = compileSpelling(rule.structured).key;
  key.lastIndex = 0;
  for (let match = key.exec(content); match; match = key.exec(content)) {
    if (match.index + match[0].length !== content.length) continue;
    const shape = keyShape(content, match.index, match[1]);
    if (shape !== "malformed") return shape;
  }
  return undefined;
}

/**
 * Judge one string as a quoted structured value of a key-named rule, exactly
 * as the structured pass judges a quoted value in text: `compact` for a
 * prefixed key's value or an object member's value, lenient for an exact key's
 * value or an array element.
 */
export function acceptsStructuredValue(rule: SecretRule, value: string, compact: boolean): boolean {
  if (!rule.structured) return false;
  // JSON.stringify leaves U+2028 and U+2029 raw, and a raw line break marks a
  // host-language artifact in text. In a payload string they are data, so they
  // are escaped like `\n` and judged in the decoded reading.
  const content = JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  // A serialized payload string is complete data, so it is always judged as
  // decoded data, never by the source-text rules for values the grammar cuts.
  // Either reading of the rule reports it, as in text.
  return ruleReadings(rule).some((reading) =>
    createValueJudge(reading, compileSpelling(reading.structured!).value, content, true).accepts(compact)(0));
}

/**
 * Element content such as `<password>value</password>`, judged by the length
 * of the literal it spells, or by the rule's own value grammar and entropy
 * predicate when the spelling declares `elementValue`.
 */
function* elementMatches(element: CompiledElement, content: string, judge: (value: string) => boolean): Generator<SecretRuleMatch> {
  // The opening pattern's cursor survives each yield, so every scan owns its own copy.
  const open = new RegExp(element.open);
  for (let match = open.exec(content); match; match = open.exec(content)) {
    const bodyStart = match.index + match[0].length;
    const body = elementBodyEnd(element, content, bodyStart);
    if (body === undefined) {
      // As a whole-element pattern would, retry from the next position.
      open.lastIndex = match.index + 1;
      continue;
    }
    if (judge(content.slice(bodyStart, body.start).trim())) yield { index: match.index };
    open.lastIndex = body.end;
  }
}

/**
 * Where an element body that starts at `start` ends: at the first closing tag
 * of the spelling's keys, skipping markup spans of other names. Undefined when
 * a tag of the same keys opens first, a `<` never closes, or no closing tag
 * follows. One forward scan; the sticky patterns run synchronously.
 */
function elementBodyEnd(element: CompiledElement, content: string, start: number): { start: number; end: number } | undefined {
  for (let index = content.indexOf("<", start); index !== -1; ) {
    element.close.lastIndex = index;
    const close = element.close.exec(content);
    if (close !== null) return { start: index, end: index + close[0].length };
    element.span.lastIndex = index;
    const span = element.span.exec(content);
    if (span === null) return undefined;
    index = content.indexOf("<", index + span[0].length);
  }
  return undefined;
}

/** An exact key's walk covers everything inside it; a prefixed key's compact walk covers only prefixed keys. */
function alreadyWalked(walkedEnd: { exact: number; compact: number }, valueStart: number, compact: boolean): boolean {
  return valueStart < walkedEnd.exact || (compact && valueStart < walkedEnd.compact);
}

/**
 * Judge a scalar value. An unquoted key's directly matching value is the flat
 * rule's finding. Its escape check runs first because that check is constant
 * time unless a quoted literal starts here, so repeated bare keys never
 * rescan the remaining text.
 */
function scalarFinds(judge: ValueJudge, accepts: (at: number) => boolean, quote: string, valueStart: number): boolean {
  if (quote) return accepts(valueStart);
  return judge.escaped(valueStart) && !judge.direct(valueStart) && accepts(valueStart);
}

/**
 * Linear structured pass. The flat rule already owns unquoted keys with scalar
 * values, so this pass judges only quoted keys and container values. Keys
 * nested inside a walked container still get their scalar check, and each
 * container is walked at most twice: once for an exact key and once for a
 * prefixed key.
 */
function* findStructuredSpellingMatches(
  rule: SecretRule,
  spelling: SecretStructuredSpelling,
  content: string,
): Generator<SecretRuleMatch> {
  const compiled = compileSpelling(spelling);
  const judge = createValueJudge(rule, compiled.value, content);
  // The key cursor survives each yield, so every scan owns its own copy; the
  // value pattern is used synchronously between yields and stays shared.
  const key = new RegExp(compiled.key);
  // An exact key's walk judges every string leniently, which covers a nested
  // prefixed key too; a prefixed key's compact walk covers only prefixed keys.
  // Each character is therefore walked at most twice.
  const walkedEnd = { exact: 0, compact: 0 };
  for (let match = key.exec(content); match; match = key.exec(content)) {
    const quote = match[1];
    const shape = keyShape(content, match.index, quote);
    if (shape === "malformed") continue;
    const compact = shape === "prefixed";
    const accepts = judge.accepts(compact);
    const valueStart = match.index + match[0].length;
    const opener = content[valueStart];
    if (opener === "[" || opener === "{") {
      if (alreadyWalked(walkedEnd, valueStart, compact)) continue;
      const walked = walkContainer(content, valueStart, accepts, judge.accepts(true));
      walkedEnd[compact ? "compact" : "exact"] = walked.end;
      if (walked.found) yield { index: match.index };
    } else if (scalarFinds(judge, accepts, quote, valueStart)) {
      yield { index: match.index };
    }
  }
  if (compiled.element) yield* elementMatches(compiled.element, content, elementValueJudge(rule, spelling, compiled));
}

/** Element content shorter than this, once references expand, is never a credential. */
const DEFAULT_ELEMENT_LITERAL_LENGTH = 8;

/**
 * The value-grammar judgment for element content when the spelling declares
 * `elementValue`; otherwise the literal-length judgment, so
 * `<password>${X}literal</password>` is judged like `password=${X}literal`
 * and a bare `<password>${X}</password>` stays a placeholder.
 */
function elementValueJudge(
  rule: SecretRule,
  spelling: SecretStructuredSpelling,
  compiled: CompiledSpelling,
): (value: string) => boolean {
  if (!spelling.elementValue) {
    // Element text has no shell quoting: an apostrophe or quote in the body is
    // a literal character, so only references expand.
    const minimum = rule.minimumLiteralLength ?? DEFAULT_ELEMENT_LITERAL_LENGTH;
    // A whole Windows `%NAME%` body spells nothing, as in text (GH-1775).
    return (value) => !BARE_PERCENT_REFERENCE.test(value.trim()) && expandRuntimeReferences(value).length >= minimum;
  }
  // The whole trimmed body must be one value, so element prose never counts. It
  // is judged as a double-quoted literal: an element body has no code to confuse
  // it with, and its own `"` characters become `'` so they cannot end it early.
  return (value) => {
    const neutral = value.replaceAll("\"", "'");
    compiled.value.lastIndex = 0;
    const match = compiled.value.exec(`"${neutral}"`);
    if (match === null || match[1] !== neutral) return false;
    // The grammar judged the neutralized body; entropy and references judge the original.
    match[1] = value;
    return acceptsSecretMatch(rule, match);
  };
}

/** An unquoted captured value matching the reference shape whose statement a `;` ends. */
function isStatementReference(shape: RegExp, match: RegExpMatchArray, value: string): boolean {
  const end = match.index! + match[0].length;
  return /^[ \t]*;/u.test(match.input!.slice(end, end + 64)) && !isQuote(captureOpener(match)) && shape.test(value);
}

// `${NAME:-word}`, `${NAME-word}`, `${NAME:=word}`, `${NAME=word}` and
// `${NAME:+word}` can expand to `word`, so their word stays literal text
// (see defaultedPrefixLength).

/** One open `${...}` or `$(...)` reference while references are expanded. */
interface ReferenceFrame {
  /** Closing delimiter. */
  close: "}" | ")";
  /** Whether the frame's text is literal (a default word) or expands to nothing. */
  keep: boolean;
  /** Source text, used when the frame never closes. */
  raw: string;
  /** Expanded literal text. */
  literal: string;
  /** Open quote inside the reference, so a quoted delimiter (`$(printf ')')`) never closes it. */
  quote?: "\"" | "'";
  /** Root only: literal length when the current top-level quoted piece opened. */
  pieceStart?: number;
  /** The reference opened a top-level quoted piece, before any of its text. */
  opensPiece?: boolean;
}

/** The `>` that closes the `<` at `start`, or -1 when another `<` or the end comes first. */
function indexOfAngleClose(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === ">") return index;
    if (text[index] === "<") return -1;
  }
  return -1;
}

/** Append plain source text to the innermost open frame. */
function appendText(frame: ReferenceFrame, text: string): void {
  frame.raw += text;
  frame.literal += text;
}

/** Open a `${...}` or `$(...)` frame at `index`; returns the next index, or -1 when no reference starts there. */
function openReference(text: string, index: number, frames: ReferenceFrame[]): number {
  const next = text[index + 1];
  if (text[index] !== "$" || (next !== "{" && next !== "(")) return -1;
  const prefix = next === "{" ? text.slice(index + 2, index + 2 + defaultedPrefixLength(text, index + 2)) : "";
  const root = frames[0]!;
  const opensPiece = frames.length === 1 && root.quote !== undefined && root.literal.length === root.pieceStart;
  frames.push({ close: next === "{" ? "}" : ")", keep: prefix !== "", raw: `$${next}${prefix}`, literal: "", opensPiece });
  return index + 2 + prefix.length;
}

const NAME_START = /[A-Za-z_]/u;
const NAME_PART = /\w/u;
/** What may follow a `$` that opens a reference: `${`, `$(` or a variable name. */
const REFERENCE_AFTER_DOLLAR = /[{(A-Za-z_]/u;
/** A `$NAME` variable reference, with the name read as the shell reads it (maximal). */
const VARIABLE_REFERENCE = /\$[A-Za-z_]\w*/y;
/** An environment-variable name by convention: CONSTANT_CASE, with no lowercase letter. */
const CONSTANT_NAME = /^_*[A-Z][A-Z0-9_]*$/u;
/** A value that is one `$name` reference and nothing else. */
const BARE_VARIABLE = /^\$[A-Za-z_]\w*$/u;
/** A text value that is one `$name` reference inside one pair of quote delimiters. */
const QUOTED_BARE_VARIABLE = /^(["'])\$[A-Za-z_]\w*\1$/u;

/**
 * Consume a `$NAME` reference at `index`; returns the next index, or -1 when
 * no variable name follows the `$`. A CONSTANT_CASE name that no literal text
 * precedes in its word (the value, or a default word) expands to nothing;
 * any other name stays literal text (see expandWords for a bare `$name`).
 */
function variableStep(text: string, index: number, frame: ReferenceFrame): number {
  VARIABLE_REFERENCE.lastIndex = index;
  const variable = VARIABLE_REFERENCE.exec(text)?.[0];
  if (variable === undefined) return -1;
  if (frame.literal === "" && CONSTANT_NAME.test(variable.slice(1))) frame.raw += variable;
  else appendText(frame, variable);
  return index + variable.length;
}

/**
 * Length of a `NAME:-`, `NAME-`, `NAME:=`, `NAME=` or `NAME:+` prefix at
 * `start`, or 0. A single forward scan, so no input can make it backtrack.
 */
function defaultedPrefixLength(text: string, start: number): number {
  if (!NAME_START.test(text[start] ?? "")) return 0;
  let index = start + 1;
  while (index < text.length && NAME_PART.test(text[index]!)) index += 1;
  if (text[index] === ":") index += 1;
  const operator = text[index];
  return operator === "-" || operator === "=" || operator === "+" ? index + 1 - start : 0;
}

/** Fold the innermost frame, closed by `character`, into its parent. */
function closeReference(frames: ReferenceFrame[], character: string): void {
  const frame = frames.pop()!;
  const parent = frames.at(-1)!;
  parent.raw += `${frame.raw}${character}`;
  if (frame.keep) parent.literal += frame.literal;
}

/**
 * Characters that never open, close, quote or escape anything in the reference
 * walker. Without the `u` flag a sticky match starts exactly at `lastIndex`,
 * even inside a surrogate pair, so the walker's positions never drift.
 */
const PLAIN_RUN = /[^$<"'\\})]+/y;

/** Characters a backslash escapes inside double quotes, as in the shell. */
const DOUBLE_QUOTE_ESCAPABLE = "$`\"\\\n";

/**
 * What a backslash and the character after it add to a default word. Outside
 * quotes the backslash escapes the next character (`$(printf \))`); in double
 * quotes it escapes only `$`, a backtick, `"`, `\` and a line break, and
 * otherwise stays part of the word (`"abcd\efg"`). Before a line break it is a
 * line continuation, and both go.
 */
function escapedContribution(next: string, quote: "\"" | undefined): string {
  if (next === "\n") return "";
  return quote === "\"" && !DOUBLE_QUOTE_ESCAPABLE.includes(next) ? `\\${next}` : next;
}

/**
 * Consume quoted or escaped text inside an open reference: nothing in it opens
 * or closes a reference, and a default word receives what the shell's quote
 * removal leaves of it. Returns the next index, or -1 when the character is
 * ordinary reference text.
 */
function quotedStep(text: string, index: number, frame: ReferenceFrame): number {
  const character = text[index]!;
  const quote = frame.quote;
  // Double quotes still expand a nested reference (`${PW:-"${FALLBACK}"}`, `${PW:-"$X"}`); single quotes do not.
  if (quote === "\"" && character === "$" && REFERENCE_AFTER_DOLLAR.test(text[index + 1] ?? "")) return -1;
  let length = 1;
  // What the character adds to a default word: the shell removes a word's
  // quote delimiters and escaping backslashes, so `${PW:-"x"}` contributes `x`.
  let contributed = character;
  if (character === "\\" && quote !== "'" && index + 1 < text.length) {
    length = 2;
    contributed = escapedContribution(text[index + 1]!, quote);
  } else if (quote === undefined) {
    if (character !== "\"" && character !== "'") return -1;
    frame.quote = character;
    contributed = "";
  } else if (character === quote) {
    frame.quote = undefined;
    contributed = "";
  }
  frame.raw += text.slice(index, index + length);
  if (frame.keep) frame.literal += contributed;
  return index + length;
}

/** Consume the reference, delimiter, placeholder span or character at `index`; returns the next index. */
function expandStep(text: string, index: number, frames: ReferenceFrame[], rootQuotesAreSyntax: boolean, variables: boolean): number {
  const innermost = frames.at(-1)!;
  // A run of characters with no meaning to the walker in any state is text,
  // appended at once, so a long value costs one step per run.
  PLAIN_RUN.lastIndex = index;
  const run = PLAIN_RUN.exec(text)?.[0];
  if (run !== undefined) {
    appendText(innermost, run);
    return index + run.length;
  }
  // Quoted text inside a reference never opens or closes a reference.
  if (frames.length > 1) {
    const quoted = quotedStep(text, index, innermost);
    if (quoted !== -1) return quoted;
  } else if (rootQuotesAreSyntax && rootQuoteStep(text[index]!, innermost)) {
    return index + 1;
  }
  const opened = openReference(text, index, frames);
  if (opened !== -1) return opened;
  const top = frames.at(-1)!;
  const character = text[index]!;
  const variable = variables && character === "$" ? variableStep(text, index, top) : -1;
  if (variable !== -1) return variable;
  if (frames.length > 1 && character === top.close) {
    closeReference(frames, character);
    return index + 1;
  }
  const angleClose = character === "<" ? indexOfAngleClose(text, index) : -1;
  if (angleClose !== -1) {
    top.raw += text.slice(index, angleClose + 1);
    return angleClose + 1;
  }
  appendText(top, character);
  return index + 1;
}

/**
 * Handle a quote at the top level of a text value, where quotes delimit quoted
 * pieces: an opening or closing delimiter contributes nothing, and a quote of
 * the other kind inside a piece is literal. Returns whether the character was
 * a delimiter.
 */
function rootQuoteStep(character: string, root: ReferenceFrame): boolean {
  if (character !== "\"" && character !== "'") return false;
  if (root.quote === undefined) {
    root.quote = character;
    root.pieceStart = root.literal.length;
    return true;
  }
  if (character !== root.quote) return false;
  root.quote = undefined;
  return true;
}

/**
 * One linear pass over a value with nesting: references contribute what they
 * can expand to, and every quote delimiter is identified exactly once, so no
 * later pass can mistake data for a delimiter.
 */
function expandWords(text: string, rootQuotesAreSyntax: boolean, variables: boolean): string {
  // A bare `$name` is a reference whatever its case, because it is the whole
  // value; judged on the source, so a concatenation never reads as one name.
  if (variables && (BARE_VARIABLE.test(text) || (rootQuotesAreSyntax && QUOTED_BARE_VARIABLE.test(text)))) return "";
  const root: ReferenceFrame = { close: "}", keep: true, raw: "", literal: "" };
  const frames: ReferenceFrame[] = [root];
  for (let index = 0; index < text.length; ) index = expandStep(text, index, frames, rootQuotesAreSyntax, variables);
  // A reference that never closes is not a reference: its source text is
  // literal. One exception, in text only: a quoted piece ends at its first
  // closing quote, so a reference that opens the piece and holds its own quote
  // (`"$(op read "item")"`) is cut there by the value grammar; that cut
  // reference contributes nothing, as a value that starts with a reference
  // always did.
  for (let depth = frames.length - 1; depth > 0; depth -= 1) {
    const frame = frames[depth]!;
    const parent = frames[depth - 1]!;
    parent.raw += frame.raw;
    if (!(rootQuotesAreSyntax && depth === 1 && frame.opensPiece === true)) parent.literal += frame.raw;
  }
  return root.literal;
}

/**
 * Expand run-time references in data, such as a decoded literal or an element
 * body, whose own quote characters are literal: `${NAME}`, `${NAME:?message}`,
 * `$(command)`, a leading CONSTANT_CASE `$NAME` and `<placeholder>` contribute
 * nothing (a value that is only one `$name` of any case spells nothing), and the default word of
 * `${NAME:-word}` contributes its own expansion with the shell's quote removal
 * (`${PW:-"x"}` contributes `x`; `${PW:-${FALLBACK}}` contributes nothing). A
 * reference that never closes, and a `<` without a `>` before the next `<`,
 * stay literal text. With `variables` false, `$NAME` text is always literal.
 */
export function expandRuntimeReferences(text: string, variables = true): string {
  return expandWords(text, false, variables);
}

/**
 * The literal a captured text value spells: references expand as in
 * {@link expandRuntimeReferences}, and the quote characters that delimit each
 * top-level quoted piece are removed, as a shell or configuration reader
 * removes them; a quote of the other kind inside a piece is part of the
 * literal. Both happen in the same pass, so a reference may hold quotes
 * (`${PW:-""}`) and a default word's data quotes stay data.
 */
export function literalAfterReferences(value: string, variables = true): string {
  return expandWords(value, true, variables);
}

/**
 * Accept a pattern match, applying the declared literal-length, literal
 * grammar, value and entropy predicates when present. A rule with a literal
 * minimum judges the literal its value spells once references expand, so a
 * reference never hides the literal around it and never counts as one.
 */
export function acceptsSecretMatch(rule: SecretRule, match: RegExpMatchArray): boolean {
  const value = rule.minimumLiteralLength === undefined ? match[1] : judgedLiteral(match);
  if (rule.minimumLiteralLength !== undefined && value.length < rule.minimumLiteralLength) return false;
  if (rule.literalValue && SPELLING_SENSITIVE.test(match[1]) && !literalMatches(rule.literalValue, value, isCodeAfterReference(match))) return false;
  if (rule.rejectValue?.test(value) === true) return false;
  // The statement shape judges the literal, so `<string>DEFAULT_TOKEN;` is a constant reference too.
  if (rule.rejectStatementReference && isStatementReference(rule.rejectStatementReference, match, value)) return false;
  if (rule.minimumEntropy === undefined) return true;
  // Count and divide by code points alike, so astral characters are not undercounted.
  const characters = [...value];
  const counts = new Map<string, number>();
  for (const character of characters) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / characters.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= rule.minimumEntropy;
}

/** Internal scanners exposed for unit tests only; not part of any public surface. */
export const _testOnly = { leadingReferencesEnd };
