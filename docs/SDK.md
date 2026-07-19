# SDK

The supported programmatic surface is `@unbrained/pm-cli/sdk`.

Use it for extension authoring, package authoring, command/action contract discovery, and deterministic app or CI automation. Do not import private `src/core/...` modules from external integrations or packages.

## Install

```bash
npm install @unbrained/pm-cli
```

The SDK ships inside the CLI package. There is no separate
`@unbrained/pm-sdk` package; package authors should depend on
`@unbrained/pm-cli` and import the public subpaths below.

The package installs `@types/node` as a runtime dependency (`>=22` matches the
runtime floor) because the shipped `.d.ts` reference Node globals and `node:*`
modules. A plain package install therefore gives strict TypeScript consumers
the declarations needed to compile the SDK without a hidden peer setup step.
Use `"moduleResolution": "node16"`, `"nodenext"`, or `"bundler"` so the
`exports`-mapped `./sdk` types resolve.

```bash
npm install --save-dev typescript
```

## Import Surfaces

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";
```

Supported package exports:

- `@unbrained/pm-cli/sdk` - stable extension and package authoring API plus CLI contract exports.
- `@unbrained/pm-cli/sdk/runtime` - runtime helpers for packages that need command implementations without private imports.
- `@unbrained/pm-cli/sdk/testing` - lightweight assertion helpers for package/extension tests.
- `@unbrained/pm-cli/cli` - runtime CLI module entrypoint for package resolution, not a typed library API.

## Public Exports

Source of truth:

- [`src/sdk/index.ts`](../src/sdk/index.ts)
- [`src/sdk/runtime.ts`](../src/sdk/runtime.ts)
- [`src/sdk/annotations.ts`](../src/sdk/annotations.ts)
- [`src/sdk/linked-artifacts.ts`](../src/sdk/linked-artifacts.ts)
- [`src/sdk/files.ts`](../src/sdk/files.ts)
- [`src/sdk/docs.ts`](../src/sdk/docs.ts)
- [`src/sdk/dependencies.ts`](../src/sdk/dependencies.ts)
- [`src/sdk/actionability.ts`](../src/sdk/actionability.ts)
- [`src/sdk/schema.ts`](../src/sdk/schema.ts)
- [`src/sdk/relationships.ts`](../src/sdk/relationships.ts)
- [`src/sdk/graph/index.ts`](../src/sdk/graph/index.ts)
- [`src/sdk/graph/assembly.ts`](../src/sdk/graph/assembly.ts)
- [`src/sdk/graph/traversal.ts`](../src/sdk/graph/traversal.ts)
- [`src/sdk/graph/analytics.ts`](../src/sdk/graph/analytics.ts)
- [`src/sdk/graph/governance.ts`](../src/sdk/graph/governance.ts)
- [`src/sdk/graph/remediation.ts`](../src/sdk/graph/remediation.ts)
- [`src/sdk/graph/cache.ts`](../src/sdk/graph/cache.ts)
- [`src/sdk/graph/run.ts`](../src/sdk/graph/run.ts)
- [`src/sdk/relationship-history.ts`](../src/sdk/relationship-history.ts)
- [`src/sdk/relationship-context.ts`](../src/sdk/relationship-context.ts)
- [`src/sdk/governance/validate.ts`](../src/sdk/governance/validate.ts)
- [`src/sdk/governance/health.ts`](../src/sdk/governance/health.ts)
- [`src/sdk/governance/gc.ts`](../src/sdk/governance/gc.ts)
- [`src/sdk/merge/index.ts`](../src/sdk/merge/index.ts)
- [`src/sdk/workspace-transaction-gc.ts`](../src/sdk/workspace-transaction-gc.ts)
- [`src/sdk/query/list.ts`](../src/sdk/query/list.ts)
- [`src/sdk/query/search.ts`](../src/sdk/query/search.ts)
- [`src/sdk/query/search-pagination.ts`](../src/sdk/query/search-pagination.ts)
- [`src/sdk/query/search-rendering.ts`](../src/sdk/query/search-rendering.ts)
- [`src/sdk/query/item-filter-options.ts`](../src/sdk/query/item-filter-options.ts)
- [`src/sdk/query/parsers.ts`](../src/sdk/query/parsers.ts)
- [`src/sdk/test/execution.ts`](../src/sdk/test/execution.ts)
- [`src/sdk/test/batch.ts`](../src/sdk/test/batch.ts)
- [`src/sdk/test/runs.ts`](../src/sdk/test/runs.ts)
- [`src/sdk/test/parsers.ts`](../src/sdk/test/parsers.ts)
- [`src/sdk/eval.ts`](../src/sdk/eval.ts)
- [`src/sdk/telemetry.ts`](../src/sdk/telemetry.ts)
- [`src/sdk/stats.ts`](../src/sdk/stats.ts)
- [`src/sdk/cli-contracts.ts`](../src/sdk/cli-contracts.ts)
- [`src/sdk/cli-bootstrap.ts`](../src/sdk/cli-bootstrap.ts)
- [`src/sdk/cli-contracts/commander-types.ts`](../src/sdk/cli-contracts/commander-types.ts)
- [`src/sdk/cli-contracts/commander-mutation-options.ts`](../src/sdk/cli-contracts/commander-mutation-options.ts)

Common authoring exports:

- `defineExtension`
- `composeExtension` / `deriveExtensionCapabilities`
- `mergeExtensionBlueprints` (combine partial blueprints into one for modular authoring)
- `composeExtensionPackage` (author-once capstone: returns both the module and its synthesized manifest)
- `synthesizeExtensionManifest` (generate a complete least-privilege manifest from a blueprint)
- `describeExtensionBlueprint` (static surface map of a blueprint) / `lintExtensionBlueprint` (author-time preflight)
- `renderExtensionSurfaceMarkdown` (render a describe summary to a drift-free Markdown reference doc for a package README)
- `checkExtensionManifestCompatibility` (author-time `pm_min_version`/`pm_max_version` check against a target pm version)
- `preflightExtension` (one-call capstone: lint + manifest synthesis + version-compat in a single consolidated report)
- `RESERVED_ITEM_FIELD_NAMES` (the shared runtime/authoring denylist); `lintExtensionBlueprint`, preflight, and the test harness reject blueprint item fields that shadow these metadata keys before publication
- `EXTENSION_CAPABILITIES`
- `EXTENSION_CAPABILITY_CONTRACT`
- `EXTENSION_CAPABILITY_CONTRACT_VERSION`
- `EXTENSION_CAPABILITY_LEGACY_ALIASES`
- `EXTENSION_POLICY_MODES`
- `EXTENSION_POLICY_SURFACES`
- `EXTENSION_TRUST_MODES`
- `EXTENSION_SANDBOX_PROFILES`
- `PM_CLI_EXPECTED_ERROR_NAME`
- `createPmCliExpectedError`
- `isPmCliExpectedError`
- `suppressHostOutput` / `isHostOutputSuppressed` / `SUPPRESS_HOST_OUTPUT_MARKER`
  for extension commands that already wrote streaming, binary, or otherwise
  pre-rendered output and must prevent a second host render

Registration builders (`define*`, zero-cost identity — see [Authoring Builders](#authoring-builders)):

- `defineCommand` / `defineFlag` / `defineItemType` / `defineItemField` / `defineMigration`
- `defineProjectProfile` (archetype bundle of types/statuses/fields/workflows/config/templates/packages — powers `pm profile`)
- `defineSearchProvider` / `defineVectorStoreAdapter`
- `defineCommandOverride` / `defineParserOverride` / `definePreflightOverride` / `defineServiceOverride` / `defineRendererOverride`
- `defineImporter` / `defineExporter`
- `defineBeforeCommandHook` / `defineAfterCommandHook` / `defineOnWriteHook` / `defineOnReadHook` / `defineOnIndexHook`

Project profiles:

- `defineProjectProfile` / `BUILTIN_PROFILES` / `PROFILE_NAMES` / `resolveProfile` / `listProfiles` / `normalizeProfileName`
- `describeProjectProfile` (pure composition summary — per-dimension counts plus resolved entry identifiers; the project-profile analogue of `describeExtensionBlueprint`) and `describeProfileComposition`
- `lintProjectProfile` (pure, tracker-independent author-time consistency check that grades findings `error`/`warning` across every dimension — invalid/duplicate types, statuses, fields; workflows governing undeclared types or referencing undeclared statuses; unknown/invalid config knobs; templates creating undeclared types; empty package specs) and its `ProjectProfileLintReport` / `ProjectProfileLintFinding` types
- `assertProjectProfile` (the throwing test counterpart: fails on any `error` finding, or on warnings too with `{ strict: true }` — the profile analogue of `assertExtensionBlueprint`)
- `planProfileApplication` (pure, idempotent diff of a profile against the current tracker state) and its `ProfileApplicationPlan` / `ProfileCurrentState` types
- The bundled [pm-kanban exemplar](../packages/pm-kanban/README.md) ships a complete archetype as an installable package: it registers the live schema (`Card` type + flow fields) and exports a `ProjectProfileDefinition` the planner can stage, all on public SDK primitives.

Author-time lifecycle: `defineProjectProfile` → `lintProjectProfile` / `assertProjectProfile` (validate before registering) → `api.registerProfile` → `describeProjectProfile` / `planProfileApplication` (preview) → `pm profile apply`. Validate a profile in a package test before it ships:

```ts
import { assertProjectProfile } from "@unbrained/pm-cli/sdk/testing";

