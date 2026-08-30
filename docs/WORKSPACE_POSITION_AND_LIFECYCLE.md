# Workspace Position and Lifecycle Roles

Tracker references: [pm-bq0ii8](../.agents/pm/features/pm-bq0ii8.toon), [pm-0mhspz](../.agents/pm/issues/pm-0mhspz.toon)

## Agent Quick Context

Project management is context management. A project status must therefore be both semantically classifiable and operationally safe to merge. Two SDK-owned primitives provide that baseline:

- lifecycle roles make custom workflow states participate consistently in `next`, `context`, list aliases, validation, and health;
- workspace position combines merge-fence, pending merge-receipt, and append-only history evidence into one bounded readiness state and one next action.

## Role-Safe Custom Statuses

Every newly registered custom status requires at least one lifecycle role:

```bash
pm schema add-status review --role active
pm schema add-status waiting_external --role blocked
pm schema add-status abandoned --role terminal --role terminal_canceled
```

The supported roles are `draft`, `active`, `blocked`, `terminal`, `terminal_done`, `terminal_canceled`, `default_open`, `default_close`, and `default_cancel`. A status may have multiple roles when it is both a lifecycle member and a workflow default.

An existing status can be updated without repeating `--role`; its registered role is preserved. New roleless statuses and explicit empty role lists are refused. This prevents an item from being accepted into storage but disappearing from every actionable read.

Role-derived behavior is shared:

- `pm next` treats every `active` status as actionable unless dependency or blocker rules exclude it.
- `pm list --status open` and the deprecated `pm list-open` alias include active statuses other than the configured `in_progress_status`.
- `pm list --status in_progress` and `pm list-in-progress` select the configured in-progress workflow anchor.
- `pm context` guarantees `summary.active_items = summary.open + summary.in_progress`; custom active statuses cannot disappear from that accounting.
- `pm list-blocked` continues to combine blocked-role status and unresolved dependency evidence.

Legacy hand-edited or older trackers may still contain roleless definitions. Both commands surface the same warning and bounded affected-item evidence:

```bash
pm health --check-only --full --json
pm validate --check-lifecycle --json
```

Look for `schema_status_missing_lifecycle_role:<count>` and
`lifecycle_status_roles`. Diagnostics retain `roleless_status_count` while
bounding both status and affected-item ID samples with explicit truncation
flags. Repair the schema by re-registering each status with its intended role
before making workflow decisions.

## One Workspace Position Read

Run:

```bash
pm workspace position
pm workspace position --json
```

The read requires no feature flag or session state. It reports:

- whether the committed `.gitattributes` merge fence matches the project schema;
- whether this clone has all required field-aware Git driver definitions;
- pending merge decisions, lossless receipt count, and invalid evidence count;
- bounded append-only history-drift counts and affected item IDs;
- one deterministic `state` and one `next_action.command`.

The next action always pins the inspected tracker with `--pm-path` and uses the
SDK's platform-aware command renderer. Paths with spaces or shell-significant
characters are therefore copy-safe on both POSIX shells and Windows command
lines, while package consumers can reuse `renderPmCommand` for their own
tokenized recovery actions.

Recovery precedence is intentional:

| State                           | Next action                                | Why it comes first                                                        |
| ------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| `merge_evidence_invalid`        | `pm merge report`                          | Untrusted evidence must be inspected before it can drive repair.          |
| `history_evidence_invalid`      | `pm validate --check-history-drift --full` | Required history evidence could not be interpreted safely.                |
| `merge_reconciliation_required` | `pm merge reconcile`                       | Pending scalar decisions can explain and settle merge-created divergence. |
| `history_repair_required`       | `pm history-repair --all`                  | Remaining append-only drift needs an audited re-anchor.                   |
| `merge_fence_unprepared`        | `pm merge install`                         | The committed fence or clone-local drivers are absent or drifted.         |
| `ready`                         | none                                       | All included readiness predicates passed.                                 |

`pm health --strict-exit` also treats missing clone-local merge drivers as blocking. Default health remains advisory for never-installed drivers so ordinary diagnostics retain backward compatibility.

## SDK and Generic Runtime

Package authors can use the same implementation as the CLI:

```ts
import {
  inspectStatusRoleAssignments,
  readWorkspacePosition,
  resolveRuntimeStatusRegistry,
} from "@unbrained/pm-cli/sdk";

const position = await readWorkspacePosition({ path: ".agents/pm" });
if (!position.ok) {
  console.log(position.next_action.command);
}
```

The generic SDK/MCP action is `workspace` with `subcommand: "position"`. Snapshot operations remain `subcommand: "snapshot"` plus `snapshotAction`. Presentation layers do not duplicate readiness or lifecycle classification logic.

## Operational Sequence

On a fresh clone:

```bash
npm install -g .
pm merge install
pm workspace position --json
pm health --strict-exit --full --json
```

After a branch merge, run workspace position before claiming that the tracker is safe. Follow only its selected next action, rerun the read, and continue until `state` is `ready`. This keeps remediation evidence ordered, token-bounded, and reproducible.
