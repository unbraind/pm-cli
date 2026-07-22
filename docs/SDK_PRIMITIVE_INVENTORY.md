# SDK Primitive Inventory

Tracked work: [pm-lodl](../.agents/pm/tasks/pm-lodl.toon), [pm-8778](../.agents/pm/tasks/pm-8778.toon), [pm-rjqr](../.agents/pm/features/pm-rjqr.toon), [pm-oslr](../.agents/pm/features/pm-oslr.toon), capstone [pm-9x6e](../.agents/pm/tasks/pm-9x6e.toon), parent [pm-usfg](../.agents/pm/epics/pm-usfg.toon).

This inventory records the completed SDK-first migration for the principle `project management = context management`.
CLI and MCP modules now import shared host services through `src/sdk/runtime-primitives.ts`; direct `src/core` imports, type-only edges, re-exports, and computed dynamic imports are unconditionally rejected by the static quality gate. There is no allowance file or ratchet escape hatch.

## Enforced Boundary

- Boundary scope: `src/cli.ts`, `src/cli/**`, `src/mcp.ts`, and `src/mcp/**`.
- Required private-edge count: zero.
- The retired ratchet ended at 48 CLI/MCP source modules and 407 private-core import edges before the capstone moved every remaining edge behind the public SDK seam.
- Type-only imports and re-exports are intentionally counted because they still expose presentation layers to private core contracts.
- Gate foundation: [pm-8778](../.agents/pm/tasks/pm-8778.toon); zero-boundary capstone: [pm-9x6e](../.agents/pm/tasks/pm-9x6e.toon).
- Rule: presentation code adds or extends an SDK primitive first; no CLI/MCP exception can be recorded.

## Public Presentation Runtime

`src/sdk/runtime-primitives.ts` is the curated low-level seam for presentation hosts. It exposes filesystem, schema, history, extension-runtime, telemetry, search, output, and storage services needed to compose the shipped CLI and MCP adapters. External integrations should still prefer typed `PmClient` and top-level SDK operations; runtime primitives exist for embedded hosts that need to build an equivalent presentation layer without private imports.

## Promotion Partition

| Promotion item | Primitive family | Primary private domains to promote |
| --- | --- | --- |
| [pm-98cz](../.agents/pm/features/pm-98cz.toon) | Item lifecycle | `core/item`, `core/store`, `core/lock`, mutation checkpoints |
| [pm-rjqr](../.agents/pm/features/pm-rjqr.toon) | Query and read | `core/search`, read projections, context/next/list/get aggregation |
| [pm-zwpp](../.agents/pm/features/pm-zwpp.toon) | Annotations and links | comments, notes, learnings, files, docs, deps, append metadata |
| [pm-3mna](../.agents/pm/features/pm-3mna.toon) | Workspace customization | `core/schema`, `core/config`, profiles, init presets |
| [pm-oxrw](../.agents/pm/features/pm-oxrw.toon) | Governance and maintenance | validate, health, gc, normalize, issue-code and remediation surfaces |
| [pm-4a7m](../.agents/pm/features/pm-4a7m.toon) | History maintenance | history read, redact, repair, compact, restore history replay |
| [pm-je50](../.agents/pm/features/pm-je50.toon) | Plan workflow | plan steps, dependencies, decisions, discoveries, validation, materialization |
| [pm-oslr](../.agents/pm/features/pm-oslr.toon) | Execution and diagnostics | linked-test running, test-run lifecycle, eval, telemetry stats/export |

## Command Family Map

| CLI/MCP source family | SDK destination | Notes |
| --- | --- | --- |
| `create`, `update`, `update-many`, `copy`, `delete`, `restore` | [pm-98cz](../.agents/pm/features/pm-98cz.toon) | Item CRUD and replay paths should become typed lifecycle SDK calls. |
| `claim`, `release`, `focus`, lifecycle shortcut helpers | [pm-98cz](../.agents/pm/features/pm-98cz.toon) | Ownership and actionable-state changes belong beside lifecycle primitives. |
| `list`, `get`, `search`, `context`, `next`, `aggregate`, `stats` | [pm-rjqr](../.agents/pm/features/pm-rjqr.toon) | `list` and `search` implementations now live under `src/sdk/query/**`; remaining read models should follow the same SDK-owned pattern. |
| `comments`, `notes`, `learnings`, `files`, `docs`, `deps`, `append` | [pm-zwpp](../.agents/pm/features/pm-zwpp.toon) | Annotation/link mutation semantics must be stable SDK primitives. |
| `schema`, `config`, `profile`, `init`, `init-agent-guidance` | [pm-3mna](../.agents/pm/features/pm-3mna.toon) | Universal customization requires programmatic schema, profile, and config APIs. |
| `history`, `activity`, `history-redact`, `history-repair`, `history-compact` | [pm-4a7m](../.agents/pm/features/pm-4a7m.toon) | Audited history read, activity, rewrite, and checkpoint operations need explicit public contracts. |
| `plan` | [pm-je50](../.agents/pm/features/pm-je50.toon) | Plan harness operations should be usable by external orchestrators through SDK calls. |
| `test`, `test-all`, `test-runs`, `eval`, `telemetry`, `stats` | [pm-oslr](../.agents/pm/features/pm-oslr.toon) | Implementations live under `src/sdk/test/**`, `src/sdk/eval.ts`, `src/sdk/telemetry.ts`, and `src/sdk/stats.ts`; CLI paths are compatibility exports with typed structured results. |
| `reindex` | [pm-rjqr](../.agents/pm/features/pm-rjqr.toon) / [pm-9x6e](../.agents/pm/tasks/pm-9x6e.toon) | Search-index refresh remains part of the query/read ownership and terminal boundary burn-down. |
| `extension`, `upgrade`, package lifecycle helpers | [pm-ugqx](../.agents/pm/epics/pm-ugqx.toon) | Existing package-author SDK surfaces stay public; package lifecycle can move behind SDK runtime helpers. |
| `src/mcp/**` | [pm-usfg](../.agents/pm/epics/pm-usfg.toon) | MCP tools should call SDK primitives directly once each family is promoted. |

## Boundary Workflow

1. Add or extend a typed primitive under `src/sdk`.
2. Consume it from CLI/MCP through an SDK module; never deep-import `src/core`.
3. Run `pnpm quality:static`; the gate must report `actual_edge_count: 0` and no unsupported dynamic imports.
4. Exercise both the public SDK contract and the presentation adapter in focused tests.
5. Link source, docs, tests, and evidence to the owning `pm` item.
