# Project Assurance Primitives

Tracker: [pm-2lex4r](../.agents/pm/features/pm-2lex4r.toon), [pm-lyfu7b](../.agents/pm/features/pm-lyfu7b.toon), [pm-wn6wot](../.agents/pm/features/pm-wn6wot.toon), [pm-91xeam](../.agents/pm/features/pm-91xeam.toon), [pm-uhv1m5](../.agents/pm/features/pm-uhv1m5.toon), [pm-m7bb7r](../.agents/pm/features/pm-m7bb7r.toon), [pm-py7qv2](../.agents/pm/issues/pm-py7qv2.toon), [pm-33mjrw](../.agents/pm/issues/pm-33mjrw.toon), [pm-q6n8sj](../.agents/pm/issues/pm-q6n8sj.toon), [pm-h06944](../.agents/pm/issues/pm-h06944.toon), [pm-88mo8m](../.agents/pm/issues/pm-88mo8m.toon), [pm-atnfh4](../.agents/pm/issues/pm-atnfh4.toon), [pm-xmmafu](../.agents/pm/issues/pm-xmmafu.toon), [pm-dwj33e](../.agents/pm/decisions/pm-dwj33e.toon)

## Agent Quick Context

Assurance turns project policy into three reusable SDK-owned declarations:

1. A **measurement** selects authoritative project data and produces a number or labelled set plus population, contributor, and compute-cost receipts.
2. An **assertion** applies exactly one explicit bound, scope, lifetime, and enforcement level to a measurement. Required negative controls prove that the bound can both pass and fail.
3. A **gate** evaluates named assertions at declared lifecycle triggers and returns one structured verdict shared by CLI, SDK, MCP, and CI callers.

Declarations live in `.agents/pm/assurance.json`. Every registry mutation and non-dry gate verdict is appended through the verified workspace history stream; never edit either file directly.

`pm history _workspace --verify`, `pm validate`, and `pm health` verify both
the hash chain and replay-to-disk agreement for every governed singleton. A
valid chain paired with a different, missing, or unreadable singleton is still
drift. SDK hosts can inspect that state with `inspectWorkspaceHistoryState`,
adopt a reviewed out-of-band value only through
`reconcileWorkspaceJsonHistory` with a terminal authorizing Decision, or
replace it from a verified version with `restoreWorkspaceJsonFromHistory`.
Both recovery paths append forward; neither rewrites the existing stream.

## Why Assurance Exists

Project management is context management. A useful quality gate therefore needs more than a shell exit code: it must preserve what was measured, which population was judged, why a bound exists, who owns it, what changed the result, how expensive the evaluation was, and which immutable tree received the verdict.

The assurance SDK keeps those semantics independent from presentation. Commander and MCP only normalize inputs. Package authors and CI hosts can use the same public functions without reconstructing policy in scripts.

## Declaration Vocabulary

Measurements support these built-in sources:

| Source            | Purpose                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `items`           | Count authoritative full item records matching status, type, tags, an exact metadata field, or a field `state` of `present`/`missing`.   |
| `dependency_kind` | Count typed relationship edges such as `blocked_by` or `verifies`; accepted aliases and canonical spellings measure the same population. |
| `graph`           | Select a numeric or labelled-set field from a public graph SDK result.                                                                   |
| `validate`        | Select a validator check status or numeric detail.                                                                                       |
| `health`          | Select a health check status, numeric detail, or labelled set.                                                                           |
| `history`         | Count immutable events by operation, author, harness, or model.                                                                          |
| `links`           | Count items with present or missing file, test, or documentation evidence.                                                               |
| `derived`         | Combine numeric measurements with deterministic arithmetic and cycle detection.                                                          |
| `provider`        | Delegate a measurement to an explicitly supplied host/package resolver.                                                                  |

`ASSURANCE_MEASUREMENT_SOURCE_KINDS` and `ASSURANCE_GATE_TRIGGERS` are the
public SDK constants for these closed vocabularies. Runtime validation rejects
missing arrays and unknown discriminants with `AssuranceMutationRefusalError`;
it never persists an unrecognized source or leaks an incidental JavaScript
property-access error. Hosts that generate forms or package schemas can obtain
the same values from `pm contracts --command assurance --json` under
`assurance_contracts`.

