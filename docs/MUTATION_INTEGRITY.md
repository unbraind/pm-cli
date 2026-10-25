# Mutation Integrity

Tracker references: [pm-h90s](../.agents/pm/issues/pm-h90s.toon), [pm-pim7](../.agents/pm/features/pm-pim7.toon), [pm-w8q4](../.agents/pm/features/pm-w8q4.toon), [pm-9yfo](../.agents/pm/tasks/pm-9yfo.toon), [pm-wwooxx](../.agents/pm/issues/pm-wwooxx.toon), [pm-3kk6](../.agents/pm/issues/pm-3kk6.toon)

Concrete home-path normalization is tracked by [pm-gh1583](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1583.toon). Tracker records are repository-only and excluded from npm.

`pm` treats mutation provenance and content safety as shared SDK policy. CLI,
MCP, and package hosts can therefore enforce the same rules without duplicating
argument parsing or exposing detected values.

## Agent Quick Context

- Every mutation should have a stable author. Precedence remains explicit
  invocation author, `PM_AUTHOR`, configured `author_default`, detected
  harness identity, then `unknown`.
- The secret guard inspects string leaves and returns only detector names and
  object paths. It never returns the matched value.
- `pm health` reports old, unclaimed in-progress work as advisory governance
  data. It does not change ownership or status.
- Historical unknown-author events remain immutable. Maintainers can append an
  audited acknowledgment rather than rewriting their original JSONL streams.

## Workspace Policy

Configure policy through `pm config`; do not hand-edit `settings.json`.

```bash
pm config project set mutation_guard_require_attributed_author true
pm config project set mutation_guard_secret_guard block
pm config project set mutation_guard_stale_in_progress_hours 48
```

Defaults preserve author compatibility while providing secret advice:

| Setting                                    | Default  | Behavior                                                 |
| ------------------------------------------ | -------- | -------------------------------------------------------- |
| `mutation_guard.require_attributed_author` | `false`  | When enabled, reject an effective author of `unknown`.   |
| `mutation_guard.secret_guard`              | `advise` | `off`, stderr/structured `advise`, or pre-write `block`. |
| `mutation_guard.stale_in_progress_hours`   | `72`     | Age threshold for unclaimed active work in `pm health`.  |

A blocking secret policy may be bypassed only by an explicit `--force` on a
force-capable mutation. The warning records that an override occurred while
remaining fully redacted.

## SDK Use

Package hosts can apply the exact runtime policy before dispatch:

```ts
import {
  evaluateMutationGuard,
  inspectStaleInProgressItems,
  scanMutationSecrets,
} from "@unbrained/pm-cli/sdk";

const guarded = evaluateMutationGuard({
  author: "package-agent",
  payload: mutationInput,
  settings: projectSettings.mutation_guard,
});

const findings = scanMutationSecrets(mutationInput);
const stale = inspectStaleInProgressItems(items, {
  in_progress_status:
    projectSettings.schema.workflow.in_progress_status ?? "in_progress",
  threshold_hours: projectSettings.mutation_guard.stale_in_progress_hours,
});
```

`evaluateMutationGuard` returns stable warning codes, redacted findings, and
whether a blocking policy was explicitly overridden. `scanMutationSecrets` is
available separately for package-specific preflight UIs. Cyclic inputs are
safe; scanner failures fail open with `secret_guard_scan_failed_open`.

Direct SDK persistence does not automatically apply this host preflight.
Integrations that require the policy must evaluate it before dispatching their
SDK mutations. CLI and MCP adapters already do this.

The SDK guard and repository scanner consume one inventory in
`src/core/shared/secret-rules.ts`. It covers GitHub, npm, Slack, AWS access
keys (including temporary keys), Google, Anthropic, OpenAI, GitLab, Sentry,
private keys, JWT-shaped tokens, npm authentication assignments, password
assignments, inline sshpass passwords, private IPv4 addresses, private SSH
hosts, and absolute home-directory paths. Every repository rule also runs
against mutation string leaves in `advise` and `block` modes.

Two repository fixture exemptions apply only to `tests/` and `examples/`:
absolute home paths and user-at-private-host matches. They never exempt
mutation content. The inventory explicitly records one mutation-only heuristic:
high-entropy assignments. Source identifiers can resemble generic assignments,
so that heuristic does not run over repository source text. No rule is silently
gate-only. Repository diagnostics retain hyphenated names; SDK findings retain
underscore names. Adding a pattern therefore changes both consumers together.

