# Releasing `@unbrained/pm-cli`

This page is for maintainers cutting npm and GitHub releases. It assumes release work is tracked with `pm`.
For local progressive-disclosure routing, install `guide-shell` with `pm install guide-shell --project`, then use `pm guide release`.

## Agent Quick Context

- Release versioning is calendar SemVer-compatible: one production version
  (`YYYY.M.D`) per UTC day. Older history can contain `YYYY.M.D-N` ordinals,
  but release preparation no longer creates them.
- Daily release preparation is owned by the GitHub Actions auto-release workflow.
- Publishing is owned by the tag-driven GitHub Actions release workflow.
- Do not run manual `npm publish`.
- Run local parity gates before pushing release tags.
- Treat `pnpm sdk:surface:check` as a release compatibility gate; never
  regenerate an unexplained public API diff.
- Use `pm guide release --json` for machine-readable release docs routing after `guide-shell` is installed.

Tracked documentation work: [pm-u9d0](../.agents/pm/epics/pm-u9d0.toon),
[pm-4s24d2](../.agents/pm/issues/pm-4s24d2.toon),
[pm-39cqqx](../.agents/pm/tasks/pm-39cqqx.toon), stable peer compatibility
[pm-csuce0](../.agents/pm/issues/pm-csuce0.toon), and artifact budgets
[pm-998juj](../.agents/pm/tasks/pm-998juj.toon), plus exact-tag recovery
[pm-lwnifd](../.agents/pm/issues/pm-lwnifd.toon), and SDK-bound reliability
classification [pm-dqtzva](../.agents/pm/issues/pm-dqtzva.toon).
The local/hosted gate selection contract is tracked by
[pm-ei6x66](../.agents/pm/tasks/pm-ei6x66.toon).

## Version Policy

Examples:

- first release on 2026-05-01: `2026.5.1`
- the next production release after `2026.5.1` is the next UTC day's
  calendar version; do not create `2026.5.1-2`

Inspect the next SemVer-compatible calendar version for diagnostics:

```bash
pnpm version:next
```

This diagnostic preserves validation compatibility with historical ordinal
tags, but never proposes one. When today's stable release already exists it
fails with immutable-tag recovery guidance, because an ordinal would be a
SemVer prerelease excluded from ordinary stable package peer ranges. An
explicit pipeline `--version` must equal the current UTC calendar date; past,
future, malformed, and ordinal targets fail before Git inspection.

Validate the current package version:

```bash
pnpm version:check
```

## One-Time Setup

- Use npm provenance publishing for `.github/workflows/release.yml` so GitHub-hosted release jobs publish signed packages. Keep `id-token: write`, Node 24 or newer, npm 11.5.1 or newer, `NODE_AUTH_TOKEN` from the `release` environment `NPM_TOKEN` secret, and `npm publish --access public --provenance`. The token must authenticate as a maintainer with read-write access to `@unbrained/pm-cli`.
- Add `RELEASE_PAT` to the `release` environment from a maintainer token with `contents:write` and branch-protection bypass rights. Auto Release creates a checked version/changelog commit and tag on `main`; the default `GITHUB_TOKEN` has `contents:write` but cannot satisfy protected-branch required status checks for that freshly-created commit. The workflow does not persist this elevated token during checkout or dependency installation; `run-release-pipeline.mjs` scopes it to the git push process.
- Add `SENTRY_AUTH_TOKEN` as an optional GitHub Environment or repository secret when Sentry release creation and sourcemap upload should run. Add `SENTRY_PERSONAL_ADMIN_TOKEN` for the GitHub-hosted Sentry issue-threshold gate; CI-scoped release tokens may not have issue-read scope. The release workflow skips Sentry upload cleanly when `SENTRY_AUTH_TOKEN` is absent, but fails the reliability threshold gate when `SENTRY_PERSONAL_ADMIN_TOKEN` is absent; local maintainers should still run the token-backed Sentry gate before release.
- Keep any `release` environment compatible with free GitHub features. This repository is public, so environment secrets and tag/branch deployment rules are compatible with the free GitHub path; do not add paid-only release gates.
- Ensure `GITHUB_TOKEN` has `contents: write` for GitHub Release creation.
- Keep `package.json` repository, homepage, and bugs URLs aligned with `https://github.com/unbraind/pm-cli`.
- Keep npm publishing compatible with provenance. The release workflow must keep `id-token: write`, a GitHub-hosted runner, Node 24 or newer, npm 11.5.1 or newer, a valid `NPM_TOKEN`, and `npm publish --access public --provenance`.

## Automated Daily Driver

