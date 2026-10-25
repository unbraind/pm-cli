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
const FILE_HOME = "file:(?:(?:[/\\\\](?![/\\\\])|[/\\\\]{3,}|[/\\\\]{2}localhost" + SEPARATOR + ")"
  + "(?:" + ROOT_HOME + "|[a-z]:" + SEPARATOR + "users" + SEPARATOR + ACCOUNT_PATH + ")"
  + "|[/\\\\]{2}(?:[a-z]:" + SEPARATOR + "users" + SEPARATOR + ACCOUNT_PATH
  + "|" + COMPONENT + SEPARATOR + "(?:" + ROOT_HOME + "|" + SHARED_PROFILE + ")))";

/** URI schemes cannot masquerade as native UNC roots; explicit file URLs remain supported. */
export const PRIVATE_HOME_PATH_PATTERN = new RegExp(
  "(?:^|[^\\p{L}\\p{N}_./\\\\~])(?:" + UNIX_HOME + "|" + WINDOWS_HOME + "|" + FILE_HOME + ")"
    + "|(?:^|[^\\p{L}\\p{N}_:./\\\\~])(?:" + MULTI_ROOT_HOME + "|" + UNC_HOME + ")",
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
}

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
    // Unquoted configuration reads with an empty fallback contain no literal
    // credential only when they end the expression, including bounded trailing
    // comments. A block comment cannot consume code beyond its first closing
    // delimiter; composed, continued and nonempty fallbacks remain detectable.
    regex:
      /\b(?:password|passphrase)\s*[:=]\s*(?:(?!<|\$\{|\$\(|config\.auth\.password\s*(?:\|\|\s*(?:''|"")|\?\s*unescape\(encodeURIComponent\(config\.auth\.password\)\)\s*:\s*(?:''|""))(?=[ \t]*(?:\/\*(?:[^*]|\*(?!\/))*\*\/[ \t]*)*(?:;|$|\/\/[^\r\n\u2028\u2029]*(?:\r\n)?$)))[A-Za-z0-9!@#$%^&*._+\-=]{8,}|"(?!<|\$\{|\$\()[^"]{8,}"|'(?!<|\$\{|\$\()[^']{8,}')/gi,
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
    regex: /\b(?:token|secret|password|passwd|api[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9+/=_-]{24,})/gi,
    mutationOnlyReason: "Generic assignments in source code are not credentials; preserve the existing mutation heuristic without treating source identifiers as secrets.",
    minimumEntropy: 3.5,
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
