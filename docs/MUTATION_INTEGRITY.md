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
mutation content. The inventory explicitly records two mutation-only
heuristics: high-entropy assignments and credential-key assignments. Source
identifiers and test fixtures can resemble generic assignments, so neither runs
over repository source text.

Credential-key assignments
([pm-gh1704](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1704.toon);
tracker record excluded from npm) flag a value under any key whose last word
names a credential: `secret`, `token`, `api_key`, `secret_key`, `private_key`,
`access_key`, `client_secret`, `passwd` and `pwd`, plus compound keys such as
`DB_PASSWORD`, `aws_secret_access_key` or `GITHUB_TOKEN`, in any case,
including `--token=…`. The value must be at least eight whitespace-free
characters (a quoted value must be whitespace-free up to its closing quote)
with a Shannon entropy of at least 3 bits per character. It must not be a
placeholder (`<…>`, `${…}`, `$(…)`, `$VAR`, `%VAR%`, `[scrubbed]`), a
filesystem path, a URL, a letters-only word, a dotted member path or a call
(in a quoted value or an element body, `?`, `:` and `|` also count as value
characters; unquoted they read as code such as `process.env.API_KEY||""`); a
whole
element body must satisfy the same grammar. `token_budget`, `max_tokens`, numeric
counts, masks such as `********` and prose stay clean. A key starts only at the
beginning of an identifier, so the scan stays linear. Plain and hyphenated
password keys remain with the password rule, so each value is reported once. No rule is silently
gate-only. Repository diagnostics retain hyphenated names; SDK findings retain
underscore names. Adding a pattern therefore changes both consumers together.

Assignment rules also recognize structured spellings
([pm-gh1699](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1699.toon);
tracker record excluded from npm). Each rule declares its structured key
vocabulary as data, so quoting the key never changes the verdict. These
spellings are covered:

- a quoted key followed by `:` or `=` (JSON, YAML flow, Python dict, TOML);
- every quoted string in value position inside an array or object under the
  key, at any depth;
- for password and credential-key assignments, element content such as
  `<password>…</password>` or `<client_secret>…</client_secret>`. Element
  content is judged like a quoted value of an exact key: at least eight
  characters after trimming, with the `${…}` and `$(…)` placeholder
  exclusions.

An *exact* key is the key word alone (`"password"`, `<password>`). A
*prefixed* key has other key text before the word, such as `reset-password`,
`smtp.password` or `"New password"`. A quoted key whose opening quote is
missing on the same line is skipped. A prefixed key's value, and an object
member's value inside a container, count only when they contain no
whitespace, because labels and JSON Schema descriptions are prose. Array
elements under an exact key keep passphrases.

Each candidate key/value is judged by the rule's own value grammar. The
eight-character minimum, the `<…`, `${…}` and `$(…)` placeholder exclusions
and the high-entropy predicate therefore carry over. Bare tokens inside a
container are never judged, so `password=[scrubbed]` stays clean. A
structured string literal that spans a raw line break is a host-language
artifact, not a credential. The pass is linear. Nested keys inside a
walked container still get their own scalar check. Each container is walked
at most twice: once for an exact key, whose lenient walk covers everything
inside it, and once for a prefixed key, whose compact walk covers only
other prefixed keys.

A private address or host path can be legitimate project context. The default
remains advisory; a workspace selecting `block` must replace those literals
with references or explicitly review a force override. CLI routing paths and
payload content are distinct: pass only content to package-owned preflight.

