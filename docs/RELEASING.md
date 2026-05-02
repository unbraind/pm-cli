# Releasing `@unbrained/pm-cli`

This page is for maintainers cutting npm and GitHub releases. It assumes release work is tracked with `pm`.

## Agent Quick Context

- Release versioning is calendar SemVer-compatible: `YYYY.M.D` or `YYYY.M.D-N`.
- Publishing is owned by the GitHub Actions release workflow.
- Do not run manual `npm publish`.
- Run local gates before tagging.

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

- Add `NPM_TOKEN` as a GitHub Environment or repository secret.
- Add `SENTRY_AUTH_TOKEN` as an optional GitHub Environment or repository secret when Sentry release creation and sourcemap upload should run. The release workflow skips this step cleanly when the secret is absent.
- Keep any `release` environment compatible with free GitHub features.
- Ensure `GITHUB_TOKEN` has `contents: write` for GitHub Release creation.
- Keep `package.json` repository, homepage, and bugs URLs aligned with `https://github.com/unbraind/pm-cli`.
- Keep npm automation token settings compatible with provenance publishing.

## Local Release Checklist

1. Confirm or compute the version.

```bash
pnpm version:next
```

2. Update release files.

- `package.json`
- `pnpm-lock.yaml`
- [CHANGELOG.md](../CHANGELOG.md)

3. Generate release notes.

```bash
pnpm build
pnpm release:notes -- --version "$(node -p 'require("./package.json").version')" --output /tmp/pm-cli-release-notes.md
```

4. Run local gates.

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

5. Verify previous-version tracker compatibility in a temporary project.

Check representative items, linked files/docs/tests, comments, close metadata, health, and history drift across the previous package and current build.

6. Commit, push, tag, and push the tag.

```bash
git push origin main
git tag v<version>
git push origin v<version>
```

## GitHub Workflow

`.github/workflows/release.yml` runs on `v*.*.*` tags and handles:

- full-history checkout
- pnpm install with frozen lockfile
- version policy and tag guard
- secret scan
- build, typecheck, test, and coverage
- sandboxed `pm` coverage
- optional Sentry release metadata and sourcemap upload when `SENTRY_AUTH_TOKEN` is configured
- npm pack dry run and npx tarball smoke test
- generated release notes from changelog plus sanitized tracker metadata
- artifact uploads
- `npm publish --access public --provenance`
- GitHub Release creation

Monitor:

```bash
gh run list --workflow Release --limit 5
gh run watch <run-id> --exit-status
```

## Post-Release Verification

```bash
npm view @unbrained/pm-cli@<version> version dist.integrity dist.unpackedSize --json
npx --yes @unbrained/pm-cli@<version> --version
bunx @unbrained/pm-cli@<version> --version
gh release view v<version> --json tagName,name,isDraft,isPrerelease,url
```

The executable remains `pm` even though the npm package is scoped.

## Failure Handling

- If local gates fail, fix and rerun before tagging.
- If the tag workflow fails before npm publish, confirm no package was published before moving or replacing a tag.
- If npm publish succeeds but GitHub Release creation fails, recreate only the GitHub Release after verifying the tag and package.
- Record failure evidence and remediation in the release `pm` item.
