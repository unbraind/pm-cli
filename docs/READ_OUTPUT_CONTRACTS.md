# Universal Read Output Contracts

Tracker references: [pm-hb7ug8](../.agents/pm/features/pm-hb7ug8.toon), [pm-cxr0jb](../.agents/pm/features/pm-cxr0jb.toon), [pm-hid9g1](../.agents/pm/features/pm-hid9g1.toon), and [pm-sb0tns](../.agents/pm/issues/pm-sb0tns.toon).

## Agent Quick Context

Every built-in read surface uses four output dimensions: what to include, how much to return, how much the result may cost, and how to encode it. The same canonical controls work through the CLI, SDK, MCP, generated schemas, runtime contracts, and shell completions.

| Dimension | CLI                             | SDK and MCP     | Meaning                                                    |
| --------- | ------------------------------- | --------------- | ---------------------------------------------------------- |
| Include   | `--output-include <csv>`        | `outputInclude` | Retain named fields or top-level sections.                 |
| Amount    | `--output-limit <n\|unbounded>` | `outputLimit`   | Bound shared row collections.                              |
| Cost      | `--output-budget <tokens>`      | `outputBudget`  | Fail closed when even the compact result cannot fit.       |
| Encoding  | `--output-format <toon\|json>`  | `outputFormat`  | Select the CLI renderer and record the requested encoding. |

The contract covers `list`, `context`, `search`, `get`, `next`, `health`, `deps`, `graph`, `history`, `activity`, `validate`, `events`, `contracts`, `comments`, `notes`, `files`, `docs`, `stats`, and `aggregate`, including list aliases and `ctx`.

Row shaping follows each envelope's `row_contract.row_keys`, including
dot-delimited nested arrays and object maps such as `graph.nodes`. Include,
amount, repeat suppression, and cost compaction therefore operate on the same
machine-declared rows; they do not rely on command-specific top-level keys.

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

Resolution is deterministic: canonical controls win over command-local compatibility options, which win over intent defaults, which win over command defaults. Existing options such as `--fields`, `--limit`, `--token-budget`, `--format`, `--brief`, and `--full` remain accepted. Contract output marks them as hidden compatibility aliases and supplies a migration hint; traversal, cursor, side-effect, and streaming controls instead receive an explicit behavior-preservation hint because a static output control cannot replace their semantics. Callers that omit the canonical controls receive the byte-identical established result.

```bash
pm list-open --output-include id,title,status --output-limit 10
pm context --for orient --output-budget 900 --output-format toon
pm search "runtime contracts" --output-limit 5 --output-format json
pm contracts --full --json
```

Every projected result carries a `read_output` receipt with the requested dimensions, precedence, observed compatibility aliases, deterministic estimated token count, string/row compaction signals, and budget outcome. If no useful content can fit, `PmReadOutputBudgetExceeded` provides a discriminated omission result; use `isReadOutputBudgetExceeded` before accessing result-specific fields. Universal controls are rejected on mutation commands and on the mutation mode of hybrid commands such as `comments`, `notes`, `files`, and `docs`.

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
node scripts/run-tests.mjs test -- tests/unit/commands/completion-command.spec.ts
```
