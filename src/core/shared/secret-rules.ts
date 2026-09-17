/**
 * @module core/shared/secret-rules
 * Single credential and private-context detector inventory for mutation preflight
 * and repository scanning. Diagnostics must never include matched text.
 */

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
    regex:
      /\b(?:password|passphrase)\s*[:=]\s*(?:(?!<|\$\{|\$\()[A-Za-z0-9!@#$%^&*._+\-=]{8,}|"(?!<|\$\{|\$\()[^"]{8,}"|'(?!<|\$\{|\$\()[^']{8,}')/gi,
  },
  {
    name: "absolute-home-path", mutationRule: "absolute_home_path",
    regex: /(?:^|[\s"'`(=])\/home\/[A-Za-z0-9._-]+\/[^\s"'`),;]+/g,
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
