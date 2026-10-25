# Universal Read Output Contracts

Tracker references: [pm-15yuly](../.agents/pm/issues/pm-15yuly.toon), [pm-g8oh0f](../.agents/pm/issues/pm-g8oh0f.toon), [pm-hb7ug8](../.agents/pm/features/pm-hb7ug8.toon), [pm-cxr0jb](../.agents/pm/features/pm-cxr0jb.toon), [pm-hid9g1](../.agents/pm/features/pm-hid9g1.toon), [pm-h8tpeh](../.agents/pm/features/pm-h8tpeh.toon), [pm-5t33or](../.agents/pm/features/pm-5t33or.toon), [pm-wv47pf](../.agents/pm/issues/pm-wv47pf.toon), [pm-srns](../.agents/pm/issues/pm-srns.toon), [pm-sb0tns](../.agents/pm/issues/pm-sb0tns.toon), [pm-gjjurs](../.agents/pm/issues/pm-gjjurs.toon), [pm-eugaqy](../.agents/pm/issues/pm-eugaqy.toon), [pm-jt8aa2](../.agents/pm/issues/pm-jt8aa2.toon), [pm-kyjdne](../.agents/pm/issues/pm-kyjdne.toon), [pm-8nev0o](../.agents/pm/issues/pm-8nev0o.toon), [pm-oahhyc](../.agents/pm/issues/pm-oahhyc.toon), [pm-q4isdq](../.agents/pm/issues/pm-q4isdq.toon), [pm-e5gl05](../.agents/pm/issues/pm-e5gl05.toon), [pm-cha95z](../.agents/pm/tasks/pm-cha95z.toon), [pm-2qvq7a](../.agents/pm/issues/pm-2qvq7a.toon), and [pm-xam9bt](../.agents/pm/issues/pm-xam9bt.toon).

## Agent Quick Context

Complete package-envelope fitting and session-reference recovery are tracked by
[pm-gh1567](../.agents/pm/issues/pm-gh1567.toon) and
[pm-session-reference-recovery](../.agents/pm/issues/pm-session-reference-recovery.toon).

Every built-in read surface uses four output dimensions: what to include, how much to return, how much the result may cost, and how to encode it. The same canonical controls work through the CLI, SDK, MCP, generated schemas, runtime contracts, and shell completions.

| Dimension | CLI                              | SDK and MCP     | Meaning                                                                |
| --------- | -------------------------------- | --------------- | ---------------------------------------------------------------------- |
| Include   | `--output-include <csv>`         | `outputInclude` | Retain named fields or sections, or select a declared projection mode. |
| Amount    | `--output-limit <n\|unbounded>`  | `outputLimit`   | Bound shared row collections.                                          |
| Cost      | `--output-budget <n\|unbounded>` | `outputBudget`  | Fail closed when even the compact result cannot fit.                   |
| Encoding  | `--output-format <toon\|json>`   | `outputFormat`  | Select the CLI renderer and record the requested encoding.             |

The contract covers `list`, `context`, `search`, `get`, `next`, `health`, `deps`, `graph`, `history`, `activity`, `validate`, `events`, `contracts`, `comments`, `notes`, `files`, `docs`, `stats`, and `aggregate`, including list aliases and `ctx`.

Primary row shaping follows each envelope's `row_contract.row_keys`, including
dot-delimited arrays and object maps such as `graph.nodes`. Include, amount, and
repeat suppression therefore remain bound to the rows the command says it
returns. A result may additionally declare `continuation_row_keys` when a
nested evidence collection must resume independently without redefining the
primary rows that `--output-limit` bounds. Cost compaction may inspect both
primary and nested collections; it does not rely on command-specific keys.
The runtime uses that declaration internally on every read but omits the
repeated metadata from results by default. Request
`--output-row-contract` / `outputRowContract: true` when a consumer needs the
row paths, jq selector, and active TOON encoding contract.

### Package-defined complete envelopes

`fitOutputEnvelope` is available from `@unbrained/pm-cli/sdk/query`, the
aggregate SDK, and an extension command's `sdk.fitOutputEnvelope`. It fits
ordered whole rows into a caller-defined envelope without changing domain
ranking, metadata or transport policy:

```ts
import { fitOutputEnvelope } from "@unbrained/pm-cli/sdk/query";

const fitted = fitOutputEnvelope([{ id: "one", title: "Context" }], {
  tokenBudget: 800,
  buildEnvelope: (items) => ({ source: "my-package", items }),
  renderers: { json: (value) => JSON.stringify(value) + "\n" },
});
process.stdout.write(fitted.renderings[0]!.text);
```

