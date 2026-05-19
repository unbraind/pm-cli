# pm-search-advanced

First-party package that restores optional advanced search surfaces in bare-core `pm`.

## Commands and behavior

- Adds `pm search-advanced` with:
  - `--mode keyword|semantic|hybrid`
  - `--semantic`, `--hybrid`
  - `--include-linked`
  - `--title-exact`
  - `--phrase-exact`
  - `--type`, `--tag`, `--priority`
  - `--deadline-before`, `--deadline-after`
  - `--limit`, `--fields`, `--compact`, `--full`
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
pm search-advanced --hybrid "vector cache" --limit 5 --json
pm search-advanced "calendar package" --mode keyword --fields id,title,score --compact --json
pm reindex --mode hybrid --progress --json
```

Without `--mode`, `--semantic`, or `--hybrid`, `search-advanced` stays keyword-first for fast agent reads.