`.github/workflows/auto-release.yml` runs once per day and can also be dispatched manually.

Policy:

- release only when commits exist after the latest release tag
- ignore tracker-governance-only commits for publish eligibility: `.agents/pm/**` and the mechanically generated `CHANGELOG.md` projection do not create a package release by themselves, while any product, test, documentation, workflow, or other changed path remains release-relevant
- create at most one production tag and npm version per UTC day; if no tag was
  created, a non-`github-actions[bot]` closure of the exact bot-created
  `Auto Release blocked` issue on the same UTC day triggers one preparation
  retry
- if today's tag already exists, blocker closure reruns and watches the exact
  tag-driven Release workflow instead of invoking release preparation or
  creating an ordinal replacement; an already-successful run is recorded as
  recovered without republishing
- release preparation must pass all quality and compatibility gates before commit+tag push
- `CHANGELOG.md` is generated by the latest npm `pm-changelog` package (`pm install npm:pm-changelog --project`, then `pm changelog generate --mode replace --all-release-tags`) from closed tracker items across git release tag windows and checked in CI; do not edit it by hand
- protected-branch pushes require `RELEASE_PAT`; Auto Release fails fast before the expensive release gates when `push=true`, `dry_run=false`, and that secret is not configured
- release reliability gating requires `SENTRY_PERSONAL_ADMIN_TOKEN` for issue-threshold checks; Auto Release fails before creating the version commit/tag when the token is missing and `push=true`, while sourcemap upload remains optional through `SENTRY_AUTH_TOKEN`
- after creating and pushing a new tag, auto-release waits for the tag-push `.github/workflows/release.yml` run to finish instead of dispatching a second publish workflow
- scheduled failure issues include the preflight state (`push`, `dry_run`, `release_pat_configured`, and `sentry_personal_admin_token_configured`) plus a detected cause so agents can distinguish missing release secrets from Sentry gate failures without scanning the full workflow log first
- when scheduled failures continue across multiple UTC days, auto-release supersedes a stale open blocker with a fresh current-day blocker so same-day retry detection follows the latest scheduled failure
- closing the exact bot-created `Auto Release blocked: scheduled run failed`
  issue as a maintainer or agent records a same-day retry marker, then either
  retries preparation when no tag exists or reruns the exact existing tag's
  Release workflow; it comments with the recovered tag on success and reopens
  the same issue on failure. A second close on the same UTC day is refused
  before release mutation and reported as `retry_already_attempted`, and
  workflow cleanup closures by `github-actions[bot]` are ignored.
- after a scheduled run publishes a tag and the downstream release workflow succeeds, auto-release closes any open `Auto Release blocked` issue so the GitHub tracker reflects current release health

Pipeline entrypoint:

```bash
node scripts/release/run-release-pipeline.mjs
```

The pipeline performs:

1. change detection + one-release-per-day guard
2. a single `YYYY.M.D` version bump; ordinal targets and the removed
   `--allow-same-day-release` override fail closed
3. latest `pm-changelog` install and main changelog refresh through package-owned full-history generation; the release pipeline passes `--release-version` with `--all-release-tags` so the pending release section matches post-tag CI checks
4. build, clone-local merge-driver installation, then the remaining strict gates (typecheck, docs/skills freshness, coverage, static quality, compatibility, security, smoke checks, reliability gate); this ordering makes the checkout-owned CLI available before bootstrap, matches CI, and prevents fresh-clone tracker measurements from observing undeclared merge-driver repairs
5. release note generation from changelog + pm evidence
6. commit and tag creation (plus optional push)

The generated changelog includes clickable pm item links to the tracked `.toon` files. Missing release evidence should be fixed in pm item history, not by hand-editing `CHANGELOG.md`.

## Changelog Classification (Contributor-Facing)

`pnpm changelog:pm` routes closed pm items into keep-a-changelog sections using `pm-changelog` classification logic. Use explicit type/tag metadata when you want deterministic section routing.

Signal tiers:

- **Strong signals**: item `type` + `tags`
- **Weak signal**: item `title` (after stripping CLI-flag-like tokens such as `--add`)

Category precedence (first matching bucket wins):

| Priority | Category     | Trigger terms (from strong + weak signals unless noted)                                                                                 |
| -------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | `Security`   | `security`, `cve`, `vulnerability`                                                                                                      |
| 2        | `Deprecated` | `deprecated`, `deprecation`                                                                                                             |
| 3        | `Removed`    | `removed`, `remove`, `deleted`, `delete`                                                                                                |
| 4        | `Fixed`      | `fix`, `fixed`, `bug`, `bugfix`, `hotfix`, `regression`                                                                                 |
| 5        | `Added`      | `feature`, `feat`, `added`, `add`, `new`                                                                                                |
| 6        | `Changed`    | strong-signal `change`, `changed`, `refactor`, `update`, `updated`, `improve`; for non-bug-like types only, title fallback is also used |
| 7        | `Other`      | no classifier match                                                                                                                     |

