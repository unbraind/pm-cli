# CLI Scripting Contract

Tracked by [pm-psy1](../.agents/pm/tasks/pm-psy1.toon), [pm-gknu](../.agents/pm/issues/pm-gknu.toon), [pm-999jh7](../.agents/pm/issues/pm-999jh7.toon), and [pm-srns](../.agents/pm/issues/pm-srns.toon).

Use this contract when composing `pm` with shells, CI runners, `jq`, or another process. Exact flags remain discoverable from `pm <command> --help --json` and `pm contracts --command <command> --flags-only --json`.

## Process Contract

| Exit | Meaning                                                                          | Script response                                      |
| ---- | -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `0`  | The requested operation completed. A successful read may still return zero rows. | Parse stdout.                                        |
| `1`  | Runtime or unexpected failure.                                                   | Preserve stderr and stop.                            |
| `2`  | Invalid flags, values, or command composition.                                   | Correct the invocation; do not retry unchanged.      |
| `3`  | Requested tracker or resource was not found.                                     | Correct the path or ID.                              |
| `4`  | State or concurrency conflict.                                                   | Refresh live state before deciding whether to retry. |
| `5`  | A required dependency operation failed.                                          | Inspect the dependency evidence before retrying.     |

Successful structured results are written to stdout. Diagnostics, warnings, profiles, and errors are written to stderr so `--json`, `--format ndjson`, CSV, and table stdout remain pipe-safe. Never merge stderr into stdout before parsing structured output.

```bash
if result=$(pm list --type Task,Issue --status open,in_progress --json); then
  printf '%s\n' "$result" | jq -r '.items[].id'
else
  status=$?
  printf '%s\n' "pm list failed" >&2
  exit "$status"
fi
```

## Stable Structured Fields

Mutation and read envelopes are intentionally different. Single-item mutation
commands emit a flat receipt whose `id`, `status`, and `changed_field_count`
are top-level fields. Reads wrap their primary entity or rows under documented
keys such as `item` or `items`. Never infer one shape from the other.

TypeScript package consumers should parse mutation stdout with the SDK boundary
helper so a wrapped or malformed result fails loudly:

```ts
import { parseMutationReceipt } from "@unbrained/pm-cli/sdk/contracts";

const { id, status, changedFieldCount } = parseMutationReceipt(stdout);
```

`pm contracts --summary --json` keeps bootstrap discovery compact while
declaring every command's default token ceiling. Use `pm contracts --full
--json` for `command_output_contracts`, which pairs the envelope declaration
with TOON- and JSON-specific token ceilings for every active core or package
command.

JSON object field order is not an API. Consume fields by name. Read envelopes keep the stable pagination vocabulary `items`, `count`, `total`, `has_more`, and, when another page exists, `next_cursor`. The `filters` object echoes the effective query scope. Plain `pm list` and `pm search` are all-status reads and disclose `filters.status: "all"`; lifecycle-specific commands such as `pm list-open` remain explicit shortcuts.

Projection flags intentionally change row shape. Use `--fields` when a script requires an exact subset, `--brief` or `--compact` only when the documented sparse shape is sufficient, and `--full` when linked metadata is required. Check `row_contract` on generic read surfaces that expose one; do not infer omitted fields as empty values.

For long-lived clients, generate or inspect the runtime contract instead of hard-coding recalled flags:

```bash
set -o pipefail
pm contracts --command list --flags-only --json |
  jq -e '.flags[] | select(.flag == "--status" and .list == true)'
```

## Uniform OR Filters

`list`, `search`, `aggregate`, and `update-many` accept repeated or comma-separated values for lifecycle status, type, tag, priority, assignee, sprint, and release selectors. Values within one selector use OR semantics; different selectors combine with AND semantics. Every token is validated before tracker rows are returned or mutated.

```bash
pm list --status open --status in_progress --type Task,Issue --json
pm search "release readiness" --priority 0,1 --assignee alice,bob --json
pm aggregate --group-by status --status open,blocked --type Task,Issue --json
pm update-many --filter-status open,blocked --filter-type Task,Issue \
  --priority 1 --dry-run --json
```

Tags follow the same OR grammar. Escape a literal comma as `\,` and a literal backslash as `\\`; quote the argument so the shell passes the backslash through:

```bash
pm list --tag 'customer\,success,security' --json
```

Package authors can reuse the exact parser without importing CLI adapters:

```ts
import {
  parsePriorityFilterSet,
  parseStringFilterSet,
  parseTypeFilterSet,
} from "@unbrained/pm-cli/sdk/query";
```

## Composition Recipes

Prefer cursor continuation over offsets for a changing corpus, and pass IDs through JSON rather than parsing human output:

```bash
if search_result=$(pm search "needs documentation" --status open,in_progress --fields id --json); then
  ids=$(printf '%s\n' "$search_result" | jq -r '.items[].id') || exit $?
  if [ -n "$ids" ]; then
    printf '%s\n' "$ids" | xargs -n 1 pm get --fields id,title,status --json
  fi
else
  status=$?
  exit "$status"
fi
```

Use NDJSON for streaming row-by-row tools:

```bash
set -o pipefail
pm list --status all --brief --format ndjson |
  jq -c 'select(.priority <= 1) | {id, title, status}'
```

Before a bulk mutation, run the same selectors with `--dry-run --json`, verify `matched_count`, `filters`, and `item_plans`, then repeat without `--dry-run`. Explicit `--ids` remains the safest final allowlist for automation.

Do not parse default TOON or table output with whitespace tools. Those formats optimize human and agent context; JSON, NDJSON, and CSV are the scripting surfaces.
