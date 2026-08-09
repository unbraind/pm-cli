# Stable Item Read Projections

Tracker reference: [pm-b1w8vr](../.agents/pm/issues/pm-b1w8vr.toon).

Item mutation and read-back surfaces share one collection vocabulary:
`comments`, `notes`, `learnings`, `files`, `tests`, `docs`, `reminders`, and
`events`. Every normal `pm get` and SDK `runGet` result carries
`item.collection_counts` with all eight keys, including zero values. This gives
agents a stable, low-token way to verify a write without requesting complete
collection payloads.

`brief` and `standard` omit the collection arrays but retain the stable counts.
`deep`, `full`, and `--full` include every collection array, normalizing absent
collections to `[]`, and retain `notes_count`, `tests_count`, and
`collection_counts`. A full projection is therefore a structural superset of
the standard item projection rather than a different shape.

Field projections can request `collection_counts` directly:

```bash
pm get pm-example --fields id,updated_at,collection_counts
```

Package authors receive the same contract from `runGet`. Do not infer whether
a collection exists by checking for an omitted key; use the count projection,
or request a full projection when the entries themselves are needed.
