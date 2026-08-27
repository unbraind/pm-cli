# Output Token Accounting

Tracker references: [pm-t5dt4z](../.agents/pm/tasks/pm-t5dt4z.toon), [pm-g3n00m](../.agents/pm/stories/pm-g3n00m.toon), [pm-8pnj](../.agents/pm/features/pm-8pnj.toon), [pm-f05lsg](../.agents/pm/features/pm-f05lsg.toon), and [pm-srns](../.agents/pm/issues/pm-srns.toon).

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

[`agent-task-transcripts.json`](agent-task-transcripts.json) is the SDK-validated, versioned golden corpus. [`agent-task-token-baseline.json`](agent-task-token-baseline.json) is its externally shipped release ratchet. The gate executes the built CLI against independent, identically seeded accounting-on and accounting-off workspaces. Its five complete workflows cover:

- bounded triage, scaled-workspace orientation, and returning-agent inspection;
- a closed-domain refusal followed by the exact advertised shell-free retry;
- an unknown option after valid flags followed by a corrected command;
- create, inspect, close, and final-state confirmation through mutation receipts;
- successful bulk partial-effect and no-effect exits without collapsing them into exit zero.

Every step verifies its public SDK output family, canonical successful or refusal exit status, required own-property paths, and refusal identity where applicable. Recovery steps must declare a successful output family instead of chaining one refusal to another, and every completed task must terminate with successful output. Successful steps cannot carry refusal-only metadata. Dot-separated `required_fields` paths are traversed structurally from the output root, so incidental prose or nested key names cannot satisfy completeness. The report publishes bytes and estimated tokens for each step and completed task, retry counts, corpus digest, and composite cost. Runtime refusals verify that their self-reported `total_bytes` matches the independent transport and that `total_estimated_tokens` equals `ceil(total_bytes / 4)`; Commander usage refusals that happen before accounting attachment are measured directly from the captured transport and labeled `independent_transport`.

The baseline fails closed on corpus digest, task identity, step identity, missing or non-finite per-step and per-task ceilings, and missing or non-finite composite cost ceilings. A seeded million-token completed-task regression proves the ratchet fails. Run it with:

```bash
pnpm quality:agent-task-token
node scripts/release/agent-task-token-gate.mjs --negative-control
```

Package authors can validate their own corpus with the same public contract before replay:

```ts
import { parsePmAgentTaskTranscriptCorpus } from "@unbrained/pm-cli/sdk/contracts";

const corpus = parsePmAgentTaskTranscriptCorpus(JSON.parse(source));
```

The parser rejects unknown versions, empty tasks or steps, duplicate identities, output families that disagree with the command contract, refusal-only metadata on successful steps, terminal refusals, and recovery edges that do not point from a successful step to an earlier refusal.

Refresh the committed ceiling only after an intentional reviewed output change:

```bash
pnpm quality:agent-task-token:update
```
