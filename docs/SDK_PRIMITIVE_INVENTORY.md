# SDK Primitive Inventory

Tracked work: [pm-lodl](../.agents/pm/tasks/pm-lodl.toon), [pm-8778](../.agents/pm/tasks/pm-8778.toon), parent [pm-usfg](../.agents/pm/epics/pm-usfg.toon).

This inventory is the current SDK-first migration map for the principle `project management = context management`.
The exact per-source CLI/MCP module inventory is checked in at [`scripts/release/sdk-import-boundary-baseline.json`](../scripts/release/sdk-import-boundary-baseline.json): each `allowed_private_core_imports[]` entry names one command, helper, or MCP source file and the private `src/core` modules it currently imports. The static quality gate reads that file and fails when `src/cli` or `src/mcp` adds a new private `src/core` import, uses a computed dynamic `import()` that cannot be ratcheted, or leaves a stale baseline entry after an import has been removed.

## Current Baseline

- Boundary scope: `src/cli.ts`, `src/cli/**`, `src/mcp.ts`, and `src/mcp/**`.
- Current scan size and private-edge counts are derived from [`scripts/release/sdk-import-boundary-baseline.json`](../scripts/release/sdk-import-boundary-baseline.json) and the `pnpm quality:static` ratchet output.
- Type-only imports and re-exports are intentionally counted because they still expose presentation layers to private core contracts.
- Baseline owner: [pm-8778](../.agents/pm/tasks/pm-8778.toon).
- Ratchet rule: SDK promotion PRs must shrink the baseline when they move a primitive behind `src/sdk`; no PR may grow it.

## Checked-In Per-Source Inventory

Use [`scripts/release/sdk-import-boundary-baseline.json`](../scripts/release/sdk-import-boundary-baseline.json) as the detailed inventory rather than duplicating every edge in Markdown. Command handlers map directly from the `source` field, for example `src/cli/commands/update.ts` inventories the update command's private core modules and `src/mcp/server.ts` inventories MCP server private core imports. Function-level ownership stays in the source modules themselves; this document maps each command family to its SDK promotion owner so the baseline can shrink without stale prose.

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
| `list`, `get`, `search`, `context`, `next`, `aggregate`, `stats` | [pm-rjqr](../.agents/pm/features/pm-rjqr.toon) | Read models should be reusable by CLI, MCP, and custom agents without shelling out. |
| `comments`, `notes`, `learnings`, `files`, `docs`, `deps`, `append` | [pm-zwpp](../.agents/pm/features/pm-zwpp.toon) | Annotation/link mutation semantics must be stable SDK primitives. |
| `schema`, `config`, `profile`, `init`, `init-agent-guidance` | [pm-3mna](../.agents/pm/features/pm-3mna.toon) | Universal customization requires programmatic schema, profile, and config APIs. |
| `history`, `activity`, `history-redact`, `history-repair`, `history-compact` | [pm-4a7m](../.agents/pm/features/pm-4a7m.toon) | Audited history read, activity, rewrite, and checkpoint operations need explicit public contracts. |
| `plan` | [pm-je50](../.agents/pm/features/pm-je50.toon) | Plan harness operations should be usable by external orchestrators through SDK calls. |
| `test`, `test-all`, `test-runs`, `eval`, `telemetry`, `reindex` | [pm-oslr](../.agents/pm/features/pm-oslr.toon) | Execution helpers should return typed run state and diagnostics instead of CLI-only text. |
| `extension`, `upgrade`, package lifecycle helpers | [pm-ugqx](../.agents/pm/epics/pm-ugqx.toon) | Existing package-author SDK surfaces stay public; package lifecycle can move behind SDK runtime helpers. |
| `src/mcp/**` | [pm-usfg](../.agents/pm/epics/pm-usfg.toon) | MCP tools should call SDK primitives directly once each family is promoted. |

## Ratchet Workflow

1. Promote one primitive family into `src/sdk`.
2. Move the relevant CLI/MCP handler calls from private `src/core` imports to SDK imports.
3. Regenerate `scripts/release/sdk-import-boundary-baseline.json` from the current tree.
4. Run `pnpm quality:static`; the gate must show no new private imports, no unsupported dynamic imports, and no stale baseline entries.
5. Link the changed source, docs, and tests back to the promotion item with `pm files`, `pm docs`, and `pm test`.
