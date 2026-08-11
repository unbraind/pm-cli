# Project Assurance Primitives

Tracker: [pm-2lex4r](../.agents/pm/features/pm-2lex4r.toon), [pm-lyfu7b](../.agents/pm/features/pm-lyfu7b.toon), [pm-wn6wot](../.agents/pm/features/pm-wn6wot.toon), [pm-91xeam](../.agents/pm/features/pm-91xeam.toon)

## Agent Quick Context

Assurance turns project policy into three reusable SDK-owned declarations:

1. A **measurement** selects authoritative project data and produces a number or labelled set plus population, contributor, and compute-cost receipts.
2. An **assertion** applies exactly one explicit bound, scope, lifetime, and enforcement level to a measurement. Required negative controls prove that the bound can both pass and fail.
3. A **gate** evaluates named assertions at declared lifecycle triggers and returns one structured verdict shared by CLI, SDK, MCP, and CI callers.

Declarations live in `.agents/pm/assurance.json`. Every registry mutation and non-dry gate verdict is appended through the verified workspace history stream; never edit either file directly.

## Why Assurance Exists

Project management is context management. A useful quality gate therefore needs more than a shell exit code: it must preserve what was measured, which population was judged, why a bound exists, who owns it, what changed the result, how expensive the evaluation was, and which immutable tree received the verdict.

The assurance SDK keeps those semantics independent from presentation. Commander and MCP only normalize inputs. Package authors and CI hosts can use the same public functions without reconstructing policy in scripts.

## Declaration Vocabulary

Measurements support these built-in sources:

| Source | Purpose |
| --- | --- |
| `items` | Count items matching status, type, tags, or an exact metadata field. |
| `dependency_kind` | Count typed relationship edges such as `blocked_by` or `verifies`. |
| `graph` | Select a numeric or labelled-set field from a public graph SDK result. |
| `validate` | Select a validator check status or numeric detail. |
| `health` | Select a health check status, numeric detail, or labelled set. |
| `history` | Count immutable events by operation, author, harness, or model. |
| `links` | Count items with present or missing file, test, or documentation evidence. |
| `derived` | Combine numeric measurements with deterministic arithmetic and cycle detection. |
| `provider` | Delegate a measurement to an explicitly supplied host/package resolver. |

Each measurement may declare `max_cost`. Evaluation fails closed when the total abstract compute units exceed that ceiling. Every result reports units, scanned items, scanned history rows, provider calls, duration, population size, and contributors.

Assertions require exactly one polarity:

- `ceiling`, `floor`, `equals`, or `zero`
- `monotone_nondecreasing` or `monotone_nonincreasing`
- `subset_of` for labelled sets

Scopes are `all`, `active`, or `filter`. A filter names another measurement whose contributors define the item population. `lifetime: hold` keeps the guarantee after its owner item becomes terminal. `lifetime: retire` retires it only after owner termination and requires `retire_reason`.

Enforcement is `block`, `warn`, or `observe`. Weakening a bound, scope, lifetime, owner, source measurement, or enforcement requires `authorization_decision` naming a terminal Decision item verified by the host. The transport verifies only that explicitly named item; it never treats unrelated workspace Decisions as authorization. Tightening does not require authorization.

## CLI Workflow

Create a measurement:

```bash
pm assurance put measurement active-issues \
  --definition '{"id":"active-issues","source":{"kind":"items","statuses":["open","in_progress"],"types":["Issue"]},"max_cost":5000}' \
  --message "Track the active issue population"
```

Create an assertion with executable negative controls:

```bash
pm assurance put assertion active-issues-ceiling \
  --definition '{"id":"active-issues-ceiling","measurement_id":"active-issues","owner_item_id":"pm-example","scope":{"kind":"active"},"ceiling":25,"lifetime":"hold","enforcement":"block","negative_control":{"cases":[{"observed":25,"expected":"pass"},{"observed":26,"expected":"fail"}]}}'
```

Create and evaluate a gate:

```bash
pm assurance put gate release-readiness \
  --definition '{"id":"release-readiness","assertion_ids":["active-issues-ceiling"],"triggers":["ci","pre-release"]}'

pm assurance run release-readiness --trigger ci --dry-run --json
pm assurance run release-readiness --trigger pre-release --tree "$(git rev-parse HEAD)" --json
pm assurance verdicts release-readiness --limit 20 --json
```

Registry reads and removals use the same nouns:

```bash
pm assurance list measurement --json
pm assurance show assertion active-issues-ceiling --json
pm assurance remove gate release-readiness
```

Referenced measurements and assertions cannot be removed. Remove the consuming gate or assertion first.

## SDK and MCP

The reusable client exposes the same action grammar:

```ts
import { PmClient } from "@unbrained/pm-cli/sdk";

const pm = new PmClient({ pmRoot: ".agents/pm" });

await pm.assurance({
  action: "run",
  id: "release-readiness",
  trigger: "ci",
  dry_run: true,
});
```

For direct host composition, use `evaluateMeasurement`, `evaluateAssuranceGate`, `createAssuranceWorkspaceContext`, and the audited declaration/verdict helpers exported from `@unbrained/pm-cli/sdk`. A host contributes provider measurements by passing stable resolver ids to `createAssuranceWorkspaceContext`; an absent resolver fails loudly. External adapters must enforce an appropriate timeout. The core evaluator bounds concurrent assertions and expression operands, and workspace history loading uses bounded concurrency; item-only callers can explicitly skip history and Git identity resolution.

Generic SDK and MCP dispatch use `action: "assurance"` with `subcommand` set to `list`, `show`, `put`, `remove`, `run`, or `verdicts`. Discover the current machine contract instead of copying parameter lists:

```bash
pm contracts --action assurance --schema-only --json
pm contracts --command assurance --flags-only --json
```

## Verdict Contract

A gate emits one object containing:

- gate id, evaluated tree, trigger, timestamp, and dry-run status;
- overall `pass`, `warn`, or `block` plus stable exit code;
- every assertion's measurement, scope, population, observed value, structured bound, signed distance, enforcement, negative-control proof, cost, and contributors;
- an aggregate compute receipt.

Dry runs never write history. Non-dry verdicts are immutable workspace audit events and remain queryable after ordinary registry changes. Verdict reads return newest entries first and default to a bounded result; use `--limit` to select up to 1,000 matching records. A blocking verdict exits non-zero; warnings and observations remain successful while preserving their failed assertion rows.

## Safety and Evolution

- Use stable lowercase ids; prose belongs in descriptions and mutation messages.
- Prefer saved measurements and derived arithmetic over duplicating queries in scripts.
- Give expensive graph, health, validate, or provider measurements explicit cost ceilings.
- Keep owner items and authorization Decisions linked into the project graph.
- Treat negative controls as part of the policy, not test decoration.
- Use `hold` unless a time-bounded guarantee has an explicit retirement rationale.
- Use `--dry-run` while authoring or tightening a gate, then persist a verdict against an immutable tree.