assertProjectProfile(kanbanProfile); // throws on any error finding
```

Package manifest exports:

- `PM_PACKAGE_RESOURCE_KINDS` (`extensions`, `docs`, `examples`, `assets`, `prompts`)
- `PM_PACKAGE_CONVENTIONAL_RESOURCE_ROOTS`
- `readPmPackageManifest`
- `collectPackageExtensionDirectories`

Storage format-version exports (under `@unbrained/pm-cli/sdk/runtime`):

- `CURRENT_ITEM_FORMAT_VERSION` / `BASELINE_ITEM_FORMAT_VERSION`
- `effectiveItemFormatVersion` (resolve an item's stored version; absent means the baseline)
- `normalizeItemFormatVersion` (persisted form; the baseline is dropped so it is never serialized)
- `classifyItemFormatVersion` (`current` / `outdated` / `ahead`)
- `scanItemFormatVersions` (partition items into outdated/ahead reference lists)

Command/action contract exports:

- `PmClient` / `runAction` (high-level in-process action execution for custom tools, bots, CI, and embedded runtimes)
- Typed read primitives on `PmClient`: `get` (including `GetOptions.at` point-in-time reads), `list`, `search`, `context`, `next`, `aggregate`, and `stats`; direct `getItemAt` reconstructs a canonical historical document without mutation
- Read primitive option/result contracts: `GetOptions` / `GetResult`, `ListOptions` / `ListResult`, `SearchOptions` / `SearchResult`, `ContextOptions` / `ContextResult`, `NextOptions` / `NextResult`, `AggregateOptions` / `AggregateResult`, `StatsCommandOptions` / `StatsResult`
- Context relevance primitives: `buildItemContextRelevanceCandidates`, `defaultScoreContextCandidates`, `scoreContextCandidates`, `scoreContextCandidatesWithActiveExtensions`, `evaluateContextRanking`, `runContextEvaluationScenario`, `runContextEvaluationCorpus`, and `summarizeContextEvaluationReports`
- Context relevance contracts: `ContextRelevanceCandidate`, `ContextRelevanceSignals`, `ContextRelevanceScorer`, `ContextRelevanceReport`, `ContextEvaluationReader`, `ContextEvaluationScenario`, `ContextEvaluationScenarioReport`, `ContextEvaluationThresholds`, and `ContextEvaluationCorpusReport`
- Context packing and feedback primitives: `packContextCandidates`, `recordContextUsageServing`, `recordContextUsageTouch`, `recordContextUsageTouches`, and `readContextUsageAffinity`
- Typed annotation and relationship primitives on `PmClient`: `comments`, `notes`, `learnings`, `files`, `filesDiscover`, `docs`, `deps`, `graph`, and `append`
- Workspace graph-query runner: `runGraph` (with `GraphCommandOptions`, `GraphResult`, and per-subcommand envelopes) resolves the workspace relationship graph through the shared fingerprint-keyed cache and dispatches bounded `ancestors`/`descendants`/`predecessors`/`successors`/`paths`/`impact`/`analyze`/`audit`/`communities`/`redundancy`/`dominators`/`plan` queries with counts-first cost, truncation, and cache metadata; the `pm graph` CLI command and `pm_graph` MCP tool are thin adapters over it.
- Structural graph analytics: `detectRelationshipCommunities` (deterministic label-propagation clustering with `maxIterations`/`minSize` bounds and convergence reporting), `findRedundantRelationshipEdges` (transitive-reduction scan that joins each directed ordering or hierarchy kind with its inverse spelling and returns witness paths), and `computeRelationshipDominators` (Cooper–Harvey–Kennedy immediate dominators with per-node gating weights for bottleneck ranking) — all deterministic, cancellable, and cost-metered like every other graph query.
- Incremental graph cache: `WorkspaceGraphCache`, `workspaceGraphCache`, `resetWorkspaceGraphCache`, and `computeWorkspaceGraphFingerprint` reuse the assembled workspace graph and memoize deterministic query results under a fingerprint that digests every relationship-relevant item field (id, title, status and terminal classification, parent, legacy blocker, structured dependencies), so long-lived hosts stop paying full-workspace assembly per bounded query; `GraphCacheMetadata` reports assembly/result hit-or-miss on every `runGraph` envelope.
- Remediation planning: `planRelationshipRemediation` (with `RelationshipRemediationPlan`, `RelationshipRemediationStep`, and operation/confidence/code contracts) derives exact dry-run `remove`/`retype`/`supersede`/`waive`/`investigate` proposals from governance-audit findings and witnessed redundancy rows — evidence-backed, confidence-rated, and never auto-applied.
- Annotation and relationship option/result contracts: `CommentsCommandOptions` / `CommentsResult`, `NotesCommandOptions` / `NotesResult`, `LearningsCommandOptions` / `LearningsResult`, `FilesCommandOptions` / `FilesResult`, `FilesDiscoverOptions` / `FilesDiscoverResult`, `DocsCommandOptions` / `DocsResult`, `DepsCommandOptions` / `DepsResult`, `AppendCommandOptions` / `AppendResult`
- Annotation kernel primitives: `resolveAnnotationInput`, `runAnnotationCommand`, `resolveAnnotationIndex`, `parseAnnotationTextInput`, `limitAnnotationEntries`, `readAnnotationEntries`, `wrapOwnershipConflict`, `isErrnoError`, and their typed input/config/result contracts
- Linked-resource kernel primitives: `runFiles`, `runFilesDiscover`, `runDocs`, `runDeps`, `runLinkedArtifacts`, parsing/normalization/path-validation helpers, and their typed contracts. The CLI files/docs/deps modules are presentation-only re-exports of these SDK implementations.
- Actionability primitives: `collectBlockedByIds`, `resolveItemBlockers`, `collectDependencyBlockedIds`, and `computeActionabilityReport` expose the same edge-aware blocked/ready definition used by `pm next`, `pm context`, and `pm list-blocked`. Embedded schedulers can therefore classify custom lifecycle schemas without importing CLI or core modules.
- Dependency-governance primitives: `collectDanglingDependencyReferences`, `collectMissingDependencyTargetIds`, and `assembleWorkspaceRelationshipGraph` normalize hierarchy, scalar blockers, and structured dependencies into one graph while partitioning missing targets into actionable active holders, informational terminal-history holders, and the legacy `no-active-blocker` sentinel without mutating stored history.
- Relationship graph primitives: `RelationshipKindRegistry`, `createRelationshipKindRegistry`, `RelationshipGraph`, `RelationshipEventLog`, `RelationshipEventStore`, `buildRelationshipContext`, `buildDepsRelationshipContext`, `hierarchyAncestors`, `hierarchyDescendants`, `orderingPredecessors`, `orderingSuccessors`, `enumerateRelationshipPaths`, `auditWorkspaceRelationshipGraph`, `isOrderingRelationshipKind`, and `dependencyToRelationship` provide application-defined edge semantics, durable replay, bounded semantic traversal, policy-aware governance, and explainable context queries. `RelationshipEventLog.stream/project` and their durable-store equivalents page immutable prefixes and fold them into deterministic application state with exact version, processed-count, and as-of metadata. See [Relationship graph semantics](RELATIONSHIP_GRAPH.md).
- Atomic application transactions: `commitWorkspaceTransaction` coordinates ordered, idempotent item and relationship mutations under one workspace writer lock and a durable replay journal. Interrupted work resumes from step inspection; ordinary failures append reverse-order compensations without rewriting immutable histories.
- Multi-branch merge primitives: `mergeItemDocuments`, `mergeHistoryStreams`, `mergeRelationshipEventStreams`, `mergeJsonDocuments`, `runMergeDriver`, and `runMergeInstall` provide the same field-aware item, hash-chain-preserving history, sequence-renumbering relationship-event, and key-level configuration semantics as `pm merge`; `buildMergeAttributePatterns`, `refreshMergeAttributeFenceIfInstalled`, and `auditMergeAttributeFence` expose the fence coverage contract, the post-schema-mutation refresh, and the validate-side drift audit. See [Multi-Branch Merge Safety](MERGE_SAFETY.md).
- Typed mutation inputs (pm-x29o / GH-601): `PmCreateActionOptions`, `PmUpdateActionOptions`, and `PmCloseActionOptions` (`PmClientCloseActionOptions` on the client method) strip the permissive custom-field index signature from the executable command-option contracts, retaining their exact public keys and value types without a second hand-written shape; the free `create`/`update`/`close` functions and `PmClient` methods share those types. `PmUpdateManyActionOptions`, `PmCloseManyActionOptions`, and `OptionsFromContracts` cover flat action-contract composition. Field typos, object values, invalid scalar kinds, and MCP-only aliases on a `PmClient` command-option bag fail `tsc` under strict. Runtime-schema custom fields use the repeatable `field` option and `PmClient.run` remains the wide escape hatch. Projected list rows expose the typed `ListProjectedItemCore` fields (`row.id` is `string | undefined`, never `unknown`).
- Typed customization primitives on `PmClient`: `init`, `config`, `schema`, `schemaList`, `schemaShow`, `schemaAddType`, `schemaRemoveType`, `schemaAddStatus`, `schemaRemoveStatus`, `schemaAddField`, `schemaRemoveField`, `schemaListFields`, `schemaShowField`, `schemaApplyPreset`, `schemaInferTypes`, `schemaShowStatus`, `profile`, `profileList`, `profileShow`, `profileApply`, and `profileLint`
- Workspace-scaffold primitives: `ensurePmGitignore` and `getPmGitignoreBlock` let custom tools apply the same idempotent runtime/search cache policy as `pm init` without importing CLI internals.
- Customization primitive option/result contracts: `InitCommandOptions` / `InitResult`, `ConfigCommandOptions` / `ConfigResult`, `SchemaSubcommand` / `SchemaResult` / `SchemaInspectResult`, `SchemaListResult`, `SchemaShowResult`, `SchemaAddTypeResult`, `SchemaRemoveTypeResult`, `SchemaAddStatusResult`, `SchemaRemoveStatusResult`, `SchemaAddFieldResult`, `SchemaRemoveFieldResult`, `SchemaListFieldsResult`, `SchemaShowFieldResult`, `SchemaApplyPresetResult`, `SchemaAddTypeInferResult`, `SchemaShowStatusResult`, `ProfileSubcommand` / `ProfileResult`, `ProfileListResult`, `ProfileShowResult`, `ProfileApplyResult`, `ProfileLintResult`
- Typed governance and maintenance primitives on `PmClient`: `validate`, `health`, `gc`, `historyRedact`, `historyRepair`, `historyRepairAll`, `historyCompact`, and `historyCompactBulk`
- Governance and maintenance option/result contracts: `ValidateCommandOptions` / `ValidateResult`, `RunHealthOptions` / `HealthResult`, `GcCommandOptions` / `GcResult`, `HistoryRedactCommandOptions` / `HistoryRedactResult`, `HistoryRepairCommandOptions` / `HistoryRepairResult` / `HistoryRepairAllResult`, and `HistoryCompactCommandOptions` / `HistoryCompactResult` / `HistoryCompactBulkCommandOptions` / `HistoryCompactBulkResult`
- Direct governance engines: `runValidate`, `runHealth`, and `runGc` are public SDK exports used by the CLI compatibility adapters and by custom policy engines that already own `GlobalOptions`. Their structured results are identical to CLI JSON output; no shell process or private core import is required.
- Execution and diagnostics engines: `runTest`, `runLinkedTests`, `runTestAll`, `runStartBackgroundRun`, `runTestRunsList`, `runTestRunsStatus`, `runTestRunsLogs`, `runTestRunsStop`, `runTestRunsResume`, `runTestRunsWorker`, `runEval`, `runTelemetry`, and `runStats`. Their CLI modules are compatibility re-exports of SDK-owned implementations.
- Execution and diagnostics contracts: `TestCommandOptions` / `TestResult` / `TestRunResult`, `TestAllCommandOptions` / `TestAllResult`, `StartBackgroundRunCommandOptions` / `StartBackgroundRunResult`, `TestRuns*CommandOptions`, `EvalOptions` / `EvalResult`, `TelemetryCommandOptions` / `TelemetrySubcommand`, and `StatsCommandOptions` / `StatsResult`.
- Linked-test authoring primitives: `parseLinkedTestJsonEntries`, the `parseLinkedTest*` field parsers, `LINKED_TEST_PM_CONTEXT_MODE_VALUES`, `LINKED_TEST_PROTECTED_ENV_KEYS`, `classifyLinkedTestFailure`, `countFailureCategories`, and `summarizeContextPreflight` let custom hosts validate, execute, classify, and report linked tests without duplicating CLI policy.
- Typed plan workflow primitives on `PmClient`: `plan`, `planCreate`, `planShow`, `planAddStep`, `planUpdateStep`, `planCompleteStep`, `planBlockStep`, `planReorderStep`, `planRemoveStep`, `planLink`, `planUnlink`, `planDecision`, `planDiscovery`, `planValidation`, `planResume`, `planApprove`, and `planMaterialize`
- Plan contracts: `PlanSubcommand`, `PlanCommandOptions`, `PlanCommandResult`, `PlanResultPlan`, `PlanStepSummary`, `PlanShowDepth`, and `PlanTemplateName`
- Typed package and extension lifecycle primitives on `PmClient`: `extension`, `extensionList`, `extensionActivate`, `extensionDeactivate`, `package`, `packageList`, `packageInstall`, `packageUninstall`, `packageDoctor`, `packageManage`, `packageDescribe`, `packageReload`, `packageCatalog`, `packageActivate`, `packageDeactivate`, and `upgrade`
- Lifecycle primitive option/result contracts: `ExtensionCommandOptions` / `ExtensionCommandResult`, `PackageCommandOptions` / `PackageCommandResult`, `UpgradeCommandOptions` / `UpgradeResult`
- `PM_CORE_COMMAND_NAMES`
- `PM_TOOL_ACTIONS`
- `PM_TOOL_PARAMETERS_SCHEMA`
- `PM_PROVIDER_TOOL_PARAMETERS_SCHEMA`
- `PM_TOOL_ACTION_PARAMETER_CONTRACTS`

### Build an entire custom project tool

The [SDK-only custom-tool exemplar](examples/sdk-custom-tool/README.md)
is the acceptance reference for applications that use pm as a universal
context engine rather than as an extension host. It imports only
`@unbrained/pm-cli/sdk` and composes schema customization, custom workflow
statuses, lifecycle mutations, annotations, linked resources, dependency
graphs, bounded context, search, health, and validation into a standalone
domain CLI.

Copy its reusable client pattern when building a company workflow,
domain-specific tracker, VCS-like system, or other application whose durable
state and business rules fit pm's public primitives. Keep the executable layer
thin: domain logic belongs in a reusable SDK client, while argv parsing and
rendering stay at the edge.

Embedded hosts can also import the SDK-owned bootstrap normalization primitives
(`normalizeBootstrapInvocation`, `parseBootstrapGlobalOptions`, and related
contracts) when they intentionally expose pm-compatible argv. Every
`runPmCli()` call constructs a fresh Commander graph, so extension commands,
extension flags, and runtime schema options from one workspace cannot leak into
the next in-process invocation.

### Plan workflows

Custom tools can manage durable plans without shelling out or importing CLI internals. The typed façade uses the same engine and result envelopes as `pm plan` and MCP `pm_plan`:

```ts
import { PmClient } from "@unbrained/pm-cli/sdk";

const pm = new PmClient({ pmRoot, author: "planning-agent" });
await pm.schemaAddField("acceptance_owner", {
  type: "string",
  requiredOnCreate: true,
  requiredTypes: ["Task"],
});
const created = await pm.planCreate({
  title: "Ship governed workflow",
  step: ["Implement", "Verify"],
});
await pm.planUpdateStep(created.plan.id, "plan-step-001", {
  stepStatus: "in_progress",
});
const result = await pm.planMaterialize(created.plan.id, {
  steps: "all",
  materializeType: "Task",
  field: ["acceptance_owner=planning-agent"],
});
```

`field` is repeatable and forwards `name=value` pairs through normal schema-aware create validation for every materialized child. Required-on-create fields remain mandatory. Each `materialized` entry includes `id`, `title`, `type`, `parent`, `tags`, and `from_step`, so an agent can confirm the created work without extra `get` calls.

### Immutable history and rich item reads

Tracked: [pm-4a7m](../.agents/pm/features/pm-4a7m.toon),
[pm-hib1](../.agents/pm/features/pm-hib1.toon),
[pm-y4z5](../.agents/pm/issues/pm-y4z5.toon), and
[pm-x1g5](../.agents/pm/issues/pm-x1g5.toon).

History rewrite ownership lives in the SDK. The CLI `history-redact`,
`history-repair`, and `history-compact` modules are thin compatibility shims
over `runHistoryRedact`, `runHistoryRepair` / `runHistoryRepairAll`, and
`runHistoryCompact` / `runHistoryCompactBulk`. Applications normally use the
typed `PmClient` methods (or matching top-level `historyRedact`,
`historyRepair`, `historyRepairAll`, `historyCompact`, and
`historyCompactBulk` helpers), while package authors can call the `run*`
primitives when they already own `GlobalOptions`.

```ts
import { PmClient, getItemAt } from "@unbrained/pm-cli/sdk";

const pm = new PmClient({ pmRoot, author: "records-agent" });

// Normal get projection, reconstructed at a one-based version.
const historical = await pm.get(itemId, {
  at: "7",
  fields: "id,title,status,body",
});
// historical.reconstructed === true
// historical.as_of_version === 7

// Direct canonical document primitive for a custom provenance/VCS interface.
const snapshot = await getItemAt(itemId, "2026-07-01T12:00:00.000Z", {
  pmRoot,
});

await pm.historyRedact(itemId, {
  literal: ["private.example"],
  replacement: "[redacted-host]",
  dryRun: true,
});
await pm.historyRepairAll({ dryRun: true });
await pm.historyCompactBulk({
  scope: "closed",
  allOver: 500,
  dryRun: true,
});
```

`getItemAt` and restore share `resolveHistoryTarget`, `applyHistoryPatch`, and
`replayHistoryToTarget`: every patch is normalized, applied strictly, and
checked against the recorded before/after hashes. The read primitive never
acquires a lock, rewrites an item, appends history, or mutates a derived index.
It returns the canonical `ItemDocument` plus `reconstructed`,
`as_of_version`, `as_of_timestamp`, normalized target metadata, and the current
stream length. Invalid and future targets throw `PmCliError` with a structured
`context.valid_range`.

The shared resolver accepts explicit caller policy: immutable reads reject
timestamps after the final recorded entry, while restore preserves
latest-entry-at-or-before semantics so a current wall-clock timestamp restores
the latest available state. Restore also retains command-specific diagnostics.

Generic reads also expose two composable SDK facets:

- `buildItemSchedule` normalizes deadlines, reminders, and events into a stable
  schedule projection with convenient earliest-event `start_at`, `end_at`, and
  `location` aliases. `pm get` includes it at standard/deep depth and supports
  narrow fields such as `schedule.start_at`.
- `buildItemChildrenRollup` accepts metadata supplied by the persistent derived
  index or a source scan and returns type-agnostic direct-child totals, active
  counts, status groups, a deterministic id-sorted sample, and explicit
  truncation/continuation metadata. The primitive caps input at
  `MAX_CHILD_PROJECTION_ITEMS` (one million) and never guesses which schema
  types are containers.

The CLI automatically computes that workspace projection for container-oriented
built-ins and custom types. Built-in leaf reads stay constant-cost unless the
caller explicitly projects `children`; SDK consumers remain fully type-agnostic.

### Linked resources and dependency governance

Tracked: [pm-jcvg](../.agents/pm/tasks/pm-jcvg.toon),
[pm-2ler](../.agents/pm/issues/pm-2ler.toon),
[pm-chyh](../.agents/pm/issues/pm-chyh.toon), and
[pm-p9sc](../.agents/pm/issues/pm-p9sc.toon).

Custom tools can use the same domain primitives as the CLI without dispatching a
command action. The direct functions accept the typed command options plus a
`GlobalOptions` tracker path, while `PmClient` remains the ergonomic façade for
applications that want shared workspace/author defaults:

The example assumes the host application already provides `id`, `pmRoot`,
`items`, and its schema-aware `terminalStatuses` set.

```ts
import {
  PmClient,
  collectDanglingDependencyReferences,
  runDeps,
  runDocs,
  runFiles,
} from "@unbrained/pm-cli/sdk";

await runFiles(
  id,
  { add: ["src/domain.ts"], note: "implementation" },
  { path: pmRoot },
);
await runDocs(id, { add: ["docs/domain.md"] }, { path: pmRoot });
const graph = await runDeps(id, { format: "graph" }, { path: pmRoot });

const pm = new PmClient({ pmRoot, author: "integration-agent" });
await pm.filesDiscover(id, { apply: true });

