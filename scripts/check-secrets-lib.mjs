export const RULES = [
  { name: "private-key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "github-token", regex: /\b(?:gh[opsru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: "npm-token", regex: /\bnpm_[A-Za-z0-9]{20,}\b/g },
  { name: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "jwt-like-token", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "npm-auth-token-assignment", regex: /_authToken\s*=\s*\S+/g },
  { name: "sentry-user-token", regex: /\bsntryu_[A-Za-z0-9]{20,}\b/g },
  { name: "sentry-org-token", regex: /\bsntrys_[A-Za-z0-9_-]{20,}\b/g },
  {
    name: "private-ip",
    regex:
      /\b(?:10\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|172\.(?:1[6-9]|2\d|3[01])\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|192\.168\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d))\b/g,
  },
  {
    name: "private-ssh-target",
    regex:
      /\b(?:ssh|scp|rsync)\s+[A-Za-z0-9._-]+@(?:10\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|172\.(?:1[6-9]|2\d|3[01])\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|192\.168\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d))\b/g,
  },
  { name: "sshpass-inline-password", regex: /\bsshpass\s+-p\s+["'][^"']{6,}["']/g },
  {
    name: "password-assignment",
    regex:
      /\b(?:password|passphrase)\s*[:=]\s*(?:(?!<|\$\{|\$\()[A-Za-z0-9!@#$%^&*._+\-=]{8,}|"(?!<|\$\{|\$\()[^"]{8,}"|'(?!<|\$\{|\$\()[^']{8,}')/gi,
  },
  {
    name: "absolute-home-path",
    regex: /(?:^|[\s"'`(=])\/home\/[A-Za-z0-9._-]+\/[^\s"'`),;]+/g,
    excludeFiles: /^(?:tests\/|examples\/)/,
  },
  {
    name: "user-at-private-host",
    regex:
      /\b[A-Za-z0-9._-]+@(?:10\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|172\.(?:1[6-9]|2\d|3[01])\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)|192\.168\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d))\b/g,
    excludeFiles: /^(?:tests\/|examples\/)/,
  },
];

function lineNumberFromIndex(content, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (content.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

export function scanContent(file, content) {
  const findings = [];
  for (const rule of RULES) {
    if (rule.includeFiles && !rule.includeFiles.test(file)) {
      continue;
    }
    if (rule.excludeFiles && rule.excludeFiles.test(file)) {
      continue;
    }
    rule.regex.lastIndex = 0;
    const matches = content.matchAll(rule.regex);
    for (const match of matches) {
      const index = match.index ?? 0;
      findings.push({
        file,
        rule: rule.name,
        line: lineNumberFromIndex(content, index),
      });
    }
  }
  return findings;
}
