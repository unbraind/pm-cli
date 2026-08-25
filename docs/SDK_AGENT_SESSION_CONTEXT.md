# SDK Agent Session and Episode Context

Tracker references: [pm-9wbiye](../.agents/pm/issues/pm-9wbiye.toon),
[pm-rbg1qo](../.agents/pm/issues/pm-rbg1qo.toon), and
[pm-oqo9l2](../.agents/pm/features/pm-oqo9l2.toon),
[pm-3zgh2c](../.agents/pm/features/pm-3zgh2c.toon),
[pm-eq9dlw](../.agents/pm/issues/pm-eq9dlw.toon), and
[pm-lu6sca](../.agents/pm/features/pm-lu6sca.toon), plus
[pm-5q8wa0](../.agents/pm/issues/pm-5q8wa0.toon) and
[pm-c0lrdm](../.agents/pm/features/pm-c0lrdm.toon).

Project management is context management. The public SDK therefore carries a
session's purpose and episode boundary through the same immutable history that
records its project mutations. These declarations are descriptive context;
they never authorize a mutation, alter item state, or become required for a
write to succeed.

## Declare context once

`runWithAgentSessionContext()` scopes a role, topic, and episode to every
mutation started inside its callback. Nested episode declarations inherit the
outer provenance and automatically name the outer episode as their parent.

```ts
import { PmClient, runWithAgentSessionContext } from "@unbrained/pm-cli/sdk";

const client = new PmClient({ cwd: process.cwd() });

await runWithAgentSessionContext(
  {
    provenance: { role: "implementer", topic: "release readiness" },
    episode: { id: "release-2026-08-01", label: "Release readiness" },
  },
  async () => {
    await client.update("pm-example", { priority: 1 });

    await runWithAgentSessionContext(
      { episode: { id: "release-review", label: "Review" } },
      () => client.comments("pm-example", { add: "Review completed." }),
    );
  },
);
```

The first mutation records `agent_episode.id=release-2026-08-01`. The nested
mutation records `agent_episode.id=release-review` and
`agent_episode.parent_id=release-2026-08-01`. Both record role and topic in
`agent_provenance` with `source=session`.

Episode ids are caller-owned join keys of 1-128 letters, digits, dots,
underscores, colons, or hyphens. Labels and provenance values are trimmed and
bounded to 256 characters. A malformed inherited environment declaration is
ignored, so context can never break an ordinary CLI mutation.

## Cross a CLI process boundary

`agentSessionEnvironment()` returns only the bounded environment values needed
by a child `pm` process. Merge them into the child's environment once; every
CLI mutation launched by that process inherits the declaration without an
identity flag on each command.

```ts
import { spawn } from "node:child_process";
import { agentSessionEnvironment } from "@unbrained/pm-cli/sdk";

const session = {
  provenance: { role: "release-operator", topic: "package acceptance" },
  episode: { id: "package-acceptance", label: "Package acceptance" },
};

spawn("pm", ["comments", "pm-example", "Accepted."], {
  env: { ...process.env, ...agentSessionEnvironment(session) },
  stdio: "inherit",
});
```

The environment contract is `PM_AGENT_SESSION_ROLE`,
`PM_AGENT_SESSION_TOPIC`, `PM_AGENT_EPISODE_ID`,
`PM_AGENT_EPISODE_LABEL`, and `PM_AGENT_EPISODE_PARENT_ID`. These are session
context keys, distinct from intentional per-observation overrides such as
`PM_AGENT_MODEL`.

Roles use the controlled values `implementer`, `implementation`,
`investigator`, `orchestrator`, `planner`, `release-operator`, and `reviewer`.
Case, spaces, and underscores normalize to lowercase hyphenated values. Other
values are ignored instead of polluting analytics. Presence-only harness flags,
including `CLAUDE_CODE_CHILD_SESSION=1`, are detection evidence and are never
persisted as semantic roles.

## Infer semantic context from lifecycle state

Successful `claim`, `release`, and `focus` operations maintain a bounded,
checkout-local semantic workset. Later CLI and SDK mutations can therefore
record useful role and topic provenance without repeating identity flags or
retaining prompt text:

- a claim records the item and at most 16 canonical parent ancestors, infers
  `role=implementer`, and uses the item or stable multi-item workset as topic;
- an explicit focus becomes the high-confidence topic and infers
  `role=planner`;
- a release removes only that claim and records `role=release-operator` while
  other active claims remain; and
- clearing the final claim and focus removes the inferred session record.

At most 64 active item ids and 32 evidence rows are retained. Multi-item topics
are deterministically bounded and hashed when their full identity would exceed
the provenance limit. The state is partitioned by the privacy-safe agent
instance when available, otherwise by a truncated hash of the resolved author.
It lives in the gitignored runtime session file and malformed records fail open.

