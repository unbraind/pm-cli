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
}

/** One detector and any explicit repository-only scope exception. */
export interface SecretRule {
  /** Repository diagnostic identifier. */
  name: string;
  /** Compatible SDK diagnostic identifier. */
  mutationRule: string;
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
  /** Quoted-key, nested-container and element spellings judged by the same value grammar. */
  structured?: SecretStructuredSpelling;
}

const PASSWORD_KEYS = "password|passphrase";
// Unquoted configuration reads with an empty fallback contain no literal
// credential only when they end the expression, including bounded trailing
// comments. A block comment cannot consume code beyond its first closing
// delimiter; composed, continued and nonempty fallbacks remain detectable.
const PASSWORD_VALUE =
  /(?:(?!<|\$\{|\$\(|config\.auth\.password\s*(?:\|\|\s*(?:''|"")|\?\s*unescape\(encodeURIComponent\(config\.auth\.password\)\)\s*:\s*(?:''|""))(?=[ \t]*(?:\/\*(?:[^*]|\*(?!\/))*\*\/[ \t]*)*(?:;|$|\/\/[^\r\n\u2028\u2029]*(?:\r\n)?$)))[A-Za-z0-9!@#$%^&*._+\-=]{8,}|"(?!<|\$\{|\$\()[^"]{8,}"|'(?!<|\$\{|\$\()[^']{8,}')/;
const HIGH_ENTROPY_KEYS = "token|secret|password|passwd|api[_-]?key";
// GH-1704: any key whose last word names a credential, including compound
// keys (`DB_PASSWORD`, `aws_secret_access_key`, `GITHUB_TOKEN`). A compound
// key consumes its prefix from a word boundary, so `token_budget`,
// `max_tokens` and `output_token_budget` never match. Plain and hyphenated
// password keys stay with password_assignment, so one value is reported once.
const CREDENTIAL_KEYS =
  "(?:[a-z0-9]+_)+(?:password|passphrase)|(?:[a-z0-9]+[_-])*(?:secret|token|(?:api|secret|private|access)[_-]?key|client[_-]?secret|passwd|pwd)";
// A whitespace-free value of eight or more characters that is not a
// placeholder (`<...>`, `${...}`, `$(...)`, `$VAR`, `%VAR%`, `[scrubbed]`), a
// filesystem path (`pwd=/usr/local/bin`), a dotted member path or a call. Entropy
// then rejects masks and words.
const CREDENTIAL_VALUE =
  /["']?((?![<[$/]|~\/|\.\.?\/|%[A-Za-z_]\w*%|(?:[A-Za-z_]\w*\.)+[A-Za-z_]\w*(?![\w!@#$%^&*.+\-=/~])|[\w$.]+\()[A-Za-z0-9!@#$%^&*._+\-=/~]{8,})/;
const HIGH_ENTROPY_VALUE = /["']?([A-Za-z0-9+/=_-]{24,})/;

/** Canonical patterns; repository exemptions never exempt mutation payloads. */
export const SECRET_RULES = [
  { name: "private-key", mutationRule: "private_key", regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  { name: "github-token", mutationRule: "github_token", regex: /\b(?:gh[opsru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: "npm-token", mutationRule: "npm_token", regex: /\bnpm_[A-Za-z0-9]{20,}\b/g },
  { name: "aws-access-key", mutationRule: "aws_access_key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "google-api-key", mutationRule: "google_api_key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "slack-token", mutationRule: "slack_token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "anthropic-api-key", mutationRule: "anthropic_api_key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  // Matches bare sk-, sk-proj-, and sk-svcacct- OpenAI key formats. A prefix
  // alternation would be redundant here: the prefixes' characters are a subset
  // of the payload class, so backtracking makes them absorbable either way.
  { name: "openai-api-key", mutationRule: "openai_api_key", regex: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
  // Dot included for GitLab's newer routable PAT format (glpat-<base64>.<len>.<crc>).
  { name: "gitlab-token", mutationRule: "gitlab_token", regex: /\bglpat-[A-Za-z0-9_.-]{20,}\b/g },
  { name: "jwt-like-token", mutationRule: "jwt_like_token", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "npm-auth-token-assignment", mutationRule: "npm_auth_token_assignment", regex: /_authToken\s*=\s*\S+/g },
  { name: "sentry-user-token", mutationRule: "sentry_user_token", regex: /\bsntryu_[A-Za-z0-9]{20,}\b/g },
  { name: "sentry-org-token", mutationRule: "sentry_org_token", regex: /\bsntrys_[A-Za-z0-9_-]{20,}\b/g },
  {
    name: "private-ip", mutationRule: "private_ip",
    regex:
      /\b(?:10\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|172\.(?:1[6-9]|2\d|3[01])\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|192\.168\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d))\b/g,
  },
  {
    name: "private-ssh-target", mutationRule: "private_ssh_target",
    regex:
      /\b(?:ssh|scp|rsync)\s+[A-Za-z0-9._-]+@(?:10\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|172\.(?:1[6-9]|2\d|3[01])\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|192\.168\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d))\b/g,
  },
  { name: "sshpass-inline-password", mutationRule: "sshpass_inline_password", regex: /\bsshpass\s+-p\s+["'][^"']{6,}["']/g },
  {
    name: "password-assignment", mutationRule: "password_assignment",
    regex: new RegExp(String.raw`\b(?:${PASSWORD_KEYS})\s*[:=]\s*` + PASSWORD_VALUE.source, "gi"),
    structured: { keys: PASSWORD_KEYS, value: PASSWORD_VALUE.source, element: true },
  },
  {
    name: "absolute-home-path", mutationRule: "absolute_home_path",
    regex: PRIVATE_HOME_PATH_PATTERN,
    excludeFiles: /^(?:tests\/|examples\/)/,
  },
  {
    name: "user-at-private-host", mutationRule: "user_at_private_host",
    regex:
      /\b[A-Za-z0-9._-]+@(?:10\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|172\.(?:1[6-9]|2\d|3[01])\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|192\.168\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d))\b/g,
    excludeFiles: /^(?:tests\/|examples\/)/,
  },
  {
    name: "high-entropy-assignment", mutationRule: "high_entropy_assignment",
    regex: new RegExp(String.raw`\b(?:${HIGH_ENTROPY_KEYS})\s*[:=]\s*` + HIGH_ENTROPY_VALUE.source, "gi"),
    structured: { keys: HIGH_ENTROPY_KEYS, value: HIGH_ENTROPY_VALUE.source },
    mutationOnlyReason: "Generic assignments in source code are not credentials; preserve the existing mutation heuristic without treating source identifiers as secrets.",
    minimumEntropy: 3.5,
  },
  {
    name: "credential-key-assignment", mutationRule: "credential_key_assignment",
    regex: new RegExp(String.raw`\b(?:${CREDENTIAL_KEYS})\s*[:=]\s*` + CREDENTIAL_VALUE.source, "gi"),
    structured: { keys: CREDENTIAL_KEYS, value: CREDENTIAL_VALUE.source, element: true },
    mutationOnlyReason: "Key-named assignments in source code and test fixtures are identifiers and synthetic data; repository scans keep the token-format rules, which recognize real credentials there.",
    minimumEntropy: 3,
  },
] as const satisfies readonly SecretRule[];

/** Share matching and normalization, returning locations rather than matched values. */
export function* findSecretRuleMatches(rule: SecretRule, content: string): Generator<SecretRuleMatch> {
  if (rule.mutationRule === "absolute_home_path") {
    yield* findPrivateHomePathMatches(content, rule.regex);
    return;
  }
  rule.regex.lastIndex = 0;
  for (const match of content.matchAll(rule.regex)) {
    if (acceptsSecretMatch(rule, match)) yield { index: match.index! };
  }
  if (rule.structured) yield* findStructuredSpellingMatches(rule, rule.structured, content);
}

interface CompiledSpelling {
  key: RegExp;
  value: RegExp;
  element?: RegExp;
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
      value: new RegExp(spelling.value, "iy"),
      ...(spelling.element
        ? { element: new RegExp(String.raw`<(?:${spelling.keys})(?:\s[^<>]*)?>([^<]*)<\/(?:${spelling.keys})\s*>`, "gi") }
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
 * its length, whitespace, placeholder prefix and entropy. A decoded quote of
 * the literal's own kind becomes the other quote, and a line break produced
 * by an escape becomes a space. The caller rejects raw line breaks first.
 */
function decodeQuotedLiteral(literal: string, terminated: boolean): string {
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
  return `${quote}${neutral}${terminated ? quote : ""}`;
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

/** Bind a rule's value grammar to one content string. */
function createValueJudge(rule: SecretRule, value: RegExp, content: string): ValueJudge {
  // A JSON, Python or YAML-flow string literal never spans a raw line break, so
  // a structured value that does is a host-language artifact, not a credential.
  const valueMatch = (text: string, at: number): RegExpExecArray | null => {
    value.lastIndex = at;
    const match = value.exec(text);
    return match !== null && !LINE_BREAK.test(match[0]) && acceptsSecretMatch(rule, match) ? match : null;
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
    if (!literal.includes("\\")) return undefined;
    // A raw line break is a host-language artifact before any escape is decoded.
    if (LINE_BREAK.test(literal)) return [];
    const readings = content[at] === "'" ? [decodeQuotedLiteral(literal, terminated), literal] : [decodeQuotedLiteral(literal, terminated)];
    return readings.map((reading) => valueMatch(reading, 0)).filter((match): match is RegExpExecArray => match !== null);
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
    accepts: (compact) => (at) => valuesAt(at).some((match) => !(compact && /\s/u.test(match[0]))),
  };
}

/** Element content such as `<password>value</password>`, judged by length and placeholder shape. */
function* elementMatches(element: RegExp, content: string): Generator<SecretRuleMatch> {
  element.lastIndex = 0;
  for (const match of content.matchAll(element)) {
    const value = match[1].trim();
    if (value.length >= 8 && !value.startsWith("${") && !value.startsWith("$(")) yield { index: match.index! };
  }
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
  if (compiled.element) yield* elementMatches(compiled.element, content);
}

/** Accept a pattern match, applying the declared entropy predicate when present. */
export function acceptsSecretMatch(rule: SecretRule, match: RegExpMatchArray): boolean {
  if (rule.minimumEntropy === undefined) return true;
  const value = match[1];
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= rule.minimumEntropy;
}