Each measurement may declare `max_cost`. Evaluation fails closed when the total abstract compute units exceed that ceiling. Every result reports units, scanned items, scanned history rows, provider calls, duration, population size, and contributors.

One workspace context memoizes identical graph operations and the shared
validate and health reports for its lifetime. A gate may therefore project many
fields from one authoritative audit snapshot without multiplying full-workspace
I/O or allowing concurrent assertions to observe different tracker states.

An `items` source with `field` must declare exactly one predicate: `equals` (including an explicit `null`) or `state`. `state: missing` treats an absent property, `null`, an empty string, or an empty array as missing; `state: present` selects the complement. Workspace evaluation loads full item metadata, so `files`, `tests`, and `docs` selectors measure stored evidence rather than a light projection that omitted those collections.

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

### Presets, derivation, and promotion

List the four built-in project shapes, preview one as ordinary declarations, or apply it atomically:

```bash
pm assurance presets
pm assurance presets software-delivery --owner pm-example
pm assurance apply software-delivery --owner pm-example \
  --message "Adopt the initial delivery evidence contract"
```

The preset creates measurements, assertions, and a gate in one audited transaction. Reapplying the same bundle is idempotent; an existing divergent id is refused rather than overwritten. The available shapes are `software-delivery`, `research`, `agent-evaluation`, and `operations`.

Self-derivation observes active items without writing anything. Each proposal reports its active scope, population size, and observed missing-evidence ceiling. Persistence requires the explicit `--apply` flag:

```bash
pm assurance derive --owner pm-example
pm assurance derive --owner pm-example --apply \
  --message "Accept the observed evidence baseline"
pm assurance promote derived-active-missing-tests-ceiling --enforcement warn
pm assurance promote derived-active-missing-tests-ceiling --enforcement block
```

Derived assertions start at `observe`. Promotion is exactly one step (`observe` to `warn`, then `warn` to `block`) and each transition is an ordinary audited declaration mutation. There is no automatic promotion and no privileged preset execution path.

## Extension Measurement Providers

An extension opens the measurement vocabulary through `api.registerAssuranceMeasurementProvider`. The registration declares stable keys, parameter types, a coarse `low`/`medium`/`high` cost class, network use, a host timeout, and a resolver. It requires the `services` capability; a network provider must also declare `permissions.network: true` in `manifest.json`.

This code-quality provider measures a local report without changing assertion or gate semantics:

```ts
import { readFile } from "node:fs/promises";
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerAssuranceMeasurementProvider({
      id: "coverage",
      keys: {
        lines: {
          value_type: "number",
          parameters: { report: { type: "string", required: true } },
        },
      },
      cost_class: "low",
      network: false,
      timeout_ms: 2_000,
      async resolve({ parameters }) {
        const report = JSON.parse(
          await readFile(String(parameters.report), "utf8"),
        ) as {
          total: { lines: { pct: number } };
        };
        return { value: report.total.lines.pct, population_size: 1, cost: 1 };
      },
    });
  },
});
```

An evaluation package can expose episode reward on the same surface:

```ts
api.registerAssuranceMeasurementProvider({
  id: "agent-eval",
  keys: {
    "mean-reward": {
      value_type: "number",
      parameters: { suite: { type: "string", required: true } },
    },
  },
  cost_class: "high",
  network: false,
  timeout_ms: 120_000,
  async resolve({ parameters }) {
    const result = await runFrozenEvaluation(String(parameters.suite));
    return {
      value: result.meanReward,
      population_size: result.episodes,
      cost: result.steps,
      contributors: result.regressedScenarioIds,
    };
  },
});
```

An external registry provider declares its network dependency explicitly:

