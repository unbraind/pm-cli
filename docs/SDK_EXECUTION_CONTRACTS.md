# SDK Execution and Recovery Contracts

Tracker references: [pm-08mt4k](../.agents/pm/issues/pm-08mt4k.toon),
[pm-ugld](../.agents/pm/issues/pm-ugld.toon),
[pm-2bqgs7](../.agents/pm/issues/pm-2bqgs7.toon),
[pm-u4t9gp](../.agents/pm/issues/pm-u4t9gp.toon), and
[pm-bfa1ob](../.agents/pm/issues/pm-bfa1ob.toon).

## Declare Who Can Execute a Type

Custom settings definitions and package `defineItemType` definitions accept
`execution_role: "agent" | "human" | "gate"`. An omitted role defaults to agent
execution; built-in Decision and Milestone types default to human and gate,
respectively. A definition can override a built-in role. Aliases resolve through
the type registry, and invalid roles are rejected rather than silently enabling
execution.

Package authors can declare a review checkpoint alongside the rest of their item
type definition:

```ts
import { defineItemType } from "@unbrained/pm-cli/sdk/authoring";

export const checkpoint = defineItemType({
  name: "Checkpoint",
  folder: "checkpoints",
  aliases: ["checkpoint"],
  execution_role: "gate",
});
```

`computeActionabilityReport` is the pure SDK primitive: it accepts candidates,
the surrounding item corpus, a status registry, and an optional item type
registry. It resolves both forward `blocked_by` and reverse `blocks` edges,
terminal prerequisites, active descendants, and execution roles. Its result
contains ready leaves, blocked leaves, human decisions, gates, and containers.
`selectActionableEntries` applies explicit dispatch opt-ins to that report;
ownership and ranking remain the responsibility of the caller. The selector
returns `ready`, `decisions`, and `gates`: eligible opted-in containers enter
`ready`, subject to their execution role. Read `report.containers` for the full
classified container worklist; the selector does not return a separate
`containers` property.

Integrations that construct an `ActionabilityReport` themselves must now provide
the `containers`, `decisions`, and `gates` arrays. Prefer computing the report
through the SDK so these classifications stay consistent with dependency and
schema rules. Existing callers may omit the new selection options and type
registry argument.

## Read Every Scheduling Bucket

`pm next` exposes `ready`, `decision_needed`, `gate_needed`, `containers`,
`blocked`, and `held_by_others`. Summary counts describe the full matching
buckets; each bounded worklist has truncation totals when needed. The row
contract advertises the new gate and container collections to generic consumers.
Intent budgets compact these worklists along with the other scheduling rows.
Final-delivery feedback records their visible identifiers so recursive context
improvement observes what the caller actually received.
A workspace containing only outcome gates returns no recommendation and explains
how to inspect or explicitly include gates.

`--include-decisions`, `--include-gates`, and `--include-containers` opt into
held-out work for both `next` and `claim --next`. The SDK and MCP use
`includeDecisions`, `includeGates`, and `includeContainers`. These options do not
bypass unresolved blockers, blocked lifecycle states, or ownership checks.
Context places gates, human work, and containers in high-level context rather
than agent execution detail. Population summaries retain all matching work.

## Stop Work Explicitly

`release` relinquishes ownership and preserves status. When an in-progress item
is released (using the configured workflow status), its result includes `released_unclaimed_in_progress` and a concrete
`pm pause-task <id>` suggestion. Use `pause-task` when the intended operation is
to stop work and return it to the configured open state. Consumers should not
interpret an ownership release as evidence that work has stopped.

## Recover from Command Mistakes

Unknown commands direct the caller to `pm --help --all`, the complete core
command surface. `pm tests <id>` is an executable alias of `pm test <id>`.
Positional item operands are accepted in help requests, including hybrid
commands such as `pm files <id> --help --json`; invalid child command names still
produce usage errors.

With `--token-accounting`, JSON refusals carry the same serialized-output
accounting used by successful commands. Accounting is attached after diagnostic
projection and recalculated if extension failures enrich the refusal. The
receipt measures the emitted diagnostic, including its own receipt overhead.
Recovery metadata retains the actual invocation, including the accounting flag.
The executable transcript gate predicts that transport change independently and
rejects any other payload drift. It also verifies that the accounting-off
attempted command agrees with its normalized arguments before projection.
Detailed recovery evidence must contain argument and provided-field arrays.
Compact recovery is accepted only when the transcript explicitly declares and
verifies that mode; its advertised retry still executes as a separate step.
Serialized JSON refusals use the SDK `writeStderr` transport primitive so an
`error_format` text override cannot replace a measured machine payload.
Human-readable error formatting remains customizable through `error_format`.

The flag-invocation gate compares registered executable options against SDK
contracts without filtering out undeclared observations. An option missing from
the contract and a root command missing a resolver both fail the gate. A seeded
undeclared option is a mandatory negative control. Contract snapshots, MCP
parameter declarations, help, and completion are regenerated from the shared
contract tables.