Bug-like default:

- Items with type `Issue`, `Bug`, `Bugfix`, or `Defect` default to `Fixed` unless a higher-priority category already matched.
- This bug-like default runs before title-only `Changed` fallback to avoid misrouting command-name issue titles (for example "`pm update ...`" issue reports).

Practical examples:

- `Issue` + title `pm update --add-tags fails` -> `Fixed`
- `Task` + tag `refactor` -> `Changed`
- `Feature` + tag `security` -> `Security`
- `Issue` + tag `feature` -> `Added` (explicit stronger signal beats default)

If a changelog routing rule appears incorrect, fix classifier behavior in the `pm-changelog` package/repo and then consume the updated package here. Do not patch generator internals in this repository.

## Local Release Parity Checklist

1. Confirm the UTC calendar date. Do not use an ordinal diagnostic as a
   production target.

```bash
pnpm version:next
```

2. Verify previous-version tracker compatibility in a temporary project before release asset edits.

Create representative data with the latest published package and then read, mutate, run linked tests, validate, and health-check the same temp `PM_PATH` with the current build. The temp run must use isolated `PM_PATH` and `PM_GLOBAL_PATH`; never point compatibility tests at the repository's real tracker data.

Minimum coverage:

- parent and dependency links
- comments, notes, learnings, body, reminders, events
- linked files, docs, and tests
- legacy markdown item files (including external YAML wrappers before JSON front matter) migrating cleanly to TOON
- closed issue metadata and history drift checks
- current-build write mutation and item-count preservation

3. Review private reliability signals.

Use maintainer-only local workflows for reliability checks and incident triage. Keep operational details, infrastructure topology, and raw diagnostics out of tracked release documentation and release notes.

Run the public Sentry/telemetry threshold gate through the package script alias:

```bash
pnpm sentry:telemetry:gate -- --telemetry-mode best-effort
```

The Sentry threshold gate reads the latest event for each issue and classifies
expected handled failures from the SDK error catalog. An event is ignored only
when it is handled, its `pm.error_code` resolves to a declared canonical code,
its `pm.exit_code` exactly matches that code's transport contract, and the
semantic class is `usage`, `not_found`, or `conflict`. Message and title prose
never participate. Unknown codes, missing or mismatched exits, unhandled
events, and every `generic_failure` or `dependency_failed` remain blocking.
This keeps rewording independent from release policy and makes stale or broad
message allowlists impossible.

If private reliability checks identify repeated user friction, either confirm the current release already contains the remediation with regression coverage or fix it before continuing.

The build writes `dist/cli-bundle/bundle-manifest.json` atomically with SHA-256 digests for every emitted bundle file. At startup, `pm` reports `bundle_integrity_torn_install` only when a module-loader failure is accompanied by manifest proof that an upgrade or rebuild changed, removed, or corrupted the active bundle. Reinstall `@unbrained/pm-cli` and retry after that diagnostic. Ordinary `ERR_MODULE_NOT_FOUND` and export failures with an intact manifest remain unexpected failures and must continue to block reliability gates.

4. Run the same release pipeline locally.

Push the final implementation commit first, wait for DeepScan and CodeFactor to
finish on that reviewed SHA, then run the canonical registry-owned preflight:

```bash
pnpm verify:preflight
```

The registry supplies the ordered executable plan, command arguments,
environment, capture policy, and explicit skip policy. Its receipt distinguishes
passed checks from declared skips. The same registry maps named PR, nightly,
and release workflow gates; hosted-only entries must explain why no faithful
local equivalent exists.

The preflight includes the mandatory local hosted-analysis proof:

```bash
pnpm quality:hosted-analysis
```

The gate accepts only DeepScan's explicit zero-new-issue status and
CodeFactor's explicit no-issues result. Both contexts are required by `main`
branch protection, and the release pipeline reruns the same immutable-tree
proof. It reads the release commit first. When GitHub does not copy app results
onto a merge commit, the gate may reuse a reviewed merge-parent or squash-PR
head only when its immutable Git tree SHA exactly matches the release commit.
Squash provenance additionally requires one unambiguous GitHub association to a
closed PR merged into `main` with the release commit as its merge commit.
Missing, ambiguous, or different-tree provenance fails closed.

