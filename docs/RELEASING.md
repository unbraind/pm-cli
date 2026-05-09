# Releasing `@unbrained/pm-cli`

This page is for maintainers cutting npm and GitHub releases. It assumes release work is tracked with `pm`.
For local progressive-disclosure routing, use `pm guide release`.

## Agent Quick Context

- Release versioning is calendar SemVer-compatible: `YYYY.M.D` or `YYYY.M.D-N`.
- Daily release preparation is owned by the GitHub Actions auto-release workflow.
- Publishing is owned by the tag-driven GitHub Actions release workflow.
- Do not run manual `npm publish`.
- Run local parity gates before pushing release tags.
- Use `pm guide release --json` for machine-readable release docs routing.

Tracked documentation work: [pm-1sb2](../.agents/pm/tasks/pm-1sb2.toon).

## Version Policy

Examples:

- first release on 2026-05-01: `2026.5.1`
- second release on 2026-05-01: `2026.5.1-2`

Check the next version:

```bash
pnpm version:next
```

Validate the current package version:

```bash
pnpm version:check
```

## One-Time Setup

- Prefer npm Trusted Publishing for `.github/workflows/release.yml` so GitHub-hosted release jobs can publish with short-lived OIDC credentials. Keep `id-token: write`, `npm publish --access public --provenance`, and the package repository URL aligned with npm's Trusted Publisher configuration. If Trusted Publishing is not configured yet, add `NPM_TOKEN` as a GitHub Environment or repository secret as the fallback publisher credential.
- Add `SENTRY_AUTH_TOKEN` as an optional GitHub Environment or repository secret when Sentry release creation and sourcemap upload should run. Add `SENTRY_PERSONAL_ADMIN_TOKEN` only when the GitHub-hosted Sentry issue-threshold gate should read unresolved issues; CI-scoped release tokens may not have issue-read scope. The release workflow skips Sentry upload cleanly when `SENTRY_AUTH_TOKEN` is absent and skips the GitHub-hosted issue-threshold gate when `SENTRY_PERSONAL_ADMIN_TOKEN` is absent; local maintainers should still run the token-backed Sentry gate before release.
- Keep any `release` environment compatible with free GitHub features. This repository is public, so environment secrets and tag/branch deployment rules are compatible with the free GitHub path; do not add paid-only release gates.
- Ensure `GITHUB_TOKEN` has `contents: write` for GitHub Release creation.
- Keep `package.json` repository, homepage, and bugs URLs aligned with `https://github.com/unbraind/pm-cli`.
- Keep npm automation token settings compatible with provenance publishing. The release workflow must keep `id-token: write`, a GitHub-hosted runner, and `npm publish --access public --provenance`.

## Automated Daily Driver

`.github/workflows/auto-release.yml` runs once per day and can also be dispatched manually.

Policy:

- release only when commits exist after the latest release tag
- ignore `.agents/pm`-only tracker commits for publish eligibility so post-release evidence and closure updates do not create a package release by themselves
- release at most once per UTC day by default
- same-day follow-up release (`YYYY.M.D-N`) is manual-only via `allow_same_day_release=true`
- release preparation must pass all quality and compatibility gates before commit+tag push
- external Sentry checks run when a Sentry token is configured; local maintainers can make Sentry and private telemetry mandatory with `--telemetry-mode required`
- after creating and pushing a new tag, auto-release dispatches `.github/workflows/release.yml` with that tag and waits for the publish workflow to finish, because GitHub does not start normal push/tag workflows from `GITHUB_TOKEN` pushes

Pipeline entrypoint:

```bash
node scripts/release/run-release-pipeline.mjs
```

The pipeline performs:

1. change detection + one-release-per-day guard
2. version bump + changelog promotion from `[Unreleased]`
3. strict gates (build, typecheck, docs/skills freshness, coverage, static quality, compatibility, security, smoke checks, reliability gate)
4. release note generation from changelog + pm evidence
5. commit and tag creation (plus optional push)

## Local Release Parity Checklist

1. Confirm or compute the version.

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

If private reliability checks identify repeated user friction, either confirm the current release already contains the remediation with regression coverage or fix it before continuing.

4. Run the same release pipeline locally.

```bash
# Read-only parity check
pnpm release:pipeline:dry-run

# Full local preparation (version/changelog mutation + local commit/tag)
pnpm release:pipeline -- --telemetry-mode required
```

5. Push branch and tag after local green.

```bash
git push origin main
git tag v<version>
git push origin v<version>
```

## GitHub Workflow

`.github/workflows/release.yml` runs on `v*.*.*` tags and handles:

- full-history checkout
- manual `workflow_dispatch` by tag for automation handoff or recovery when a tag already exists
- pnpm install with frozen lockfile
- version policy and tag guard
- secret scan
- build, typecheck, test, and coverage
- static quality gate (complexity, duplication, dead/orphan module, file/folder hygiene)
- temporary-project compatibility gate against latest published tracker data
- reliability threshold gate (Sentry severity threshold, telemetry policy mode)
- sandboxed `pm` coverage
- optional Sentry release metadata and sourcemap upload when `SENTRY_AUTH_TOKEN` is configured
- npm pack dry run and npx tarball smoke test
- generated release notes from changelog plus sanitized tracker metadata
- artifact uploads
- `npm publish --access public --provenance`, skipped on retry when the exact version is already present on npm
- post-publish npm/npx/bunx verification
- GitHub Release creation

Monitor:

```bash
gh run list --workflow Release --limit 5
gh run watch <run-id> --exit-status
```

## Post-Release Verification

```bash
npm view @unbrained/pm-cli@<version> version dist.integrity dist.unpackedSize --json
npx --yes --package @unbrained/pm-cli@<version> -- pm --version
bunx --bun @unbrained/pm-cli@<version> pm --version
gh release view v<version> --json tagName,name,isDraft,isPrerelease,url
```

The executable remains `pm` even though the npm package is scoped.

Use the npm registry package for maintainer global updates. Do not use `npm install -g https://github.com/unbraind/pm-cli.git` as the normal update path; npm can leave a stale shim while replacing git-sourced global installs. If a workstation is already in that state, run `bash scripts/install.sh --repair` or `npm uninstall -g @unbrained/pm-cli && npm install -g @unbrained/pm-cli@latest`.

## Failure Handling

- If local gates fail, fix and rerun before tagging.
- If the tag workflow fails before npm publish, confirm no package was published before moving or replacing a tag.
- If npm publish succeeds but GitHub Release creation fails, rerun `.github/workflows/release.yml` with `workflow_dispatch` and `tag=v<version>`; the workflow skips duplicate npm publish, reruns public verification, and creates the GitHub Release for the existing tag.
- Record failure evidence and remediation in the release `pm` item.
