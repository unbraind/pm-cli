# SDK Context Integrity Primitives

Tracker references: [pm-2i12ti](../.agents/pm/issues/pm-2i12ti.toon), [pm-r9pudt](../.agents/pm/issues/pm-r9pudt.toon), [pm-g512pv](../.agents/pm/issues/pm-g512pv.toon), [pm-96tter](../.agents/pm/issues/pm-96tter.toon), [pm-bxdlfa](../.agents/pm/issues/pm-bxdlfa.toon), [pm-z5vamp](../.agents/pm/issues/pm-z5vamp.toon), [pm-j36ypd](../.agents/pm/issues/pm-j36ypd.toon), [pm-jvken3](../.agents/pm/issues/pm-jvken3.toon), [pm-qswf81](../.agents/pm/issues/pm-qswf81.toon), [pm-wdrkfr](../.agents/pm/issues/pm-wdrkfr.toon), [pm-x2aplf](../.agents/pm/issues/pm-x2aplf.toon), and [pm-ixoa](../.agents/pm/issues/pm-ixoa.toon).

This page collects the context-integrity contracts shared by the CLI, SDK, and
package runtime. They preserve the central invariant that project management is
context management: state transitions must be complete, evidence must survive,
diagnostics must explain the selected workspace, and large analyses must disclose
their cost without flooding agent context.

## Batch duplicate discovery

Use `findDuplicateClusters` when a package or maintenance workflow needs one
whole-tracker duplicate sweep. The operation reads lightweight metadata once,
defaults to every lifecycle status, prepares each title once, and scores only
pairs that share a deterministic signal.

```ts
import { findDuplicateClusters } from "@unbrained/pm-cli/sdk";

const result = await findDuplicateClusters({
  pmRoot: ".agents/pm",
  threshold: 0.82,
  statuses: ["open", "in_progress", "closed"],
  since: "2026-01-01T00:00:00.000Z",
  limit: 100,
});

for (const cluster of result.clusters) {
  console.log(cluster.id, cluster.items, cluster.matches);
}
console.log(result.cost);
```

The returned `cost` reports retained items, candidate pairs, and scored pairs.
Results are connected components, so transitive similarity is represented
without emitting every unrelated pair. Ordering is deterministic. The SDK caps
cluster results at 1,000 and candidate pair evaluation at 1,000,000.

For custom in-memory pipelines, use `prepareSimilarityText` once per title and
`scorePreparedItemSimilarity` for repeated comparisons. `findSimilarItems`
remains the index-first primitive for one create/copy candidate.

## Structured document errors

`PmCliError.code` mirrors the stable machine code in its context. Item document
readers distinguish syntax/shape failures from schema-validation failures:

- `item_document_parse_failed` identifies malformed JSON, Markdown frontmatter,
  TOON syntax, merge-conflict residue, or a non-item document shape.
- `item_document_invalid` identifies a parsed document that is missing required
  item fields or fails schema validation.

The context can include `reason`, `field`, `format`, and `format_version`.
Consumers should branch on `error.code`, use bounded context for recovery, and
treat prose messages as presentation rather than a parsing contract.

## Plan lifecycle and evidence

Seeded `pm plan create` validates step evidence before creating the Plan and
persists Plan metadata, ordered steps, validation entries, and the requested
assignee together. This prevents a cross-owner intermediate Plan from becoming
observable.

`update-step` accepts repeatable `--file`, `--test`, and `--doc` evidence. Entries
are parsed before mutation, persisted on the step, and deduplicated. Invalid
evidence uses the stable code `malformed_plan_step_evidence`.

`resume` and `approve` persist an explicitly supplied `--scope`. Closing a Plan
whose steps are all complete changes `plan_mode` to `completed` in the same
history mutation. Later Plan mutations fail with `terminal_plan_mutation` for a
closed Plan or a Plan in `completed`/`superseded` mode.

These rules keep the item lifecycle, Plan lifecycle, resumable context, and
evidence ledger aligned for stateless agents.

## Linked-test output and installed extensions

Linked tests always drain child stdout and stderr. Stored evidence is bounded at
20 MiB per stream; crossing the bound truncates retained output instead of
terminating a healthy verbose child. Results disclose truncation in stdout and
progress emits `output=truncated`.

Project extensions installed into a linked-test sandbox remain available to
child `pm` processes. Package acceptance should still use an exact installed
artifact in a fresh temporary project:

```bash
pnpm build
node scripts/run-tests.mjs test -- tests/unit/commands/test-command.spec.ts
```

## Workspace relocation diagnostics

When `--pm-path` selects a tracker whose active extension command set differs
from the current workspace tracker, unknown-command recovery reports an
`extension-root-relocation` diagnostic. It identifies the selected storage root,
extension discovery root, current workspace root, missing command paths, and
copy-pasteable install or `--pm-path` recovery.

This is diagnostic only: pm never silently changes the requested tracker root or
loads project extensions from a different workspace.

## Sparse settings persistence

Settings reads retain both the validated source settings and effective runtime
settings. A write computes the intended runtime delta and applies only that delta
to the validated file-backed source. Consequently, changing one leaf:

- preserves explicit stored values owned by a preset;
- preserves unknown forward-compatible keys;
- does not materialize unrelated optional default sections; and
- keeps stable top-level ordering.

Callers should continue using the public config and settings APIs rather than
rewriting `settings.json`.

## Delete tombstones

`pm delete` removes the live item and retains
`history/<id>.jsonl` as append-only audit proof. Its structured result exposes:

```json
{
  "history_retained": "history/pm-example.jsonl",
  "tombstone_retention": "retain_append_only"
}
```

The storage health check reports a bounded tombstone count/list separately from
corrupt orphan streams. A stream whose final operation is `delete` and whose
live item is absent is informational. A history-only stream without a delete
terminal operation emits `history_orphaned_stream:<id>` and makes the storage
check warn.

The retention policy is deliberately explicit: automatic tombstone garbage
collection is disabled. `pm history <id>` and restore workflows continue to use
the retained stream.

## Output service ownership

`output_format` is a fall-through service: handlers must return `null`,
`undefined`, or the original payload for results they do not own. A package that
declares `manifest.activation.commands` establishes a bounded command ownership
contract, so doctor does not classify its `output_format` handler as global.

Unscoped output services still emit
`extension_output_service_override_global`, and multiple non-fall-through
services still participate in collision diagnostics. First-party calendar and
guide-shell packages declare disjoint command activation lists and therefore
retain their specialized output without creating a global ownership warning.

## Verification

Run focused tests while iterating, then the mandatory repository gates:

```bash
pnpm build
pnpm lint
node scripts/run-tests.mjs coverage
pnpm contracts:check
pnpm sdk:surface:check
pm validate --check-resolution --check-history-drift
pm health --check-only
```

Do not weaken coverage, static-quality, contract, security, or release gates to
accommodate a new primitive. Public SDK additions require an intentional SDK
surface snapshot update after reviewing the additive diff.
