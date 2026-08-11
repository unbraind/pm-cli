# Trustworthy Context and Evidence Contracts

Tracker: [pm-py7qv2](../.agents/pm/issues/pm-py7qv2.toon), [pm-33mjrw](../.agents/pm/issues/pm-33mjrw.toon), [pm-q6n8sj](../.agents/pm/issues/pm-q6n8sj.toon), [pm-h97qxd](../.agents/pm/issues/pm-h97qxd.toon), [pm-rncuf7](../.agents/pm/issues/pm-rncuf7.toon), [pm-m0b7h8](../.agents/pm/issues/pm-m0b7h8.toon)

## Agent Quick Context

Project management is context management. These contracts make absence, identity, composition, and mutation outcomes explicit across CLI, SDK, MCP, packages, and persisted history:

- Assurance evaluates authoritative full item records, supports first-class field presence predicates, canonicalizes relationship aliases, fingerprints measurement definitions, and attributes writes through the normal detected-author chain.
- Graph audit reports both counts and ratios: `edge_share_by_kind`, `semantic_edges`, and `semantic_edge_share` alongside the existing structural profile.
- Every health check row carries `ok: boolean` beside its compatible `status: ok|warn` value, including brief, summary, skipped, and full projections.
- Linked-test removal preserves commands containing commas or equals signs, offers a lossless 1-based index selector, reports `removed`, and refuses a zero-match removal.
- Collection grammar recovery labels positional roles when noun-verb-object input is transposed, then provides the accepted object-first command.

Use runtime contracts for the exact active surface:

```bash
pm contracts --command test --flags-only --json
pm contracts --action test --schema-only --json
pm health --summary --json
pm graph audit --summary --json
```

## Assurance Predicates and Verdict Identity

An item-field measurement must choose exactly one predicate:

```json
{
  "id": "missing-tests",
  "source": { "kind": "items", "field": "tests", "state": "missing" }
}
```

```json
{
  "id": "priority-one",
  "source": { "kind": "items", "field": "priority", "equals": 1 }
}
```

`state: missing` covers absent properties, `null`, empty strings, and empty arrays. `state: present` is its complement. Explicit `equals: null` remains an exact-value predicate and is not conflated with missing configuration.

Each measurement result carries `definition_fingerprint`; assertion verdicts copy it as `measurement_definition_fingerprint`. A stored verdict can therefore be joined to the exact declaration semantics that produced it. Older verdicts remain readable and are visibly legacy because the fingerprint field is absent.

## Graph Composition

`pm graph audit` uses deduplicated directed edges as the denominator:

```json
{
  "edges": 12,
  "edges_by_kind": { "parent": 4, "related": 6, "verifies": 2 },
  "edge_share_by_kind": {
    "parent": 0.3333333333333333,
    "related": 0.5,
    "verifies": 0.16666666666666666
  },
  "semantic_edges": 2,
  "semantic_edge_share": 0.16666666666666666
}
```

The semantic numerator is the sum of `discovered_from`, `incident_from`, `supersedes`, and `verifies`. Audit baselines preserve the new fields, accept older snapshots with explicit zero defaults, and report signed count/share deltas.

## Health Row Predicate

Every entry in `health.checks` has this stable shape:

```json
{ "name": "storage", "status": "ok", "ok": true, "details": {} }
```

`status` remains for compatibility and human rendering. `ok` is the direct machine predicate; it survives brief and summary projections. Assurance health sources accept either `field: status` or `field: ok` and normalize success to `0`, warning to `1`.

## Lossless Linked-Test Removal

List first when selecting an index:

```bash
pm test pm-example --list --json
pm test pm-example --remove-index 2 --json
```

`--remove-index` is repeatable and uses the current 1-based list order. Exact identity selectors remain available:

```bash
pm test pm-example --remove 'command=node -e "console.log("left=right,still-command")"' --json
pm test pm-example --remove 'path=tests/example.spec.ts' --json
```

For `command=` and `path=`, everything after the first identity prefix is the value; commas and equals signs are not re-parsed as fields. A successful mutation reports `removed`; a selector matching nothing raises `linked_test_remove_no_match` with unmatched selectors and a list-first recovery instead of returning a false-success no-op.

## Collection Grammar Recovery

Collection mutations use object-first grammar:

```bash
pm notes pm-example --add "context"
pm comments pm-example --add "reviewed"
pm files pm-example --add path=src/example.ts
pm docs pm-example --add path=docs/example.md
pm test pm-example --add 'command=pnpm test'
```

Inputs such as `pm notes add pm-example --note context` are refused as a transposed `add` subcommand. Structured recovery reports `transposed_subcommand=add` and `item_id=pm-example`, then supplies `pm notes pm-example --add context`. The visible notes `--note` alias remains accepted for compatibility, but new automation should use canonical `--add`.
