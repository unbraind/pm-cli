# pm-changelog

Generate `CHANGELOG.md` from pm-cli items.

## Install

```bash
pm install npm:pm-changelog --project
```

```bash
pm changelog generate --mode prepend --output CHANGELOG.md
```

Rebuild a full project changelog from git release tags:

```bash
pm changelog generate --all-release-tags --mode replace --output CHANGELOG.md
```

Standalone npm usage:

```bash
npm install --save-dev pm-changelog @unbrained/pm-cli
npx pm-changelog --mode prepend --output CHANGELOG.md
```

## Opt-in extras

These flags are strictly additive — omitting them keeps output byte-for-byte identical to the default:

```bash
npx pm-changelog --stdout --section-by type      # group by type/status/label instead of categories
npx pm-changelog --stdout --conventional         # Features / Bug Fixes / ... headings
npx pm-changelog --stdout --contributors         # per-release contributor list
npx pm-changelog --all-release-tags --limit 10   # keep only the newest N releases
npx pm-changelog --all-release-tags --since-version 2.0.0
npx pm-changelog --all-release-tags --changelog-json > changelog.json
```

See [Usage](docs/usage.md#opt-in-enhancements) for details.

## Docs

- [Docs index](docs/README.md)
- [Usage](docs/usage.md)
- [Release and CI](docs/release.md)
- [Development](docs/development.md)
- [Changelog](CHANGELOG.md)
