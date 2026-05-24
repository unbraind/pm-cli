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

## Docs

- [Docs index](docs/README.md)
- [Usage](docs/usage.md)
- [Release and CI](docs/release.md)
- [Development](docs/development.md)
- [Changelog](CHANGELOG.md)