Home-path detection recognizes concrete POSIX and macOS account roots, root
subdirectories, Windows user profiles, UNC profile shares, DOS device namespace
profiles, and explicit file URLs. Device prefixes follow the
[documented Windows path families](https://learn.microsoft.com/dotnet/standard/io/file-path-formats).
It accepts surrounding markup and punctuation. Detection-only views
decode percent-byte runs, serialized slash/character escapes, and documented
Unicode disguises. Unicode handling applies NFKC, removes zero-width/bidi
controls, and folds division/fraction slashes and Cyrillic look-alikes for the
path vocabulary's letters o and s. These are finite heuristics, not filesystem
canonicalization or a complete confidentiality guarantee.

Inspection is limited to four normalization passes per original line. Findings
can include typed `normalizations` identifiers; original and decoded values are
never returned, and payloads are never rewritten. If encoding remains after the
limit, `normalization_incomplete: true` conservatively requires review using
the same advisory/blocking policy. It applies to the entire string leaf, even
when an earlier line already contained a concrete path. A blocking workspace
may explicitly force a reviewed value. Repository diagnostics retain original source lines, including
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

CLI refusals do not echo URL credentials from the invocation either
([pm-nhauur](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nhauur.toon);
tracker record excluded from npm). This applies to typed refusals, Commander
usage errors and bootstrap JSON help, in both JSON and text. Four rules
combine:

- Every refusal builder receives the invocation with each token already
  redacted. Anything a builder derives from it is therefore safe by
  construction, even when it lower-cases, truncates, re-quotes or wraps the
  value.
- Every JSON and text refusal is rendered from one guidance object, and that
  object is redacted before its envelope, its diagnostic budget and its
  output accounting exist, so receipts measure the delivered bytes. Values a
  producer echoed from the raw invocation pass the token rule (argv-token
  fields) or the word rule (free text). A producer may also split a value at
  whitespace or a comma, truncate it, re-case it or escape it before echoing
  it. The CLI therefore registers each secret for the running invocation:
  the password, or the whole userinfo of a bare token. The registration also
  holds the secret's shell and JSON escaping, and it removes every run of
  text that shares a six-character fragment with any of them. This bounds
  what any producer can expose to five consecutive secret characters. A
  secret too long for the 65,536-fragment budget is registered at aligned
  positions instead, and the bound widens to `fragmentLength + stride - 2`. The
  registry lives in an AsyncLocalStorage scope, so overlapping in-process
  invocations never share it. It protects telemetry and Sentry as well.
- The rule is conservative. A token is left alone only when no parser can
  read userinfo in it: its authority (the text between the slashes after the
  first `:` and the next `/`; SSH-style parsers read userinfo across `?` and
  `#`) holds neither `:` nor `@`, the rest
  of the token holds no `:` (so no nested URL), and it has no tab or line
  break. `https://www.npmjs.com/package/@unbrained/pm-cli` and blob paths with
  an `@` therefore keep their host, path and executable retry
  ([pm-gh1707](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1707.toon);
  tracker record excluded from npm). Everything else keeps the span from the
  first `:` to the last `@`, so prose shaped like `Reminder: ping @bob` or
  `alias@npm:@scope/pkg@1.0.0` is redacted in refusal output, and that
  invocation's refusals withhold executable retries.
- When the invocation carried credentials, the guidance withholds
  `suggested_retry` and `suggested_retry_args` and gains a final next step
  telling the caller to restore them. JSON and text output therefore agree.

Identities never carry credentials. URL userinfo in an asserted or configured
author (`--author`, `PM_AUTHOR`, `default_author`), in `--assignee` on create
and update, and in identity fields set through runtime or registered field
values is replaced with `[redacted]` before anything is stored, so the claim
principal derived from it is clean too. A holder stored by an older version
still reads unchanged. Ownership checks still compare it exactly, so two
holders that differ only in userinfo can never act as each other; its owner
takes it back with `--force` (a coordinated takeover) or by rewriting it.
Ownership refusals, warn-mode ownership warnings and claim or release envelopes (`claimed_by`, `previous_assignee` and the
`claim_skipped_held_by` and `claim_takeover` warnings) redact it as one whole
value, so whitespace inside its userinfo cannot split it. Rewrite such a holder
with `pm update <id> --assignee <name>` or a fresh claim.

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