const references = collectDanglingDependencyReferences(items, (status) =>
  terminalStatuses.has(status),
);
// references.active gates work; references.legacy_terminal is historical debt.
```

Local file and documentation paths have one storage contract: relative inputs
are resolved from the invocation directory and stored relative to the workspace
that owns `.agents/pm`. Absolute paths and remote references stay absolute.
Globs, discovery, removal, and `validatePaths` use the same anchoring rule, so a
tool invoked from a nested package never records a path that changes meaning
when another agent runs from the repository root. Root-layout trackers use the
tracker directory itself as their workspace.

`runDeps` also projects missing `parent` and legacy `blocked_by` references as
typed missing edges, alongside structured dependencies. Tree, graph, and
summary output therefore share the same relationship-integrity view.

`pm validate --check-lifecycle` uses the same classification. Its
`dependency_references` check warns only when
`active_dangling_reference_count` is non-zero. Terminal-holder debt is reported
under `legacy_terminal_dangling_reference_count` and receives no mutation hint,
so an agent is never told to rewrite a closed item merely to silence validation.
The backward-compatible `dangling_reference_count` remains the total of active
and terminal-holder rows; use the explicit active field for gating.
`no_active_blocker_sentinel_count` separately identifies the legacy scalar
sentinel rather than presenting it as a mistyped pm id.

Testing helper exports (also under `@unbrained/pm-cli/sdk/testing`):

- `createExtensionTestHarness`
- `activateExtensionForTest`
- `deactivateExtensionForTest`
- `runRegisteredCommandForTest`
- `runRegisteredHookForTest`
- `runRegisteredParserOverrideForTest`
- `runRegisteredPreflightOverrideForTest`
- `runRegisteredCommandOverrideForTest`
- `runRegisteredRendererOverrideForTest`
- `runRegisteredServiceOverrideForTest`
- `runRegisteredSearchProviderForTest`
- `runRegisteredVectorStoreAdapterForTest`
- `runRegisteredMigrationForTest`
- `runRegisteredImporterForTest`
- `runRegisteredExporterForTest`
- `assertExtensionDeactivated`
- `assertPackageManifest`
- `assertRegisteredCommandContract`
- `assertRegisteredFlags`
- `assertRegisteredCommandOverride`
- `assertRegisteredParserOverride`
- `assertRegisteredPreflightOverride`
- `assertRegisteredRendererOverride`
- `assertRegisteredHook`
- `assertRegisteredSearchProvider`
- `assertRegisteredImporter`
- `assertRegisteredExporter`
- `assertRegisteredVectorStoreAdapter`
- `assertRegisteredItemField`
- `assertRegisteredItemType`
- `assertRegisteredProfile`
- `assertRegisteredServiceOverride`
- `assertRegisteredMigration`
- `assertExtensionCapabilityUsage`
- `assertExtensionBlueprint` (throwing preflight; pairs with `lintExtensionBlueprint`)
- `assertExtensionManifestMatchesBlueprint` (strict manifest↔blueprint capability guard)
- `assertExtensionManifestCompatible` (throwing version-bound guard; pairs with `checkExtensionManifestCompatibility`)
- `assertExtensionPreflight` (one-line throwing capstone over `preflightExtension`; replaces chaining the three asserts above)
- `describeExtensionActivation`
- `describeExtensionBlueprint` / `lintExtensionBlueprint` (also surfaced here for the full author → describe → preflight → test loop)
- `renderExtensionSurfaceMarkdown` (render the describe summary to a drift-free Markdown reference; powers `describe --markdown`)

`createExtensionTestHarness(module, options)` is the recommended entry point and
the ergonomic capstone over every standalone helper below: it activates the
module once and returns a fluent `ExtensionTestHarness` whose `assert*`/`run*`
methods are pre-bound to the correct activation sub-registry, so a package author
never threads `activation.registrations` vs `activation.commands` vs
`activation.hooks` (etc.) by hand — picking the wrong one is a common footgun that
surfaces as a confusing `available: (none)` error. Write
`const ext = await createExtensionTestHarness(module, { capabilities: ["commands"] })`,
then `ext.assertCommandContract({ command })`, `await ext.runCommand({ command })`,
`ext.activationSummary()`, `ext.renderMarkdown({ title: "My package" })`, and
`await ext.deactivate()`. `activationSummary()` returns the same
`ExtensionActivationSummary` as `describeExtensionActivation(ext.activation)`;
`renderMarkdown()` feeds that summary through `renderExtensionSurfaceMarkdown`,
with an optional `extensionName` filter for scoped package docs. The methods do
not use `this`, so they remain safe to destructure
(`const { runCommand, renderMarkdown } = ext;`), and the raw `ext.activation`
stays public as an escape hatch to the standalone helpers for any surface a
convenience method does not cover.

`assertExtensionCapabilityUsage(activation, { declared })` is the least-privilege
counterpart of the per-surface `assertRegistered*` helpers: pass the same
capabilities as your `manifest.capabilities` and it fails the test when the
manifest grants a capability the extension never registers against. Use
`allowUnused` for capabilities a runtime registers only behind a config flag.

`deactivateExtensionForTest(module, options)` is the teardown counterpart to
`activateExtensionForTest`: it runs pm's real `deactivateExtensions` engine
(including the bounded per-hook timeout and best-effort failure capture) over the
module and returns the `ExtensionDeactivationResult`, so a package can prove its
`deactivate` releases the resources `activate` opened. `assertExtensionDeactivated(result)`
asserts the single-extension happy path (one extension deactivated, none failed)
by default; pass `{ deactivated, failed }` to assert other counts. Forward the
`activation` result and `deactivateTimeoutMs` to mirror real host teardown.

`runRegisteredCommandForTest(activation.commands, { command, args, options, global, pmRoot })`
is the "invoke" verb that completes the package-author testing loop —
`activateExtensionForTest` → `assertRegisteredCommandContract` → **run** →
`deactivateExtensionForTest`. It dispatches a registered command handler through
pm's real engine and returns the `CommandHandlerResult`, so a test can assert
_behavior_ (`result.result`) rather than only that the command is wired. The
`CommandHandlerContext` is built with agent-safe global defaults
(`{ json: true, quiet: true, noPager: true }`) that callers may override. A clean
run yields `{ handled: true, result, warnings: [] }`; a handler that throws a
non-exit error yields `{ handled: false, warnings: [code], errorMessage }` so the
failure can be asserted, while one that throws an error carrying a numeric
`exitCode` propagates the throw. An unregistered command throws a descriptive
error listing the available handler command paths. Because
`registerImporter`/`registerExporter` register handlers under `"<name> import"` /
`"<name> export"`, the same helper exercises importer and exporter handlers too.

Production command contexts also expose `sdk`: a host-bound native-action
`PmClient`, point-in-time `getItemAt`, and durable relationship-store factory.
The host client deliberately reuses the current extension activation instead of
recursively loading packages, preserving registered schema while avoiding
activation-queue re-entry.

The remaining runtime surfaces an extension can register have matching invoke
helpers, so the "invoke" verb covers the whole command pipeline — not just
command handlers:

- `runRegisteredHookForTest(activation.hooks, { kind, context })` fires every
  registered lifecycle hook of a `kind` (`before_command` | `after_command` |
  `on_read` | `on_write` | `on_index`) through pm's real hook runner and returns
  the warnings array (`[]` = clean; a thrown hook contributes one
  `extension_hook_failed:*` warning while the others still run). The `context` is
  type-safe per `kind`.
- `runRegisteredParserOverrideForTest(activation.parsers, context)` returns the
  rewritten `ParserOverrideResult` (args/options/global the override produces
  before dispatch).
- `runRegisteredPreflightOverrideForTest(activation.preflight, context)` returns
  the `PreflightOverrideResult` (the migration/format gate decision).
- `runRegisteredCommandOverrideForTest(activation.commands, context)` returns the
  `CommandOverrideResult` (the transformed command result payload).
- `runRegisteredRendererOverrideForTest(activation.renderers, context)` returns
  the `RendererOverrideResult` (the custom string rendered for an output format).
- `runRegisteredServiceOverrideForTest(activation.services, context)` returns the
  `ServiceOverrideResult` (how the override handles an internal service payload).

Each override helper guards that a matching override is registered for the target
(command / format / service), so a typo surfaces as a descriptive error rather
than a silent `overridden: false` / `handled: false`.

The _executable registration_ surfaces — search providers, vector store
adapters, schema migrations, importers, and exporters — also have invoke helpers,
so every executable register\* method has both an `assertRegistered*` and a
`runRegistered*ForTest` counterpart. Each exercises the real registered behavior,
not a re-implementation, but along two execution paths that mirror how the host
runs them. Providers, adapters, and migrations are resolved through the same
runtime resolver the host uses and invoked via their `runtime_definition` (the
clone that preserves live functions). Importers and exporters have no standalone
`runtime_definition` — `registerImporter`/`registerExporter` wrap their handler
into a command path, so their helpers resolve by name and dispatch through the
command runner instead, returning a `CommandHandlerResult`:

- `runRegisteredSearchProviderForTest(activation.registrations, { provider, operation, context })`
  resolves a registered provider by name (case-insensitive, last registration
  wins) and invokes one `operation` — `query`, `embed`, `embedBatch`,
  `queryExpansion`, or `rerank` — returning that operation's result. The
  `context` and return type are inferred from `operation`, and the camelCase /
  snake_case spellings the host accepts (`embedBatch`/`embed_batch`,
  `queryExpansion`/`query_expansion`) both resolve.
- `runRegisteredVectorStoreAdapterForTest(activation.registrations, { adapter, operation, context })`
  resolves a registered adapter by name and invokes `query` (returns
  `VectorStoreQueryHit[]`), `upsert`, or `delete`.
- `runRegisteredMigrationForTest(activation.registrations, { migration, extensionName?, pmRoot? })`
  resolves a registered migration by id and invokes its `run` with a context
  mirroring the host's (`command: "migration"`, the registering extension's
  layer/name, the supplied `pmRoot`, and the migration's normalized status),
  returning whatever `run` returns. Unlike the host — which skips applied
  migrations and folds a throw into a warning — it always invokes `run` and lets a
  throw propagate, so both success and failure are assertable.
- `runRegisteredImporterForTest(activation, { importer, extensionName?, args?, options?, global?, pmRoot? })`
  and `runRegisteredExporterForTest(activation, { exporter, ... })` resolve a
  registered importer/exporter by name, derive the `"<name> import"` /
  `"<name> export"` command path internally — so authors never hand-build it — and
  validate that the name is genuinely a registered importer/exporter before
  dispatching. They take the whole `activation` because resolution spans two
  sub-registries (`registrations` proves it exists, `commands` holds the wrapped
  handler), and they return the command runner's `CommandHandlerResult` verbatim,
  so `handled`/`warnings`/`errorMessage` semantics and `exitCode` propagation match
  invoking the importer/exporter as a command.

Each surface helper guards that the named provider / adapter / migration /
importer / exporter is registered (and, for providers and adapters, implements the
requested operation), so a typo surfaces as a descriptive error rather than a
silent no-op. All invoke helpers are `async`, so a test always `await`s them.

`describeExtensionActivation(activation, { extensionName })` is the **describe**
(enumerate-all) verb that complements the `assertRegistered*` (verify-one) and
`runRegistered*ForTest` (invoke-one) helpers. The activation result already
carries per-surface _counts_; this returns the _names_. It walks every
sub-registry once and returns a flat `ExtensionActivationSummary` whose arrays
are de-duplicated and locale-sorted (except `hooks`, emitted in canonical
lifecycle order to mirror `hook_counts`) of every registered surface's
identifiers — command paths, hook kinds, item-type /
field names, migration ids, importer / exporter / provider / adapter names,
overridden service names and renderer formats, flag target-commands, and the
preflight-override count — plus the `capabilities` those surfaces exercise. Two
uses:

```ts
import { describeExtensionActivation } from "@unbrained/pm-cli/sdk/testing";

const summary = describeExtensionActivation(activation);
// Least-privilege check: assert the WHOLE registration surface in one deepEqual.
assert.deepEqual(summary.commands, ["greet hello"]);
assert.deepEqual(summary.hooks, ["after_command"]);
assert.deepEqual(summary.capabilities, ["commands", "hooks"]);
```

Without `extensionName` the summary unions every extension in the activation;
with it (matched case-insensitively after trimming, like
`collectUsedExtensionCapabilities`) only that extension's registrations
contribute. The three command fields capture distinct dimensions and can
overlap: `commands` lists definitions declared via `registerCommand(definition)`,
`command_handlers` lists every command path backed by an extension handler (a
superset that also includes the synthesized `"<name> import"` / `"<name> export"`
importer/exporter paths), and `command_overrides` lists built-in commands
replaced via `registerCommand(name, override)`. For agents, one call returns the
entire surface instead of traversing fifteen-plus sub-registries — keeping the context
window lean ("project management = context management").

The same verb is reachable from the CLI and MCP without writing a test:
`pm extension describe [name]` / `pm package describe [name]` (and `pm_run` with
`action: "extension"`/`"package"` and `describe: true`) activate the workspace's
extensions and return each loaded extension's `ExtensionActivationSummary` under
`details.extensions[].surfaces`, plus a deduplicated `details.union`. Omit the name
to map every loaded package; pass one to scope to it. This is the agent-facing answer
to "what does this installed package add to my context?" — distinct from
`pm package doctor` (errors/policy) and `pm package manage` (update metadata), which
report only command/action paths, not the full registration surface.

`renderExtensionSurfaceMarkdown(summary, options?)` is the **render** leg of the
describe verb: it projects any `ExtensionActivationSummary` to a deterministic
Markdown reference document — a title heading, a one-line capabilities summary,
and a section per registered surface. Pipe `describeExtensionBlueprint(blueprint)`
straight into it during a build or test step and embed the result in your
README, and the "commands & capabilities" reference can never drift from the
surface the loader actually registers ("project management = context
management"). `options.title` / `options.headingLevel` (an integer in `[1, 6]`,
default `2`; section headings render one level deeper) control nesting, and
`options.includeEmpty` renders every section (as `_None._`) rather than omitting
empty ones.

```ts
import {
  describeExtensionBlueprint,
  renderExtensionSurfaceMarkdown,
} from "@unbrained/pm-cli/sdk";

