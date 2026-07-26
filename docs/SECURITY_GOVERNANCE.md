# Security Governance and Resilience Testing

Repository security-governance work is tracked by
[pm-gnzh](../.agents/pm/features/pm-gnzh.toon), with the security policy,
property-fuzzing, review discipline, and OpenSSF Best Practices work owned by
[pm-2d7k](../.agents/pm/tasks/pm-2d7k.toon),
[pm-0yi7](../.agents/pm/tasks/pm-0yi7.toon),
[pm-obq2](../.agents/pm/tasks/pm-obq2.toon), and
[pm-rrt1](../.agents/pm/tasks/pm-rrt1.toon).

## Vulnerability Reporting

The public [security policy](../SECURITY.md) defines supported versions, the
private reporting channel, response targets, coordinated disclosure, scope,
and safe harbor. Vulnerability evidence stays in GitHub private advisories and
must not be copied into public `pm` history.

## Review Discipline

All repository changes should arrive through a pull request with the exact head
validated by required CI, security analysis, and the configured review tools.
Every actionable review thread must receive an evidence-based response and be
resolved before merge.

OpenSSF Scorecard's Code-Review check specifically requires independent human
approval; automated or AI review does not count. This repository currently has
one active human maintainer, so enforcing one approval would make routine
maintenance impossible. Until another trusted human maintainer is available:

- request independent human approval for security-sensitive changes whenever
  a reviewer is available;
- never describe automated review as human approval;
- retain the complete bot-feedback and exact-head CI loop as defense in depth;
  and
- keep the Scorecard limitation open and explicit instead of weakening or
  bypassing branch rules.

Once a second maintainer is active, enable a repository ruleset requiring one
approval for `main`, including administrators, and record the rule under
`pm-obq2` and `pm-5zca`.

## Property-Based Fuzzing

The `fast-check` suite in
[`tests/fuzz/project-boundaries.fuzz.spec.ts`](../tests/fuzz/project-boundaries.fuzz.spec.ts)
generates bounded adversarial inputs for four public trust boundaries:

- TOON serialization and strict decoding;
- opaque query cursor encoding and validation;
- hash-chained history JSONL merge and replay; and
- ISO and relative-time parsing.

Run it directly with:

```bash
pnpm test:fuzz
```

The same specs are included in the normal Vitest and four-shard coverage lanes,
so every pull request exercises them under the required 100% coverage gate.
`fast-check` reports the seed and shrunk counterexample on failure so a
non-sensitive, non-security finding can be reproduced and filed as a dedicated
`pm` issue. Suspected vulnerabilities and exploit details must use GitHub
private vulnerability reporting and must not be copied into public `pm`
history.

ClusterFuzzLite and OSS-Fuzz are not a practical first integration for this
TypeScript CLI: the Scorecard-supported `fast-check` path runs the native
JavaScript boundaries without a separate native fuzz target or long-lived
external service. Re-evaluate continuous fuzzing if the project adds a native
parser, unsafe memory boundary, or a stable corpus that benefits from
long-running infrastructure.

## OpenSSF Best Practices

The maintainer controls registration and attestation at
[bestpractices.dev](https://www.bestpractices.dev/). Agents may prepare
evidence-backed answers in `pm-rrt1`, but must not submit claims or impersonate
the maintainer. The passing badge can be added to the README only after the
public program records the project as passing.
