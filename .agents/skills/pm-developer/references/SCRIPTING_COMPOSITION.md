# Composing pm With Shell Tools

`pm` is designed to be a process in a pipeline. Full contract:
[docs/SCRIPTING.md](../../../../docs/SCRIPTING.md) (~1.9k tok).

## Exit Codes Are Part Of The Answer

| Exit | Meaning                                   | Response                            |
| ---- | ----------------------------------------- | ----------------------------------- |
| 0    | Completed (a read may return zero rows)   | Parse stdout.                       |
| 1    | Runtime failure                           | Preserve stderr and stop.           |
| 2    | Invalid flags or composition              | Fix the invocation; do not retry.   |
| 3    | Tracker or resource not found             | Fix the path or id.                 |
| 4    | State or concurrency conflict             | Refresh live state, then decide.    |
| 5    | A dependency operation failed             | Inspect dependency evidence.        |
| 6    | Succeeded, matched nothing to change      | Success. Inspect the receipt.       |
| 7    | Succeeded, changed part of the selection  | Success. Inspect unmatched rows.    |

`0`, `6`, and `7` are all success. A bare `if pm ...; then` treats `6` and `7`
as failure, so classify the status explicitly in scripts.

## JSON Shapes

- CLI JSON has **no result wrapper**. `pm get <ID> --json` returns the entity
  envelope directly.
- Collections return `items`, `count`, `total`, `has_more`, `next_cursor`, and
  a `completeness` block.
- Mutations return a flat receipt: `id`, `status`, `changed_field_count`.
- `--lean` drops nulls and empty containers, which makes `jq` selectors shorter
  and the payload smaller.

## Patterns

Select ids and act on them:

```bash
ids=$(pm list --status open --type Issue --json --output-budget unbounded \
  | jq -r '.items[] | select(.title | test("Semgrep")) | .id' | paste -sd,)
pm update-many --ids "$ids" --tags triaged --dry-run
```

Bulk writes take ids comma-joined in a single argument; reads emit one id per
line. `paste -sd,` or `tr '\n' ','` bridges the two.

Aggregate without loading rows:

```bash
pm aggregate --group-by type --json | jq '.groups'
pm stats --json | jq '.by_status'
```

Drive a check from graph structure:

```bash
pm graph audit --json | jq '{findings: .finding_count, redundant: .profile.redundant_edges}'
```

Stream history:

```bash
pm activity --limit 50 --json | jq -r '.events[] | [.at, .op, .item_id] | @tsv'
```

## Guardrails

- One malformed flag makes a whole bulk update apply nothing. Use `--dry-run`
  first on any `*-many` command.
- Never delete items by search match. Delete only by exact id.
- Do not write absolute filesystem paths into item text; run the repository
  secret scan before committing tracker changes.
- Prefer `--output-budget unbounded` only inside scripts that consume the output
  programmatically, never in an agent's own context.

## Discovering Exact Flags

The contract is authoritative and never stale:

```bash
pm <command> --help --json
pm contracts --command <command> --flags-only --json
pm contracts --command <command> --full --json | jq '.command_exit_contracts'
```