const reference = renderExtensionSurfaceMarkdown(
  describeExtensionBlueprint(blueprint),
  { title: "my-pkg", headingLevel: 2 },
);
// → "## my-pkg\n\nCapabilities: `commands`, `schema`\n\n### Commands\n\n- `greet hello`\n…"
```

The same renderer powers `pm extension describe --markdown` / `pm package
describe --markdown`, which compose a per-extension section plus a union section
across every loaded extension. Add `--output docs/package-reference.md` to write
the generated Markdown directly to a file for README/reference-doc refreshes.
`--markdown` is a presentation format (it cannot be combined with `--json`);
MCP `describe` keeps returning the structured summary, which a caller can hand to
`renderExtensionSurfaceMarkdown` itself.

Commander option contract exports:

- `CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS`
- `UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS`
- `CREATE_COMMANDER_STRING_OPTION_CONTRACTS`
- `CREATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS`
- `UPDATE_COMMANDER_STRING_OPTION_CONTRACTS`
- `UPDATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS`
- `LIST_COMMANDER_STRING_OPTION_CONTRACTS`
- `SEARCH_COMMANDER_STRING_OPTION_CONTRACTS`
- `CALENDAR_COMMANDER_STRING_OPTION_CONTRACTS`
- `CONTEXT_COMMANDER_STRING_OPTION_CONTRACTS`
- `ACTIVITY_COMMANDER_STRING_OPTION_CONTRACTS`
- `readFirstStringFromCommanderOptions`
- `readStringArrayFromCommanderOptions`

Extension runtime contract exports:

- `PM_EXTENSION_CAPABILITY_CONTRACTS`
- `PM_EXTENSION_SERVICE_NAME_CONTRACTS`
- `PM_EXTENSION_POLICY_MODE_CONTRACTS`
- `PM_EXTENSION_POLICY_SURFACE_CONTRACTS`
- `PM_EXTENSION_TRUST_MODE_CONTRACTS`
- `PM_EXTENSION_SANDBOX_PROFILE_CONTRACTS`

Least-privilege capability reconciliation exports (map declared capabilities to
the registration surfaces a package actually exercises at activation):

- `EXTENSION_CAPABILITY_REGISTRATION_SURFACES`
- `collectUsedExtensionCapabilities`
- `reconcileExtensionCapabilityUsage`

Common types:

- `ExtensionApi`
- `ExtensionActivationSummary`
- `ExtensionManifest`
- `ExtensionManifestEngines`
- `CommandDefinition`
- `FlagDefinition`
- `ImportExportRegistrationOptions`
- `ServiceOverrideContext`
- `PmCliExpectedError`
- `CreatePmCliExpectedErrorOptions`
- `SchemaFieldDefinition`
- `SchemaItemTypeDefinition`
- `SearchProviderDefinition`
- `VectorStoreAdapterDefinition`
- `GlobalOptions`
- `ItemDocument`
- `PmSettings`

## Static And Runtime Contracts

`PM_TOOL_ACTIONS` and `PM_TOOL_PARAMETERS_SCHEMA` describe the always-on static core action surface. They include core project-management primitives, package lifecycle actions, and `upgrade`.

Package-owned actions such as `beads-import`, `todos-export`, `calendar`, and `templates-save` are intentionally not advertised as static core actions. Discover installed package actions with runtime contracts:

```bash
pm contracts --runtime-only --json
pm contracts --action calendar --runtime-only --schema-only --json
pm contracts --command templates --runtime-only --flags-only --json
```

Use static SDK contracts for baseline validation, then use runtime contracts in the target project before invoking package-provided commands or actions. Embedded SDK consumers can avoid subprocesses:

```ts
import { getContracts } from "@unbrained/pm-cli/sdk";

const contracts = await getContracts("/path/to/project/.agents/pm", {
  runtimeOnly: true,
  flagsOnly: true,
});
```

To execute pm from an embedded tool without spawning `pm`, use `PmClient` (or
the lower-level `runAction`) from `@unbrained/pm-cli/sdk/runtime`. It uses the
same compact, extension-aware dispatcher as the MCP `pm_run` tool:

```ts
import { PmClient, runAction } from "@unbrained/pm-cli/sdk/runtime";

const pm = new PmClient({
  pmRoot: "/path/to/project/.agents/pm",
  author: "ci-agent",
});

const created = await pm.create({
  title: "Investigate release drift",
  type: "Task",
  status: "open",
  createMode: "progressive",
});
await pm.claim(created.item.id, { author: "ci-agent" });
await pm.update(created.item.id, { status: "in_progress" });
const open = await pm.list({ status: "open", limit: "20" });
const recommendation = await pm.next({ readyOnly: true });
const grouped = await pm.aggregate({ groupBy: "status", count: true });
const stats = await pm.stats({ metadataCoverage: true });
await pm.comments(created.item.id, { add: "Investigation context captured." });
await pm.files(created.item.id, { add: ["src/index.ts"], note: "entrypoint" });
await pm.docs(created.item.id, {
  add: ["docs/SDK.md"],
  note: "authoring reference",
});
const graph = await pm.deps(created.item.id, {
  format: "context",
  maxDepth: 3,
  nodeLimit: 20,
  edgeLimit: 40,
  tokenBudget: 800,
});
const types = await pm.schemaList();
const profiles = await pm.profileList();
const validation = await pm.validate({ checkResolution: true });
const health = await pm.health({ checkOnly: true, summary: true });
const packages = await pm.packageList({ project: true });
const doctor = await pm.packageDoctor({ project: true, isolated: true });
const plannedUpgrade = await pm.upgrade(undefined, {
  dryRun: true,
  cliOnly: true,
});

await runAction({
  action: "context",
  path: "/path/to/project/.agents/pm",
  options: { limit: "10" },
});
```

Mutation convenience methods default to compact changed-field output for agent
efficiency. Pass `fullChangedFields: true` alongside the command options when an
embedded SDK consumer needs the full `changed_fields` array.

Read convenience methods and the matching top-level read functions (`get`,
`list`, `search`, `context`, `next`, `aggregate`, `stats`) are foundational
SDK PM primitives: they return the same structured data the CLI/MCP surfaces
use, but with stable TypeScript contracts exported from
`@unbrained/pm-cli/sdk` and `@unbrained/pm-cli/sdk/runtime`. Use them instead of
spawning `pm get`, `pm list`, `pm search`, `pm context`, `pm next`,
`pm aggregate`, or `pm stats` when building a custom project-management tool, CI
integration, or agent runtime. Presentation stays outside the SDK primitive:
callers choose their own rendering while the data shape remains shared with the
CLI.

The `next` result excludes the recommended item from the `ready` tail, assigns
stable one-based ranks, reports foreign-owned work in `held_by_others`, and
treats dangling dependency ids as unresolved blockers. Human-gated decisions
remain visible in `decision_needed` but stay outside the agent-ready queue unless
the caller explicitly opts in. `PmClient.claimNext()` and top-level `claimNext()`
compose the same ranking result and atomic claim mutation, accept the next-work
filters, and bound the race-loss candidate walk with `maxAttempts` (1 through
100 inclusive), so custom SDK
tools do not need to reproduce CLI concurrency policy.

Lifecycle convenience methods and the matching top-level functions (`create`,
`update`, `close`, `claim`, `release`, `copy`, `deleteItem`, `restore`,
`focus`, `startTask`, `pauseTask`, and `closeTask`) use the same mutation paths
as the CLI and MCP dispatcher. They are the baseline primitives for custom PM
tools that need to own item state without spawning `pm`.

### Atomic workspace transactions

Tracked by [pm-4e12](../.agents/pm/features/pm-4e12.toon), with the VCS
acceptance story [pm-8ngt](../.agents/pm/stories/pm-8ngt.toon).

`commitWorkspaceTransaction` is the public unit-of-work primitive for domain
commands that must coordinate several SDK mutations. A plan supplies a stable
transaction id plus ordered steps. Each step can inspect its durable state,
apply an idempotent forward mutation, and append an idempotent compensation.
The coordinator serializes transaction writers with one workspace lock and
persists `.agents/pm/transactions/sdk/<transaction-id>.json` after every step.
Before invoking a pending step, it also persists that step's durable ownership
marker. Recovery and compensation therefore distinguish mutations begun by
this transaction from matching domain state that existed before the attempt.
Steps that must restore prior values implement `prepareCompensation()`; its
JSON-safe result is stored atomically with that ownership marker before
`apply()` begins and is passed back to `compensate(data)` after a restart.
`lockTtlSeconds` (default `30`) and `lockWaitMs` (default `3000`) let callers
size the writer lease above their longest expected attempt and choose their
contention budget; both must be positive integers.

If a process stops between the domain write and the journal update, rerunning
the same plan discovers the already-applied step and continues. An ordinary
error switches the journal to compensation mode and runs applied steps in
reverse order, limited to steps whose forward attempt was durably recorded.
Compensations are new item-history or relationship events: the
coordinator never deletes or rewrites immutable history. A crash during
compensation resumes compensation before a new attempt begins.

```ts
import {
  PmClient,
  commitWorkspaceTransaction,
  type WorkspaceTransactionStep,
} from "@unbrained/pm-cli/sdk";

const pmRoot = "/workspace/.agents/pm";
const pm = new PmClient({ pmRoot, author: "billing-agent" });
const steps: WorkspaceTransactionStep[] = [
  {
    id: "approve-invoice",
    async inspect() {
      const invoice = await pm.get("invoice-42", { depth: "deep" });
      if (invoice.item.status === "approved")
        return { state: "applied", result: { status: "approved" } };
      if (invoice.item.status !== "open")
        throw new TypeError("Invoice must be open before approval");
      return { state: "pending" };
    },
    async apply() {
      await pm.update("invoice-42", { status: "approved" });
      return { status: "approved" };
    },
    async compensate() {
      await pm.update("invoice-42", {
        status: "open",
        message: "Compensate interrupted invoice approval",
      });
    },
  },
];

await commitWorkspaceTransaction({
  pmRoot,
  transactionId: "approve-invoice-42",
  author: "billing-agent",
  steps,
});
```

Logical atomicity is defined at the journal/replay boundary: callers publish a
successful domain result only after the journal reaches `committed`, while
failed attempts converge to compensated domain state. The filesystem adapter is
not a database MVCC layer, so raw readers that bypass the coordinator are not
snapshot-isolated during the short forward/compensation window. Use stable step
ids, deterministic event ids, state-based inspection, and append-only inverse
events. A step may return `undefined` when it has no journal result to retain.
The optional transition observer exposes `step_compensating` immediately before
each inverse mutation, which supports telemetry and semantic failure injection
without coupling tests to storage call counts.
`WorkspaceTransactionInterruptedError` is reserved for deterministic
crash-boundary tests and leaves the journal resumable instead of triggering the
normal in-process compensation path.

Extension commands receive the same coordinator as
`context.sdk.commitWorkspaceTransaction(...)`, already bound to the invoking
tracker root. The bundled `pm-vcs` merge command is the reference implementation:
it commits the changeset lifecycle transition and `commits_to` relationship
together, compensates both streams on failure, and resumes a crash or a
previously compensated retry without package-private file access.

For the ubiquitous "commit N item mutations atomically" case (bulk import,
bulk sync), `commitItemMutations` wraps the coordinator so callers describe
the mutations instead of hand-writing a step array. The helper wires the
crash-consistency contract for you: creates use their explicit stable `id` as
the idempotency key (exists-by-id inspection) and are compensated by closing
the item (or deleting it with `createCompensation: "delete"`); updates stamp a
durable history marker for applied-detection and are compensated by restoring
the captured pre-mutation version; closes treat an already-terminal target as
applied and are likewise compensated by version restore. A stable
`transactionId` makes interrupted batches resumable across processes and
agents.

```ts
import { commitItemMutations } from "@unbrained/pm-cli/sdk";

const result = await commitItemMutations({
  pmRoot,
  transactionId: "sync-jira-batch-2026-07-19",
  author: "jira-sync",
  mutations: [
    {
      op: "create",
      id: "jira-1042",
      options: { title: "Imported: fix login flow", type: "Issue" },
    },
    { op: "update", id: "pm-a1b2", options: { priority: "1" } },
    { op: "close", id: "pm-c3d4", reason: "Resolved upstream in Jira" },
  ],
});
// result.results is keyed by derived step id: { "1-create-jira-1042": { id, op }, ... }
```

`commitWorkspaceTransaction` remains the escape hatch for arbitrary domains
(relationship events, foreign stores, mixed-step plans); `commitItemMutations`
covers the item-mutation 90% case with correct-by-construction wiring.
Update mutation options use the same acceptance-criteria representation as the
CLI: criteria are stored in one string with semicolons as boundaries. Therefore
each `addAc`/`removeAc` entry must be semicolon-free; unmatched removals are
reported as `remove_ac_unmatched:<text>` warnings rather than disappearing as
silent no-ops.

Package and extension lifecycle convenience methods are the SDK primitive layer
for custom PM tools that need to manage their own package surface without
shelling out. Use `pm.packageList`, `pm.packageInstall`,
`pm.packageUninstall`, `pm.packageDoctor`, `pm.packageManage`,
`pm.packageDescribe`, `pm.packageReload`, `pm.packageCatalog`,
`pm.packageActivate`, `pm.packageDeactivate`, and `pm.upgrade` for package-mode
automation; use `pm.extensionList`, `pm.extensionActivate`, and
`pm.extensionDeactivate` when the UI vocabulary is explicitly extension-focused.
The matching top-level helpers (`packageLifecycle`, `packageList`,
`packageInstall`, `packageUninstall`, `packageDoctor`, `packageManage`,
`packageDescribe`, `packageReload`, `packageCatalog`, `packageActivate`,
`packageDeactivate`, `extension`, `extensionList`, `extensionActivate`,
`extensionDeactivate`, and `upgrade`) construct a short-lived `PmClient` for
one-off calls. Package helpers return `PackageCommandResult` and extension
helpers return `ExtensionCommandResult`; both names describe the same lifecycle
payload shape with vocabulary-appropriate SDK signatures. `UpgradeResult` is the
same structured payload rendered by the CLI, so embedded tools can own their
presentation layer while sharing pm's package/install/doctor semantics.

Annotation and relationship convenience methods turn "project management =
context management" into a typed SDK surface. Use `pm.comments`, `pm.notes`,
`pm.learnings`, `pm.files`, `pm.docs`, `pm.deps`, and `pm.append` when an
embedded agent, package, or custom UI needs to add durable rationale, link
changed files/docs/tests, or inspect the item graph. `pm.filesDiscover` exposes
the same file-candidate discovery used by the CLI, so a custom tool can present
reviewable link suggestions instead of scraping git output itself.
Comments, notes, and learnings share the exported annotation kernel, including
plain/stdin/file input resolution for CLI and embedded SDK calls, one-based
edit/delete semantics, ownership guidance, history mutation metadata, and stable
list pagination. MCP tool actions intentionally omit file input to prevent host
filesystem access. Package authors can build custom annotation presentation
layers without importing CLI modules.

Customization convenience methods are the SDK baseline for project-specific pm
tools. `pm.init` stages a tracker, `pm.config` reads/writes settings,
`pm.schema*` methods manage types/statuses/fields/presets, and `pm.profile*`
methods list, inspect, apply, and lint project archetypes. These helpers let a
package or app construct an opinionated project-management experience while
staying on the same schema/profile primitives the CLI and MCP use.
The schema mutation and inspection engine is owned by `src/sdk/schema.ts`; the
CLI schema module is a presentation-compatible re-export. Embedded runtimes can
therefore compose schema operations without importing CLI code, while CLI, MCP,
and `PmClient` continue to share the same validation, locking, persistence, and
result contracts.
`pm.init` accepts `workspace` to initialize `<workspace>/.agents/pm`; path-target
calls retain tracker-root semantics. `InitResult.target` exposes the resolved
mode, tracker root, and optional workspace root, while every explicit-target
`next_steps` command carries `--pm-path` so embedded tools can display runnable
recovery without depending on the caller's current directory.

Package install results include `details.verification`, a light doctor-equivalent
projection of activation, registered commands/actions/item types, target tracker
root, and health verdict. Treat `ok: false` or `verification.status: "degraded"`
as an install failure even when files were copied successfully; use
`activation_diagnostics` and `command_discovery.next_steps` for remediation.

Governance and maintenance convenience methods expose the operational floor a
custom PM host should run before it trusts or publishes tracker state.
`pm.validate` checks resolution/history invariants, `pm.health` performs
read-only diagnostics, and `pm.gc` runs dry-run or explicit cleanup paths through
the same bounded maintenance engine as the CLI. Prefer these typed calls over
shelling out when building CI, editor integrations, or long-running agent
runtimes.

### Query execution

Tracked by [pm-rjqr](../.agents/pm/features/pm-rjqr.toon) and the SDK boundary
capstone [pm-9x6e](../.agents/pm/tasks/pm-9x6e.toon).

`runList` and `runSearch` are SDK-owned query engines, including filtering,
projection, pagination, keyword and semantic ranking, extension-provider
dispatch, and token-efficient response metadata. Their historical CLI module
paths are identity-preserving compatibility exports, while `runEval` consumes
the SDK search engine directly. Package authors can import these functions and
their typed result contracts from `@unbrained/pm-cli/sdk` without importing CLI
implementation modules.

List result rows are modeled by projection: `ListFullResult` contains complete
`ListedItem` records, tree ordering may enrich them with `ListTreeMetadata`, and
compact or `fields` projections return `ListProjectedItem` dictionaries. Use
`full: true` when an integration requires complete item metadata; the overload
then returns `ListFullResult` without an assertion or cast.

### Execution and diagnostics

Tracked by [pm-oslr](../.agents/pm/features/pm-oslr.toon) and the SDK boundary
capstone [pm-9x6e](../.agents/pm/tasks/pm-9x6e.toon).

Test execution, background-run supervision, search evaluation, telemetry
inspection, and tracker statistics are SDK-owned primitives. A custom CI host or
project-specific tool can compose the same sandboxing, context-preflight,
deduplication, failure classification, progress, consent, and structured-result
behavior as the CLI without spawning `pm` or importing `src/core` modules:

```ts
import {
  runEval,
  runTelemetry,
  runTest,
  runTestAll,
  runTestRunsStatus,
  type GlobalOptions,
} from "@unbrained/pm-cli/sdk";

