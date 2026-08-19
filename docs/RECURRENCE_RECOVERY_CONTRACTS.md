# Recurrence and Executable Recovery Contracts

Tracked by [pm-83cz0o](../.agents/pm/features/pm-83cz0o.toon),
[pm-qljv](../.agents/pm/issues/pm-qljv.toon),
[pm-surv](../.agents/pm/issues/pm-surv.toon),
[pm-h8tpeh](../.agents/pm/features/pm-h8tpeh.toon), and
[pm-f05lsg](../.agents/pm/features/pm-f05lsg.toon).

## Agent Quick Context

- Reuse an active matching item; reopen a terminal matching item.
- `pm item reopen` is the noun-first recurrence command. It never creates a
  second item and never rewrites the earlier close event.
- Recovery guidance is capability-aware: it names an executable command on the
  current surface, or installs the package that owns the command first.
- Generated `AGENTS.md` guidance detects the target repository's test command.
  When no executable test contract exists, it prints an explicit placeholder
  instead of naming a pm-cli repository script that the target does not have.

## Reopen Terminal Work

```bash
pm item reopen pm-a1b2 "The production failure recurred after deployment"
pm item reopen pm-a1b2 "The customer reproduced the issue" --status in_progress
```

The command accepts only the workspace open or in-progress status. While
holding the item lock it verifies that the current status is terminal, records
one `reopen` history event with structured recurrence context, and delegates the
state change to the normal update pipeline. Active metadata drops stale
`closed_at`, `completed_at`, `close_reason`, `resolution`, `expected_result`,
`actual_result`, and `fixed_version` values. Earlier history retains the exact
closure values.

Compact output keeps the recurrence receipt because the prior and next status,
reason, and terminal evidence are the proof that this was a recurrence rather
than a generic edit. An already-active item fails with
`item_already_active` and points to `pm get <id> --full`; continue that item with
`pm update` instead of manufacturing another recurrence event.

## SDK and MCP

```ts
import { PmClient, reopen } from "@unbrained/pm-cli/sdk";

const pm = new PmClient({ pmRoot: "/workspace/.agents/pm" });
const viaClient = await pm.reopen(
  "pm-a1b2",
  "The production failure recurred",
  { status: "in_progress" },
);

const viaFunction = await reopen(
  "pm-c3d4",
  "The customer reproduced the issue",
  {},
  { pmRoot: "/workspace/.agents/pm" },
);

console.log(viaClient.recurrence.previous_terminal);
console.log(viaFunction.recurrence.from_status);
```

Generic action hosts use `item-reopen` with required `id` and `reason` fields.
The action participates in the generated action schema, SDK dispatch coverage,
CLI/SDK parameter parity, command grammar, and MCP `pm_run` surface.

## Duplicate Intake

Create and copy similarity governance inspect all lifecycle statuses. The
strongest active match returns a `pm get <id> --full` reuse path. The strongest
terminal match returns:

```bash
pm item reopen <id> "<recurrence reason>"
```

Strict duplicate refusal exposes the same command and tokenized arguments in
its structured recovery envelope. Advisory mode adds a compact
`likely_duplicate_recovery:<reuse|reopen>:<id>` warning so agents can select the
correct lifecycle action without reparsing prose.

## Capability-Aware Reindex Recovery

When semantic search detects stale vectors, it inspects the active extension
command registry. If `reindex` is active, the direct recovery is:

```bash
pm reindex --mode hybrid
```

If the command is absent, recovery is a two-step executable sequence:

```bash
pm install search-advanced --project
pm reindex --mode hybrid
```

The human warning and structured `vector_index_recovery` tokens come from the
same resolution. This prevents a base installation from suggesting an
unavailable command.

## Target-Aware Generated Test Guidance

`pm init --agent-guidance add` resolves the linked-test command in this order:

1. `node scripts/run-tests.mjs test` when that repository script exists.
2. The declared package manager's `test` script (`pnpm test`, `bun run test`,
   `yarn test`, or `npm test`).
3. `<your project test command>` when the target does not declare an executable
   test contract.

The managed guidance block is versioned, so a later init can replace an older
pm-managed block without changing surrounding repository instructions.