The SDK reserves `output_fit`, attaches the omission/accounting receipt, and
stabilizes its `estimated_tokens` and `output_bytes` against complete output,
including the receipt itself and caller-supplied framing. Multiple required
renderers may be supplied, such as JSON and TOON; each must fit, and the receipt
records the greatest token estimate and byte count independently. Emit a cached
rendering directly: another serializer or extra newline changes its cost.
`buildEnvelope` can read the receipt for a package-owned self-accounting field.

The default estimator is `ceil(UTF-8 bytes / 4)`. Supply `estimateTokens` for
another contract, including a stronger one-token-per-byte bound. Estimates are
not a tokenizer guarantee. Callbacks must be pure, deterministic, promptly
returning, and include mandatory metadata in every rendering. The SDK does not
interpret package fields or provider authentication.

The default `prefix` policy stops at the first row that does not fit. `skip`
tries later rows without changing their order. The receipt retains original
`included_indices`, `total_candidates` and `omitted_count`; `complete` on the
result means all candidate rows fit. Neither policy splits rows or assumes
serialized size is monotone. A smaller budget does not promise nested selected
sets under `skip`; use `prefix` when prefix continuity matters.

The empty mandatory envelope must fit before any row is attempted.
`OutputEnvelopeFitError.code` distinguishes `output_envelope_infeasible`
(with `minimum_tokens`), `output_envelope_work_limit`, and
`output_envelope_unstable`. No unverified or oversized packet is returned.
`maxRenderCalls` defaults to 10,000 across every trial and renderer;
`maxStabilizationPasses` defaults to 16 per trial. Actual renderer calls and
evaluated candidates are reported in `work`, outside the measured packet.
These ceilings bound fitting work; they cannot interrupt arbitrary callback
execution. Existing candidate-projection packing and pre-receipt token
attribution retain their distinct contracts.

### Include Modes

`--output-include` accepts two kinds of token. A **field selector** names a row
field or section and narrows the computed result. A **projection mode** names a
whole declared projection and is the canonical spelling of a command-local mode
flag: `brief`, `compact`, `full`, `summary`, and `counts`, depending on the
surface. Controls that change execution rather than projection remain separate:
for example, `deps --collapse <none|repeated>` retains dependency-grouping
semantics, and `health --check-only` retains refresh-suppression semantics.

Mode tokens are resolved before the command computes its rows, because a mode
selects which fields exist rather than which of the computed fields survive.
`pm list --output-include brief` is therefore exactly `pm list --brief`, and the
two are byte-identical apart from the `read_output` receipt that records which
spelling was used. Modes and field selectors compose: the mode selects the
projection, the remaining selectors narrow it.

```bash
pm list --status open --output-include brief          # same result as --brief
pm contracts --output-include full                    # same result as --full
pm list --status open --output-include brief,id       # brief projection, id only
```

Read `readOutputIncludeModeOptions(command)` from the SDK for the exact
replacement modes a surface declares. Every compatibility alias also declares
`semantics: "replacement" | "behavior_preserving"`; generators therefore do
not have to infer obligation strength from prose. The executable migration test
derives all 22 projection-mode replacements from this table, invokes both
spellings in a temporary tracker, and compares their useful result after
removing spelling receipts and volatile run metadata. A selector that matches
neither a declared mode nor any field on any returned row is refused with the
legal domain, rather than returning rows with every field removed.

Runtime discovery publishes the same exact vocabulary before invocation.
`pm contracts --command <command> --summary` returns
`output_projection_contracts.commands`, while
`output_projection_contracts.global_ladder_scope: "union_not_per_command"`
explicitly marks `output_policy.degradation_ladder` as a cross-command union,
not a promise that every member is accepted by the selected command. For
example, `list` declares `brief`, `compact`, and `full`; `health` declares
`brief`, `full`, and `summary`. The full `read_output_dimensions` matrix also
includes `projection_modes` for every canonical read surface, including an
explicit empty array when a surface has no whole-result modes.

## Single-item detail fallback

