# Agent Provenance ADR Amendment

Tracker reference: [pm-oskdmu](../.agents/pm/decisions/pm-oskdmu.toon).
Implementation lineage:
[pm-itsjf0](../.agents/pm/features/pm-itsjf0.toon),
[pm-0zcwz6](../.agents/pm/issues/pm-0zcwz6.toon),
[pm-1zhfls](../.agents/pm/issues/pm-1zhfls.toon),
[pm-pwq0g5](../.agents/pm/issues/pm-pwq0g5.toon), and
[pm-te6elw](../.agents/pm/tasks/pm-te6elw.toon).

Status: accepted amendment to
[pm-qwuber](../.agents/pm/decisions/pm-qwuber.toon). The original stable-author
contract remains authoritative; this amendment replaces only its fixed
model-only provenance shape.

## Decision

Mutation history may retain bounded descriptive agent provenance independently
from the stable mutation author. `agent_provenance` is a string-keyed map whose
values are either `{ value, source }` observations or `null` when a detected
harness declares a dimension but cannot expose a value.

The default runtime understands `model`, `effort`, and `role`. Harness
descriptors and trusted embedded hosts may add dimensions such as `topic`
without a storage migration. The legacy `agent_model` and
`agent_model_source` fields remain populated from `agent_provenance.model` for
backward-compatible readers.

The precedence for each dimension is:

1. explicit `PM_AGENT_<DIMENSION>` override;
2. the selected harness descriptor's environment keys;
3. MCP client provenance;
4. trusted embedding-host provenance;
5. bounded argv values.

`detectAgentIdentity()` and `detectHarnessIdentity()` use ambient invocation
signals when called with no argument. An explicitly supplied signal object
remains isolated from ambient state. SDK hosts that need async-safe scoping use
`runWithHarnessDetectionSignals()`.

## Privacy and security boundary

Provenance values are descriptive context, never authentication or
authorization principals. Values are trimmed, length-bounded, and obtained only
from literal descriptor keys or trusted caller data. Detection does not spawn
processes, traverse process trees, evaluate regexes, read files, or access the
network.

Raw session identifiers remain transient and are never written to history or
telemetry. When a harness and session are both present, history may retain only
the existing domain-separated, truncated `agent_instance` digest. Public
telemetry continues to use installation-scoped hashes or presence booleans; it
does not export raw provenance values.

## Compatibility

All new history fields are optional. Readers must accept:

- legacy entries with no agent fields;
- model-only entries using `agent_model` and `agent_model_source`;
- new entries with `agent_provenance`;
- explicit `model: null`, `effort: null`, or `role: null` observations meaning
  the dimension was declared but unavailable for a detected harness.

MCP clients may supply a bounded `clientInfo.provenance` map during initialize.
The server retains only valid dimension names and trimmed values, then resolves
that map inside the invocation-scoped identity context for every mutation. A
missing MCP signal is recorded as explicit `null`; it is never confused with a
legacy entry that predates the dimension.

Unknown provenance dimensions are preserved as data and do not change author
resolution. Removing a dimension from a descriptor never rewrites existing
history.

## SDK and completeness contracts

The aggregate and core SDK entrypoints export:

- `AGENT_PROVENANCE_DIMENSIONS`;
- `detectAgentIdentity()` and `detectHarnessIdentity()`;
- `analyzeAgentProvenanceDescriptorCoverage()` for the descriptor capability
  matrix and negative controls;
- `summarizeAgentModelProvenance()` for observed, unavailable, legacy-missing,
  and inert-capture reporting;
- `analyzeSdkCliParameterCompleteness()` for a derived bidirectional CLI flag
  and strict SDK parameter matrix.

The SDK/CLI matrix classifies every input as shared, positional, transport,
presentation, local adapter, scope selector, compatibility alias, or SDK-native.
An unknown CLI flag fails closed as `unclassified`. Committed test baselines cap
every waiver category and the representative behavioral-envelope corpus, so
coverage may expand and waivers may shrink without returning to a curated
hand-picked list.

## Operational guidance

Use provenance to answer context questions such as which harness/model/effort
performed a mutation or whether a capture source is inert. Do not use it to
decide who is allowed to mutate an item. Use `author`, ownership, and explicit
project policy for authorization and coordination.
