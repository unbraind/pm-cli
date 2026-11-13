# Fact-preserving agent output

Tracked by [pm-kvxqp1](../.agents/pm/features/pm-kvxqp1.toon) and
[pm-5t33or](../.agents/pm/features/pm-5t33or.toon). Project management is context
management: fewer tokens must carry the same decision facts.

## Presentation contract

JSON remains the authoritative structured result, including stable collection
counts, aliases, projections, omission receipts, and continuation coordinates.
TOON keeps the existing sparse presentation policy. It renders primitive arrays
inline and uses standard nested TOON for short object collections. For collections
of at least two object rows, the renderer compares the complete nested and
key-hoisted representations, including decoding metadata, and selects the table
only when its UTF-8 payload is smaller. Before constructing a candidate, it counts
present own-field cells and distinct columns in linear input time. A dense grid
larger than twice the present-cell count uses expanded TOON without allocating
padding or absent coordinates. Uniform collections remain eligible at any size.
Existing flat tables remain unchanged.

Nested table cells contain JSON text. `<collection>_encoding.json_columns` names
every column using this codec; all present cells in such a column use JSON,
including scalar cells, so strings that resemble JSON remain distinguishable.
`absent_rows` maps each column with missing fields to the zero-based rows that
lack it, for example `blocked[7]: 0,1,4,5,6,9,10`. Null padding does not imply
an explicit null in the original object. Column order follows first occurrence;
row order, ranking, identities, and nested facts are preserved. A compact
candidate omits columns that are null in every row and names them in
`null_columns`; `null_column_index` records each omitted column's original
position, so restoration is exact without repeating the full column list
(decoders still accept the legacy `column_order`).
A producer-owned `<collection>_encoding` field prevents this transformation.

Recognize a block by its reserved `<collection>_encoding` key beside the
`<collection>` array, not by which fields it carries. TOON leaves out an empty
`json_columns` list and an empty set of missing fields, so a block may hold
only `list_columns` or `null_columns`. Releases up to 2026.11.13 always wrote
`json_columns` and an `absent` list of `[row_index, column_name]` pairs;
`decodePmTableRows` still restores those blocks. On a 20-row `pm context` read
of this repository's tracker, encoding metadata fell from 618 to 310 bytes
([pm-gh1684](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1684.toon);
repository-only tracker record excluded from npm). `encodePmTableRows` still
returns both arrays, so SDK callers that read its result are unaffected.

Package authors can use `encodePmTableRows` and `decodePmTableRows` from
`@unbrained/pm-cli/sdk`. The helpers accept JSON object rows and return primitive
cells plus explicit restoration metadata. They preserve empty containers, nulls,
false, zero, sparse keys, and arbitrary JSON strings. The CLI's existing sparse
projection runs before encoding; the codec itself never drops those values.
Malformed JSON cells throw instead of silently changing their meaning.
Explicit codec calls construct a dense grid proportional to row count times
distinct-column count; package authors must budget that allocation for sparse
inputs. This public codec does not impose a row cap or silently change encoding.

Two read shapes keep values the sparse policy would otherwise drop
([pm-e3hfv8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-e3hfv8.toon),
[pm-fkhdy8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-fkhdy8.toon);
tracker records excluded from npm):

- Rows addressed by absolute position. `PM_READ_OUTPUT_POSITIONAL_ROW_PATHS`
  declares the `comments`, `notes` and `learnings` listings, whose rows
  `--edit <index>` and `--delete <index>` address. Their TOON listing renders
  every stored row, a malformed `null` entry included, so the rendered length
  matches `count` and a row's position matches its address. A listing with no
  such row renders exactly as before.
- An explicit `get --fields` selection renders every empty collection inside
  the selected item fields and derived facets (`linked`, `schedule`,
  `claim_state`, `children`, `blockers`) at any depth, as JSON delivers it,
  for example `linked.tests: []`. Nulls inside those values stay dropped.

The TOON presentation of an item prints `collection_counts.notes` and
`collection_counts.tests` once, suppressing `notes_count` or `tests_count` only
when the alias equals its canonical count. Zero counts and differing values stay
visible. JSON, including explicit lean JSON, continues to carry the legacy keys.

## Measurement and readability

The reproducible fixtures in `tests/unit/sdk/output/table-rows.spec.ts` cover search,
next-work selection, ranked context, and entity evidence at 1, 8, and 32 rows.
Each includes nested facts. The historical renderer is measured at commit
`5f8ae4d00d77357cbce7e5546569231d02fa7b00`. Token counts use pinned
`gpt-tokenizer@4.0.0`, encoding `o200k_base`, rather than the runtime byte estimate.
Measurements are committed in `tests/fixtures/agent-encoding-baseline.json`.