Tracked by [pm-8eclqf](../.agents/pm/issues/pm-8eclqf.toon).
When a standard `get` exceeds its budget, the SDK first tries the declared
brief projection. It retains complete item metadata and dependencies while
omitting body, linked artifacts, claim history, and schedule details. The
receipt records `applied_depth: brief` and
`degradation_reason: output_budget_reached`; the omission receipt names the
removed sections and how to restore them. Explicit field selections, full/deep
reads, trees, and continuation requests keep their selected semantics.
If brief still exceeds the ceiling, normal compaction and eventual refusal
apply. `estimated_tokens` measures the emitted envelope;
`omitted_result_estimated_tokens` measures the useful result that could not fit.

## Typed producer pages

Receipt typing is tracked by [pm-gh1551](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1551.toon)
(repository-only tracker record excluded from npm).
Finalized `list`, `context`, `search`, and `get` first pages expose the shared
`PmReadOutputMetadata` contract. Their `omission_receipt` is present; accounting
receipts `read_output`, `read_session`, and `output_budget_truncation` remain
optional. The raw query result types expose these receipts optionally because
`runList`, `runContext`, `runSearch`, and `runGet` return before final projection.
The metadata type is available from the root, core, query, contracts, and runtime
entrypoints. Producer continuation pages may reference the initial omission
receipt, and whole-result budget omissions retain their separate discriminant.

Tracked by [pm-oybmsd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-oybmsd.toon),
[pm-jqgkis](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jqgkis.toon), and
[pm-qal1uw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qal1uw.toon)
(repository-only tracker records excluded from npm).
Native `PmClient.list`, `search`, and `context` reads and their standalone
convenience functions return sparse metadata when `after` resumes a producer
page. Retain the first page's filters, projection, sorting, totals and completeness
certificate. Subsequent pages carry `continuation_contract` with
`metadata: "reference"` and `restore_with: "omit --after"`; repeated metadata
is optional in `PmReadOutputProducerContinuation<Result>`. Follow `next_cursor`
until it is empty, rather than relying on the optional `has_more` field.

Calls whose options contain no producer cursor retain their first-page types.
Omitting the options argument has the same precise type as passing `{}` for
client and standalone `list`, `context`, and `search` calls; it does not imply
that an explicit budget, session, or output cursor was supplied.
Options with an optional cursor can return either page shape. When a budget,
session, or output cursor is possible, first use `isReadOutputBudgetExceeded`
to narrow the omission branch before accessing rows. This remains required for
unions of option shapes: a budgeted variant cannot be erased by an unbudgeted
variant. The low-level query producers retain their original result contracts;
metadata suppression belongs to the shared native SDK transport.

```ts
const first = await client.list({ brief: true, limit: "10" });
consume(first.items);
let cursor = first.next_cursor;
while (cursor) {
  const page = await client.list({ brief: true, limit: "10", after: cursor });
  consume(page.items);
  cursor = page.next_cursor;
}
```

## Cross-Call Context Sessions

Typed session results are tracked by
[pm-t1p1jv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-t1p1jv.toon)
(repository-only tracker record excluded from npm). After narrowing budget
omission with `isReadOutputBudgetExceeded`, use `isReadOutputSessionReference`
from the SDK or `sdk/core` before accessing row prose or a search hit's nested
`item`. A reference contains only `id` and `context_ref`. Calls with no session,
including calls that specify only an output budget, retain their ordinary row
types. The direct `applyReadOutputDimensions` helper also infers session
capability from its options, including the accepted `output_session` spelling.
Unspecified or explicitly undefined session options retain ordinary rows;
optional, union, or dynamically typed session options admit references.
`PmReadOutputSessionResult<Result>` models literal `row_contract.row_keys`
paths (including nested arrays and keyed maps). Dynamic path declarations
conservatively admit references in nested collections, and envelopes without a
row declaration use the top-level array fallback. Keep package row paths literal
with `as const` to preserve precision in package result declarations.

```ts
const page = await client.context({ outputSession: sessionState });
if (!isReadOutputBudgetExceeded(page)) {
  for (const row of page.high_level) {
    if (isReadOutputSessionReference(row)) consumeReference(row.context_ref);
    else consumeTitle(row.title);
  }
}
```

Read-option recovery is tracked by
[pm-7gpx34](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7gpx34.toon)
(repository-only tracker record excluded from npm). For explicit static encoding,
use `--output-format toon|json` across read commands. Completeness uses
`--output-include full` on list, search and get; context detail depth uses
`--depth full`. These controls retain the normal row and token ceilings.
When `context --full`, `list/search --depth full`, or `--toon` on list, search,
context or get is refused,
the error provides `recovery.suggested_retry_args` for the same command with the
supported spelling. The SDK's `resolveReadOptionRetryArgs` exposes the same
token-preserving correction. Conflicting controls or ambiguous operands do not
receive a guessed retry.
An explicit `--json` conflicts with `--toon`, so that invocation receives no
encoding-changing retry. Non-conflicting TOON refusals include the corrected
command in human output without requiring JSON diagnostics.