const pmRoot = "/path/to/project/.agents/pm";
const itemId = "pm-example";
const runId = "test-run-example";
const global: GlobalOptions = { path: pmRoot };

const itemRun = await runTest(
  itemId,
  {
    run: true,
    autoPmContext: true,
    checkContext: true,
    failOnEmptyTestRun: true,
  },
  global,
);

const workspaceRun = await runTestAll(
  { status: "open", autoPmContext: true, failOnSkipped: true },
  global,
);
const background = await runTestRunsStatus(runId, global);
const relevance = await runEval({ mode: "keyword", k: 10 }, global);
const telemetry = await runTelemetry(
  { subcommand: "stats", limit: 20 },
  global,
);
```

`runTest` and `runTestAll` always execute linked commands in isolated project and
global tracker roots. `pm_context_mode`, run-level overrides, automatic tracker
context, assertion requirements, empty-run detection, and failure categories are
part of the SDK result contract rather than presentation-layer behavior.
Background-run helpers return durable records and health/log projections; the
host remains responsible for its own rendering and exit-code policy.

`runTelemetry` retains consent and storage ownership inside the primitive:
`status` and `stats` are observational, `flush` uses the consent-aware queue
runtime, and `clear` disables telemetry and removes runtime artifacts. `runEval`
uses the same live search path and unrounded gate decision as `pm eval`, returning
compact rounded report metrics for stable machine output.

### Context relevance and evaluation

Tracked by [pm-4k6b](../.agents/pm/features/pm-4k6b.toon),
[pm-h3no](../.agents/pm/tasks/pm-h3no.toon),
[pm-atfm](../.agents/pm/features/pm-atfm.toon), and
[pm-qyc6](../.agents/pm/issues/pm-qyc6.toon).

`pm context` and `pm next` share the public deterministic relevance model.
Candidate order is the structural baseline; normalized metadata signals add
explainable weighted contributions. Package authors can call
`buildItemContextRelevanceCandidates(items, { statusRegistry, now, author,
semanticSimilarity })`
to derive the exact built-in metadata signals, then call
`scoreContextCandidates` with a scorer callback, while installed extensions can
register the governed `context_relevance` service override. A malformed or
throwing override degrades to the deterministic default and emits an
`extension_context_relevance_invalid_result` warning instead of breaking the
read path.

Use `--explain-ranking --json` on `pm context` or `pm next` to include the model,
available signals, baseline rank, final rank, score, and per-signal
contributions. Explanation data is opt-in so default agent output stays bounded.

The opt-in explanation also carries a compact `packing` envelope: the derived
token budget, estimated usage, included projection depths, omitted ids, active
task-set profile, and completeness. Packing still governs every default call;
only its accounting envelope is omitted to preserve the token budget.
`packContextCandidates` exposes the same
deterministic optimizer to SDK consumers. It admits required anchors first,
penalizes redundant clusters, applies uncertainty-aware value, and buys
identity → summary → full upgrades so relevant rows lose detail before they are
omitted. Built-in `context` and `next` profiles select intent-appropriate
diversity and uncertainty policies while required safety anchors remain
mask-immune. An optional `latencyBudgetMs` bounds candidate comparisons; the
report discloses `selection_complete`, `termination_reason`, evaluated rows,
the active profile, and the full projection-degradation ladder.

The optional context-usage feedback loop is a derived runtime artifact under
`.agents/pm/runtime/context-usage.jsonl`. Serving events retain only author,
timestamp, surface, profile, item id, rank, and inclusion; subsequent reads and
mutations record item id and command intent. The bounded ledger compacts by age and count,
never enters item history, and feeds a decayed `usage_affinity` signal with an
exploration floor. SDK hosts can use `recordContextUsageServing`,
`recordContextUsageTouch`, `recordContextUsageTouches`, and
`readContextUsageAffinity` directly. Set
`PM_CONTEXT_USAGE_DISABLED=1` for a zero-read/zero-write opt-out.

Custom tools can evaluate the same behavior without shelling out:

```ts
import {
  PmClient,
  runContextEvaluationCorpus,
  type ContextEvaluationScenario,
  type ContextEvaluationThresholds,
} from "@unbrained/pm-cli/sdk";

const pm = new PmClient({
  pmRoot: ".agents/pm",
  author: "context-quality-ci",
});

const scenarios: ContextEvaluationScenario[] = [
  {
    id: "returning-agent",
    surface: "context",
    options: { limit: "5" },
    judgments: { "pm-current": 3, "pm-support": 2 },
    required_ids: ["pm-current"],
    continuity_ids: ["pm-current", "pm-support"],
    token_budget: 1200,
    rationale: "Resume claimed work with its supporting context.",
  },
];

const thresholds: ContextEvaluationThresholds = {
  ndcg: 0.9,
  reciprocal_rank: 0.9,
  required_recall: 1,
  continuity_coverage: 1,
  token_budget_adherence: 1,
};

const report = await runContextEvaluationCorpus(scenarios, pm, thresholds);
if (!report.passed) throw new Error(report.failures.join(", "));
```

The evaluator calls only the public `context()` / `next()` reader contract. It
scores nDCG, reciprocal rank, required-item recall, returning-agent continuity,
and deterministic `ceil(UTF-8 JSON bytes / 4)` token-budget adherence. Reports
retain attribution only for served items, while token accounting measures the
normal packet without the opt-in ranking explanation.

`PmClient` and `runAction` share the same process-wide extension activation
queue as MCP. Calls from one process are serialized across extension load,
activation, dispatch, cleanup, and deactivate so active extension registries stay
consistent. Use separate processes when a host needs true parallel pm action
throughput.

`PmClient` convenience methods (`list`, `create`, `update`, and the rest) accept
command options only. For per-call runtime overrides such as `cwd`, `path`, or
`noExtensions`, use `run` or call `runAction` directly:

```ts
await pm.run("list", { cwd: "/path/to/project", options: { status: "open" } });
await pm.run("create", { title: "Capture SDK input", type: "Task" });
```

For `create`, `PmClient.run` also accepts the common structured top-level item
keys (`title`, `type`, `status`, `description`, `body`, `priority`, `tags`,
`parent`, `createMode`, and `allowMissingParent`) and maps them to command
options. This keeps dynamic SDK callers ergonomic while the typed `pm.create`
method remains the preferred fully documented path.

For item-type context, use the CLI inspection primitives before issuing custom-domain mutations:

```bash
pm schema list --json
pm schema show Experiment --json
```

`schema list/show` include built-in, persisted custom, and extension-provided item types. Extension-provided types include provenance (`layer` and package/extension name) in `show --json`, which helps agents decide whether a missing type should be registered persistently with `pm schema add-type`, added through `pm init --type-preset`, or provided by an installed package.

When a package-owned command is missing at runtime, CLI usage guidance now includes a deterministic install hint (for example `pm install calendar` or `pm install search-advanced`) so agents can recover in one retry.

Package installs currently activate only extension resources. Additional package resource kinds (`docs`, `examples`, `assets`, `prompts`) are metadata-first and available through package manifest/catalog inspection.

Package tests can assert the normalized manifest through the SDK without
reimplementing resource sorting, alias normalization, or package.json parsing:

```ts
import {
  assertPackageManifest,
  readPmPackageManifest,
} from "@unbrained/pm-cli/sdk";

const manifest = await readPmPackageManifest(packageRoot);

assertPackageManifest(manifest, {
  packageName: "@acme/pm-incident-workflow",
  aliases: ["incident-workflow"],
  resources: {
    extensions: ["extensions/incident-workflow"],
    docs: ["README.md"],
    examples: ["examples/basic.md"],
    assets: ["assets/workflow-diagram.png"],
    prompts: ["prompts/triage.md"],
  },
});
```

Package tests can also assert extension registrations without importing private
loader internals. Prefer `createExtensionTestHarness` — its `assert*`/`run*`
methods bind to the right sub-registry for you:

```ts
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

const ext = await createExtensionTestHarness(extensionModule, {
  capabilities: ["commands", "schema"],
});

ext.assertCommandContract({
  command: "incident triage",
  flags: ["--severity"],
});
ext.assertFlags({ targetCommand: "list", flags: ["--incident-filter"] });
const { result } = await ext.runCommand({
  command: "incident triage",
  options: { severity: "high" },
});
const summary = ext.activationSummary();
const reference = ext.renderMarkdown({ title: "incident package surfaces" });
await ext.deactivate();
```

For provider-safe schemas, use `PM_PROVIDER_TOOL_PARAMETERS_SCHEMA`. It is flat and avoids advanced schema constructs such as root `oneOf`.

## Capability Requirements

| Registration                 | Manifest capability |
| ---------------------------- | ------------------- |
| `registerCommand`            | `commands`          |
| inline command flags         | `schema`            |
| `registerFlags`              | `schema`            |
| `registerItemFields`         | `schema`            |
| `registerItemTypes`          | `schema`            |
| `registerMigration`          | `schema`            |
| `registerProfile`            | `schema`            |
| `registerImporter`           | `importers`         |
| `registerExporter`           | `importers`         |
| `registerParser`             | `parser`            |
| `registerPreflight`          | `preflight`         |
| `registerService`            | `services`          |
| `registerRenderer`           | `renderers`         |
| lifecycle hooks              | `hooks`             |
| `registerSearchProvider`     | `search`            |
| `registerVectorStoreAdapter` | `search`            |

Some override surfaces are single-winner: command overrides, parser overrides, preflight overrides, and output renderers. Keep those handlers narrowly scoped and verify package combinations with:

```bash
pm package doctor --project --detail deep --trace
pm package doctor --project --isolated --detail deep --trace
pm health --check-only --brief
```

Use `--isolated` (alias `--ignore-global`) for hermetic package smoke tests:
project diagnostics skip global registrations and avoid machine-local
renderer/service overrides. The same isolation can be applied to a whole
subprocess suite by setting `PM_GLOBAL_PATH` to a temporary directory.

Collision warnings are deterministic and include package names plus deactivation guidance.
If extension code calls a `register*` API without declaring the matching
manifest capability, activation fails with
`extension_capability_missing:<name>:<capability>` in doctor triage. Run doctor
with `--trace` to see the exact method, `missing_capability`, and manifest
capability entry to add before publishing.

## Minimal Command Extension

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerCommand({
      name: "hello",
      action: "hello",
      description: "Return a deterministic hello payload.",
      intent: "verify SDK extension activation",
      examples: ["pm hello"],
      failure_hints: [
        "Run pm package doctor --detail deep --trace on activation failures.",
      ],
      run: async () => ({ ok: true, message: "hello" }),
    });
  },
});
```

Manifest:

```json
{
  "name": "hello",
  "version": "0.1.0",
  "entry": "./index.ts",
  "pm_min_version": "2026.5.31",
  "trusted": true,
  "sandbox_profile": "strict",
  "permissions": {
    "fs_read": false,
    "fs_write": false,
    "network": false,
    "env_read": false,
    "env_write": false,
    "process_spawn": false
  },
  "capabilities": ["commands"]
}
```

`pm_min_version` is an inclusive minimum pm CLI version. When the installed CLI is older than the manifest requires, discovery emits `extension_pm_min_version_unmet:<layer>:<name>:required=<version>:current=<version>` and does not load the extension. Use a plain numeric version such as `2026.5.31`; `>=2026.5.31` is accepted for compatibility with `engines.pm`, but ranges beyond an inclusive minimum are not interpreted.

Manifest typing also accepts optional `engines` metadata:

```json
{
  "engines": {
    "pm": ">=2026.5.31",
    "node": ">=22.18"
  }
}
```

Use `pm_min_version` for the loader gate. Keep `engines` as package-manager and tooling metadata.
For pure command packages, keep `trusted: true`, `sandbox_profile: "strict"`, and all six permissions set to `false`; relax only the permission keys the package actually needs and verify the result with `pm package doctor --project --detail deep --trace`.

For a complete commands-capability package that combines `registerCommand`,
`registerFlags`, and `registerParser`, see the first-party
[pm-command-kit exemplar](../packages/pm-command-kit/README.md).

For a generated starter, use `pm package init ./my-package`. Pass
`--capability hooks` to scaffold a command plus an `afterCommand` lifecycle
reactor and a runnable `node:test` file that exercises
`activateExtensionForTest`, `assertRegisteredHook`, `runRegisteredHookForTest`,
and `deactivateExtensionForTest`. Pass `--capability search` to scaffold a
command plus a deterministic search provider/vector-store adapter pair and a
runnable `node:test` file that exercises `assertRegisteredSearchProvider`,
`assertRegisteredVectorStoreAdapter`, `runRegisteredSearchProviderForTest`, and
`runRegisteredVectorStoreAdapterForTest`. Pass `--capability importers` to
scaffold paired import/export commands with example flag metadata and a runnable
`node:test` file that exercises `assertRegisteredImporter`,
`assertRegisteredExporter`, `runRegisteredImporterForTest`, and
`runRegisteredExporterForTest`; the generated manifest declares both `importers`
and `schema` because extension flag metadata is schema-governed. Pass
`--capability schema` to scaffold a command plus a custom item type, item field,
and migration (via `registerItemTypes`/`registerItemFields`/`registerMigration`)
and a runnable `node:test` file that exercises `assertRegisteredItemType`,
`assertRegisteredItemField`, `assertRegisteredMigration`, and
`runRegisteredMigrationForTest` — a copyable starting point for modeling a
project domain. Pass `--capability profile` to scaffold a command plus a complete
project-profile archetype (item types, statuses, fields, a per-type workflow,
config, a create template, and package recommendations via `registerProfile`) and
a `node:test` file exercising the harness-bound `assertProfile` (the public
`assertRegisteredProfile`); it omits
`activation.commands` (granted by the same `schema` capability) so the contributed
profile resolves through `pm profile list/show/apply` and `pm profile apply <name>`
tailors a fresh tracker in one shot — the broadest customization primitive in one
copyable starter.

