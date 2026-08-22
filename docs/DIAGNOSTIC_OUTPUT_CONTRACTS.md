# Diagnostic Output Contracts

Tracker references: [pm-cha95z](../.agents/pm/tasks/pm-cha95z.toon), [pm-5t33or](../.agents/pm/features/pm-5t33or.toon), [pm-f05lsg](../.agents/pm/features/pm-f05lsg.toon), and [pm-h8tpeh](../.agents/pm/features/pm-h8tpeh.toon).

## Agent Quick Context

Failures are context-management surfaces. Every diagnostic family now declares
a format-aware token ceiling and one degradation ladder in the public SDK:

| Class                | Text | JSON | Corrective action that survives degradation |
| -------------------- | ---: | ---: | ------------------------------------------- |
| `error`              |  768 | 2000 | required action, retry/domain, or next step |
| `warning`            |  768 | 2000 | required action, retry/domain, or next step |
| `validation_summary` | 1500 | 3000 | required action, retry/domain, or next step |
| `recovery_bundle`    |  768 | 2000 | required action, retry/domain, or next step |

The smallest explicit ceiling is 192 estimated tokens. At that floor, the
projector may reduce the diagnostic to its code, required action, compact
recovery, and exit status. It never removes the first corrective action.

## SDK Contract

Use the public contract surface rather than maintaining a package-local error
budget:

```ts
import {
  PM_DIAGNOSTIC_OUTPUT_BUDGET_CONTRACTS,
  projectPmDiagnosticOutput,
  projectPmDiagnosticText,
  resolvePmDiagnosticOutputBudget,
} from "@unbrained/pm-cli/sdk/contracts";

const contract = resolvePmDiagnosticOutputBudget("error");
const projected = projectPmDiagnosticOutput(
  {
    code: "invalid_argument_value",
    required: "Use --status open and retry.",
    recovery: { suggested_retry: "pm list --status open" },
    detail: "The supplied status is not declared.",
    exit_code: 2,
  },
  { maxEstimatedTokens: contract.minimum_max_estimated_tokens },
);

const text = projectPmDiagnosticText(
  "A long rendered diagnostic",
  "Use --status open and retry.",
).output;
```

The JSON projector orders `code`, `required`, recovery, and next steps before
explanation. Untruncated diagnostics add no per-call receipt overhead; their
binding declaration is discoverable from `pm contracts --full --json` under
`diagnostic_output_contracts`. When degradation occurs, the returned
`diagnostic_output` receipt records the effective budget, original and emitted
estimates, applied stages, and omitted top-level fields. Minimal fallbacks bound
the named omission list and disclose any additional count through
`omitted_fields_overflow_count`.

Structured CLI refusals also include a compact `refusal` identity with the
failing command/flag/operand surface, rejected scalar when observable, complete
legal domain when one exists, and the process exit code. Recovery-bearing
errors use the `recovery_bundle` diagnostic class. Collection degradation may
compact explanatory domains inside `recovery`, but `refusal.legal_domain`
remains complete and `recovery.suggested_retry_args` is atomic: the projector
either retains the executable argv or removes the recovery rather than slicing
it into a dead command.

The deterministic ladder is:

1. full diagnostic;
2. omit explanation;
3. limit diagnostic collections;
4. compact recovery to actionable keys;
5. retain the action-only envelope.

Human diagnostics lead with `What is required` and next steps before explaining
what happened. If their declared ceiling binds, the compact text still begins
with the required action and points to structured JSON for the bounded recovery
envelope.

## Executable Assurance

`pnpm quality:recovery-closure` builds the current CLI and replays 117 refusal
contracts in isolated trackers: 18 closed-domain rows, 88 required-argument
omissions derived from core executable positional signatures, seven
closed-action families, and four tracker-preflight states. Package-owned
commands enter executable coverage when their package runtime is active rather
than being misreported as core. Ten representative, high-frequency failure
paths are also ratcheted by
`scripts/release/diagnostic-output-baseline.json`. The gate requires every row
to remain within the SDK-declared JSON ceiling and retain a mechanically
actionable correction. It reports the aggregate original and emitted token
estimates without claiming a reduction when no degradation was required.

The baseline is a coverage ratchet, not permission to weaken a ceiling. Its
negative control requires a missing baseline probe to fail. The existing
refusal-closure negative controls independently prove that incomplete domains,
broken retries, and malformed recovery envelopes remain blocking findings.
The grammar corpus additionally hashes authoritative tracker state around each
refusal; schema, items, history, settings, and package state must not change.
Ephemeral runtime lock/cache directories are excluded from that semantic
snapshot.

Run the focused proof with:

```bash
pnpm build
node scripts/release/refusal-closure-gate.mjs
node scripts/run-tests.mjs test -- \
  tests/unit/sdk/agent-output-contracts.spec.ts \
  tests/unit/cli/error-guidance.spec.ts \
  tests/unit/scripts/refusal-closure-gate.spec.ts
```