`--output-session <json>` / `outputSession` composes the four per-call
dimensions across a request group. The caller supplies versioned state and
passes the returned `read_session.next_state` to the next read:

```json
{
  "version": 1,
  "id": "orientation",
  "token_budget": 4000,
  "spent_tokens": 0,
  "seen_item_ids": []
}
```

The session ceiling and an explicit `--output-budget` both bind; the smaller
remaining allowance wins. Rows for item facts already present in the caller's
context become `{ "id": "pm-a1b2", "context_ref":
"session:orientation:pm-a1b2" }` instead of repeating prose. References retain
stable item identity and can be restored with `pm get <item-id> --depth brief` when
the prior context is unavailable. The receipt reports estimated and charged
tokens separately when the remaining group allowance is smaller than the
minimum control envelope, plus the accumulated spend, remaining capacity,
newly served items, and suppressed repeats.

The carried served-item set accepts at most 10,000 identities. A receipt always
preserves identities already present in the supplied state and retains newly
served identities in deterministic order until that capacity is full. When a
single read crosses the boundary, `seen_item_overflow_count` reports how many
new identities were not carried forward; those facts remain in the current
envelope and may be served in full again on a later read. The emitted
`next_state` therefore always remains valid input to the next call without
silently widening the safety bound.

Session state is deliberately caller-carried: CLI processes, SDK clients, MCP
hosts, and packages share the same deterministic primitive without a hidden
daemon or mutable cache. Validation rejects unknown fields, invalid identifiers,
unsupported schema versions, unsafe integers, and spend beyond the declared
ceiling before a read executes.

The mandatory orientation calibration runs `context`, `list`, `search`, `get`,
and `next` against both a two-item tracker and a 2,243-item tracker. Its
cross-call ceilings are strict: complete serialized bytes and cumulative spend
may only shrink, while repeat suppression may only hold or improve. The gate
also fixes the expected unique-fact shape:

| Tracker tier | Group spend / budget | Seen items | Suppressed repeats | Delivered bytes |
| ------------ | -------------------- | ---------- | ------------------ | --------------- |
| 2 items      | 3,820 / 20,000       | 2          | 3                  | 15,274          |
| 2,243 items  | 10,156 / 20,000      | 106        | 7                  | 40,614          |

These are deterministic synthetic-corpus measurements from
`scripts/release/context-intent-calibration.json`; they contain no hosted
tracker content.

## Precedence and Compatibility

Resolution is deterministic: canonical controls win over command-local compatibility options, which win over intent defaults, which win over command defaults. Existing options such as `--fields`, `--limit`, `--token-budget`, `--format`, `--brief`, and `--full` remain accepted. Contract output marks them as hidden compatibility aliases and supplies a migration hint; traversal, cursor, side-effect, and streaming controls instead receive an explicit behavior-preservation hint because a static output control cannot replace their semantics. Callers that omit the four shaping dimensions retain the established data projection; the one intentional envelope correction is that repeated `row_contract` metadata is now opt-in.

Completeness spellings preserve their established promise. `pm list-all` and
list-family `--no-truncate` imply an unbounded cost dimension when the caller
does not supply `--output-budget`; they cannot silently return a budget-trimmed
subset while claiming to return every matched row. An explicit canonical
budget still has precedence and may request a bounded result deliberately.
The same SDK-native rule applies to every declared complete-result spelling,
including `contracts --full`: explicit completeness defeats only the implicit
default ceiling. If an explicit caller budget cannot retain any useful domain
result, the CLI still prints the parseable omission receipt but exits 2; a
consumer therefore cannot interpret the missing command or action arrays as a
successful empty contract.

```bash
pm list --status open --output-include id,title,status --output-limit 10
pm context --for orient --output-budget 900 --output-format toon
pm search "runtime contracts" --output-limit 5 --output-format json
pm stats --output-row-contract
pm contracts --full --json
```

