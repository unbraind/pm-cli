# History maintenance and recovery

Tracked by [pm-34w8za](../.agents/pm/chores/pm-34w8za.toon) and
[pm-tqel](../.agents/pm/tasks/pm-tqel.toon).

History is authoritative context: maintenance must preserve replay integrity,
version addresses, provenance, and retained recovery evidence. The SDK owns
these policies; the CLI exposes the same operations through one history family.

## Command paths

| Native command | Permanent compatibility spelling | Purpose |
| --- | --- | --- |
| `pm history <id>` | unchanged | Read or verify one item stream |
| `pm history activity` | `pm activity` | Read activity across streams |
| `pm history redact <id>` | `pm history-redact <id>` | Remove selected sensitive content |
| `pm history repair [id]` | `pm history-repair [id]` | Repair or salvage a stream using explicit policy |
| `pm history compact [id]` | `pm history-compact [id]` | Retain a baseline and selected history tail |
| `pm history restore <id> <version>` | `pm restore <id> <version>` | Restore an item's historical state |

Compatibility commands remain executable with their existing flags and result
shapes. Default discovery omits these root aliases. `pm --all --help` and full
contracts retain the compatibility inventory. SDK function names and MCP action
identifiers remain stable, including `history-repair` and `restore`.

```bash
pm history repair --help
pm contracts --command "history compact" --flags-only --json
pm contracts --command "history restore" --availability-only --json
pm history activity --limit 10
pm history pm-example --verify --strict-exit
pm history compact pm-example --dry-run
pm history repair pm-example --dry-run
```

Maintenance previews do not write history or item files. Review the operation's
report before applying a rewrite. Restore returns the standard flat mutation
receipt; activity uses the existing bounded read envelope and streaming
contracts. Universal output controls resolve against the selected leaf, so a
restore does not inherit the parent history read envelope.

## SDK integration

Use `runHistoryRedact`, `runHistoryRepair`, `runHistoryCompact`, and `runRestore`
from the public SDK for ordinary integrations. These functions retain each
operation's validation, audit events, version mapping, and recovery policy.

`runHistoryMaintenance` is the shared SDK pipeline for history transforms. It
accepts a resolved subject, settings, type registry, operation policy, execution
options, and a transform. The transform receives one captured stream, chain
verification, current item, and resolved author. It returns planned entries,
a result renderer, and optional transactional callbacks.

The pipeline performs these steps:

1. Read original bytes and decode entries from the same file read.
2. Capture the current item and construct the operation-specific plan.
3. Verify the complete planned chain, including during dry runs.
4. For a changed apply, enforce ownership and acquire the existing rewrite lock.
5. Recheck both stream and item bytes under that lock; reject concurrent changes.
6. Persist with rollback, then collect post-write hook warnings and render the report.

`readHistorySnapshot` exposes the paired raw bytes and decoded entries when an
integration needs a concurrency baseline. `readHistoryEntries` remains the
array-returning compatibility API.

A custom `applyRewrite` callback owns any coupled item/history transaction and
its rollback. `beforeWrite` runs under the lock for evidence checks, and
`afterWrite` supplies operation-specific hook and index warnings. Planning must
not persist changes. The shared pipeline verifies the planned chain but cannot
make arbitrary callback side effects transactional.

Redaction uses the coupled item/history transaction. Repair retains its
source-bound abandonment and salvage policies. Compaction retains baseline,
checkpoint, and historical version mappings. Restore uses the same snapshot
and under-lock drift primitives while retaining its lifecycle transaction and
unreadable-item recovery reader. Copy retains its existing SDK lifecycle
implementation.

## Verification

The namespace integration tests compare native and compatibility previews and
activity results, verify untouched bytes after previews, apply restore, and
verify the resulting chain. SDK maintenance tests exercise invalid plans and
concurrent changes. Existing redaction, repair, compaction, and restore suites
continue to cover operation-specific rollback and retained evidence.

Run tests through the sandbox wrapper described in [Testing](TESTING.md):

```bash
node scripts/run-tests.mjs test -- tests/integration/history-namespace.integration.spec.ts tests/unit/sdk/history/maintenance.spec.ts tests/unit/sdk/cli-contracts/history-namespace-completion.spec.ts
```

See [Mutation Integrity](MUTATION_INTEGRITY.md),
[Context Integrity Contracts](CONTEXT_INTEGRITY_CONTRACTS.md), and
[CLI Grammar](CLI_GRAMMAR.md) for the surrounding guarantees.