| Surface / rows | Previous TOON | JSON | Nested TOON | Hoisted cells | Ordinal | Selected |
| -------------- | ------------: | ---: | ----------: | ------------: | ------: | -------: |
| search / 1     |            83 |  110 |          70 |            86 |      88 |       73 |
| search / 8     |           503 |  607 |         406 |           303 |     417 |      303 |
| search / 32    |          1943 | 2311 |        1558 |          1047 |    1545 |     1047 |
| next / 1       |            86 |  122 |          76 |            94 |      93 |       79 |
| next / 8       |           527 |  703 |         454 |           367 |     457 |      367 |
| next / 32      |          2039 | 2695 |        1750 |          1303 |    1705 |     1303 |
| context / 1    |            89 |  118 |          76 |            89 |      95 |       79 |
| context / 8    |           544 |  664 |         447 |           320 |     459 |      321 |
| context / 32   |          2104 | 2536 |        1719 |          1112 |    1707 |     1113 |
| get / 1        |            86 |  124 |          76 |           115 |     106 |       80 |
| get / 8        |           408 |  551 |         279 |           311 |     400 |      264 |
| get / 32       |          1512 | 2015 |         975 |           983 |    1408 |      840 |

These are fixture measurements, not universal compression guarantees. Selected
output combines the existing scalar presentation with a per-collection choice,
so it can differ from a whole-document candidate. The runtime compares bytes;
the mandatory full test suite independently enforces token and byte ratchets.
Information equivalence is checked by standard TOON decoding and explicit cell
restoration, including a negative comparison against an answer missing facts.

Readability requires discoverable column names, unchanged row order, visible
identities, explicit nested-cell metadata, and complete recovery/omission facts.
The review scores one point for each of those five properties, then subtracts
one for an extra JSON-cell decoding step or two for positional row interpretation.
The minimum adopted score is four; it is a design criterion alongside the
independent executable equivalence gate.

| Candidate       | Readability score / 5 | Interpretation                            |
| --------------- | --------------------: | ----------------------------------------- |
| JSON            |                     5 | Named fields and native nested values     |
| Nested TOON     |                     5 | Named fields and standard nested decoding |
| Hoisted cells   |                     4 | Named columns and declared JSON cells     |
| Ordinal         |                     3 | Column lookup plus positional nested rows |
| Selected hybrid |                   4–5 | Expanded small rows or declared tables    |

Ordinal arrays require an additional positional interpretation and save nothing
on these nested fixtures, so they are not adopted. The complete brief-list
projection and existing flat-table defaults retain their earlier policy.
The [TOON benchmark methodology](https://toonformat.dev/guide/benchmarks) motivates
measuring uniform and nested shapes separately rather than assuming one encoding
wins everywhere.

Run the focused equivalence and token gate with:

```bash
node scripts/run-tests.mjs test -- tests/unit/sdk/output/table-rows.spec.ts tests/unit/cli/compact-agent-output.spec.ts
```

## Context budget boundary

For complete JSON/TOON responses, `pm context --token-budget 800` now bounds the
whole rendered envelope: focus, agenda, extension health, provenance, and final
receipts. `read_output.estimated_tokens` uses `ceil(UTF-8 bytes / 4)`, including
the final newline, and reports whether the response fits. The compatibility
ceiling is disclosed as `budget_source: legacy` and `budget_tokens`.
When an enforced context intent already discloses the same ceiling, its receipt
is reused. Session accounting still includes the complete envelope. A mismatched
or unenforced intent receipt never suppresses compatibility-budget evidence.

The SDK applies the same rule to `tokenBudget` and `token_budget`. Canonical
`outputBudget` / `--output-budget` takes precedence. A budget too small for the
answer returns an explicit omission receipt and recovery; it does not pretend
that omitted work is an empty population. Use `--output-budget unbounded` to
request the complete result. Markdown, NDJSON, and other command-specific
streaming budgets remain separate contracts.

`pm next --token-budget` is a selection ceiling for `recommended` and `ready`,
not a response cost: it never replaces the universal ceiling, and requesting it
audits the complete envelope under that ceiling, so `read_output` discloses
`budget_source: default`, `budget_tokens`, and the measured `estimated_tokens`
beside `truncation.ready_budget`. `filters.token_budget` is `null` unless a
selection budget was requested. An enforced `--for` intent receipt already
discloses the whole-response cost and suppresses the duplicate audit.