Canonical amount, encoding, and cost controls that leave an already-fitting result unchanged do not add a `read_output` receipt. Explicit include projections, sessions, continuations, and `--output-row-contract` retain the detailed receipt. Every shaped or budget-compacted result carries a `read_output` receipt with the requested dimensions, precedence, observed option provenance, deterministic estimated token count, string/row compaction signals, and budget outcome. When canonical controls are present, `canonical_options_used` records spellings such as `--output-include`; the optional field is omitted when no canonical control was supplied so minimum-budget session receipts remain compact. `legacy_aliases_used` and `migration_hints` record only compatibility flags the caller actually supplied. A command-local flag synthesized internally to execute a canonical projection mode is therefore never misreported as deprecated syntax. When both spellings are supplied, both provenance arrays report that mixed invocation. Budget degradation discovers nested arrays as well as declared result rows, so validation diagnostics and other governance payloads compact their inner findings before the useful result is omitted. `compacted_row_paths` names every reduced collection without redefining those nested arrays as ordinary pagination rows.

The estimate is `ceil(utf8_bytes / 4)` for the complete envelope. The CLI uses
its selected built-in JSON or TOON representation, including indentation and
the final newline. SDK calls that select `outputFormat` use that representation;
structured SDK calls without a renderer retain compact JSON measurement.
The native SDK dispatcher preserves that distinction for packing decisions,
infeasible-budget receipts, and session debits, including the returned next state
([pm-gh1552](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1552.toon),
repository-only tracker record excluded from npm).
Those unformatted calls keep the conservative workload-class ceiling
(`default_max_estimated_tokens`, also used as the generated TOON ceiling).
Selecting JSON explicitly opts into its larger declared rendering allowance;
serializing an SDK object for measurement does not implicitly select that policy.
Per-call and session receipts include their own cost and continuation disclosure.
Compaction reserves room for that disclosure before returning a useful page, so
an envelope cannot claim to fit merely because its rows fit before receipts were
added. Each selected collection uses a measured prefix search instead of irreversible
halving, retaining the largest prefix that fits with the other collections held
fixed. `applied_limit` and both continuation forms follow the retained item count.
A complete page and a truncated page have different mandatory metadata costs;
row counts across that boundary are not an unconditional monotonicity guarantee. An infeasible ceiling returns the explicit omission result.

For `context` and `next`, that final projection is also the usage-feedback
delivery boundary. The SDK carries a JSON-invisible serve receipt through
intent and universal output projection, then appends the final omitted decision
and exact emitted item ids. An infeasible output budget records zero delivered
rows; it can never leave the packer's earlier inclusions marked as served.
`PmClient` finalizes the receipt before resolving, while the CLI finalizes it
from the exact active result passed to telemetry and after-command hooks.

When rows are dropped to satisfy a ceiling, the result also carries `output_budget_truncation`, naming the binding budget and its source, any explicitly requested dimension the budget overrode, every compacted collection path, and executable CLI/SDK/MCP recovery options — a default ceiling can override an explicit `--output-limit unbounded`, and that override is reported rather than silent. If a producer supplied an opaque item-page cursor, compaction rebases it to the last row actually returned and reports `continuation_cursor_rebased: true`; following the cursor therefore cannot skip rows removed from the middle of a producer page. If no useful content can fit, `PmReadOutputBudgetExceeded` provides a discriminated omission result, a compact `{ outputBudget: "unbounded" }` recovery object, and `omitted_result_estimated_tokens`, the last useful-result estimate before omission; use `isReadOutputBudgetExceeded` before accessing result-specific fields. The encoding control `--output-format <toon|json>` also applies to mutation envelopes, including the mutation modes of `comments`, `notes`, `files`, and `docs`. Other universal read controls remain rejected before mutation execution. `--json` remains supported.

Cursor recovery carries the opaque value once in `recovery.cursor` and declares
the accepting `cli`, `sdk`, and `mcp` binding beside it. This avoids
serializing the same cursor once per transport while retaining an executable,
machine-readable binding for each surface.
When `restore_with` is `"recovery"`, consumers must resolve the adjacent
`recovery` object: pass its `cursor` value through `cli` (`--output-cursor`)
or the `sdk`/`mcp` field (`outputCursor`) while repeating the original query.
The string is a reference, not a shell command. Other `restore_with` values
provide retry guidance when no declared row collection can continue.