The four override surfaces complete the matrix to one starter per SDK
registration capability. Pass `--capability renderers` to scaffold a `toon`
output renderer override (via `registerRenderer`, scoped to its own command so
other output passes through) with a `node:test` file exercising
`assertRegisteredRendererOverride` and `runRegisteredRendererOverrideForTest`;
`--capability parser` for a parser override (via `registerParser`) that rewrites
the command's parsed options — the starter command declares matching
`--shout`/`--upper` flags (so the manifest also declares `schema`) and surfaces
the normalized value, making the override runnable through `pm <command> --shout`
— exercising `assertRegisteredParserOverride` and
`runRegisteredParserOverrideForTest`; `--capability preflight` for a preflight
override (via `registerPreflight`) over pm's pre-run migration/format gate
decision, exercising `assertRegisteredPreflightOverride` and
`runRegisteredPreflightOverrideForTest`; and `--capability services` for an
`output_format` service override (via `registerService`, scoped to its own
command), exercising `assertRegisteredServiceOverride` and
`runRegisteredServiceOverrideForTest`.

Every command-bearing variant's generated `manifest.json` also declares
`activation.commands` — the exact command paths the starter registers — so pm
activates the package lazily, importing and running `activate` only when an
invoked command matches. This mirrors every first-party bundled package and is
the contract authors keep in sync with their registrations: an omitted or stale
entry means the matching command will not dispatch from the CLI (globally-scoped
surfaces such as hooks and search providers for built-in search commands still
activate regardless). The `schema` starter is the deliberate exception: it omits
`activation.commands` so its custom item type — a global contribution that
built-in commands like `pm create <type>` must see — activates conservatively for
every command rather than gating on the package's own commands.

