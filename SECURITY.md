# Security Policy

Security work for `pm-cli` is tracked under [pm-2d7k](.agents/pm/tasks/pm-2d7k.toon).

## Supported Versions

`pm-cli` uses date-based releases. Security fixes are made against the current
release on the `latest` npm tag and the `main` branch. Older releases are not
maintained as separate security branches. Upgrade to the latest published
version before reporting an issue that may already be fixed.

## Reporting a Vulnerability

Do not open a public issue, discussion, pull request, or `pm` item for a
suspected vulnerability.

Use [GitHub private vulnerability reporting](https://github.com/unbraind/pm-cli/security/advisories/new)
to share:

- the affected version or commit;
- the affected CLI, SDK, package, extension, or release surface;
- reproduction steps or a minimal proof of concept;
- the likely impact and any known mitigations; and
- whether the report or exploit details have been disclosed elsewhere.

Never include live credentials, private service identifiers, signed URLs, or
other sensitive user data. Use synthetic evidence wherever possible.

## Response and Disclosure Timeline

The maintainer aims to:

- acknowledge a report within 3 business days;
- complete initial severity and reproducibility triage within 7 business days;
- provide a remediation or coordination update at least every 14 days;
- remediate critical and high-severity vulnerabilities within 30 days when a
  safe fix is available; and
- remediate lower-severity vulnerabilities within 90 days when practical.

Complex or upstream-dependent reports can require more time. If a target cannot
be met, the private advisory will record the reason, current mitigation, and
next update date.

Please coordinate public disclosure through the private advisory. The project
will normally publish an advisory after a fixed release is available and users
have had reasonable upgrade time. Early disclosure may be appropriate when a
vulnerability is already public or actively exploited, but it should still be
coordinated to avoid increasing user risk.

## Scope

Security reports are welcome for:

- the published `@unbrained/pm-cli` package and its SDK entrypoints;
- first-party packages and extension loading or isolation boundaries;
- tracker integrity, merge drivers, history, and mutation authorization;
- secret handling, telemetry redaction, and diagnostic output;
- install, update, packaging, provenance, and release workflows; and
- command execution or path handling that crosses a trust boundary.

General defects, feature requests, and documentation improvements that do not
have a security impact belong in the
[public issue tracker](https://github.com/unbraind/pm-cli/issues).

`pm` extensions execute as trusted local Node.js code. A third-party extension
can intercept command execution and access the current user's files and
credentials. Prefer reviewed extensions, report the active manifest and
capabilities when relevant, and use `--no-extensions` during incident triage.

## Safe Harbor

Good-faith research that avoids privacy violations, data destruction, service
disruption, credential access, social engineering, and unnecessary exposure of
vulnerability details is welcome. Stop testing and report privately if you
encounter sensitive data or evidence of active compromise.