```bash
# Read-only parity check
pnpm release:pipeline:dry-run

# Full local preparation (version/changelog mutation + local commit/tag)
pnpm release:pipeline
```

The static phase includes `pnpm sdk:surface:check`,
`pnpm benchmark:sdk-entrypoints:check`, and
`pnpm benchmark:transport:check`. The packaging phase runs
`pnpm quality:package-artifact`, which evaluates npm's actual packlist against
the committed unpacked-size, file-count, required-runtime-file, and forbidden
source-map budgets. Additive SDK exports require a reviewed
snapshot refresh. A removal or semantic signature change fails until the
maintainer supplies
`pnpm sdk:surface:update -- --acknowledge-breaking "<release rationale>"`;
pair that acknowledgement with migration guidance, compatible extension
version bounds where applicable, and the next eligible date-based release.

5. Push branch and tag after local green.

```bash
git push origin main
git tag v<version>
git push origin v<version>
```

## GitHub Workflow

`.github/workflows/release.yml` runs on `v*.*.*` tags and handles:

- full-history checkout
- manual `workflow_dispatch` by tag for recovery. An authenticated exact-version probe keeps already-published access recovery on the reviewed dispatch-time `main` source; when the immutable tag exists but npm publication never completed, recovery checks out that exact tagged source and retains the original version guard
- pnpm install with frozen lockfile
- version policy and tag guard
- secret scan
- build, clone-local merge-driver installation, typecheck, test, and coverage
- generated changelog verification and `pm-changelog` installation before the
  tracker-bearing static gate, so a clean checkout does not misclassify the
  managed extension's linked files as missing
- static quality gate (shared complexity, duplication, dead/orphan module, file/folder hygiene, source/exported docstring coverage profile)
- temporary-project compatibility gate against latest published tracker data
- reliability threshold gate (Sentry severity threshold, bounded to a recent-activity window via `--sentry-window-days` (default `14`, `0` = unbounded) so a stale benign unresolved issue cannot block every scheduled release; `--telemetry-mode` gate policy: `off` | `best-effort` | `required`). Scheduled `auto-release.yml` failures open/update an `Auto Release blocked` GitHub issue so blocked daily releases are never silently skipped.
- sandboxed `pm` coverage
- optional Sentry release metadata and sourcemap upload when `SENTRY_AUTH_TOKEN` is configured
- npm pack dry run and npx tarball smoke test
- generated release notes from changelog plus sanitized tracker metadata
- artifact uploads
- `npm publish --access public --provenance --tag latest`, skipped on retry
  only when the exact version is anonymously visible from a fresh npm cache.
  If the package is public but the target version is absent, the workflow
  publishes immediately without attempting a package-access mutation. A
  dispatch may do so only when its source-selection preflight pinned the
  checkout to the requested immutable tag; reviewed-main recovery continues
  to refuse publication of a missing target. Only
  when neither the target nor package metadata is anonymously visible does the
  same-tag recovery path attempt to restore public package access, because a
  hidden version can also return 404 to authenticated metadata reads. After a
  successful access recovery it rechecks anonymous metadata, then either skips
  the now-visible target or publishes the still-missing version. Permission,
  authentication, and registry failures stop the workflow instead of risking
  an immutable-version overwrite. The checked-out tag's `package.json` supplies
  the canonical package identity to both the publish guard and the
  post-publish npm/npx/bunx verifier so those identities cannot drift. The
  explicit stable dist-tag also preserves
  correct `latest` behavior when rerunning historical ordinal tags.
- post-publish npm/npx/bunx verification through
  `scripts/release/verify-published-release.mjs`, using isolated empty npm and
  Bun caches plus an empty npm user config so maintainer credentials and cached
  metadata cannot mask a public-registry outage. The verifier dispatches a real
  `pm contracts` command through both explicit-bin and package-default
  invocations, performs a JSON-RPC initialize handshake against the
  symlink-resolved `pm-mcp` bin under both npx and bunx, derives bin coverage
  from `package.json`, and proves missing-bin and missing-command controls fail.
- exact-package installed acceptance through
  `scripts/release/verify-installed-agent-session.mjs`. Separate npm and Bun
  install roots must contain the resolved executable, then each drives the
  cold-start `init -> context -> create -> claim -> annotate -> files -> close
-> validate -> get -> context` loop. The structured report identifies the
  failing step and records per-step output ceilings and estimated token cost.
- GitHub Release creation
- GitHub Release metadata verification through the same local verification script

Monitor:

```bash
gh run list --workflow Release --limit 5
gh run watch <run-id> --exit-status
```

