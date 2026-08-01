# Output Token Accounting

Tracker references: [pm-t5dt4z](../.agents/pm/tasks/pm-t5dt4z.toon) and [pm-g3n00m](../.agents/pm/stories/pm-g3n00m.toon).

## Agent Quick Context

Add `--token-accounting` to any CLI invocation when you need to attribute its output cost. MCP callers pass the top-level `tokenAccounting: true` transport option. Accounting is disabled by default and does not change the result when omitted.

```bash
pm context --for orient --limit 5 --json --token-accounting
pm get pm-example --json --token-accounting
```

Both transports attach the same `token_accounting` receipt. SDK and package hosts can call `attachOutputTokenAccounting(result, render)` with their real renderer, so the measurement describes emitted transport bytes rather than an intermediate object.

## Receipt Contract

The receipt reports:

- `total_bytes`: exact UTF-8 bytes emitted before the receipt;
- `total_estimated_tokens`: `ceil(total_bytes / 4)`, the estimator used by pm output budgets;
- `sections`: exact byte allocation across `result_rows`, `envelope`, `diagnostics`, and `hints`;
- `accounting_receipt_bytes`: independently measured receipt overhead;
- `measurement_scope: output_before_token_accounting` and `excluded_fields: [token_accounting]`.

Section bytes sum exactly to `total_bytes`. Structural bytes are allocated in proportion to each section's canonical JSON size. That deterministic allocation supports comparisons across CLI and MCP while the total always comes from the transport's actual renderer.

Accounting deliberately excludes itself. This avoids recursive cost reporting and keeps budget comparisons honest. The release gate also requires every receipt to stay below 1,024 bytes.

## Failure Output

Structured CLI failures participate when `--json --token-accounting` is used. This makes learning and recovery cost attributable in the same loop as successful reads:

```bash
pm get pm-missing --json --token-accounting
```

The command still exits with its normal non-zero status; the receipt is additive to the structured error envelope.

## Release-Level Task Entitlement

[`agent-task-token-baseline.json`](agent-task-token-baseline.json) is the externally shipped release baseline. The gate executes the built CLI in an isolated workspace and covers:

- a small-workspace read;
- a scaled-workspace context read;
- a returning-agent item read with a required-field completeness assertion;
- a failing command with bounded recovery output.

Each invocation is independently byte-counted, its section sum is checked, and its consumed field is retained. A seeded million-token regression proves the ratchet fails. Run it with:

```bash
pnpm quality:agent-task-token
node scripts/release/agent-task-token-gate.mjs --negative-control
```

Refresh the committed ceiling only after an intentional reviewed output change:

```bash
pnpm quality:agent-task-token:update
```
