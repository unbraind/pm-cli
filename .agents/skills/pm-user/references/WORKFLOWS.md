# User and Operator Workflows

## Intake Workflow

1. Query current context:

```bash
pm context --limit 10
pm search "<keywords>" --limit 10
pm list-open --limit 20
pm list-in-progress --limit 20
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

## Audit-Friendly Collaboration

For non-owner append-only collaboration:

```bash
pm comments <ID> --add "audit comment" --allow-audit-comment
pm notes <ID> --add "audit note" --allow-audit-comment
pm update <ID> --dep "id=<id>,kind=related,author=<author>,created_at=now" --allow-audit-dep-update
```
