# Releasing `@unbrained/pm-cli`

This repository uses a tag-driven GitHub Actions pipeline that publishes to npm and creates a GitHub Release. The pipeline uses standard GitHub Actions, repository or environment secrets, artifacts, and npm provenance; it does not require paid GitHub features or paid-only environment protection rules.

## Version Policy

`pm-cli` uses a calendar SemVer-compatible scheme:

- `YYYY.M.D` for the first release on a date
- `YYYY.M.D-N` for additional releases on the same date (`N >= 2`)

Examples:

- First release on 2026-03-09: `2026.3.9`
- Second release on 2026-03-09: `2026.3.9-2`

Use this to compute the next expected release version from the npm registry:

```bash
pnpm version:next
```

The release workflow enforces the package version, tag name, calendar date, and npm registry sequencing before publishing.

## One-Time Setup

- Add `NPM_TOKEN` as a GitHub Environment or repository secret named `NPM_TOKEN`.
- If using an Environment named `release`, keep it free-feature compatible: no paid-only reviewer or deployment-protection requirements.
- Ensure `GITHUB_TOKEN` has the default workflow permission needed by `permissions: contents: write` for GitHub Release creation.
- Keep npm two-factor settings compatible with automation tokens and provenance publishing.
- Keep `package.json` repository, homepage, and bugs URLs aligned with the canonical GitHub source repository (`https://github.com/unbraind/pm-cli`); npm provenance validation rejects mismatched repository metadata.

## Local Release Checklist

1. Confirm the next version:

```bash
pnpm version:next
```

2. Update `package.json`, `pnpm-lock.yaml`, and `CHANGELOG.md`.

   Keep direct dependency specifiers deterministic. Do not publish `latest` ranges; pin runtime and development dependencies to explicit SemVer ranges that resolve to the audited lockfile versions so Dependabot and downstream installs evaluate the same safe package line.

3. Generate release notes locally from changelog + pm tracker data:

```bash
pnpm build
pnpm release:notes -- --version "$(node -p 'require("./package.json").version')" --output /tmp/pm-cli-release-notes.md
```

4. Run local release gates:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm test:coverage
node scripts/run-tests.mjs coverage
pnpm version:check
pnpm security:scan
pnpm smoke:npx
```

5. Verify previous-version tracker compatibility before tagging. Use a temporary project with the previously published package, create representative items, then run the current build against the same sandboxed `PM_PATH` and `PM_GLOBAL_PATH`. Confirm item count, fields, linked files/docs/tests, comments, close metadata, health, and history drift checks remain intact.

6. Commit, push, tag, and push the tag:

```bash
git push origin main
git tag v<version>
git push origin v<version>
```

## Release Workflow

`.github/workflows/release.yml` runs on `v*.*.*` tags and performs:

- full-history checkout for previous-tag and release-note generation
- pnpm install with frozen lockfile
- version policy and tag guard
- secret leak scan
- build, typecheck, test coverage, and sandboxed pm coverage
- npm pack dry run and npx tarball smoke test
- generated release notes from `CHANGELOG.md` plus sanitized `pm` tracker metadata
- coverage and release-note artifact uploads
- `npm publish --access public --provenance`
- GitHub Release creation using the generated release-note body

Monitor with:

```bash
gh run list --workflow Release --limit 5
gh run watch <run-id> --exit-status
```

## Post-Release Verification

After the workflow succeeds, verify all distribution paths:

```bash
npm view @unbrained/pm-cli@<version> version dist.integrity dist.unpackedSize --json
npx --yes @unbrained/pm-cli@<version> --version
bunx @unbrained/pm-cli@<version> --version
gh release view v<version> --json tagName,name,isDraft,isPrerelease,url
```

The `pm` executable name remains unchanged even though the npm package is scoped.

## Failure Handling

- Do not run manual `npm publish`; publishing is owned by `.github/workflows/release.yml`.
- If local gates fail, fix the code/docs/tests and rerun the checklist before tagging.
- If the tag workflow fails before npm publish, fix the issue, move the tag only after confirming no package was published, and rerun the workflow.
- If npm publish succeeds but GitHub Release creation fails, rerun only the release creation after confirming the tag and package are correct.
