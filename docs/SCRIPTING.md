# CLI Scripting Contract

Tracked by [pm-psy1](../.agents/pm/tasks/pm-psy1.toon), [pm-hqa8g1](../.agents/pm/tasks/pm-hqa8g1.toon), [pm-gknu](../.agents/pm/issues/pm-gknu.toon), [pm-999jh7](../.agents/pm/issues/pm-999jh7.toon), [pm-srns](../.agents/pm/issues/pm-srns.toon), [pm-3oq022](../.agents/pm/issues/pm-3oq022.toon), [pm-iktj](../.agents/pm/tasks/pm-iktj.toon), and [pm-kexu](../.agents/pm/issues/pm-kexu.toon).

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
| `6`  | The request succeeded but matched nothing to change.                             | Treat as success and inspect the effect receipt.     |
| `7`  | The request succeeded and changed only part of the selected targets.             | Treat as success and inspect unmatched/skipped rows. |

Exits `0`, `6`, and `7` are successful outcomes. Bulk mutation envelopes repeat
the distinction as `outcome: effect`, `outcome: no_effect`, or `outcome:
partial_effect` with the same `exit_code`. Because POSIX shells treat every
nonzero exit as a false condition, scripts invoking effect-aware bulk commands
must preserve and classify the status explicitly rather than relying on a bare
`if` condition:

```bash
set +e
result=$(pm update-many --ids "$ids" --tags reviewed --json)
status=$?
set -e

case "$status" in
  0|6|7) printf '%s\n' "$result" | jq '{outcome, matched_count, updated_count}' ;;
  *)     printf '%s\n' "pm update-many failed with exit $status" >&2; exit "$status" ;;
esac
```

The generated contract is authoritative. `pm contracts --command update-many
--full --json` returns `command_exit_contracts.vocabulary` and the selected
command's exhaustive `exit_codes`; SDK consumers can use the same declarations
and `isPmSuccessfulExitCode` from `@unbrained/pm-cli/sdk/contracts`.

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
keys such as `item` or `items`. Bulk mutations such as `close-many` and
`update-many` use collection envelopes under `rows`; consult
`command_output_contracts` for the exact command path. Never infer one shape
from another.

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

Bulk selectors on `update-many`, `close-many`, and `history-compact` accept the
same explicit ID grammar through three CLI channels: comma/newline-delimited
argv text, `-` for stdin, and `@path` for a UTF-8 file. This makes a
read-selector-write pipeline executable without `xargs` command fan-out:

```bash
pm list --status open,in_progress --fields id,priority --json |
  jq -r '.items[] | select(.priority >= 2) | .id' |
  pm update-many --ids - --priority 1 --dry-run --json

pm close-many --ids @reviewed-ids.txt \
  --reason "Reviewed batch completed" --dry-run --json

pm list --status closed --fields id --json |
  jq -r '.items[].id' |
  pm history-compact --ids - --dry-run --json
```

An unreadable `@path`, empty stdin, or empty file fails before the tracker is
read or mutated. `unmatched_ids` means the requested ID does not exist; an
existing ID excluded by another filter is not misreported as nonexistent.
Apply-mode exit `6`/`7` and the structured effect receipt remain authoritative.

`update-many --dry-run` may be filter-only. It returns the matched rows with an
empty `planned_update_options` object and empty per-row `changes`, which is a
bounded way to validate a selector before choosing a mutation. The same
filter-only invocation without `--dry-run` is rejected with exit `2`.

Direct SDK and MCP callers may pass `ids` as a string, a finite numeric scalar,
or an array of string and finite numeric IDs. The SDK normalizes every accepted
shape through the same stable-deduplicating parser; non-finite numbers and
unsupported explicit selector values are rejected before target selection:

```ts
import { PmClient } from "@unbrained/pm-cli/sdk";

const pm = new PmClient({ pmRoot: ".agents/pm" });
await pm.run("update-many", {
  options: {
    ids: ["pm-a1b2", "pm-c3d4"],
    priority: 1,
    dryRun: true,
  },
});
```

File-reading text flags use the same stdin sentinel. `--body-file -` reads a
create/update body, while `comments`, `notes`, and `learnings` accept
`--file -`. Real file paths remain compatible:

```bash
generate_body | pm create --title "Generated plan" --body-file -
render_review | pm comments pm-a1b2 --file -
```

Each command invocation may consume stdin for only one option. Competing
stdin-backed inputs such as `--description - --body-file -` are rejected before
the stream is read.

Use NDJSON for streaming row-by-row tools:

```bash
set -o pipefail
pm list --status all --brief --format ndjson |
  jq -c 'select(.priority <= 1) | {id, title, status}'
```

Before a bulk mutation, run the same selectors with `--dry-run --json`, verify `matched_count`, `filters`, and `item_plans`, then repeat without `--dry-run`. Explicit `--ids` remains the safest final allowlist for automation.

Do not parse default TOON or table output with whitespace tools. Those formats optimize human and agent context; JSON, NDJSON, and CSV are the scripting surfaces.