Budget-compacted declared row paths are independently resumable. The
disclosure's `continuations` entries name the row path, retained/remaining/total
counts, and an opaque cursor. `continuation_kind` distinguishes a rebased
producer cursor, a universal output cursor, and a terminal page;
`next_cursor` mirrors the first universal entry for ordinary one-path
consumers. Replay the same query and budget
with `--output-cursor <cursor>` / `outputCursor`. The cursor validates the
command, declared continuation path, total, and canonical content fingerprint
before slicing, so same-cardinality content changes and other stale replays
fail closed instead of skipping evidence. A
bounded recovery therefore does not require replacing a 600-token request with
an unbounded multi-megabyte response;
`recovery_budget_multiplier: 1` declares that each next page retains the same
useful-result ceiling.

Health continuation fingerprints use a versioned nonvolatile-snapshot policy
for the `checks` row. Command-lifecycle telemetry may refresh timestamps, queue
counters, and pending spans between pages, so the policy excludes only those
explicit direct fields from the `telemetry` row's `details`. The row identity,
verdict, enabled state, capture level, endpoint, environment overrides, probe
result, and failure errors remain fingerprinted. Every other health check also
remains fully fingerprinted; changing storage, integrity, history, or another
stable check fails closed. `PM_READ_OUTPUT_CONTINUATION_FINGERPRINT_POLICIES`
publishes the exact ignored detail fields per dynamic row. Other commands still
fingerprint every field, including fields with the same spelling, and any
policy-version change fails closed against an older cursor.

When compaction affects a nested collection that is not declared resumable,
the recovery budget is derived from the larger of the binding ceiling plus one
and the measured pre-compaction result. The SDK adds a 25% envelope margin and
rounds up to 100 tokens. The CLI, SDK, and MCP bindings therefore receive the
same finite value, which is strictly larger than the request that already
truncated. If safe-integer arithmetic cannot represent that value, recovery
uses `unbounded` explicitly. `resolveReadOutputRecoveryBudget()` exposes the
versioned pure calculation to package authors; there is no hard-coded smaller
retry and no recovery cycle.

Assurance declares `budget_retention_policy: verdict_priority`: failing block,
warn, and observe rows precede retired and passing rows while preserving order
within each class. `assertions_total` remains the pre-projection denominator,
and the `assertions` row path uses the same continuation primitive. A blocking
verdict consequently keeps its causal evidence on the first bounded page even
when the failing assertion was declared last.

Diagnostic gates retain bounded, actionable predicates. Every metadata field
required by the active validation profile emits a numeric count, including
zero, so assurance expressions can distinguish a clean check from a missing
key. Health retains at most 100 warning rows and reports `warning_count`,
`warning_limit`, and `warnings_truncated`; `--strict-exit` defaults to summary
projection unless `--full` is explicit, keeping the failing check identities
and warning codes inside the ordinary budget.

Failure transports use the companion
[Diagnostic Output Contracts](DIAGNOSTIC_OUTPUT_CONTRACTS.md). Those contracts
bind errors, warnings, validation summaries, and recovery bundles independently
from successful command results. Corrective actions precede explanation and
survive every degradation stage, while untruncated JSON avoids a per-call
receipt tax.

## SDK and Package Usage

Typed `PmClient` read methods accept `PmReadOutputOptions` directly:

```ts
import { PmClient } from "@unbrained/pm-cli/sdk";

const pm = new PmClient({ pmRoot: ".agents/pm" });
const result = await pm.list({
  status: "open,in_progress",
  outputInclude: "id,title,status",
  outputLimit: 10,
  outputBudget: 800,
  outputRowContract: true,
  outputSession: {
    version: 1,
    id: "orientation",
    token_budget: 4000,
    spent_tokens: 0,
    seen_item_ids: [],
  },
  // Supply outputCursor from output_budget_truncation to fetch the next row page.
});
```

Package authors should use the exported read-output contracts instead of inventing package-local limit or projection vocabularies. `PM_READ_OUTPUT_SURFACE_CONTRACTS` is the machine-readable matrix, `PM_READ_OUTPUT_CONTINUATION_FINGERPRINT_POLICIES` declares stable-snapshot exceptions, and `resolveReadOutputDimensions` plus `applyReadOutputDimensions` are the shared execution primitives.

## Drift Gates

The full runtime contract reports every surface and all four dimensions. Strict SDK/MCP schemas expose the canonical camelCase keys, and the generated contract fixture catches surface or schema drift:

```bash
pnpm contracts:check
node scripts/run-tests.mjs test -- tests/unit/sdk/read-output-contracts.spec.ts
node scripts/run-tests.mjs test -- tests/unit/sdk/read-output-migration-hints.spec.ts
node scripts/run-tests.mjs test -- tests/unit/commands/workspace/completion-command.spec.ts
```