```ts
api.registerAssuranceMeasurementProvider({
  id: "npm-registry",
  keys: {
    "dist-tag-count": {
      value_type: "number",
      parameters: { package: { type: "string", required: true } },
    },
  },
  cost_class: "medium",
  network: true,
  timeout_ms: 5_000,
  async resolve({ parameters }) {
    const name = encodeURIComponent(String(parameters.package));
    const response = await fetch(
      `https://registry.npmjs.org/-/package/${name}/dist-tags`,
    );
    if (!response.ok) throw new Error(`registry returned ${response.status}`);
    const tags = (await response.json()) as Record<string, string>;
    return { value: Object.keys(tags).length, population_size: 1, cost: 10 };
  },
});
```

The corresponding measurement is ordinary registry data:

```json
{
  "id": "published-tag-count",
  "source": {
    "kind": "provider",
    "provider": "npm-registry",
    "key": "dist-tag-count",
    "parameters": { "package": "@example/tool" }
  }
}
```

A provider-backed gate must opt into every provider and each trigger's execution envelope. Omission refuses provider execution:

```json
{
  "id": "release-readiness",
  "assertion_ids": ["published-tag-count-ceiling"],
  "triggers": ["ci", "scheduled"],
  "provider_policy": {
    "allowed_providers": ["npm-registry"],
    "triggers": {
      "ci": { "max_cost_class": "low", "allow_network": false },
      "scheduled": { "max_cost_class": "medium", "allow_network": true }
    }
  }
}
```

Before invocation the host verifies the provider allow-list, declared cost class, and network capability for the active trigger. It then validates key parameters and result shape, enforces the registered timeout, and charges the returned cost through the existing measurement ceiling. Extension tests must bind `PM_PATH` and `PM_GLOBAL_PATH` to temporary roots; never point provider fixtures at the repository tracker or a live service.

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

For direct host composition, use `evaluateMeasurement`, `evaluateAssuranceGate`, `createAssuranceWorkspaceContext`, the preset/derivation helpers, and the audited declaration/verdict helpers exported from `@unbrained/pm-cli/sdk`. Active extension registrations are discovered automatically. Embedding hosts may additionally pass stable resolver ids and matching `provider_capabilities` to `createAssuranceWorkspaceContext`; an absent resolver or capability fails loudly. The core evaluator bounds concurrent assertions and expression operands, and workspace history loading uses bounded concurrency; item-only callers can explicitly skip history and Git identity resolution.

Generic SDK and MCP dispatch use `action: "assurance"` with `subcommand` set to `list`, `show`, `put`, `remove`, `run`, `verdicts`, `presets`, `apply`, `derive`, or `promote`. Discover the current machine contract instead of copying parameter lists:

```bash
pm contracts --action assurance --schema-only --json
pm contracts --command assurance --flags-only --json
pm contracts --command assurance --json
```

Command-scoped contract output omits unrelated extension, governance,
relationship, and Commander-alias catalogs unless `--full` is requested. This
keeps the selected action schema and its assurance vocabularies complete under
the default output budget instead of truncating the very enum a caller needs.

## Verdict Contract

A gate emits one object containing:

- gate id, evaluated tree, trigger, timestamp, and dry-run status;
- overall `pass`, `warn`, or `block` plus stable exit code;
- every assertion's measurement, scope, population, observed value, structured bound, signed distance, enforcement, negative-control proof, cost, and contributors;
- every assertion's `measurement_definition_fingerprint`, a SHA-256 identity for the exact declaration that produced the observation;
- an aggregate compute receipt.

Dry runs never write history. Non-dry verdicts are immutable workspace audit events and remain queryable after ordinary registry changes. Verdict reads return newest entries first and default to a bounded result; use `--limit` to select up to 1,000 matching records. A blocking verdict exits non-zero; warnings and observations remain successful while preserving their failed assertion rows.

Verdicts persisted before definition fingerprints were introduced remain readable and are identifiable by the absence of `measurement_definition_fingerprint`. Registry mutations and verdict writes use the same explicit-author, configured-author, and detected-harness precedence as other SDK mutations; they do not manufacture an `unknown` author when a harness identity is available.

## Safety and Evolution

- Use stable lowercase ids; prose belongs in descriptions and mutation messages.
- Prefer saved measurements and derived arithmetic over duplicating queries in scripts.
- Give expensive graph, health, validate, or provider measurements explicit cost ceilings.
- Keep owner items and authorization Decisions linked into the project graph.
- Treat negative controls as part of the policy, not test decoration.
- Use `hold` unless a time-bounded guarantee has an explicit retirement rationale.
- Use `--dry-run` while authoring or tightening a gate, then persist a verdict against an immutable tree.
