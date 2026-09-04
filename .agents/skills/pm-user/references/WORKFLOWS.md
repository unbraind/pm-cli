# User and Operator Workflows

## Intake Workflow

1. Query current context:

```bash
pm context --limit 10
pm search "<keywords>" --limit 10
pm list --status open --limit 20
pm list --status in_progress --limit 20
```

2. If existing item matches, reuse and update it.
3. If no match exists, create parent lineage then child item.
4. Add duplicate-check evidence in comments at creation time.

## Claim and Ownership Workflow

```bash
pm claim <ID>
pm update <ID> --status in_progress --message "Start work"
pm comments <ID> "Owner update: <state>"
pm release <ID>
```

## Recording Durable Knowledge

A comment explains this item; a learning outlives it. Record a lesson the
moment it is confirmed, on the item that produced it:

```bash
pm learnings <ID> --add "<what turned out to be true and how it was proven>"
pm learnings <ID> --limit 5
pm guide evidence --depth brief
```

## Append-Only Collaboration Between Owners

Comments, notes, and typed dependencies append for any author on a bare
install; no bypass flag is needed. The review-style flags below are provided by
the `governance-audit` package and are refused as unknown options until it is
installed:

```bash
pm package install governance-audit --project
pm comments <ID> --add "review comment" --allow-audit-comment
pm notes <ID> --add "review note" --allow-audit-comment
pm update <ID> --dep "id=<id>,kind=discovered_from" --allow-audit-dep-update
```
