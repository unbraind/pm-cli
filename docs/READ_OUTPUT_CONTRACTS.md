# Universal Read Output Contracts

Tracker references: [pm-hb7ug8](../.agents/pm/features/pm-hb7ug8.toon), [pm-cxr0jb](../.agents/pm/features/pm-cxr0jb.toon), [pm-hid9g1](../.agents/pm/features/pm-hid9g1.toon), [pm-h8tpeh](../.agents/pm/features/pm-h8tpeh.toon), [pm-sb0tns](../.agents/pm/issues/pm-sb0tns.toon), [pm-gjjurs](../.agents/pm/issues/pm-gjjurs.toon), [pm-eugaqy](../.agents/pm/issues/pm-eugaqy.toon), [pm-jt8aa2](../.agents/pm/issues/pm-jt8aa2.toon), and [pm-kyjdne](../.agents/pm/issues/pm-kyjdne.toon).

## Agent Quick Context

Every built-in read surface uses four output dimensions: what to include, how much to return, how much the result may cost, and how to encode it. The same canonical controls work through the CLI, SDK, MCP, generated schemas, runtime contracts, and shell completions.

| Dimension | CLI                             | SDK and MCP     | Meaning                                                                |
| --------- | ------------------------------- | --------------- | ---------------------------------------------------------------------- |
| Include   | `--output-include <csv>`        | `outputInclude` | Retain named fields or sections, or select a declared projection mode. |
| Amount    | `--output-limit <n\|unbounded>` | `outputLimit`   | Bound shared row collections.                                          |
| Cost      | `--output-budget <tokens>`      | `outputBudget`  | Fail closed when even the compact result cannot fit.                   |
| Encoding  | `--output-format <toon\|json>`  | `outputFormat`  | Select the CLI renderer and record the requested encoding.             |

The contract covers `list`, `context`, `search`, `get`, `next`, `health`, `deps`, `graph`, `history`, `activity`, `validate`, `events`, `contracts`, `comments`, `notes`, `files`, `docs`, `stats`, and `aggregate`, including list aliases and `ctx`.

Row shaping follows each envelope's `row_contract.row_keys`, including
dot-delimited nested arrays and object maps such as `graph.nodes`. Include,
amount, repeat suppression, and cost compaction therefore operate on the same
machine-declared rows; they do not rely on command-specific top-level keys.
The runtime uses that declaration internally on every read but omits the
repeated metadata from results by default. Request
`--output-row-contract` / `outputRowContract: true` when a consumer needs the
row paths, jq selector, and active TOON encoding contract.

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

## Cross-Call Context Sessions

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
stable item identity and can be restored with `pm get <item-id> --brief` when
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

```bash
pm list-open --output-include id,title,status --output-limit 10
pm context --for orient --output-budget 900 --output-format toon
pm search "runtime contracts" --output-limit 5 --output-format json
pm stats --output-row-contract
pm contracts --full --json
```

Every projected result carries a `read_output` receipt with the requested dimensions, precedence, observed compatibility aliases, deterministic estimated token count, string/row compaction signals, and budget outcome. Budget degradation discovers nested arrays as well as declared result rows, so validation diagnostics and other governance payloads compact their inner findings before the useful result is omitted. `compacted_row_paths` names every reduced collection without redefining those nested arrays as ordinary pagination rows.

When rows are dropped to satisfy a ceiling, the result also carries `output_budget_truncation`, naming the binding budget and its source, any explicitly requested dimension the budget overrode, every compacted collection path, and an executable recovery instruction — a default ceiling can override an explicit `--output-limit unbounded`, and that override is reported rather than silent. If no useful content can fit, `PmReadOutputBudgetExceeded` provides a discriminated omission result and reports `omitted_result_estimated_tokens`, the last useful-result estimate before omission; use `isReadOutputBudgetExceeded` before accessing result-specific fields. Universal controls are rejected on mutation commands and on the mutation mode of hybrid commands such as `comments`, `notes`, `files`, and `docs`.

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
});
```

Package authors should use the exported read-output contracts instead of inventing package-local limit or projection vocabularies. `PM_READ_OUTPUT_SURFACE_CONTRACTS` is the machine-readable matrix and `resolveReadOutputDimensions` plus `applyReadOutputDimensions` are the shared execution primitives.

## Drift Gates

The full runtime contract reports every surface and all four dimensions. Strict SDK/MCP schemas expose the canonical camelCase keys, and the generated contract fixture catches surface or schema drift:

```bash
pnpm contracts:check
node scripts/run-tests.mjs test -- tests/unit/sdk/read-output-contracts.spec.ts
node scripts/run-tests.mjs test -- tests/unit/sdk/read-output-migration-hints.spec.ts
node scripts/run-tests.mjs test -- tests/unit/commands/completion-command.spec.ts
```
