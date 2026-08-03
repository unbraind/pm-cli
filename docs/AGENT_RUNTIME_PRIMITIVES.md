# Agent Runtime Primitives

Tracker references: [pm-z9x1r2](../.agents/pm/features/pm-z9x1r2.toon),
[pm-zqpnte](../.agents/pm/chores/pm-zqpnte.toon),
[pm-954h0o](../.agents/pm/issues/pm-954h0o.toon),
[pm-j4ac9a](../.agents/pm/issues/pm-j4ac9a.toon),
[pm-1exil1](../.agents/pm/issues/pm-1exil1.toon), and
[pm-s1w0sf](../.agents/pm/issues/pm-s1w0sf.toon), plus the structured identity
bundle [pm-qwuber](../.agents/pm/decisions/pm-qwuber.toon),
[pm-03pq3o](../.agents/pm/features/pm-03pq3o.toon),
[pm-6uxhe0](../.agents/pm/issues/pm-6uxhe0.toon),
[pm-zqsrt5](../.agents/pm/issues/pm-zqsrt5.toon),
[pm-sx52hr](../.agents/pm/issues/pm-sx52hr.toon), and
[pm-brxdct](../.agents/pm/tasks/pm-brxdct.toon). The extensible provenance
amendment is tracked by [pm-oskdmu](../.agents/pm/decisions/pm-oskdmu.toon),
[pm-itsjf0](../.agents/pm/features/pm-itsjf0.toon),
[pm-0zcwz6](../.agents/pm/issues/pm-0zcwz6.toon), and
[pm-pwq0g5](../.agents/pm/issues/pm-pwq0g5.toon), with cross-surface parity
tracked by [pm-1zhfls](../.agents/pm/issues/pm-1zhfls.toon).
Session provenance and episode continuity are tracked by
[pm-9wbiye](../.agents/pm/issues/pm-9wbiye.toon),
[pm-rbg1qo](../.agents/pm/issues/pm-rbg1qo.toon), and
[pm-oqo9l2](../.agents/pm/features/pm-oqo9l2.toon). Automatic bounded probes,
historical projections, and versioned legacy identity are tracked by
[pm-ffz0a9](../.agents/pm/issues/pm-ffz0a9.toon),
[pm-v8gfi7](../.agents/pm/features/pm-v8gfi7.toon), and
[pm-3yxwv5](../.agents/pm/tasks/pm-3yxwv5.toon).

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
`configured`, `detected`, or `unknown`. Author selection and agent observation
are independent: even an explicit, environment, or configured author retains
the observed `agent_harness`, legacy `agent_model`/`agent_model_source`, and
extensible `agent_provenance` fields. The built-in provenance dimensions are
`model`, `effort`, `role`, `topic`, and `version`. A declared session can also record the
optional `agent_episode` join key. Older history remains valid because all agent
fields are optional.

Detection is bounded: it does not launch a subprocess, traverse a process tree,
execute user regexes, emit environment values, or make network requests. A
named built-in resolver may inspect a strictly capped tail of a harness-owned
session file and retain only allow-listed model/version values. Set
`agent_identity.probes_enabled` to `false`, or `PM_AGENT_PROBES=off`, to disable
those resolvers. Raw harness session signals are transient
invocation context: they are never persisted to history or exported to
telemetry. Explicit semantic session context uses bounded role, topic, and
episode declarations that are safe to retain in repository-local history.
Non-minimal telemetry hashes harness/model with the installation id; minimal
telemetry emits presence booleans only.

SDK hosts can preflight the same behavior:

```ts
import {
  detectAgentIdentity,
  detectHarnessIdentity,
  resolveAuthorIdentity,
} from "@unbrained/pm-cli/sdk";

const agent = detectAgentIdentity();
const harness = detectHarnessIdentity();
const identity = resolveAuthorIdentity(undefined, configuredAuthor);
```

Omitting detector arguments reads the current bounded invocation context:
process environment/argv for ordinary SDK calls or the active
`runWithHarnessDetectionSignals()` scope for embedded hosts. Passing an explicit
signal object remains deterministic and isolated.

`PM_AGENT_MODEL`, `PM_AGENT_EFFORT`, and `PM_AGENT_ROLE` are explicit
observation overrides. Built-in harness-specific environment variables are
evaluated next, followed by MCP client metadata, trusted host provenance, and
bounded argv tokens. A detected harness records every built-in dimension.
Unobserved model, effort, role, and topic values are explicit `null`, making
surface-level unavailability distinguishable from legacy history written
before the provenance contract. See
[SDK Agent Session and Episode Context](SDK_AGENT_SESSION_CONTEXT.md) for the
SDK, CLI-child, MCP, and immutable-history analysis contracts.

## Custom harness descriptors

Packages can append pure signal definitions with
`registerHarnessSignalDescriptors()` and dispose them during deactivation.
Embedded hosts can scope workspace settings with
`runWithWorkspaceHarnessSignalDescriptors()`. The CLI and MCP adapters do this
automatically using `settings.agent_identity.harness_signals`.

```json
{
  "agent_identity": {
    "harness_signals": [
      {
        "harness": "acme-agent",
        "environment_keys": ["ACME_AGENT"],
        "model_environment_keys": ["ACME_MODEL"],
        "session_environment_keys": ["ACME_SESSION"],
        "provenance_environment_keys": {
          "effort": ["ACME_EFFORT"],
          "role": ["ACME_ROLE"],
          "topic": ["ACME_TOPIC"]
        },
        "provenance_resolvers": {
          "version": "ai_agent_version"
        },
        "provenance_unavailable_dimensions": [],
        "argv_markers": ["acme-agent"],
        "client_names": ["acme-agent"]
      }
    ]
  }
}
```

Descriptors are literal, length-bounded data. Built-in namespaces cannot be
overridden; duplicate package/workspace namespaces fail with a deterministic
collision error. Precedence is built-ins, registered packages, then the active
workspace. Registration performs no filesystem, process, or network access.

## Patch-free historical context

The CLI, SDK, and MCP expose the same historical context vocabulary:

```bash
pm history pm-example --provenance --harness codex \
  --provenance-filter effort=xhigh --provenance-summary --json
pm activity --provenance --agent-instance <digest> --json
pm events --provenance --harness claude-code
```

These projections retain the immutable timestamp, operation, original author,
canonical harness interpretation, instance digest, and extensible observations.
They omit patches and hashes. The workspace's versioned
`agent_identity.identity_vocabulary.aliases` may interpret exact historical
author literals at read time; every row reports `harness_source` and
`vocabulary_version`, and unresolved literals remain visible in the bounded
summary. No history entry is rewritten.

MCP captures `clientInfo.name` and `clientInfo.version` during initialize and
scopes all later tool calls to that client signal. Optional host-provided
`model`, `session`, `provenance`, and `episode` fields are supported, but
version is not
misclassified as a model or session. Provenance keys must use the bounded
lowercase dimension vocabulary; blank, malformed, and oversized data is
discarded before mutation context is created. See
[Agent Provenance ADR Amendment](AGENT_PROVENANCE_ADR.md) for precedence,
privacy, compatibility, and coverage-report contracts.

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
`PM_GLOBAL_PATH`, and protect `PM_SOURCE_PM_PATH` as the read-only source
tracker coordinate for source-repository lifecycle commands such as
`pm merge install`. Extensions can therefore inspect source VCS metadata
without writing real tracker state. Package code should prefer `pm_root_rel`
in output and persisted evidence to avoid leaking host-specific absolute
paths.

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
