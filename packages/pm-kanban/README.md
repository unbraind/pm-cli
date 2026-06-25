# @unbrained/pm-kanban

> Tracker: pm-a7o4 (epic pm-ugqx — extension & package platform maturity).

First-party **archetype exemplar** for pm. Where
[`pm-command-kit`](../pm-command-kit) shows the `commands` capability, this package
shows how to ship a *complete project-management archetype* — a profile plus its
live schema — as an installable pm package, using **public SDK primitives only**.

It adds a fourth archetype, **Kanban continuous flow**, alongside the three
core-baked profiles (`agile`, `ops`, `research`) without modifying core.

## What it demonstrates

| Surface | What the exemplar does |
| --- | --- |
| `api.registerItemTypes([...])` | Registers the `Card` flow item type (`folder: cards`, alias `kanban-card`) as a GLOBAL schema contribution. |
| `api.registerItemFields([...])` | Registers the flow fields `wip_limit` (number), `class_of_service` (string), and `impediment` (string). |
| `ProjectProfileDefinition` (`kanbanProfile`) | Exports the complete archetype — types, custom statuses (`doing`, `verifying`), fields, the `Card` workflow, offline search config, a `card` create template, and package recommendations — consumable by the SDK profile planner. |

## Install

```bash
pm install kanban --project
```

Installing the package activates its schema. Because item types and fields are
**global** contributions that built-in commands must see, `manifest.json`
deliberately declares no `activation.commands`: pm activates the package under its
conservative tier for every command, so the `Card` type is immediately usable.

## Usage

```bash
pm schema list                       # Card appears under extension item types
pm create "Wire up checkout" --type Card --field wip_limit=3 --field class_of_service=expedite
pm list --type Card
```

Extension-registered fields are set with the repeatable `--field name=value`
option (`pm create --help` lists it), keeping custom flow metadata on the item
without minting a bespoke flag per field.

### Staging the full archetype

The live schema (types/fields) is applied on install. The remaining profile
dimensions — custom statuses, search config, and the `card` template — are
described by `kanbanProfile` and staged the same way the built-in profiles are:

```bash
pm schema add-status doing --role active --alias wip
pm schema add-status verifying --role active --alias verify
pm config set search_provider bm25
pm config set search_max_results 30
```

SDK consumers can compute the idempotent diff programmatically:

```ts
import { planProfileApplication } from "@unbrained/pm-cli/sdk";
import { kanbanProfile } from "@unbrained/pm-kanban/extensions/kanban/index.ts";

const plan = planProfileApplication(kanbanProfile, currentState);
// plan.types / plan.statuses / plan.fields / plan.workflows / plan.config / plan.templates
```

## Package anatomy

```text
packages/pm-kanban/
├── package.json                  # pm resources: aliases, extensions, catalog, docs
├── README.md
└── extensions/kanban/
    ├── manifest.json             # capabilities, trusted, sandbox_profile, permissions
    └── index.ts                  # TypeScript source (type-only SDK imports)
```

Key conventions for authors:

- The extension ships **only TypeScript** (ADR pm-m1uz). `index.ts` imports
  *types only* from the published `@unbrained/pm-cli/sdk` specifier; type-only
  imports are erased, so the module loads without resolving the SDK at
  module-evaluation time when the package is copied into an installed tracker.
- The module's `manifest.capabilities` literal must match `manifest.json` exactly.
  Schema registrations (`registerItemTypes`/`registerItemFields`/`registerMigration`)
  declare the `schema` capability.
- A schema package **omits `activation.commands`** so its global item types and
  fields load for every command. (A package that also owns commands or importers
  lists those command paths in `activation.commands` for lazy activation.)
- This extension is pure compute (no fs/network/env/process access), so the
  manifest declares `"trusted": true`, `"sandbox_profile": "strict"`, and all six
  permission keys (`fs_read`, `fs_write`, `network`, `env_read`, `env_write`,
  `process_spawn`) as `false`.
- Unit tests validate every registration with public SDK helpers:
  `assertRegisteredItemType` and `assertRegisteredItemField` (via
  `createExtensionTestHarness`); the profile is exercised with
  `planProfileApplication`.
