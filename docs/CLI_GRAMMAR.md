# Noun–Verb CLI Grammar and Compatibility Policy

Tracked by [pm-pbyu](../.agents/pm/decisions/pm-pbyu.toon), implemented through [pm-0z7n](../.agents/pm/features/pm-0z7n.toon), [pm-pfqi](../.agents/pm/tasks/pm-pfqi.toon), [pm-yy8rmx](../.agents/pm/tasks/pm-yy8rmx.toon), [pm-wt43zj](../.agents/pm/tasks/pm-wt43zj.toon), [pm-e2bq](../.agents/pm/features/pm-e2bq.toon), and [pm-yql1](../.agents/pm/tasks/pm-yql1.toon).

## Agent Quick Context

Use the canonical noun-first form when generating commands. Existing spellings remain executable, but deprecated compatibility aliases are absent from default help and completion discovery and emit one migration hint on stderr. Machine clients can read alias lifecycle and replacement tokens from `pm contracts --full --json`.

Default `pm --help` stays within the core one-screen budget. Use
`pm help --all` for every public command or `pm help --all --json` for the same
surface with per-command visibility/family metadata and the complete alias
lifecycle table. `--explain` also expands command discovery while adding the
detailed narrative.

The first completed consolidation is the list family:

```bash
pm list                         # active lifecycle rows
pm list --status open          # one lifecycle class
pm list --status open,blocked  # several classes
pm list --status blocked       # status- or dependency-blocked semantics
pm list --all                  # every lifecycle status
```

`list-all`, `list-draft`, `list-open`, `list-in-progress`, `list-blocked`, `list-closed`, and `list-canceled` preserve command results and stdout behavior. Their documented migration hint may add one stderr line.

## Status

Accepted. The grammar contract, destination census, and compatibility policy are executable SDK data and mandatory static gates.

## Context

pm grew by adding one top-level spelling per feature. That made help, completions, contracts, documentation, and agent routing grow linearly even when several commands represented the same concept. The list family alone repeated almost the same help surface eight times. A universal project-management tool needs extensible behavior without requiring every agent to memorize an ever-growing flat vocabulary.

The governing product principle is `project management = context management`: command discovery must route an agent to the smallest authoritative context, while compatibility must preserve scripts and historical instructions.

## Decision Drivers

- Preserve every published invocation and its stdout behavior.
- Keep frequent operations concise without making aliases the discovery model.
- Make domain ownership explicit enough to generate routing, help, completions, SDK contracts, MCP projections, and documentation.
- Prevent surface regrowth with a fail-closed, bidirectional contract gate.
- Let packages add domain behavior without consuming the core noun budget.
- Make migration guidance suppressible for automation while keeping canonical replacements machine-readable.

## Alternatives Considered

### Flat surface status quo

Rejected. Each feature adds another root spelling and duplicates contract/help context. A byte-count snapshot records growth but does not decide whether the new command belongs in the architecture.

### Pure git-style subcommands

Rejected as an exclusive rule. Noun-first paths are canonical, but forcing high-frequency operations such as `create`, `get`, `update`, `claim`, and `close` to pay an extra token on every invocation would regress the agent hot path. Named permanent aliases may remain visible and are distinguished from deprecated compatibility shims in contract data.

### BusyBox-style multi-binary surface

Rejected. Separate binaries multiply distribution, signing, package resolution, documentation, and shell-discovery surfaces without improving domain routing.

## Decision

1. The core routing vocabulary has twelve nouns: `item`, `list`, `context`, `search`, `graph`, `history`, `workspace`, `package`, `ops`, `plan`, `contracts`, and `help`.
2. Canonical forms are noun-first. Verbs and facets are subcommands; projections and predicates are flags.
3. Shared semantics use a shared verb vocabulary. Noun-specific verbs require an explicit checked-in disposition.
4. Scope precedes its operation: for example, `workspace snapshot create`, not `workspace create snapshot`.
5. Package-owned commands are declared as such and do not silently expand the core noun set.
6. Published spellings are not removed. Deprecated spellings are hidden aliases with a canonical token sequence, PM owner, lifecycle, and one stderr migration hint.
7. Permanent hot-path aliases and deprecated aliases are different contract states. Permanent aliases are ergonomic API; deprecated aliases are compatibility state.
8. Every live command has exactly one destination row. A row may name its target noun, a tracked consolidation owner, a package owner, or a reasoned keep-as-is exception.
9. The census is bidirectional: missing live rows and stale checked-in rows both fail CI.
10. Default-visible top-level growth is ceilinged. Lowering the ceiling is always valid; raising it requires a tracked noun-placement decision rather than regenerating a baseline.

## SDK Contract

Package authors and embedded clients use the public exports:

```ts
import {
  PM_CLI_GRAMMAR_CONTRACT,
  PM_COMMAND_ALIAS_CONTRACTS,
  PM_COMMAND_DESTINATION_CONTRACTS,
  resolvePmCommandAlias,
  verifyPmCliGrammar,
} from "@unbrained/pm-cli/sdk";
```

`PM_COMMAND_ALIAS_CONTRACTS` carries `alias`, `canonical`, `canonical_argv`, `lifecycle`, `hidden`, `registration`, and `owner`. `verifyPmCliGrammar` returns deterministic findings with an offending spelling and nearest conforming target.

Runtime contracts expose the compact noun/verb policy in summary output and include the exhaustive destination census in full output. Deprecated aliases remain queryable but are excluded from the default command-summary denominator.

## Compatibility and Migration Hints

Hints go to stderr exactly once per deprecated-alias invocation and never alter stdout. Disable them for a project when an automation intentionally retains old spellings:

```bash
pm config project set ux_deprecation_hints false
```

This setting changes presentation only. It does not disable aliases or change command results. The uniform machine result-envelope receipt is intentionally deferred to its separately tracked cross-command contract so this implementation does not create a list-only shape.

## Enforcement

`pnpm quality:command-grammar` builds the SDK, reads the live runtime command contracts, and compares them with the checked-in destination and alias tables. Package-owned destination rows are conditional because installed packages vary by workspace; every activated package command still requires a declared row, while an inactive package does not make its row stale. The gate also proves parity between discoverable SDK actions, the MCP `pm_run` action enum, and narrow MCP tools. The same gate runs inside `quality:static`, alongside contract drift checks. Its negative controls prove that unknown commands, stale core rows, broken alias targets, MCP drift, and surface-ceiling growth fail upward.

## Consequences

- Agents discover one list command instead of eight repeated help pages.
- Existing scripts keep working and receive an actionable replacement.
- CLI, SDK, completion, and contract consumers share one alias table.
- New commands require an explicit architectural home and PM owner.
- The compatibility table is long-lived public API and must be reviewed like any other SDK contract.
- Consolidation proceeds incrementally: current legacy commands may remain only with a named disposition until their owning PM item lands.