Each `--capability` starter authors an imperative `activate` body. To scaffold the
declarative `composeExtension` form instead, pass `--declarative` to
`pm package init` / `pm package scaffold` (it is an init/scaffold flag, package-mode
only — every `--capability` variant emits its blueprint form, since `composeExtension`
is a runtime SDK value import that only package-mode authoring links) — see
[Declarative Authoring](#declarative-authoring). See [EXTENSIONS.md](EXTENSIONS.md)
for the manifest-field reference.

## Self-Identity and Lifecycle

`activate(api)` receives a read-only `api.extension` describing the extension it
was created for, so authors can emit self-identifying logs, gate on their own
version, and build better error messages without re-reading the manifest:

```ts
export default defineExtension({
  activate(api) {
    // api.extension: { name, layer, version, capabilities, pm_min_version?, pm_max_version?, source_package? }
    if (api.extension.version.startsWith("0.")) {
      api.hooks.afterCommand(() => {
        // ...pre-1.0 behaviour, labelled with api.extension.name
      });
    }
  },
});
```

`api.extension.capabilities` is filtered to the canonical capability set, and both
the object and its `capabilities` array are frozen.

Modules may also export an optional VS Code-style `deactivate` teardown hook. The
host runs it on shutdown/reload — the long-running MCP server invokes it between
native-action requests — so an extension can close connections, clear timers, and
release buffers opened during `activate`. `deactivate` runs only for extensions
that activated successfully (a failed `activate` never fully initialized), and
teardowns run concurrently. Teardown is best-effort: a throwing `deactivate` is
recorded as a warning, never propagated, and each hook is bounded by a host
timeout so one extension cannot block another's cleanup or a host reload. Hosts
that call `deactivateExtensions` directly may pass `deactivate_timeout_ms: 0` or
`Infinity` only when they intentionally want to wait indefinitely.

```ts
export default defineExtension({
  activate(api) {
    /* open resources */
  },
  async deactivate() {
    /* close connections, flush sinks, clear timers */
  },
});
```

## Flag Contracts

`FlagDefinition` (used by `registerFlags` and inline command `flags`) supports the
same list/default semantics as core flags:

- `value_type` is the canonical coercion kind (`string` | `number` | `boolean`;
  the aliases `int`/`integer`/`float` and `bool` are also accepted). The
  deprecated `type` alias is still read, but `value_type` wins when both are set
  (`value_type ?? type`). An unrecognized value type is rejected at registration.
- `list: true` makes a repeated, comma-joined flag accumulate into an array —
  parity with core list flags such as `--tags`. `--scope a,b --scope c` resolves
  to `["a", "b", "c"]`, with each element coerced by `value_type`. Long and
  short aliases share one accumulator, so `-s a --scope b,c --scope=d` preserves
  command-line order as `["a", "b", "c", "d"]`.
- `default` (a scalar, or an array of scalars for a `list` flag) is applied when
  the flag is omitted; for a `list` flag the default is flattened into the
  accumulated array exactly like a provided value — comma-joined strings (e.g.
  `default: "a,b"` or `default: ["a,b", "c"]`) are split into elements. A default
  that would not cleanly coerce under the declared `value_type` (e.g.
  `value_type: "number", default: "abc"`) is rejected at registration.

```ts
api.registerFlags("report", [
  {
    long: "--scope",
    short: "-s",
    value_type: "string",
    list: true,
    default: "all",
  },
  { long: "--limit", value_type: "number", default: 20 },
]);
```

Dynamic extension commands follow the same end-of-options contract as core
commands. Put `--` before variadic content that begins with a dash or resembles a
pm flag: `pm query run -- RETURN -h --json`. Everything after the separator is
delivered to the registered positional arguments unchanged.

## Output Ownership

Command handlers should normally return structured data and let the host select
TOON, JSON, service, or registered renderer output. A renderer override returns a
string when it owns the matching payload and `null` to fall back to native
rendering. When a command must write directly — for example, a streaming export,
binary response, or already-rendered protocol — return `suppressHostOutput()` so
the CLI does not append a second payload:

```ts
import { suppressHostOutput } from "@unbrained/pm-cli/sdk";

api.registerCommand({
  name: "archive stream",
  async run() {
    await writeArchiveToStdout();
    return suppressHostOutput({ records: 42 });
  },
});
```

The optional structured result remains available to command-result hooks,
telemetry, and embedded hosts, while the CLI writes no host-rendered output. The
marker is structural rather than identity-based, so separately installed
packages and custom SDK-built hosts can exchange it safely.

`registerItemFields` validates each declared field `type` against the canonical
coercion kinds (`string`, `number`, `boolean`, `array`, `object`) at activation.
A typo fails activation with a did-you-mean hint (e.g. `type: "strnig"` →
`Did you mean "string"?`) instead of silently passing and failing opaquely at use
time.

## Expected CLI Errors

Package commands should throw expected user/action errors with the public SDK shape so the CLI can preserve exit codes and Sentry can filter expected retry failures:

```ts
import { EXIT_CODE, createPmCliExpectedError } from "@unbrained/pm-cli/sdk";

throw createPmCliExpectedError("hello requires --name", {
  exitCode: EXIT_CODE.USAGE,
  context: {
    code: "missing_name",
    why: "The command needs a target name.",
  },
});
```

The helper returns an `Error` whose public name is `PmCliError` and whose `exitCode` is structural. That makes it safe for bundled, linked, and separately installed package code even when class identity is not shared with the running CLI.

## Package Runtime Imports

Third-party packages should import from stable public SDK subpaths:

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";
import { createPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
```

`PM_CLI_PACKAGE_ROOT` is reserved for first-party packages bundled inside this repository. Those packages use it to locate the running CLI's `dist/sdk/runtime.js` before they are installed as independent npm packages. External packages must not depend on `PM_CLI_PACKAGE_ROOT`, `dist/` paths, or `src/core/...`; declare `@unbrained/pm-cli` as a dependency or peer dependency and import the public SDK subpaths instead. When pm installs a registry package, it links that dependency to the running host CLI so the package gets the active SDK without downloading a second CLI copy into the project.

## Authoring Builders

Tracked: [pm-12tj](../.agents/pm/features/pm-12tj.toon) (design rationale: ADR [pm-3mph](../.agents/pm/decisions/pm-3mph.toon)).

The `define*` builders are the authoring half of the `author → register → test`
loop: they type a registration definition where you write it, before it ever
reaches `api.register*`. Each is a zero-cost identity function (it returns its
argument unchanged), exactly like `defineExtension` and the wider
`defineConfig`/`defineComponent` ecosystem convention — the value is entirely at
the type level.

pm packages are authored **and loaded** as TypeScript (ADR
[pm-2c28](../.agents/pm/decisions/pm-2c28.toon) / [pm-m1uz](../.agents/pm/decisions/pm-m1uz.toon)). A bare `const cmd = { ... }`
satisfies the registration types only structurally and widens its literals;
wrapping it in a builder checks the object against the contract _and_ preserves
the narrow literal types, while inferring the nested handler's `context`
parameter from the builder signature — the same ergonomics `defineConfig` gives a
Vite config. It also lets you colocate, export, reuse, and unit-test a definition
apart from `activate`:

```ts
import { defineCommand, defineAfterCommandHook } from "@unbrained/pm-cli/sdk";
import type { ExtensionApi } from "@unbrained/pm-cli/sdk";

// `context` is inferred from the builder signature; the literal name/action are preserved.
export const greetCommand = defineCommand({
  name: "greet hello",
  action: "greet-hello",
  description: "Say hello.",
  run: (context) => ({ greeting: `hi ${context.args[0] ?? "world"}` }),
});

export const auditHook = defineAfterCommandHook((context) => {
  if (!context.ok) return;
  // react to context.affected — "project management = context management"
});

export function activate(api: ExtensionApi): void {
  api.registerCommand(greetCommand);
  api.hooks.afterCommand(auditHook);
}
```

Object-definition builders (`defineExtensionManifest`, `defineCommand`,
`defineFlag`, `defineItemType`, `defineItemField`, `defineMigration`,
`defineSearchProvider`, `defineVectorStoreAdapter`) preserve the narrow literal
type. `defineExtensionManifest` additionally contract-checks the in-module
manifest mirror where it is authored and pairs with `deriveExtensionCapabilities`
(see [Declarative Authoring](#declarative-authoring)). Function-definition
builders (`defineCommandOverride`, `defineParserOverride`,
`definePreflightOverride`, `defineServiceOverride`, `defineRendererOverride`,
`defineImporter`, `defineExporter`, and the five hook builders
`defineBeforeCommandHook` / `defineAfterCommandHook` / `defineOnWriteHook` /
`defineOnReadHook` / `defineOnIndexHook`) are non-generic so a bare arrow's
parameter is contextually typed instead of falling back to `any`. The
[`assertRegistered*`](#testing-helpers) helpers below verify these same
definitions once registered.

## Declarative Authoring

Tracked: [pm-iqq0](../.agents/pm/features/pm-iqq0.toon).

`composeExtension` is the capstone of the `author → register → test` loop. Instead
of hand-wiring each `api.register*` call inside an imperative `activate(api)`
body — calling the right method, in the right order, without forgetting one —
describe **what** to register as a plain `ExtensionBlueprint` object and let the
SDK generate the `activate` for you. Every field is optional; populate the
surfaces you use (ideally with `define*`-authored definitions) and leave the rest
out:

```ts
import {
  composeExtension,
  defineCommand,
  deriveExtensionCapabilities,
} from "@unbrained/pm-cli/sdk";
import type { ExtensionBlueprint } from "@unbrained/pm-cli/sdk";

const echo = defineCommand({
  name: "command-kit echo",
  action: "command-kit-echo",
  description: "Echo a message as structured output.",
  run: (context) => ({ message: context.args.join(" ") }),
});

const blueprint: ExtensionBlueprint = {
  commands: [echo],
  parsers: { "command-kit echo": (context) => ({ options: context.options }) },
  flags: {
    list: [{ long: "--kit-note", value_type: "string", value_name: "text" }],
  },
};

// The generated `activate` registers commands → overrides → flags → parsers →
// renderers → services → preflights → item types → item fields → migrations →
// search providers → vector store adapters → importers → exporters → hooks, then
// awaits any imperative `activate` you also pass (an escape hatch run last).
export default composeExtension(blueprint);
```

`deriveExtensionCapabilities(blueprint)` returns the exact least-privilege
capability set the blueprint exercises (sorted, de-duplicated), so you can author
`manifest.json` `capabilities` with zero declared-but-unused or used-but-undeclared
drift. It is the author-time inverse of the runtime
[`reconcileExtensionCapabilityUsage`](#capability-requirements) check, and the set
it returns is the set `composeExtension`'s generated `activate` requires — they
agree by construction:

```ts
deriveExtensionCapabilities(blueprint); // ["commands", "parser", "schema"]
```

The blueprint's record-keyed fields (`commandOverrides`, `flags`, `parsers`,
`renderers`, `services`) map a routing key to its handler, mirroring the
two-argument `api.register*` overloads; `hooks` groups the five lifecycle kinds.
The array-valued `relationshipKinds` field registers application-defined graph
semantics and contributes the `schema` capability just like `itemTypes`,
`itemFields`, and `profiles`.
`composeExtension` is a pure assembler: it does not validate definitions —
per-surface contract enforcement stays in `api.register*` and the loader, so a
malformed definition surfaces the same activation diagnostic as a hand-written
`activate`. The bundled first-party packages intentionally keep import-free
hand-written `activate` bodies so they load in extension-only installs; reach for
`composeExtension` in npm package-mode authoring where the SDK is a dependency.

For a generated starting point, `pm package init <path> --declarative` scaffolds
this loop end to end for any `--capability`: an `index.ts` that authors a
`defineExtensionBlueprint` blueprint (the capability's surfaces wired through the
`define*` builders) and exports `composeExtension(blueprint)`, plus an
`index.test.ts` that guards it with the author-time `assertExtensionPreflight`
capstone and exercises the composed module through `createExtensionTestHarness`. It
is package-mode only (`composeExtension` is a runtime SDK value import, so it belongs
in package-mode authoring where the SDK is a linked dependency, not the import-free
extension-only starters).

### Modular blueprints

Tracked: [pm-high](../.agents/pm/tasks/pm-high.toon),
[pm-nvgy](../.agents/pm/tasks/pm-nvgy.toon).

A large extension's surface does not have to live in one object. `mergeExtensionBlueprints(...blueprints)`
combines several partial blueprints into one — a commands module, a search module,
a hooks module — so each concern is authored (and tested) in its own file and
assembled at the entry point. Wrap each fragment in `defineExtensionBlueprint(...)`
so it is contract-checked at its own definition site (with editor completion) —
the blueprint-level companion to `defineExtension` (a whole module) and
`defineExtensionManifest` (a manifest):

```ts
// commands.ts
import { defineExtensionBlueprint } from "@unbrained/pm-cli/sdk";
export const commandsModule = defineExtensionBlueprint({
  commands: [{ name: "kit run", action: "kit-run", run: () => ({ ok: true }) }],
});
```

```ts
// index.ts — the manifest entry; import sibling .ts modules by their real extension (loaded directly via native type stripping).
import {
  composeExtension,
  mergeExtensionBlueprints,
} from "@unbrained/pm-cli/sdk";
import { commandsModule } from "./commands.ts";
import { searchModule } from "./search.ts";

export default composeExtension(
  mergeExtensionBlueprints(commandsModule, searchModule),
);
```

The merge is pure, deterministic, and never mutates an input. Each surface combines
the way its `api.register*` call composes: array surfaces (`commands`, `itemTypes`,
`migrations`, `searchProviders`, `importers`, …) concatenate in order; `flags`
concatenates the flag arrays of a shared target command; single-handler records
(`commandOverrides`, `parsers`, `renderers`, `services`) take last-defined-wins
precedence on a key collision; `hooks` concatenate per lifecycle kind; imperative
`activate` hatches chain forward (acquisition order) while `deactivate` hooks chain
in reverse (LIFO teardown); the `manifest` mirror is last-defined-wins. Because the
result is an ordinary blueprint, every downstream helper (`deriveExtensionCapabilities`,
`describeExtensionBlueprint`, `lintExtensionBlueprint`, `preflightExtension`) reads it
exactly as it would a hand-written one — a command two modules both define survives
as a duplicate and `lintExtensionBlueprint` flags it. Merging zero blueprints returns
an empty blueprint (`{}`).

### Generate the manifest (author once)

Tracked: [pm-u5le](../.agents/pm/features/pm-u5le.toon).

`deriveExtensionCapabilities` gives you only the capability set; every other
manifest field is still yours to hand-write. `synthesizeExtensionManifest(blueprint, identity)`
closes that gap — it is the **generate** verb that completes the declarative loop
(`compose → derive → describe/lint → synthesize`). Supply the identity fields a
blueprint cannot determine (`name`, `version`, `entry`, `priority`, plus any
optional `engines`/`permissions`/version floors/etc.) and it returns a complete
`ExtensionManifest` with `capabilities` derived, sorted, and de-duplicated. Write
the blueprint once; never hand-sync `capabilities` again:

```ts
import { synthesizeExtensionManifest } from "@unbrained/pm-cli/sdk";

const manifest = synthesizeExtensionManifest(blueprint, {
  name: "command-kit",
  version: "1.0.0",
  entry: "./index.ts",
  priority: 0,
});
manifest.capabilities; // ["commands", "parser", "schema"] — derived, not hand-written
```

Where `defineExtensionManifest` only _types_ a manifest you wrote by hand, this
_generates_ it. For the rare surface registered through the imperative `activate`
escape hatch (invisible to static derivation — e.g. a renderer wired in
`activate`), pass `additionalCapabilities` and they are unioned in (legacy-alias
resolved, unknown names dropped). Use the result as the on-disk `manifest.json`
content or the in-module `manifest` mirror; guard a hand-maintained manifest
against drift with `assertExtensionManifestMatchesBlueprint` (below).

### Ship both halves (author once)

Tracked: [pm-cn0c](../.agents/pm/tasks/pm-cn0c.toon).

`composeExtension` produces the runtime module; `synthesizeExtensionManifest`
produces the manifest. `composeExtensionPackage(blueprint, identity)` is the
author-once capstone that returns both halves of a shippable package from one call,
with the synthesized manifest set as the module's authoritative in-module mirror —
so the runtime module and the on-disk `manifest.json` are generated from one source
and cannot drift:

```ts
import { composeExtensionPackage } from "@unbrained/pm-cli/sdk";

const { module, manifest } = composeExtensionPackage(blueprint, {
  name: "command-kit",
  version: "1.0.0",
  entry: "./index.ts",
  priority: 0,
});
export default module; // the package entry's default export
// write `manifest` verbatim as manifest.json — capabilities derived, never hand-synced
```

It is a pure assembler (no validation, loading, or filesystem access), exactly like
the two functions it composes; pair it with `preflightExtension` /
`assertExtensionPreflight` for the author-time verify step. Combined with
`mergeExtensionBlueprints`, the full declarative loop is: author each concern with
`define*`, assemble them modularly with `mergeExtensionBlueprints`, then ship both
halves with `composeExtensionPackage`.

### Author-time introspection and preflight

Tracked: [pm-tlpv](../.agents/pm/features/pm-tlpv.toon),
[pm-9ect](../.agents/pm/features/pm-9ect.toon),
[pm-4oio](../.agents/pm/decisions/pm-4oio.toon).

Two pure, no-activation helpers complete the loop, so a blueprint is fully
inspectable and verifiable before it is ever loaded — the author-time inverse of
the runtime guardrails (the same discipline as `deriveExtensionCapabilities`
inverting [`reconcileExtensionCapabilityUsage`](#capability-requirements)):

```ts
import {
  describeExtensionBlueprint,
  lintExtensionBlueprint,
} from "@unbrained/pm-cli/sdk";

// describeExtensionBlueprint returns the same ExtensionActivationSummary shape as
// the runtime describeExtensionActivation — but from the blueprint data alone, no
// activation. It is to the named surfaces what deriveExtensionCapabilities is to
// the capability set.
describeExtensionBlueprint(blueprint).command_handlers; // ["command-kit echo", ...]

// lintExtensionBlueprint preflights for the footguns activation would otherwise
// surface late: a capability a surface exercises but the manifest omits is an
// `error` (the loader throws extension_capability_missing); a declared-but-unused
// capability, a duplicate command, a command/override conflict, and a present-but-
// empty surface are `warning`s. Pass declaredCapabilities or set manifest.capabilities.
const report = lintExtensionBlueprint(blueprint, {
  declaredCapabilities: ["commands", "parser", "schema"],
});
report.ok; // false if any error-severity finding
report.findings; // [{ code, severity, message, capability?/command?/field? }, ...]
```

Both read only the declarative data, so the imperative `activate` escape hatch is
invisible to them — a blueprint that registers everything through that hatch
summarizes as empty and lints clean. In a package test, `assertExtensionBlueprint`
(below) turns the lint into a one-line CI guard.

## Testing Helpers

Package tests can assert registration contracts without depending on Vitest-specific
helpers. Every assertion normalizes the expected name, returns the matched registration
entry, and throws an `Error` that lists what _is_ available when the expectation is
missing. They are exported from both `@unbrained/pm-cli/sdk/testing` and the main
`@unbrained/pm-cli/sdk` barrel.

Activate an in-memory extension module without private loader imports:

```ts
import {
  activateExtensionForTest,
  assertRegisteredCommandContract,
} from "@unbrained/pm-cli/sdk/testing";

const activation = await activateExtensionForTest({
  manifest: {
    name: "hello-ext",
    version: "0.1.0",
    entry: "./index.ts",
    priority: 0,
    capabilities: ["commands", "schema"],
  },
  activate(api) {
    api.registerCommand({
      name: "hello",
      action: "hello",
      description: "Return a deterministic hello payload.",
      flags: [{ long: "--name", value_type: "string" }],
      run: async () => ({ ok: true }),
    });
  },
});

assertRegisteredCommandContract(activation.registrations, {
  command: "hello",
  action: "hello",
  flags: ["--name"],
});
```

`activateExtensionForTest` uses the real pm activation engine and capability
guardrails, but it does not discover files or install packages. Use it for unit
tests of extension registration shape; keep `pm package doctor` and runtime
contracts in integration tests.

For declarative (`composeExtension`) packages, `assertExtensionBlueprint(blueprint, options?)`
is the `assert*` family member that preflights the blueprint _without_ activating
it — it runs `lintExtensionBlueprint` and throws if any finding is error-severity
(today: a capability a surface exercises but the declared set omits, which would
fail activation with `extension_capability_missing`). It returns the full
`ExtensionBlueprintLintResult` on success so a test can still inspect advisory
warnings:

```ts
import { assertExtensionBlueprint } from "@unbrained/pm-cli/sdk/testing";

// Throws if the blueprint and its declared capabilities have drifted; otherwise
// returns the lint result (including any non-blocking warnings) for inspection.
const report = assertExtensionBlueprint(blueprint);
```

`assertExtensionManifestMatchesBlueprint(manifest, blueprint)` is the **strict**
bookend to that lenient preflight: where `assertExtensionBlueprint` only fails on
an _undeclared_ capability and merely warns on an unused one, this assertion fails
on **both** — so a hand-maintained `manifest.json` stays exactly the least-privilege
set the blueprint requires (assert what `synthesizeExtensionManifest` would
otherwise generate). Only `capabilities` are reconciled, since that is the one
manifest field a blueprint determines:

```ts
import { assertExtensionManifestMatchesBlueprint } from "@unbrained/pm-cli/sdk/testing";

// Throws if manifest.capabilities is missing any capability the blueprint uses, or
// declares any the blueprint never exercises. Returns { used, declared, missing,
// unused, findings } on an exact match.
assertExtensionManifestMatchesBlueprint(manifest, blueprint);
```

Where the blueprint guards `capabilities`, a manifest's `pm_min_version` /
`pm_max_version` bounds guard _which pm CLI versions the package supports_.
Tracker references: `pm-knma` introduced `checkExtensionManifestCompatibility`;
`pm-hng2` introduced `assertExtensionManifestCompatible`.
`checkExtensionManifestCompatibility(manifest, { pmVersion, pmMaxVersionExceededMode? })`
is the author-time inverse of the loader's runtime version gate: it takes the pm
version you target and returns structured per-bound findings (the same
`extension_pm_*_version_*` outcomes the loader emits), so you can verify the window
without installing the package against a real CLI. `assertExtensionManifestCompatible`
is the throwing CI guard — it fails on a blocking incompatibility (a malformed
bound, a `pm_min_version` the target is below, or a `block`-mode `pm_max_version`
the target exceeds) and stays quiet on advisory `*_unchecked` / `*_exceeded_warn`
warnings, which still load:

```ts
import { checkExtensionManifestCompatibility } from "@unbrained/pm-cli/sdk";
import { assertExtensionManifestCompatible } from "@unbrained/pm-cli/sdk/testing";

// Inspect every bound outcome against a target version…
const report = checkExtensionManifestCompatibility(manifest, {
  pmVersion: "2026.6.23",
});
//   report.compatible === false, report.findings[0].code === "pm_min_version_unmet", …

// …or fail the package's own suite when a bound would block the load.
assertExtensionManifestCompatible(manifest, { pmVersion: "2026.6.23" });
```

Tracked: [pm-ozaf](../.agents/pm/features/pm-ozaf.toon).

`preflightExtension(blueprint, { identity?, target?, declaredCapabilities? })` is the
author-time **capstone** that runs all of the above in one call — the static analog
of `createExtensionTestHarness`, which unified the runtime-test helpers. Rather than
chaining `lintExtensionBlueprint`, `synthesizeExtensionManifest`, and
`checkExtensionManifestCompatibility` (and reconciling their separate results)
before publishing, you read one `ExtensionPreflightReport`: the blueprint is always
linted; when `identity` is given the complete least-privilege manifest is synthesized
and returned; when `target` is given the synthesized bounds (or, absent an identity,
the blueprint's in-module `manifest` mirror) are version-checked. The per-stage
results are exposed unmodified (`report.blueprint` / `report.manifest` /
`report.compatibility`) alongside a flattened `report.findings` where each entry is
tagged by `source` (`"blueprint"` | `"compatibility"`); `report.ok` is `false` if any
stage produced an `error`. `assertExtensionPreflight(blueprint, options?)` is the
throwing one-line CI guard over it — it fails listing every blocking finding tagged
`[source:code]` and stays quiet on advisory warnings, returning the full report on
success:

```ts
import { preflightExtension } from "@unbrained/pm-cli/sdk";
import { assertExtensionPreflight } from "@unbrained/pm-cli/sdk/testing";

// Inspect every author-time stage in one report…
const report = preflightExtension(blueprint, {
  identity: {
    name: "command-kit",
    version: "1.0.0",
    entry: "./index.ts",
    priority: 0,
  },
  target: { pmVersion: "2026.6.23" },
});
//   report.manifest.capabilities (derived), report.compatibility.compatible, report.findings[]

// …or guard the whole package in one CI line.
assertExtensionPreflight(blueprint, {
  identity: {
    name: "command-kit",
    version: "1.0.0",
    entry: "./index.ts",
    priority: 0,
  },
  target: { pmVersion: "2026.6.23" },
});
```

Invoke a registered command handler to assert its behavior (not just that it was
registered). `runRegisteredCommandForTest` dispatches through pm's real engine and
returns the `CommandHandlerResult`:

```ts
import { runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";

const invocation = await runRegisteredCommandForTest(activation.commands, {
  command: "hello",
  options: { name: "ada" },
});

// invocation.handled === true; invocation.result is the handler's return value.
```

Importers and exporters get dedicated name-based helpers so tests never hand-build
the `"<name> import"` / `"<name> export"` command path. Pass the whole `activation`
and the registration name:

```ts
import {
  runRegisteredImporterForTest,
  runRegisteredExporterForTest,
} from "@unbrained/pm-cli/sdk/testing";

const imported = await runRegisteredImporterForTest(activation, {
  importer: "csv",
  options: { rows: 3 },
});
const exported = await runRegisteredExporterForTest(activation, {
  exporter: "csv",
});

// Both return a CommandHandlerResult: imported.result is the importer's return value.
```

Fire a registered lifecycle hook to assert its behavior (the `context` is
type-safe per `kind`). A clean run returns `[]`; a hook that throws contributes a
single `extension_hook_failed:*` warning while the others still run:

```ts
import { runRegisteredHookForTest } from "@unbrained/pm-cli/sdk/testing";

const warnings = await runRegisteredHookForTest(activation.hooks, {
  kind: "after_command",
  context: { command: "close", args: ["pm-1a2b"], pm_root: "", ok: true },
});
// warnings === [] when every after_command hook ran cleanly.
```

The override surfaces have parallel invoke helpers that delegate to pm's real
runners and return the override result verbatim, after guarding that a matching
override is registered for the target (command / format / service):

```ts
import {
  runRegisteredParserOverrideForTest,
  runRegisteredCommandOverrideForTest,
  runRegisteredRendererOverrideForTest,
  runRegisteredServiceOverrideForTest,
  runRegisteredPreflightOverrideForTest,
} from "@unbrained/pm-cli/sdk/testing";

const parsed = await runRegisteredParserOverrideForTest(activation.parsers, {
  command: "deploy",
  args: ["staging"],
  options: {},
  global: {},
  pm_root: "",
});
// parsed.overridden === true; parsed.context holds the rewritten args/options.

const rendered = await runRegisteredRendererOverrideForTest(
  activation.renderers,
  {
    format: "toon",
    result: { id: "pm-1a2b" },
  },
);
// rendered.rendered is the custom string the override produced.
```

Assert a command registration contract:

```ts
import { assertRegisteredCommandContract } from "@unbrained/pm-cli/sdk/testing";

assertRegisteredCommandContract(activation.registrations, {
  command: "hello",
  action: "hello",
  flags: ["--name"],
});
```

Assert importer, exporter, and search-provider registrations against an
`ExtensionRegistrationRegistry` (from `activation.registrations`). The optional
`extensionName` narrows the match to a single extension:

```ts
import {
  assertRegisteredExporter,
  assertRegisteredImporter,
  assertRegisteredSearchProvider,
  assertRegisteredVectorStoreAdapter,
} from "@unbrained/pm-cli/sdk/testing";

assertRegisteredImporter(activation.registrations, { importer: "jsonl" });
assertRegisteredExporter(activation.registrations, {
  exporter: "jsonl",
  extensionName: "my-ext",
});
assertRegisteredSearchProvider(activation.registrations, {
  provider: "semantic-local",
});
assertRegisteredVectorStoreAdapter(activation.registrations, {
  adapter: "pinecone",
});
```

Use `assertRegisteredVectorStoreAdapter` for packages that call
`registerVectorStoreAdapter`. It proves the semantic-storage integration is
present without importing private registry internals or configuring a live
vector store in unit tests.

Assert package-owned schema registrations the same way. This lets packages prove
their custom project-management primitives without importing private registry
types or reading generated schema files:

```ts
import {
  assertRegisteredItemField,
  assertRegisteredItemType,
} from "@unbrained/pm-cli/sdk/testing";

assertRegisteredItemField(activation.registrations, {
  field: "severity",
  extensionName: "incident-ext",
  type: "string",
});
assertRegisteredItemType(activation.registrations, {
  itemType: "Incident",
  folder: "incidents",
});
```

Hooks are surfaced via `activation.hooks` (an `ExtensionHookRegistry`), not the command
registry, so `assertRegisteredHook` takes the hook registry and a lifecycle `kind`
(`before_command` | `after_command` | `on_read` | `on_write` | `on_index`):

```ts
import { assertRegisteredHook } from "@unbrained/pm-cli/sdk/testing";

const hook = assertRegisteredHook(activation.hooks, {
  kind: "on_write",
  extensionName: "my-ext",
});
// hook.run is the registered OnWriteHook handler
```

Override registrations from `registerCommand(command, override)`, `registerParser`,
`registerPreflight`, and `registerRenderer` live on `activation.commands`,
`activation.parsers`, `activation.preflight`, and `activation.renderers` (not the
registration registry). Each override helper takes the matching registry and
returns the registered entry (so you can invoke `entry.run` directly):

```ts
import {
  assertRegisteredCommandOverride,
  assertRegisteredParserOverride,
  assertRegisteredPreflightOverride,
  assertRegisteredRendererOverride,
} from "@unbrained/pm-cli/sdk/testing";

assertRegisteredCommandOverride(activation.commands, { command: "list" });
assertRegisteredParserOverride(activation.parsers, {
  command: "list",
  extensionName: "my-ext",
});
assertRegisteredPreflightOverride(activation.preflight); // preflight overrides are global (no command)
assertRegisteredRendererOverride(activation.renderers, { format: "toon" });
```

Service overrides from `registerService(service, override)` live on
`activation.services` (an `ExtensionServiceRegistry`), so
`assertRegisteredServiceOverride` takes the service registry and a known service
name (`output_format` | `error_format` | `help_format` | `lock_acquire` |
`lock_release` | `history_append` | `item_store_write` | `item_store_delete`):

```ts
import { assertRegisteredServiceOverride } from "@unbrained/pm-cli/sdk/testing";

const service = assertRegisteredServiceOverride(activation.services, {
  service: "output_format",
  extensionName: "my-ext",
});
// service.run is the registered ServiceOverride handler
```

Schema migrations from `registerMigration(definition)` live on
`activation.registrations.migrations`. `assertRegisteredMigration` matches by the
migration `id` and can additionally assert the `mandatory` governance flag (an
unset flag is treated as non-mandatory):

```ts
import { assertRegisteredMigration } from "@unbrained/pm-cli/sdk/testing";

const migration = assertRegisteredMigration(activation.registrations, {
  migration: "backfill-severity",
  mandatory: true,
});
// migration.definition is the normalized SchemaMigrationDefinition
```

### Project profiles (`registerProfile`)

Tracked: [pm-08sv](../.agents/pm/features/pm-08sv.toon).

A **project profile** is the broadest customization primitive a package can ship:
one declarative `ProjectProfileDefinition` that bundles item types, custom
statuses, fields, per-type workflows, config knobs, create templates, and package
recommendations into a single archetype `pm profile apply` stages idempotently.
The three core archetypes (`agile`/`ops`/`research`) are baked in; a package adds
its own with `api.registerProfile(profile)` under the `schema` capability:

```ts
import { defineProjectProfile, type ExtensionApi } from "@unbrained/pm-cli/sdk";

export const kanbanProfile = defineProjectProfile({
  name: "kanban",
  title: "Kanban continuous flow",
  summary: "WIP-limited flow with a verifying stage.",
  types: [{ name: "Card", folder: "cards" }],
  statuses: [{ id: "doing", roles: ["active"] }],
  fields: [
    { key: "wip_limit", type: "number", commands: ["create", "update"] },
  ],
  workflows: [{ type: "Card", allowed_transitions: [["open", "doing"]] }],
  config: [
    {
      key: "search_provider",
      value: "bm25",
      summary: "Offline lexical search.",
    },
  ],
  templates: [{ name: "card", options: { type: "Card" } }],
  packages: [{ spec: "templates", reason: "Reusable card shapes." }],
});

export function activate(api: ExtensionApi): void {
  api.registerProfile(kanbanProfile);
}
```

Once the package is active, the profile resolves by name through `pm profile list`
(labelled with its source package), `pm profile show <name>`, and
`pm profile apply <name>` — exactly like a core archetype, with no consumer code.
Built-in names are reserved: a registered profile that collides with a core name
(or another package's profile) is ignored with a warning rather than shadowing it.
Profiles flow through the declarative loop too — `composeExtension({ profiles: [...] })`
auto-wires `registerProfile`, and `deriveExtensionCapabilities` maps a `profiles`
surface to `schema`. Prove a profile registered with `assertRegisteredProfile`:

```ts
import { assertRegisteredProfile } from "@unbrained/pm-cli/sdk/testing";

const { profile } = assertRegisteredProfile(activation.registrations, {
  profile: "kanban",
});
// profile is the normalized ProjectProfileDefinition
```

Together these complete the SDK assertion surface: every extension `register*`
method (including `registerProfile`) now has a matching `assertRegistered*`
helper, so packages can prove any registration without importing private registry
internals.

The three executable registration surfaces add `runRegistered*ForTest` invoke
helpers on top of those assertions, so a package can exercise the real behavior of
a custom provider, adapter, or migration:

```ts
import {
  runRegisteredSearchProviderForTest,
  runRegisteredVectorStoreAdapterForTest,
  runRegisteredMigrationForTest,
} from "@unbrained/pm-cli/sdk/testing";

// Invoke a registered provider's semantic query (or embed / embedBatch /
// queryExpansion / rerank); the result type follows `operation`.
const hits = await runRegisteredSearchProviderForTest(
  activation.registrations,
  {
    provider: "semantic-local",
    operation: "query",
    context: {
      query: "calendar",
      mode: "semantic",
      tokens: ["calendar"],
      options: {},
      settings,
      documents,
    },
  },
);

// Invoke a registered adapter's upsert / query / delete.
await runRegisteredVectorStoreAdapterForTest(activation.registrations, {
  adapter: "pinecone",
  operation: "upsert",
  context: { points: [{ id: "pm-1", vector }], settings },
});

// Invoke a registered migration's run with a host-shaped context.
await runRegisteredMigrationForTest(activation.registrations, {
  migration: "backfill-severity",
  pmRoot,
});
```

The bundled `pm-lifecycle-hooks` package is the first-party hooks exemplar. It
declares only the `hooks` capability and registers a default-inert `afterCommand`
hook, so package authors can copy a lifecycle pattern that does not write files,
produce output, or alter command behavior.

The bundled `pm-governance-audit` package is the governance hook exemplar. It
combines package-owned commands with `onRead` and `onWrite` hooks, declares the
`hooks` capability, and only writes a compact JSONL sidecar when
`PM_GOVERNANCE_AUDIT_HOOK_LOG` is set. Use that pattern for audit/cache/telemetry
packages that need file-level context without storing item bodies by default.

`afterCommand` receives the command outcome plus an optional `affected` array for
item mutations. Each affected entry is a compact command context:
`id`, `op`, `item_type`, `previous_status`, `status`, `changed_fields`, and
partial `previous`/`current` item metadata snapshots. Use this for
transition-aware packages such as notifications; do not parse the untyped
`result` payload when the transition fields are available.

`onWrite` receives `{ path, scope, op }` for every observed write. When the write
is tied to an item mutation, the context also includes `item_id`, `item_type`,
`before`, `after`, and `changed_fields`, so sync packages can mirror the exact
item change without reparsing files. Non-item writes omit those item fields.
`changed_fields` lists mutated fields for updates and uses lifecycle sentinels
for item lifecycle writes: `["imported"]` for package imports, `["restored"]`
for restores, and `["deleted"]` for deletes.

## Custom Item Type

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerItemTypes([
      {
        name: "Incident",
        folder: "incidents",
        aliases: ["incident"],
        required_create_fields: ["title", "description", "severity"],
        options: [
          {
            key: "severity",
            values: ["critical", "major", "minor"],
            required: true,
          },
          { key: "service", values: ["api", "web", "worker"] },
        ],
      },
    ]);

    api.registerItemFields([
      { name: "severity", type: "string" },
      { name: "service", type: "string", optional: true },
    ]);
  },
});
```

Manifest capability: `schema`.

Declared item fields are first-class create/update inputs. Agents and importers can persist extension provenance without description markers:

```bash
pm create "Import issue" --type Incident --field service=api --field severity=critical
pm update pm-1234 --field service=worker
```

`--field` accepts only fields declared by active `registerItemFields` registrations and coerces values using the declared field type.

## Importer / Exporter

`registerImporter(name, importer)` and `registerExporter(name, exporter)` register
a data adapter and automatically create a `<name> import` / `<name> export` command
path that invokes it. The handler receives an `ImportExportContext`
(`registration`, `action`, `command`, `args`, `options`, `global`, `pm_root`).

By default the auto-created command only has a handler. Pass an optional third
`ImportExportRegistrationOptions` argument to make it a first-class command with a
description, flags, intent, examples, failure hints, and positional arguments —
surfaced in `--help` and runtime contracts exactly like `registerCommand`:

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerImporter(
      "jsonl",
      async (context) => {
        // context.options.file, context.global, context.pm_root, ...
        return { ok: true, imported: 0 };
      },
      {
        action: "jsonl-import",
        description: "Import JSONL records into pm items.",
        intent: "ingest external task records",
        examples: ["pm jsonl import --file source.jsonl"],
        failure_hints: ["Verify the JSONL source path exists."],
        flags: [
          {
            long: "--file",
            value_name: "path",
            value_type: "string",
            description: "Path to the JSONL source file.",
          },
        ],
      },
    );

    api.registerExporter("jsonl", async () => ({ ok: true }), {
      description: "Export pm items to JSONL.",
    });
  },
});
```

Manifest capability: `importers` (and `schema` when supplying `flags`). The two-argument
form remains supported; supplying the options object never produces a command-handler
collision because the definition and handler share the same command path and extension.

Importers and exporters read their source/destination through flags (e.g. `--file`,
`--folder`) and take **no positional argument** unless one is declared via `arguments`.
An unexpected positional (such as `pm jsonl import data.jsonl` instead of
`pm jsonl import --file data.jsonl`) is rejected with a usage error rather than being
silently ignored, and any `failure_hints` you register are appended to that error so an
agent is steered to the correct flag. Flags declared via `flags` render once, as
first-class options in the standard `Options:` section of `--help`.

The bundled `pm-beads` and `pm-todos` packages are first-party importer/exporter
exemplars that use this registration path and expose runtime contracts for their
generated commands.

## Search Provider

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerSearchProvider({
      name: "example-search",
      async query(context) {
        return context.documents
          .filter((doc) =>
            doc.metadata.title
              ?.toLowerCase()
              .includes(context.query.toLowerCase()),
          )
          .map((doc) => ({
            id: doc.metadata.id,
            score: 0.5,
            matched_fields: ["title"],
          }));
      },
    });
  },
});
```