The same workset feeds `pm context` as `claim_focus` relevance: claimed and
focused items receive affinity `1`, while bounded canonical ancestors receive
`0.75`. Active work is preserved by the context packer under its existing token
ceiling; the inference never raises the requested budget.

Explicit overrides, declared session context, command flags, environment,
MCP-client declarations, host declarations, and configured probes all retain
precedence. Automatic observations use `source=inferred`, `rule_version=v2`,
and carry the bounded claim/focus/lineage evidence that supports them. The pure
`semanticAttributionAffinity()` helper and lifecycle recording primitives are
public SDK exports for custom hosts.

## Diagnose missing provenance

`diagnoseAgentIdentity()` is the additive diagnostic companion to
`detectAgentIdentity()`. It returns the same privacy-safe identity plus a
`provenance_outcomes` row for every built-in dimension. Each row is
`resolved`, `unavailable`, `not_configured`, or `failed`, carries rule version `v1`, and may name
the bounded built-in resolver. It never contains environment values, session
paths, prompts, or file contents.

New mutation history records failed or explicitly unavailable configured
resolver outcomes under `context.agent_provenance_outcomes`; dimensions with
no configured resolver retain the compact legacy-compatible null projection.
A resolver is only counted as
attempted when its required input belongs to the detected harness; a foreign
host's shared `AI_AGENT` value is not Codex input. Consequently `pm health` can report
`provenance_resolver_zero_success:<harness>:<dimension>:<resolver>:<attempts>`
without confusing an unavailable harness signal with a failed resolver. The
warning is advisory and the storage check includes the bounded attempt and
success counters for diagnosis.

Older immutable history can also contain roles outside the controlled domain,
including values recorded from presence-only harness flags before semantic role
validation existed. `pm health` retains the privacy-safe
`provenance_value_domain_invalid:<harness>:<dimension>:<value-shape>:<count>`
warning and its bounded storage aggregate, but treats the finding as advisory:
truthful append-only history is not rewritten merely to make health green. New
session, environment, MCP, and inferred provenance still pass through the
controlled write-time validator, so this disposition does not permit new
invalid values.

## Cross an MCP boundary

An embedding MCP 2026-07-28 client can add bounded `provenance` and `episode`
fields to request-local `io.modelcontextprotocol/clientInfo`. The server
retains only those fields while processing that request; no later request
inherits them.

```json
{
  "_meta": {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": {
      "name": "agent-host",
      "version": "1.0.0",
      "provenance": {
        "role": "implementer",
        "topic": "release readiness"
      },
      "episode": {
        "id": "release-2026-08-01",
        "label": "Release readiness"
      }
    }
  }
}
```

Malformed keys, blank values, invalid episode ids, inherited object
properties, and values beyond the documented bounds are discarded before a
tool call reaches the mutation runtime.

## Analyze immutable history

`summarizeAgentProvenance(entries)` reports observed, explicitly unavailable,
and legacy-missing counts for every built-in dimension: model, effort, role,
and topic. This keeps old history distinguishable from a current harness that
declared a dimension but supplied no value. The compatibility helper
`summarizeAgentModelProvenance(entries)` remains available for model-only
consumers.

`evaluateSemanticAttributionCoverage(entries, options)` groups role/topic
availability by harness and precedence source. Its explicit minimum-entry and
minimum-coverage ratchet fails empty corpora, making a negative control part of
the contract instead of allowing an unobserved harness to pass vacuously.

`groupHistoryByEpisode(entries)` returns deterministic nested groups:

- recorded episode keys produce `source: "declared"`;
- legacy events with `agent_instance` use that privacy-safe join key and
  produce `source: "inferred"`;
- older events without an instance fall back to a bounded author/time cohort;
- entry and child order is stable regardless of input stream order;
- missing parents and cyclic parent declarations remain roots instead of
  hiding history or recursing indefinitely.

The grouping function is a pure projection. A workspace that never declares
an episode writes the same item and history fields it wrote before this
contract; only the read-time inferred grouping is new.

## Privacy and compatibility

Episode context stays in repository-local history and is not a credential
channel. Do not put tokens, private hostnames, signed URLs, or raw external
payloads in ids, labels, roles, or topics. Session ids used to derive
`agent_instance` remain transient and are not persisted. Every new history
field is optional, so existing streams and packages remain readable.
Automatic semantic attribution is likewise restricted to item ids, controlled
roles, rule metadata, and canonical lineage ids. It never persists argv,
environment values, prompts, filesystem contents, or raw harness session ids.
