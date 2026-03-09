# Releasing `@unbrained/pm-cli`

This repository uses a tag-driven GitHub Actions release pipeline that publishes to npm and creates a GitHub Release.

## Version policy

`pm-cli` uses a calendar SemVer-compatible scheme:

- `YYYY.M.D` for the first release on a date
- `YYYY.M.D-N` for additional releases on the same date (`N >= 2`)

Examples:

- First release on 2026-03-09: `2026.3.9`
- Second release on 2026-03-09: `2026.3.9-2`

Use:

```bash
pnpm version:next
```

to compute the next expected release version from the npm registry.

## One-time GitHub setup

- Create GitHub Environment `release`
- Add environment secret `NPM_TOKEN` (npm automation token with publish rights for `@unbrained/pm-cli`)

## Release checklist

1) Update `package.json` version and `CHANGELOG.md`

2) Run release gates locally:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm version:check
pnpm security:scan
pnpm smoke:npx
```

3) Commit and tag:

```bash
git tag v<version>
git push origin main
git push origin v<version>
```

4) Verify Actions:

- `CI` passes for commit
- `Release` workflow passes for tag
- npm package published at `@unbrained/pm-cli`
- GitHub Release created with generated notes

## Notes

- Do not run manual `npm publish`; publishing is owned by `.github/workflows/release.yml`.
- Release workflow enforces tag/version alignment and calendar version sequencing before publish.
