# Linked-test metadata edits and configuration refusals

Trackers: [pm-9djr6d](../.agents/pm/tasks/pm-9djr6d.toon),
[pm-gh1440](../.agents/pm/issues/pm-gh1440.toon).

Correct a linked test without removing and re-adding it:

```bash
pm test <item-id> --list
pm test <item-id> --update-index 1 --set-json '{"note":"Verified coverage gate","timeout_seconds":900}'
pm test <item-id> --update 'command=node scripts/check.mjs' --set-json '{"note":"Updated evidence"}'
pm test <item-id> --update 'path=tests/check.mjs' --set-json '{"note":null}'
```

Each edit patches only explicit metadata fields. The entry keeps its position,
command and original `provenance`; changed entries gain `updated_by` and
`updated_at`. An unchanged normalized retry writes no item or history bytes.
One `tests_update` history event carries field-level patches plus the edited
index and metadata field names in `context.linked_test_update`.

Use `null` to clear an optional field, such as a note, path or timeout. Scope is
required and cannot be cleared. Every entry must retain a nonblank command or path:
replace a path-only entry's path rather than clearing its last identity.
Unknown fields, command changes, provenance
changes and editor-stamp overrides are refused. To change the command, remove
and add it through the ordinary provenance-recording workflow. Editing context
or environment controls changes the clone-local trust fingerprint, so any prior
acknowledgment must be reviewed again.

Exactly one selector must match the current collection under the item lock.
Absent selectors and ambiguous command/path matches refuse the whole edit and
retain authoritative bytes; ambiguity names matching indexes. An index addresses
the current list position. Durable metadata-fragment references remain tracked
separately by [pm-gh1381](../.agents/pm/features/pm-gh1381.toon).
Apply edits separately from listing, additions, removals, execution options,
measurements, metric filters and trust acknowledgment. Run-level `--timeout`
and `--progress` are refused on edits; change stored `timeout_seconds` in the
metadata patch when needed. `--list` remains a separate read-only operation.

The public SDK owns the same operation:

```typescript
import { updateLinkedTest } from "@unbrained/pm-cli/sdk/core";

const receipt = await updateLinkedTest(itemId, {
  selector: { command: "node scripts/check.mjs" },
  patch: { note: "Verified coverage gate", timeout_seconds: 900 },
}, { path: trackerRoot });
```

The aggregate SDK exports the same function. `PmClient.run("test", ...)` and the MCP `test`
action accept `update` or `updateIndex` with `setJson`, matching CLI flags. The
receipt exposes `updated_index`, `updated_fields`, and `changed`.
For extension-owned item types, fields or mutation hooks, wrap a direct primitive
with `runWithActiveExtensions({ cwd: projectRoot }, callback)` as described in
[SDK transaction composition](SDK.md#schema-evolution-and-workspace-history).
The `PmClient` action dispatcher owns this scope automatically.

Linked-test mutations through `test`, `create`, `update` and the SDK refuse
`pm_context_mode=none` unless the stored `workspace_context_mode` is `isolated`
or `snapshot`. For example:

```bash
pm test <item-id> --add-json '{"command":"node scripts/self-isolated-check.mjs","pm_context_mode":"none","workspace_context_mode":"isolated"}'
```

The refusal code is `linked_test_context_invalid` and includes a concrete recovery
example. Legacy invalid records remain readable. Running such a record returns
`status: refused`, `failure_category: config_refusal`, and `exit_code: null`;
the command never runs. The item, aggregate and background run remain unsuccessful.
Actual child-process failures retain their observed exit code and ordinary
execution failure category.

SDK consumers with exhaustive `TestRunResult.status` or failure-category switches
must handle `refused` and `config_refusal`. Treat a refusal as an unsuccessful
gate, and display its recovery message; `exit_code: null` means no subprocess ran.
Context mismatches and a missing required PM assertion also use this result.
The `TestRunResult.exit_code` type now allows null, and `TestCommandOptions` and
`TestResult` include the optional editor flags and receipt fields described above.

## Mixed host versions

Tracked by [pm-gh1458](../.agents/pm/issues/pm-gh1458.toon).
Editor stamps require item format 2. Ordinary records retain format 1, while
existing unstamped or legacy format-1 records advance only on a real write that
needs the new fields. Upgrade the CLI, pinned SDK, CI and clone-local merge
driver together before editing guarded records. Hosts from 2026.10.10 refuse
with `item_format_version_unsupported`; preserve item/history bytes and upgrade
instead of lowering the marker or re-anchoring valid history. Inspection of
legacy 2026.10.12–13 records retains their original history commitments.
Restoration retains the format requirement even when selecting a pre-edit state.
The SDK refuses a guarded write when the owning project's declared or resolved
runtime pins still select a pre-2026.10.10 host. Such hosts predate format
admission and must be upgraded before they read guarded records.
