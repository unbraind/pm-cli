# SDK Action and Boundary Conformance

Tracked by [pm-0834kq](../.agents/pm/issues/pm-0834kq.toon),
[pm-xpumg4](../.agents/pm/issues/pm-xpumg4.toon),
[pm-prsvjh](../.agents/pm/issues/pm-prsvjh.toon), and
[pm-rnl3sa](../.agents/pm/issues/pm-rnl3sa.toon).

## Agent Quick Context

- CLI command names are the source for the built-in SDK and MCP action vocabulary.
- `help`, `item`, and `packages` are explicit CLI-only presentation waivers.
- Extension and package lifecycle actions are generated from one nested verb list.
- A public action must have an in-process SDK handler and a strict parameter schema.
- CLI and MCP code may import an SDK module only when a published SDK entrypoint exports that module, unless it is in the shrinking private-module ratchet.
- Explicit intent token budgets derive row limits beyond default page caps and report the binding constraint.

## One Action Vocabulary

`PM_CORE_COMMAND_NAMES` declares built-in CLI commands.
`PM_TOOL_ACTIONS` is derived from that declaration, the three documented
CLI-only waivers, and `PM_EXTENSION_PACKAGE_ACTION_SUBCOMMANDS`. The same
array drives:

- `PmToolAction` and `runAction` dispatch coverage;
- the `pm_run` MCP action enum;
- strict action parameter schemas;
- flattened extension and package lifecycle aliases;
- CLI-to-SDK completeness analysis.

Use the public parity receipt when extending the command surface:

```ts
import {
  analyzePmToolActionParity,
  analyzeSdkActionCoverage,
} from "@unbrained/pm-cli/sdk";

const vocabulary = analyzePmToolActionParity();
const dispatch = analyzeSdkActionCoverage();

if (
  vocabulary.missing_cli_actions.length > 0 ||
  vocabulary.stale_waivers.length > 0 ||
  dispatch.some((row) => !row.covered)
) {
  throw new Error("pm action conformance failed");
}
```

Dedicated MCP tools reuse `NARROW_TOOL_ACTIONS` from their schema definitions.
They do not maintain a second server-side action map. `pm_events` therefore
reaches the same `events` SDK action as `pm_run`.

## SDK-First Operations

The generic action dispatcher covers the CLI vocabulary, including:

- relevance evaluation with `action: "eval"`;
- bounded mutation events with `action: "events"`;
- merge install, reconcile, report, and driver operations with `action: "merge"`;
- workspace snapshot create, list, inspect, restore, and delete with `action: "workspace"`;
- meeting, event, and reminder creation with `action: "meet"`, `"event"`, or `"remind"`.

Scheduling implementations live in `src/sdk/scheduling-shortcuts.ts`; the CLI
module is a compatibility export. Package authors can import `runMeet`,
`runEvent`, and `runRemind` from `@unbrained/pm-cli/sdk` without importing CLI
implementation modules.

## Public SDK Import Boundary

The static quality gate builds a closure from published SDK entrypoints and
their static export declarations. It then compares every CLI/MCP-to-SDK import
with that closure. Its report includes:

- `private_sdk_allowlist_count`;
- `new_private_sdk_imports`;
- `stale_private_sdk_allowlist`.

New private imports fail. An allowlisted module that is no longer imported also
fails so the ratchet must shrink. Export the required primitive from the
narrowest supported SDK entrypoint, update the public-surface snapshot, and
remove its allowlist entry.

## Intent Budget Diagnostics

An explicit token budget is an optimization control, not merely a truncation
ceiling. For row-oriented `list` and `search` intents, pm reports:

- `budget_derived_limit` at the result root and in `context_intent`;
- `binding_constraint` as `token_budget` or `explicit_limit`;
- `limit_reason` with the selection rationale.

Default intent budgets retain the ordinary page cap. Explicit budgets may
derive larger pages; recursive compaction and resumable cursor safeguards still
enforce the final serialized token ceiling.

## Package-Runner Invocation

The bootstrap normalizer accepts one leading published CLI bin token (`pm` or
`pm-cli`) in command position. This supports package-default invocations such
as:

```bash
npx --yes @unbrained/pm-cli@<version> pm --json --no-extensions contracts --summary
bunx --silent --bun @unbrained/pm-cli@<version> pm --json --no-extensions contracts --summary
```

Other leading tokens remain commands and fail normally. The published-release
verifier runs both package-default forms, their disambiguated-bin equivalents,
MCP initialization, and missing-command negative controls from isolated caches.

## Required Change Loop

When adding or renaming a built-in command:

1. update the CLI command contract and handler;
2. add the SDK action handler and strict parameter contract;
3. declare a reasoned CLI-only waiver only for a presentation namespace;
4. run action schema parity and the static boundary gate;
5. update SDK public-surface and generated contract snapshots;
6. verify a packed or published package through npm, npx, and bunx.