## Post-Release Verification

```bash
npm view @unbrained/pm-cli@<version> version dist.integrity dist.unpackedSize --json
npx --yes --package @unbrained/pm-cli@<version> -- pm --json --no-extensions contracts --summary
npx --yes @unbrained/pm-cli@<version> pm --json --no-extensions contracts --summary
bunx --silent --bun --package @unbrained/pm-cli@<version> pm --json --no-extensions contracts --summary
bunx --silent --bun @unbrained/pm-cli@<version> pm --json --no-extensions contracts --summary
pnpm release:verify-installed-agent -- --version <version> --manager both --json
gh release view v<version> --json tagName,name,isDraft,isPrerelease,url
pnpm release:verify-published -- --version <version>
```

The executable remains `pm` even though the npm package is scoped.

Use the npm registry package for maintainer global updates. Do not use `npm install -g https://github.com/unbraind/pm-cli.git` as the normal update path; npm can leave a stale shim while replacing git-sourced global installs. If a workstation is already in that state, run `bash scripts/install.sh --repair` or `npm uninstall -g @unbrained/pm-cli && npm install -g @unbrained/pm-cli@latest`.

## Failure Handling

- If local gates fail, fix and rerun before tagging.
- Treat failed scheduled Nightly Validation jobs as release-health blockers until triaged. The nightly workflow opens or updates a GitHub issue for each failing scheduled OS/Node matrix entry, with the run URL and commit SHA, so cross-platform regressions do not rely on someone manually scanning the Actions tab.
- Treat a green manual Auto Release dry-run (`push=false` or `dry_run=true`) as gate confidence only. It does not prove the protected-branch publish path; scheduled production runs still require `RELEASE_PAT` and `SENTRY_PERSONAL_ADMIN_TOKEN` to be configured in the `release` environment.
- If release preparation fails before creating a tag, fix the cause and retry
  preparation on the same UTC day.
- Once a tag exists, never move or replace it and never create a same-day
  ordinal recovery version. Rerun `.github/workflows/release.yml` with
  `workflow_dispatch` and `tag=v<version>` (or close the current bot-created
  blocker once to trigger the guarded exact-run recovery). The workflow skips
  duplicate npm publication for an anonymously visible version. Before
  installing or running gates, dispatch performs an authenticated exact-version
  probe. An
  existing version keeps the reviewed dispatch-time `main` source and cannot
  be republished. A definitive missing-version response pins the checkout to
  the existing immutable tag, reapplies the version guard, installs the managed
  changelog extension before tracker measurement, and permits first publication
  only from that exact tagged source. Other registry failures stop before
  source selection or publication.
- If an immutable published package contains a defect that cannot be repaired
  by rerunning the same tag workflow, document the incident and ship the code
  fix in the next UTC day's release.
- A manual exact-tag `workflow_dispatch` recovery uses isolated anonymous
  registry probes before any account-level access mutation. A visible package
  with a missing target version proceeds directly to exact-tag publication, so
  a publish-capable automation token is not required to change package access.
  Access recovery is reserved for the ambiguous case where neither the package
  nor target version is anonymously visible. An already-visible immutable
  version is still verified and never republished. Recovery starts from the
  dispatch-time commit SHA and fails unless the dispatch ref is the repository
  default branch (`main`). It remains on that reviewed source when the exact
  npm version exists. When the version is definitively absent, it switches to
  the resolved commit behind `RELEASE_TAG`, requires `package.json` to match the
  tag, installs the clone-local merge driver and managed changelog extension,
  and may publish that exact source after every gate passes.
- Record failure evidence and remediation in the release `pm` item.

### Silent skip debugging

When auto-release exits green but does not cut a version, inspect the pipeline's JSON skip `reason` from `scripts/release/run-release-pipeline.mjs` (or rerun locally with `pnpm release:pipeline:dry-run -- --json`):

- tracker-only skip family: `tracker_only_changes_since_last_tag` (all changed paths are `.agents/pm/**` and/or the generated `CHANGELOG.md` projection; a product-visible path is the required negative control)
- changelog-empty skip family: `empty_generated_changelog_section_for_target_version` (generated release section exists but has no non-empty entries)

`pm-changelog` is maintained in a separate repository/package. Classifier or release-window bugs must be fixed and released there first, then consumed here via the latest npm package (`pm install npm:pm-changelog --project`) before rerunning release generation.

Before local changelog regeneration diagnostics, always refresh tags first:

```bash
git fetch --tags --force
```

Without a forced tag refresh, local tag windows can drift from origin and produce misleading changelog or skip diagnostics.