A private address or host path can be legitimate project context. The default
remains advisory; a workspace selecting `block` must replace those literals
with references or explicitly review a force override. CLI routing paths and
payload content are distinct: pass only content to package-owned preflight.

Home-path detection recognizes concrete POSIX and macOS account roots, root
subdirectories, Windows user profiles, UNC profile shares, and explicit file
URLs. It accepts surrounding markup and punctuation. Detection-only views
decode percent-byte runs, serialized slash/character escapes, and documented
Unicode disguises. Unicode handling applies NFKC, removes zero-width/bidi
controls, and folds division/fraction slashes and Cyrillic look-alikes for the
path vocabulary's letters o and s. These are finite heuristics, not filesystem
canonicalization or a complete confidentiality guarantee.

Inspection is limited to four normalization passes per original line. Findings
can include typed `normalizations` identifiers; original and decoded values are
never returned, and payloads are never rewritten. If encoding remains after the
limit, `normalization_incomplete: true` conservatively requires review using
the same advisory/blocking policy. A blocking workspace may explicitly force a
reviewed value. Repository diagnostics retain original source lines, including
when an encoded value contains a newline.

Portable references remain literal: current-user and named tilde references,
home environment variables, and Windows profile variables are not expanded
using the scanner's host. They do not establish a concrete absolute coordinate.
Ordinary web URLs and relative paths are also preserved. Package-specific
policies may classify additional context, but must not treat an empty finding
list as proof that arbitrary content is safe to publish.

Nested settings reads use own properties. Writes reject empty and prototype
path segments before changing any object, create local containers for inherited
values, and define own data properties without invoking inherited setters. Findings expose only the stable rule
name and object path. Matched credential text is never returned, logged, or
included in a recovery bundle.

### Executable mutation inventory

`PM_MUTATION_ACTION_CONTRACTS` is the public, typed inventory of core mutation
actions. Each entry identifies whether the action must append item history,
workspace history, or both. Package hosts and quality gates should derive
mutation coverage from this contract instead of maintaining a second command
list.

```ts
import { PM_MUTATION_ACTION_CONTRACTS } from "@unbrained/pm-cli/sdk";

const itemHistoryActions = PM_MUTATION_ACTION_CONTRACTS.filter(
  (contract) => contract.history_scope === "item",
);
```

The contract is a classification primitive, not proof that every handler
actually wrote its required event. The history-completeness release gate must
execute every classified action against a sandbox and assert the resulting
operation and author before the repository can treat that invariant as fully
enforced. Workspace actions remain explicitly classified while that executable
gate is completed.

## Linked-Test JSON Assertions

Tracked by [pm-czr31p](../.agents/pm/issues/pm-czr31p.toon).

JSON assertions accept dotted fields and non-negative safe integer indexes,
such as `result.items[0].count` or `[0][1].count`. The whole path must match:
empty segments, empty brackets, negative indexes, and omitted separators fail
the assertion instead of silently selecting a different field. Traversal reads
only own data properties and never invokes getters or follows prototypes.

## Unknown-Author Disposition

Use `scanHistoryAuthorAttribution` to obtain exact item and one-based line
coordinates. After evidence-backed review, SDK hosts can call
`acknowledgeUnknownAuthorHistoryEvents`. The function validates that every
target is still an actionable unknown-author event and appends
`history:author-acknowledge` to `_workspace.jsonl`.

The same primitive is available as
`pm history-author-acknowledge --event <item-id:line> ...`,
`PmClient.historyAuthorAcknowledge`, and the MCP `pm_run` action
`history-author-acknowledge`. See
[Agent Runtime Primitives](AGENT_RUNTIME_PRIMITIVES.md) for the shared
CLI/SDK/MCP contract.

The acknowledgment includes target coordinates, the attributed principal,
reviewer, and rationale. Subsequent health and validation scans keep the
unknown event in immutable totals but remove it from actionable warnings.

## Stale In-Progress Governance

`scanStaleInProgressItems` combines item metadata with the latest valid history
timestamp. An item is reported only when all three conditions hold:

1. its normalized status matches the configured in-progress status;
2. it has no assignee;
3. its last activity is at least the configured threshold old.

The health result includes deterministic item ordering, age, last activity,
threshold, and remediation. Resolve each finding by claiming genuinely active
work or returning abandoned work to `open`. A direct
`pm update <id> --status in_progress` also emits a stderr-only advisory when
the resulting item would have no assignee; use `pm claim <id>` to make active
ownership explicit. Machine-readable `--json` invocations suppress this
presentation advisory so stderr remains a single parseable error envelope.
