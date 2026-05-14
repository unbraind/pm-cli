# pm-search-advanced

First-party package that restores optional advanced search surfaces in bare-core `pm`.

## Commands and behavior

- Adds `pm search-advanced` with:
  - `--mode keyword|semantic|hybrid`
  - `--include-linked`
  - `--title-exact`
  - `--phrase-exact`
- Adds `pm reindex` with:
  - `--mode keyword|semantic|hybrid`
  - `--progress`

## Install

```bash
pm install search-advanced --project
```

## Verify

```bash
pm search-advanced "vector cache" --mode hybrid --limit 5 --json
pm reindex --mode hybrid --progress --json
```
