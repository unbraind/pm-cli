# Next-work selection budgets

Tracked by [pm-v53h9j](../.agents/pm/issues/pm-v53h9j.toon) and
[pm-lixy](../.agents/pm/tasks/pm-lixy.toon).

`pm next` distinguishes two costs:

- `--token-budget` bounds the `recommended` and `ready` fields together. It
  retains a prefix of the ranking, dropping alternatives before the
  recommendation. An oversized first candidate is omitted explicitly rather
  than silently replaced by a lower-ranked task.
- `--output-budget` bounds the complete response, including companion queues,
  explanations, receipts, and recovery instructions. Use this control when
  reserving space in an agent's context window.

```bash
pm next --token-budget 500 --output-budget 2000
pm next --for execute --token-budget 1200
```

The same options are available as `tokenBudget` and `outputBudget` on
`PmClient.next()` and through the MCP next operation. Selection accounting uses
the greater of the built-in JSON and TOON rendered UTF-8 byte costs divided by
four, rounded up. It includes both selection field names. This is a
deterministic estimate, not a model-specific tokenizer count.

SDK callers that request a whole-response budget must handle its omission union
before using the normal `NextResult` fields:

```ts
import { PmClient } from "@unbrained/pm-cli/sdk";

const result = await new PmClient().next({ tokenBudget: 500, outputBudget: 2000 });
if ("output_budget_exceeded" in result) {
  console.log(result.output_budget_exceeded.restore_with);
} else {
  console.log(result.recommended?.id, result.truncation?.ready_budget);
}
```

`truncation.ready_budget` identifies the measured scope, requested budget,
actual estimate, omitted row count, recommendation omission, feasibility, and
the budget needed to restore the original row-limited selection. A budget too
small even for `{ recommended: null, ready: [] }` reports
`within_budget: false`. Empty output in this case does not mean no work exists:
`summary.ready` still reports the complete ready population, and recovery names
the larger selection budget.

Intent reads (`--for execute`) already include a complete-response budget
receipt. They add the selection receipt only when selection rows were omitted
or the selection ceiling was infeasible, avoiding redundant context overhead.

The independent row cap still applies. Raising a selection budget does not
raise `--limit`, and budget omission counts exclude rows already withheld by
that cap. `truncation.ready_total` reports the complete ready population when
either the row cap or the selection budget removes rows, including when a
generous budget fits every row allowed by the cap.
Companion decisions, gates, containers, and blockers are outside the
selection budget; their output is covered by the complete-response budget.
Selection accounting precedes whole-response projection. If the latter removes
more data, its outer output-budget receipt describes that additional omission.
Without an explicit selection budget, the established row-limited behavior
remains in place. Generic `packing` diagnostics describe the candidate
optimizer; `truncation.ready_budget` describes the emitted executable answer.

Ranking explanations and usage-feedback inclusion refer to the delivered
recommendation and alternatives. They do not mark hidden ranked candidates as
included merely because the generic optimizer considered them affordable.

## Reproducible quality checks

The committed golden corpus includes scratch, hierarchy, continuity,
served-then-used, and medium backlog cases at different selection budgets.
The gate independently measures the selection instead of trusting its receipt.
Negative controls reject missing receipts, ignored budgets, false feasibility
claims, and budgets that fit compact JSON but fail the actual rendered cost.

```bash
node scripts/release/context-eval-gate.mjs
node scripts/release/context-eval-gate.mjs \
  --corpus tests/context-eval/scale-scenarios.json \
  --baseline tests/context-eval/scale-baseline.json
```

The required CI smoke check also runs the scale corpus, using the shared SDK-backed shape generator: a 10,000-item
representative workspace and a 100,000-item scratch-shaped workspace, each
with a current claimed anchor. Each run creates and removes isolated temporary
trackers. The public SDK evaluation runner respects a scenario's explicit
`outputBudget`; absent that option, it retains exhaustive diagnostic reads.

Review changed judgments and scenario metrics before intentionally refreshing
either baseline with the corresponding command plus `--update`. A refreshed
baseline does not waive the corpus's absolute quality thresholds.
