# Agent Runtime Primitives

Tracker references: [pm-z9x1r2](../.agents/pm/features/pm-z9x1r2.toon),
[pm-zqpnte](../.agents/pm/chores/pm-zqpnte.toon),
[pm-954h0o](../.agents/pm/issues/pm-954h0o.toon),
[pm-j4ac9a](../.agents/pm/issues/pm-j4ac9a.toon),
[pm-1exil1](../.agents/pm/issues/pm-1exil1.toon), and
[pm-s1w0sf](../.agents/pm/issues/pm-s1w0sf.toon).

`pm` treats project management as context management. These primitives keep
mutation provenance, source-workspace identity, extension flags, and bounded
item projections consistent across CLI, SDK, MCP, and linked-test hosts.

## Automatic author identity

Agents do not need to export `PM_AUTHOR`. New trackers detect known harnesses
when no explicit author or environment override is present. Existing trackers
continue to use their configured `author_default`.

The stable resolution order is:

1. explicit `--author` or SDK argument;
2. `PM_AUTHOR`;
3. configured `author_default`;
4. detected harness (`harness:claude-code`, `harness:codex`, `harness:pi`,
   `harness:opencode`, `harness:cursor`, `harness:aider`,
   `harness:gemini-cli`, or `harness:ci`);
5. `unknown`.

Every newly created `HistoryEntry` records `author_source` as `asserted`,
`configured`, `detected`, or `unknown`. Detection is a pure, bounded signal
match: it does not launch a subprocess, traverse an unbounded process tree,
emit environment values, or send telemetry.

SDK hosts can preflight the same behavior:

```ts
import {
  detectHarnessIdentity,
  resolveAuthorIdentity,
} from "@unbrained/pm-cli/sdk";

const harness = detectHarnessIdentity({
  env: process.env,
  argv: process.argv,
});
const identity = resolveAuthorIdentity(undefined, configuredAuthor);
```

## Unknown-author remediation

Historical events remain immutable. Use the scan coordinates and append an
evidence-backed disposition:

```bash
pm history-author-acknowledge \
  --event pm-example:4 \
  --event pm-example:5 \
  --attributed-author codex-agent \
  --reviewer maintainer \
  --reason "Matched the isolated test-run invocation and commit evidence."
```

The SDK exposes
`acknowledgeUnknownAuthorHistoryEvents(pmRoot, options)` and
`PmClient.historyAuthorAcknowledge(options)`. The MCP `pm_run` action is
`history-author-acknowledge`; its `historyEvent` array uses the same
`<item-id>:<one-based-line>` spelling. All three surfaces append
`history:author-acknowledge` to `_workspace.jsonl`.

## Portable extension workspace context

Every extension command, parser, preflight hook, renderer, and service receives:

- `source_workspace_root`: immutable source workspace root;
- `repo_root`: resolved source Git root when available;
- `pm_root`: active tracker root, including a sandbox root;
- `pm_root_rel`: POSIX path relative to the source workspace when the tracker is
  contained there.

Linked tests set `PM_SOURCE_WORKSPACE_ROOT` before replacing `PM_PATH` and
`PM_GLOBAL_PATH`. Extensions can therefore inspect source VCS metadata without
writing real tracker state. Package code should prefer `pm_root_rel` in output
and persisted evidence to avoid leaking host-specific absolute paths.

## Strict extension flag descriptors

`FlagDefinition.repeatable` is the package-author alias for the canonical
`list` contract. Activation normalizes `repeatable: true` to `list: true`, so
repeated values pass through the same CLI, help, contract, and MCP semantics as
core list flags.

Unknown descriptor keys fail extension activation with the exact field names.
When both `list` and `repeatable` are present, they must match. Array defaults
require either `list: true` or `repeatable: true`.

## Token-bounded item reads

Brief and standard `get` projections omit test bodies but return
`item.tests_count`, alongside `item.notes_count`. Deep and full reads return the
actual collections and omit redundant counts. Narrow consumers can request:

```bash
pm get pm-example --fields id,title,notes_count,tests_count
```

This makes omitted context explicit without forcing agents to pay for full
linked-test payloads.
