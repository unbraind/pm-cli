# Token Budgets and Read Output

Every `pm` read declares a default token ceiling, degrades deterministically
when it is reached, and reports what it withheld. This reference is the
operating procedure; [docs/READ_OUTPUT_CONTRACTS.md](../../../../docs/READ_OUTPUT_CONTRACTS.md)
(~3.6k tok) is the full contract.

## The Four Levers, In Order

Apply the cheapest lever that answers the question.

1. **Projection.** Ask for fewer fields or sections.

   ```bash
   pm get <ID> --output-include id,title,status,dependencies
   pm list --status open --output-include id,title,type
   ```

2. **Row limit.** Bound the number of rows before bounding tokens.

   ```bash
   pm list --status open --output-limit 20
   pm search "<terms>" --limit 10
   ```

3. **Budget.** Only after 1 and 2 are set.

   ```bash
   pm context --limit 10 --output-budget 4000
   ```

4. **Continuation.** Resume rather than re-read.

   ```bash
   pm notes <ID> --output-cursor <cursor-from-previous-response>
   ```

## Reading The Receipt

Two blocks decide whether a result may be treated as complete.

- `omission_receipt` — declares whether field groups were dropped and the flag
  that restores each one. `has_omissions: false` means the projection is whole.
- `output_budget_truncation` — appears only when a ceiling bound the result. It
  names the `reason`, the `budget_source`, the row collections it compacted, and
  whether a continuation is available.

A truncated read is a claim about the part it withheld. Never summarize a
truncated list as if it were the population. When `continuation_available` is
true, the cursor is the correct recovery; `--output-budget unbounded` is the
last resort and can be hundreds of times more expensive.

## Formats

- `--output-format toon` (default) is the agent-loop encoding: tabular rows are
  emitted once as a header plus values, not repeated per row.
- `--output-format json` / `--json` is for strict parsing. JSON ceilings are
  higher than TOON ceilings for the same command because the encoding is larger.
- `--lean` omits null and empty containers from JSON output.
- `--token-accounting` attaches a per-section cost receipt so a read can be
  profiled before it is made routine.

## Measuring Before Committing To A Pattern

```bash
pm contracts --summary --json | jq '.command_summaries[]
  | {command, toon: .default_max_estimated_tokens_by_format.toon}'
pm list --status open --token-accounting
```

Use the declared ceiling per command rather than assuming a global one. A
command with no declared ceiling inherits the workspace default, which is a
weaker guarantee than a declared one.

## Cold-Start Cost

The cheapest useful orientation is two calls:

```bash
pm next                 # ~2.5k tok — one actionable item with its context
pm contracts --summary  # ~2.6k tok — the command surface with per-command ceilings
```

Prefer `pm next` over `pm list-open` when the goal is to start work: it applies
relevance ranking and returns a working set rather than a page of rows.
