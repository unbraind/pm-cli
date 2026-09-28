# Agent Read and Test Receipts

Tracked by [pm-s8ztcl](../.agents/pm/issues/pm-s8ztcl.toon), [pm-aao1hy](../.agents/pm/issues/pm-aao1hy.toon), and [pm-c3aiik](../.agents/pm/issues/pm-c3aiik.toon).

## Agent Quick Context

The SDK owns the authoritative read and test results. CLI JSON preserves the same receipts so an agent can distinguish a completed action from recorded evidence, and can continue a bounded history read without silently losing rows.

## Command Help

`pm help <command> --json` reports `intent_source`. A named help bundle supplies `help_bundle`; when a command has no named bundle, the command description supplies `command_description`. Root help applies only to the root request. An unbundled command shows a command-specific help invocation and empty `tips` rather than unrelated root examples.

## Linked Test Runs

`pm test <id> --run --json` returns `evidence_recording` on an executed run. `recorded: true` means the test summary was appended to tracker history. `recorded: false` includes a reason such as `tracking_disabled` or `write_failed`; the disabled case also includes a recovery command. The command's `changed` field is true when the run was recorded even if no test definition changed. The receipt does not claim that a passing process exit was persisted when tracking is disabled.

Enable recording with `pm config project set test-result-tracking --policy enabled`, then rerun the linked test. The history `test_run_track` event is the durable evidence to inspect. Use a temporary tracker for experiments; repository linked tests must keep real `.agents/pm` data isolated.

## History Diff Continuation

`pm history <id> --diff --json` can return separate `compact_history` and `diff` continuation cursors under a bounded output budget. Continue the `diff` cursor to retrieve subsequent diff rows. Its `projection.row_key` identifies the active collection and `count` counts that collection. A budget cursor is available only when `next_cursor` is present. When `applied_bound.kind` is `output_limit`, `has_more: true` can instead mean the explicit row limit withheld rows; raise `--output-limit` to retrieve them. If `truncated` remains true without a cursor, increase `--output-budget` or select a smaller history range. A single diff entry larger than the chosen budget requires a larger budget.
