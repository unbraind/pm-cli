# Universal Read Output Contracts

Tracker references: [pm-hb7ug8](../.agents/pm/features/pm-hb7ug8.toon) and [pm-cxr0jb](../.agents/pm/features/pm-cxr0jb.toon).

## Agent Quick Context

Every built-in read surface uses four output dimensions: what to include, how much to return, how much the result may cost, and how to encode it. The same canonical controls work through the CLI, SDK, MCP, generated schemas, runtime contracts, and shell completions.

| Dimension | CLI | SDK and MCP | Meaning |
| --- | --- | --- | --- |
| Include | `--output-include <csv>` | `outputInclude` | Retain named fields or top-level sections. |
| Amount | `--output-limit <n\|unbounded>` | `outputLimit` | Bound shared row collections. |
| Cost | `--output-budget <tokens>` | `outputBudget` | Fail closed when even the compact result cannot fit. |
| Encoding | `--output-format <toon\|json>` | `outputFormat` | Select the CLI renderer and record the requested encoding. |

The contract covers `list`, `context`, `search`, `get`, `next`, `health`, `deps`, `graph`, `history`, `activity`, `validate`, `events`, `contracts`, `comments`, `notes`, `files`, `docs`, `stats`, and `aggregate`, including list aliases and `ctx`.

## Precedence and Compatibility

Resolution is deterministic: canonical controls win over command-local compatibility options, which win over intent defaults, which win over command defaults. Existing options such as `--fields`, `--limit`, `--token-budget`, `--format`, `--brief`, and `--full` remain accepted. Contract output marks them as hidden compatibility aliases and supplies a migration hint; callers that omit the canonical controls receive the byte-identical established result.

```bash
pm list-open --output-include id,title,status --output-limit 10
pm context --for orient --output-budget 900 --output-format toon
pm search "runtime contracts" --output-limit 5 --output-format json
pm contracts --full --json
```

Every projected result carries a `read_output` receipt with the requested dimensions, precedence, observed compatibility aliases, deterministic estimated token count, and budget outcome. Universal controls are rejected on mutation commands and on the mutation mode of hybrid commands such as `comments`, `notes`, `files`, and `docs`.

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
