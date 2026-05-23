# Release and CI

## Local Release Gate

Run the full local release gate before tagging or publishing:

```bash
npm run release:check
```

The gate:

- Type-checks the TypeScript source.
- Builds and runs the TypeScript-authored test suite.
- Audits production dependencies.
- Verifies package contents with `npm pack --dry-run`.
- Checks that `CHANGELOG.md` is current.

## Automated Release

`.github/workflows/release.yml` runs daily and by manual dispatch. It uses free GitHub Actions features only.

The workflow skips publishing when there are no commits after the latest release tag. When changes exist, it:

- Computes the next date-based tag in the configured release timezone, currently `Europe/Vienna`.
- Updates `package.json`, `package-lock.json`, `manifest.json`, and `src/extension.ts`.
- Rebuilds `dist/`.
- Generates `CHANGELOG.md` with `pm-changelog` itself.
- Runs release checks.
- Commits release files.
- Publishes to npm with provenance.
- Creates the public GitHub release.

Required repository secret:

```text
NPM_TOKEN
```

Required workflow permissions:

- `contents: write` for release commits, tags, and GitHub releases.
- `id-token: write` for npm provenance.

## Versioning

Release tags follow the pm CLI date-based convention:

```text
vYYYY.MM.DD
vYYYY.MM.DD-N
```

npm package versions use the SemVer-compatible equivalent without the leading `v` or zero-padded numeric components:

```text
2026.5.23
2026.5.23-1
```

The automated workflow uses `RELEASE_TIMEZONE=Europe/Vienna` when computing date-based tags. This avoids UTC rollover surprises for manual dispatches near local midnight.

## GitHub Checks

Use `gh` for release readiness checks:

```bash
gh repo view --json nameWithOwner,visibility,defaultBranchRef,hasIssuesEnabled,hasProjectsEnabled,hasWikiEnabled,latestRelease
gh issue list --limit 50
gh pr list --limit 50
gh run list --limit 20
gh secret list
gh api repos/unbraind/pm-changelog/dependabot/alerts
```

## npm Checks

Use npm registry and dependency checks:

```bash
npm outdated --json
npm audit --omit=dev
npm view pm-changelog version dist-tags time --json
```

## Public Release Verification

After publishing, verify:

```bash
npm view pm-changelog version dist-tags --json
gh release view "$(git describe --tags --abbrev=0)"
```

Then install from a clean temporary pm project:

```bash
tmp="$(mktemp -d)"
cd "$tmp"
pm init --json
pm install npm:pm-changelog --project --json
pm package doctor --project --json --detail deep
```
