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
  - `--eval`
  - `--eval-fixtures <path>`

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
pm reindex --mode keyword --eval --eval-fixtures tests/search-eval/golden-queries.json --json
```

Without `--mode`, `--semantic`, or `--hybrid`, `search-advanced` stays keyword-first for fast agent reads.

## Reindex eval harness

`pm reindex --eval` runs a golden-query relevance harness after the reindex pass and appends a deterministic `eval` object to JSON output:

- per-fixture pass/fail verdicts
- `ndcg_at_5` score for each fixture
- aggregate `average_ndcg_at_5`, pass/fail counts, and overall status

The default fixture file is `tests/search-eval/golden-queries.json`. Override with `--eval-fixtures <path>`.

### Fixture schema

Fixtures can be either a top-level array or an object with a `fixtures` array:

```json
{
  "fixtures": [
    {
      "name": "search-eval-task",
      "query": "pm-22x2 search relevance evaluation harness",
      "mode": "keyword",
      "expected_top_ids": ["pm-22x2", "pm-fhsg"],
      "min_ndcg_at_5": 0.8
    }
  ]
}
```

Rules:

- `query` is required and must be non-empty.
- `mode` is optional (`keyword`, `semantic`, `hybrid`), default `keyword`.
- `expected_top_ids` is required and defines the ideal ranking for nDCG@5.
- `min_ndcg_at_5` is optional (`0..1`), default `0.7`.