Manifest capability: `search`.

Core search invokes the registered `query` when `settings.search.provider` matches
the provider `name`. The bundled `pm-search-advanced` package ships a working
first-party exemplar: `searchAdvancedLocalProvider()` registers a deterministic,
dependency-free local lexical ranker named `search-advanced-local` (enable with
`pm config set search.provider search-advanced-local`). Authors building
embedding-backed providers (for example Ollama or a hosted model) implement
`embed`/`embedBatch` on the same `SearchProviderDefinition` shape, and may also
`registerVectorStoreAdapter` for a custom vector store.

Optional advanced relevance hooks:

- `queryExpansion` (or `query_expansion`) for `search.query_expansion.provider`
- `rerank` for hybrid rerank candidates when `search.rerank.enabled=true`

Both hooks are best-effort. If a hook throws or returns an invalid shape, core
search degrades gracefully and emits warning codes instead of hard-failing.

## Robust Automation Pattern

1. Read `PM_TOOL_ACTIONS` or `PM_TOOL_PARAMETERS_SCHEMA` for baseline static validation.
2. Load runtime contracts with `getContracts(pmRoot, { runtimeOnly: true })` or run `pm contracts --runtime-only --json` inside the target project.
3. Verify the action appears in `actions` and has `action_availability[].invocable: true`.
4. Validate required fields with `PM_TOOL_ACTION_PARAMETER_CONTRACTS` for static actions or the runtime schema for package actions.
5. Execute only after preflight passes.

Runnable examples:

- [SDK-only custom project tool](examples/sdk-custom-tool/README.md)
- [SDK contract consumer](examples/sdk-contract-consumer/README.md)
- [SDK app embedding](examples/sdk-app-embedding/README.md)
- [CI examples](examples/ci/)

## CLI Simplification Migration

The conservative full-surface simplification pass updated invocation parsing and error envelopes. Integration details are documented in [CLI Simplification Migration](MIGRATION_CLI_SIMPLIFICATION.md).

For SDK and automation consumers, the key runtime change is the optional `recovery` object in CLI usage/error JSON payloads:

- `attempted_command`
- `normalized_args`
- `provided_fields`
- `missing`
- `suggested_retry`

Treat `recovery.suggested_retry` as the first-choice deterministic replay command when present.

## Authoring Pattern

- Keep handlers deterministic and JSON-like.
- Return data, not pre-rendered terminal text, unless implementing a renderer or output service.
- After directly writing streaming, binary, or pre-rendered output, return
  `suppressHostOutput()` to make output ownership explicit and prevent duplicate
  CLI rendering.
- Keep service, renderer, and preflight overrides narrow. For `output_format`, return `context.payload`, `null`, or `undefined` for unrelated commands; for renderers, return `null` when the payload should fall back to native rendering.
- Declare only capabilities in use.
- Set `pm_min_version` when the package requires SDK or runtime behavior added after older pm releases.
- Include examples and failure hints in dynamic commands.
- Add `pm package doctor` diagnostics to testing instructions.

## Related Docs

- [Extensions And Packages](EXTENSIONS.md)
- [CLI Simplification Migration](MIGRATION_CLI_SIMPLIFICATION.md)
- [Architecture](ARCHITECTURE.md)
- [Starter Extension](examples/starter-extension/README.md)
