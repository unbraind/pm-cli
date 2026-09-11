# Lifecycle Commands and Ownership

Tracked by [pm-ik19](../.agents/pm/tasks/pm-ik19.toon) and
[pm-eq4x](../.agents/pm/tasks/pm-eq4x.toon) and
[pm-r1f9f1](../.agents/pm/tasks/pm-r1f9f1.toon).

Bulk mutations and ownership compositions share SDK implementations with their
compatibility spellings. Runtime help and contracts describe the active surface:

```bash
pm update many --help
pm close many --help
pm close delete --help
pm contracts --command 'close many' --flags-only --json
```

## Command migration

| Canonical invocation | Compatibility invocation |
| --- | --- |
| `pm update many --ids <ids> --priority 1` | `pm update-many --ids <ids> --priority 1` |
| `pm close many --ids <ids> --reason "Verified"` | `pm close-many --ids <ids> --reason "Verified"` |
| `pm close delete <id> --dry-run` | `pm delete <id> --dry-run` |
| `pm claim <id> --start` | `pm start-task <id>` |
| `pm release <id> --pause` | `pm pause-task <id>` |
| `pm close <id> "Verified" --release-assignment` | `pm close-task <id> "Verified"` |

The old spellings remain accepted as hidden aliases. Bulk aliases are permanent;
the three task aliases are deprecated. Human output for deprecated aliases can
include migration hints according to `ux.deprecation_hints`; JSON and quiet
invocations suppress those hints. Bulk commands retain their existing filters,
stdin selection, dry runs, rollback behavior, and evidence flags. Put bulk flags
after `many`. Deletion recovery remains `pm history restore <id> <version>`.

Plain `claim`, `release`, `update`, and `close` keep their original semantics.
`claim --start` requires an explicit item and rejects `--next` and
`--if-available` before mutation. It claims ownership, then moves the item to the
configured in-progress status. `release --pause` moves work to the configured
open status, then releases ownership. `close --release-assignment` records the
close and its inline evidence, then releases ownership.

Each constituent operation enforces its own policy and writes its own history.
Compositions do not provide rollback across operations: for example, if the
status transition fails after a successful claim, the claim remains. Inspect the
item before retrying after an error. A second-step failure retains the original
error code and adds recovery guidance naming the completed operation. Its SDK
error `cause` retains the underlying failure.

## Compact transport receipts

CLI and MCP compositions default to an `id`, final `status`, `action`, and
`changed_field_count`, plus compact receipts for each constituent step. The root
count is the number of distinct fields touched across the steps, not their sum.
Step receipts retain ownership, close reason, warnings, and recovery evidence.
Item descriptions, bodies, and annotation histories are not echoed by default.

Use CLI `--full-changed-fields` or MCP `fullChangedFields: true` for complete
constituent results; `--id-only` or `idOnly: true` returns only the final identity
and status. CLI `--no-changed-fields` preserves item snapshots while replacing
field arrays with counts. Plain release supports the same output controls.
Typed `PmClient` methods and the direct SDK primitives retain full results.

## SDK and MCP

```ts
import { PmClient } from "@unbrained/pm-cli/sdk";

const pm = new PmClient({ pmRoot: "/project/.agents/pm" });
const started = await pm.claim("pm-example", { start: true });
const paused = await pm.release("pm-example", { pause: true });
const closed = await pm.close("pm-example", "Acceptance verified", {
  releaseAssignment: true,
  resolution: "Implemented the requested behavior",
  expectedResult: "Acceptance checks pass",
  actualResult: "Acceptance checks passed",
  validateClose: "warn",
});
```

Literal `true` options return typed `StartTaskResult`, `PauseTaskResult`, or
`CloseTaskResult` receipts. Their discriminators remain `start_task`,
`pause_task`, and `close_task`, with the constituent results available under
`claim`, `update`, `close`, or `release`. Public `runStartTask`, `runPauseTask`, and
`runCloseTask` primitives expose the same SDK-owned compositions.

MCP actions remain `claim`, `release`, and `close`, using `start`, `pause`, and
`releaseAssignment`. Action-specific discovery types claim's `start` as boolean;
scheduling actions retain string timestamps. For the broad provider tool schema,
pass the claim boolean through `options: { start: true }` because its shared flat
`start` property retains the scheduling string contract. Bulk action names remain
`update_many`, `close_many`, and `delete` for transport compatibility.

See [SDK Lifecycle Policy](SDK_LIFECYCLE.md) for transaction and policy ownership
and [CLI Scripting Contract](SCRIPTING.md) for output projection.
