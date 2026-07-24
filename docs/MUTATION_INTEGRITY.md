# Mutation Integrity

Tracker references: [pm-h90s](../.agents/pm/issues/pm-h90s.toon), [pm-pim7](../.agents/pm/features/pm-pim7.toon), [pm-w8q4](../.agents/pm/features/pm-w8q4.toon)

`pm` treats mutation provenance and content safety as shared SDK policy. CLI,
MCP, and package hosts can therefore enforce the same rules without duplicating
argument parsing or exposing detected values.

## Agent Quick Context

- Every mutation should have a stable author. Precedence remains explicit
  invocation author, `PM_AUTHOR`, then `author_default`.
- The secret guard inspects string leaves and returns only detector names and
  object paths. It never returns the matched value.
- `pm health` reports old, unclaimed in-progress work as advisory governance
  data. It does not change ownership or status.
- Historical unknown-author events remain immutable. Maintainers can append an
  audited acknowledgment rather than rewriting their original JSONL streams.

## Workspace Policy

Configure policy through `pm config`; do not hand-edit `settings.json`.

```bash
pm config project set mutation_guard_require_attributed_author true
pm config project set mutation_guard_secret_guard block
pm config project set mutation_guard_stale_in_progress_hours 48
```

Defaults preserve author compatibility while providing secret advice:

| Setting                                    | Default  | Behavior                                                 |
| ------------------------------------------ | -------- | -------------------------------------------------------- |
| `mutation_guard.require_attributed_author` | `false`  | When enabled, reject an effective author of `unknown`.   |
| `mutation_guard.secret_guard`              | `advise` | `off`, stderr/structured `advise`, or pre-write `block`. |
| `mutation_guard.stale_in_progress_hours`   | `72`     | Age threshold for unclaimed active work in `pm health`.  |

A blocking secret policy may be bypassed only by an explicit `--force` on a
force-capable mutation. The warning records that an override occurred while
remaining fully redacted.

## SDK Use

Package hosts can apply the exact runtime policy before dispatch:

```ts
import {
  evaluateMutationGuard,
  inspectStaleInProgressItems,
  scanMutationSecrets,
} from "@unbrained/pm-cli/sdk";

const guarded = evaluateMutationGuard({
  author: "package-agent",
  payload: mutationInput,
  settings: projectSettings.mutation_guard,
});

const findings = scanMutationSecrets(mutationInput);
const stale = inspectStaleInProgressItems(items, {
  in_progress_status:
    projectSettings.schema.workflow.in_progress_status ?? "in_progress",
  threshold_hours: projectSettings.mutation_guard.stale_in_progress_hours,
});
```

`evaluateMutationGuard` returns stable warning codes, redacted findings, and
whether a blocking policy was explicitly overridden. `scanMutationSecrets` is
available separately for package-specific preflight UIs. Cyclic inputs are
safe; scanner failures fail open with `secret_guard_scan_failed_open`.

## Unknown-Author Disposition

Use `scanHistoryAuthorAttribution` to obtain exact item and one-based line
coordinates. After evidence-backed review, SDK hosts can call
`acknowledgeUnknownAuthorHistoryEvents`. The function validates that every
target is still an actionable unknown-author event and appends
`history:author-acknowledge` to `_workspace.jsonl`.

The acknowledgment includes target coordinates, the attributed principal,
reviewer, and rationale. Subsequent health and validation scans keep the
unknown event in immutable totals but remove it from actionable warnings.

## Stale In-Progress Governance

`scanStaleInProgressItems` combines item metadata with the latest valid history
timestamp. An item is reported only when all three conditions hold:

1. its normalized status matches the configured in-progress status;
2. it has no assignee;
3. its last activity is at least the configured threshold old.

The health result includes deterministic item ordering, age, last activity,
threshold, and remediation. Resolve each finding by claiming genuinely active
work or returning abandoned work to `open`. A direct
`pm update <id> --status in_progress` also emits a stderr-only advisory when
the resulting item would have no assignee; use `pm claim <id>` to make active
ownership explicit. Machine-readable `--json` invocations suppress this
presentation advisory so stderr remains a single parseable error envelope.
