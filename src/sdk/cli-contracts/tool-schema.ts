/**
 * @module sdk/cli-contracts/tool-schema
 *
 * MCP tool-parameter schema contracts: the per-action required/optional key sets
 * and the lazily-built strict (action-scoped) and provider-compatible (flat)
 * JSON Schemas served to MCP clients, the `pm contracts` command, and SDK
 * consumers from a single source of truth.
 */
import { normalizeUniqueStringList } from "./string-lists.js";
import { PM_TOOL_ACTIONS, type PmToolAction } from "./enum-contracts.js";
import {
  TOOL_CREATE_OPTION_CONTRACTS,
  TOOL_SHARED_CREATE_UPDATE_OPTION_CONTRACTS,
  TOOL_UPDATE_OPTION_CONTRACTS,
  TOOL_UPDATE_MANY_FILTER_OPTION_CONTRACTS,
  TOOL_CONTEXT_OPTION_CONTRACTS,
  TOOL_ACTIVITY_OPTION_CONTRACTS,
  TOOL_LIST_FILTER_OPTION_CONTRACTS,
  TOOL_AGGREGATE_OPTION_CONTRACTS,
  TOOL_SEARCH_FILTER_OPTION_CONTRACTS,
  TOOL_CLOSE_MANY_FILTER_OPTION_CONTRACTS,
} from "./tool-option-contracts.js";
import {
  PM_TOOL_PARAMETER_PROPERTIES,
  PM_TOOL_PARAMETER_METADATA,
  PM_TOOL_ACTION_SCOPED_PARAMETER_METADATA,
  PLAN_ACTION_PARAMETER_PROPERTIES,
  PLAN_ACTION_PARAMETER_METADATA,
} from "./tool-parameter-tables.js";
import {
  toUniqueFlagContracts,
  withFlagAliasMetadata,
} from "./flag-contracts.js";

const PM_TOOL_GLOBAL_PARAMETER_KEYS = [
  "json",
  "quiet",
  "profile",
  "noExtensions",
  "noPager",
  "path",
  "pmExecutable",
  "timeoutMs",
] as const;

const PM_TOOL_ACTION_MUTATION_PARAMETER_KEYS: Partial<
  Record<PmToolAction, readonly string[]>
> = {
  create: ["fullChangedFields", "idOnly"],
  copy: ["fullChangedFields", "idOnly"],
  update: ["fullChangedFields", "idOnly"],
  close: ["fullChangedFields", "idOnly"],
  restore: ["fullChangedFields", "idOnly"],
  append: ["fullChangedFields"],
  "update-many": ["fullChangedFields"],
  "close-many": ["fullChangedFields"],
};

/** Runtime-consumed nested compatibility keys that intentionally sit outside the canonical strict schema. */
const PM_TOOL_ACTION_NESTED_OPTION_COMPATIBILITY_KEYS = Object.freeze({
  "close-many": [
    "list",
    "expected_result",
    "expected",
    "actual_result",
    "actual",
    "validate_close",
    "dry_run",
    "checkpoint",
    "no_checkpoint",
    "filterAssignee_filter",
  ],
  "update-many": [
    "list",
    "update",
    "dry_run",
    "checkpoint",
    "no_checkpoint",
    "filterAssignee_filter",
  ],
  ...Object.fromEntries(
    PM_TOOL_ACTIONS.filter(
      (action) =>
        action === "install" ||
        action === "extension" ||
        action === "package" ||
        action.startsWith("extension-") ||
        action.startsWith("package-"),
    ).map((action) => [action, ["project", "local", "global"]]),
  ),
}) as Readonly<Record<string, readonly string[]>>;

/** Declarative description of one pm action's MCP parameter constraints — required/optional keys plus JSON-Schema-style cross-field rules (anyOf, oneOf, conditional, dependent, and mutually-exclusive groups) — from which the strict action-scoped tool schema is built. */
export interface PmActionSchemaContract {
  /** Value that configures or reports required for this contract. */
  required?: string[];
  /** Value that configures or reports optional for this contract. */
  optional?: string[];
  /** Value that configures or reports any of required for this contract. */
  anyOfRequired?: Array<string[]>;
  /** Value that configures or reports one of required for this contract. */
  oneOfRequired?: Array<string[]>;
  /** Value that configures or reports dependent any of required for this contract. */
  dependentAnyOfRequired?: Array<{
    property: string;
    anyOfRequired: Array<string[]>;
  }>;
  /** Value that configures or reports conditional required for this contract. */
  conditionalRequired?: Array<{
    property: string;
    value: string;
    required: string[];
  }>;
  /** Groups of parameters that must not be supplied together. Each group emits a JSON Schema `not: { required: [...] }` constraint so MCP clients validating against the contract reject the same combinations the runtime rejects (e.g. focus `id` + `clear`), keeping schema and runtime in lock-step. */
  mutuallyExclusive?: Array<string[]>;
  /** Value that configures or reports mutually exclusive when for this contract. */
  mutuallyExclusiveWhen?: Array<
    Array<{
      property: string;
      schema: Record<string, unknown>;
    }>
  >;
}

function toSchemaKeyList(values: string[]): string[] {
  return normalizeUniqueStringList(values);
}

const CREATE_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_CREATE_OPTION_CONTRACTS.map((entry) => entry.param),
  ...TOOL_SHARED_CREATE_UPDATE_OPTION_CONTRACTS.map((entry) => entry.param),
  "assignee",
]);

const UPDATE_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_UPDATE_OPTION_CONTRACTS.map((entry) => entry.param),
  ...TOOL_SHARED_CREATE_UPDATE_OPTION_CONTRACTS.map((entry) => entry.param),
  "force",
]);

const UPDATE_MANY_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_UPDATE_MANY_FILTER_OPTION_CONTRACTS.map((entry) => entry.param),
  ...UPDATE_CONTRACT_PARAMETER_KEYS,
  "dryRun",
  "rollback",
  "noCheckpoint",
]);

const CLOSE_MANY_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_CLOSE_MANY_FILTER_OPTION_CONTRACTS.map((entry) => entry.param),
  "reason",
  "resolution",
  "expectedResult",
  "actualResult",
  "validateClose",
  "dryRun",
  "rollback",
  "noCheckpoint",
  "author",
  "message",
  "force",
]);

const CONTEXT_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_CONTEXT_OPTION_CONTRACTS.map((entry) => entry.param),
  "past",
  "section",
]);

const ACTIVITY_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_ACTIVITY_OPTION_CONTRACTS.map((entry) => entry.param),
  "stream",
]);

const LIST_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_LIST_FILTER_OPTION_CONTRACTS.map((entry) => entry.param),
  "includeBody",
  "noTruncate",
  "compact",
  "brief",
  "full",
]);
const LIST_WINDOW_MUTUALLY_EXCLUSIVE_GROUPS = [
  [
    { property: "today", schema: { const: true } },
    { property: "recent", schema: { const: true } },
  ],
  [
    { property: "today", schema: { const: true } },
    { property: "updatedAfter", schema: { type: "string", pattern: "\\S" } },
  ],
  [
    { property: "recent", schema: { const: true } },
    { property: "updatedAfter", schema: { type: "string", pattern: "\\S" } },
  ],
];
const CONTRACTS_PROJECTION_MUTUALLY_EXCLUSIVE_GROUPS = [
  [
    { property: "summary", schema: { const: true } },
    { property: "schemaOnly", schema: { const: true } },
  ],
  [
    { property: "summary", schema: { const: true } },
    { property: "flagsOnly", schema: { const: true } },
  ],
  [
    { property: "summary", schema: { const: true } },
    { property: "availabilityOnly", schema: { const: true } },
  ],
  [
    { property: "schemaOnly", schema: { const: true } },
    { property: "flagsOnly", schema: { const: true } },
  ],
  [
    { property: "schemaOnly", schema: { const: true } },
    { property: "availabilityOnly", schema: { const: true } },
  ],
  [
    { property: "flagsOnly", schema: { const: true } },
    { property: "availabilityOnly", schema: { const: true } },
  ],
];
const AGGREGATE_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_AGGREGATE_OPTION_CONTRACTS.map((entry) => entry.param),
  "count",
  "completion",
  "includeUnparented",
]);
const SEARCH_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  "query",
  "keywords",
  "mode",
  "semantic",
  "hybrid",
  "includeLinked",
  "titleExact",
  "phraseExact",
  "highlight",
  "compact",
  "full",
  ...TOOL_SEARCH_FILTER_OPTION_CONTRACTS.map((entry) => entry.param),
]);

const NEXT_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  "type",
  "tag",
  "priority",
  "assignee",
  "assigneeFilter",
  "sprint",
  "release",
  "parent",
  "limit",
  "blockedLimit",
  "readyOnly",
  "format",
  "includeDecisions",
  "tokenBudget",
  "explainRanking",
]);

const AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS = ["author", "message", "force"];

/** Close-action option keys shared by the strict tool schema and the typed SDK close input (pm-x29o); the author/message/force triple is appended separately by the schema contract. */
export const CLOSE_ACTION_OPTION_KEYS = [
  "text",
  "reason",
  "closeReason",
  "duplicateOf",
  "validateClose",
  "resolution",
  "expectedResult",
  "actualResult",
] as const;
const LIFECYCLE_AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS = [
  "author",
  "assignee",
  "message",
  "force",
];

const MANAGED_EXTENSION_PACKAGE_OPTION_KEYS = [
  "target",
  "scope",
  "github",
  "ref",
  "init",
  "install",
  "uninstall",
  "explore",
  "manage",
  "describe",
  "markdown",
  "output",
  "reload",
  "doctor",
  "catalog",
  "adopt",
  "adoptAll",
  "activate",
  "deactivate",
  "runtimeProbe",
  "fixManagedState",
  "isolated",
  "ignoreGlobal",
  "detail",
  "trace",
  "watch",
  "strictExit",
  "failOnWarn",
];

function managedLifecycleSchemaContracts(
  prefix: "extension" | "package",
): Record<string, PmActionSchemaContract> {
  return {
    [`${prefix}-init`]: { required: ["target"], optional: ["scope"] },
    [`${prefix}-install`]: {
      optional: ["target", "github", "scope", "ref"],
      anyOfRequired: [["target"], ["github"]],
    },
    [`${prefix}-uninstall`]: { required: ["target"], optional: ["scope"] },
    [`${prefix}-explore`]: { optional: ["scope"] },
    [`${prefix}-manage`]: {
      optional: ["scope", "runtimeProbe", "fixManagedState"],
    },
    [`${prefix}-describe`]: {
      optional: ["target", "scope", "markdown", "output"],
    },
    [`${prefix}-reload`]: { optional: ["scope", "watch"] },
    [`${prefix}-doctor`]: {
      optional: [
        "scope",
        "detail",
        "trace",
        "fixManagedState",
        "isolated",
        "ignoreGlobal",
        "strictExit",
        "failOnWarn",
      ],
    },
    [`${prefix}-catalog`]: { optional: ["scope", "fields"] },
    [`${prefix}-adopt`]: {
      required: ["target"],
      optional: ["scope", "github", "ref"],
    },
    [`${prefix}-adopt-all`]: { optional: ["scope"] },
    [`${prefix}-activate`]: { required: ["target"], optional: ["scope"] },
    [`${prefix}-deactivate`]: { required: ["target"], optional: ["scope"] },
    [prefix]: {
      optional: MANAGED_EXTENSION_PACKAGE_OPTION_KEYS,
    },
  };
}

const PM_TOOL_ACTION_SCHEMA_CONTRACTS: Record<string, PmActionSchemaContract> =
  {
    init: {
      optional: [
        "prefix",
        "preset",
        "typePreset",
        "defaults",
        "author",
        "agentGuidance",
        "withPackages",
        "force",
        "verbose",
      ],
    },
    config: {
      required: ["scope", "configAction"],
      optional: [
        "key",
        "value",
        "criterion",
        "clearCriteria",
        "format",
        "policy",
      ],
    },
    ...managedLifecycleSchemaContracts("extension"),
    ...managedLifecycleSchemaContracts("package"),
    install: {
      optional: ["target", "github", "scope", "ref"],
      anyOfRequired: [["target"], ["github"]],
    },
    upgrade: {
      optional: [
        "target",
        "scope",
        "dryRun",
        "cliOnly",
        "packagesOnly",
        "repair",
        "tag",
        "packageName",
      ],
    },
    create: {
      required: [
        "title",
        "description",
        "type",
        "status",
        "priority",
        "message",
      ],
      optional: CREATE_CONTRACT_PARAMETER_KEYS,
    },
    copy: { required: ["id"], optional: ["title", "author", "message"] },
    focus: { optional: ["id", "clear"], mutuallyExclusive: [["id", "clear"]] },
    list: {
      optional: LIST_CONTRACT_PARAMETER_KEYS,
      mutuallyExclusiveWhen: LIST_WINDOW_MUTUALLY_EXCLUSIVE_GROUPS,
    },
    "list-all": {
      optional: LIST_CONTRACT_PARAMETER_KEYS,
      mutuallyExclusiveWhen: LIST_WINDOW_MUTUALLY_EXCLUSIVE_GROUPS,
    },
    "list-draft": {
      optional: LIST_CONTRACT_PARAMETER_KEYS,
      mutuallyExclusiveWhen: LIST_WINDOW_MUTUALLY_EXCLUSIVE_GROUPS,
    },
    "list-open": {
      optional: LIST_CONTRACT_PARAMETER_KEYS,
      mutuallyExclusiveWhen: LIST_WINDOW_MUTUALLY_EXCLUSIVE_GROUPS,
    },
    "list-in-progress": {
      optional: LIST_CONTRACT_PARAMETER_KEYS,
      mutuallyExclusiveWhen: LIST_WINDOW_MUTUALLY_EXCLUSIVE_GROUPS,
    },
    "list-blocked": {
      optional: LIST_CONTRACT_PARAMETER_KEYS,
      mutuallyExclusiveWhen: LIST_WINDOW_MUTUALLY_EXCLUSIVE_GROUPS,
    },
    "list-closed": {
      optional: LIST_CONTRACT_PARAMETER_KEYS,
      mutuallyExclusiveWhen: LIST_WINDOW_MUTUALLY_EXCLUSIVE_GROUPS,
    },
    "list-canceled": {
      optional: LIST_CONTRACT_PARAMETER_KEYS,
      mutuallyExclusiveWhen: LIST_WINDOW_MUTUALLY_EXCLUSIVE_GROUPS,
    },
    aggregate: { optional: AGGREGATE_CONTRACT_PARAMETER_KEYS },
    guide: { optional: ["list", "format", "depth"] },
    context: { optional: CONTEXT_CONTRACT_PARAMETER_KEYS },
    ctx: { optional: CONTEXT_CONTRACT_PARAMETER_KEYS },
    get: {
      required: ["id"],
      optional: ["depth", "full", "fields", "tree", "treeDepth", "format"],
    },
    search: {
      optional: SEARCH_CONTRACT_PARAMETER_KEYS,
      anyOfRequired: [["query"], ["keywords"]],
    },
    next: { optional: NEXT_CONTRACT_PARAMETER_KEYS },
    reindex: { optional: ["mode", "progress"] },
    history: {
      required: ["id"],
      optional: ["limit", "compact", "full", "diff", "verify", "format"],
    },
    "history-redact": {
      required: ["id"],
      optional: [
        "literal",
        "regex",
        "replacement",
        "dryRun",
        ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
      ],
      anyOfRequired: [["literal"], ["regex"]],
    },
    "history-repair": {
      // Exactly one of `id` (single stream) or `all` (bulk drift repair) is required.
      optional: ["id", "all", "dryRun", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS],
      oneOfRequired: [["id"], ["all"]],
    },
    "history-compact": {
      // Single-id mode (`id` + optional `before`) or bulk mode (any of `ids` /
      // `allOver` / `closed` / `allStreams`, with optional `minEntries`). Scan
      // selectors (`allOver` + `closed`/`allStreams`) legitimately combine, so the
      // mode/exclusivity contract is enforced at runtime by assertHistoryCompactTarget
      // rather than a one-of schema rule.
      optional: [
        "id",
        "before",
        "ids",
        "allOver",
        "closed",
        "allStreams",
        "minEntries",
        "dryRun",
        ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
      ],
    },
    schema: {
      required: ["subcommand"],
      // No --message: schema mutations write config files, not item history.
      optional: [
        "name",
        "description",
        "defaultStatus",
        "folder",
        "alias",
        "role",
        "order",
        "fieldType",
        "commands",
        "cliFlag",
        "required",
        "requiredOnCreate",
        "allowUnset",
        "requiredTypes",
        "typePreset",
        "infer",
        "minCount",
        "apply",
        "to",
        "migrationId",
        "fieldTypeScope",
        "dryRun",
        "author",
        "force",
      ],
      conditionalRequired: [
        { property: "subcommand", value: "show", required: ["name"] },
        { property: "subcommand", value: "show-status", required: ["name"] },
        { property: "subcommand", value: "add-type", required: ["name"] },
        { property: "subcommand", value: "remove-type", required: ["name"] },
        // show-status/add-status/remove-status pass the status id as `name`.
        { property: "subcommand", value: "add-status", required: ["name"] },
        { property: "subcommand", value: "remove-status", required: ["name"] },
        // field subcommands pass the field key as `name`.
        { property: "subcommand", value: "add-field", required: ["name"] },
        { property: "subcommand", value: "remove-field", required: ["name"] },
        { property: "subcommand", value: "show-field", required: ["name"] },
        {
          property: "subcommand",
          value: "rename-type",
          required: ["name", "to", "migrationId"],
        },
        {
          property: "subcommand",
          value: "rename-field",
          required: ["name", "to", "migrationId"],
        },
        {
          property: "subcommand",
          value: "remap-status",
          required: ["name", "to", "migrationId"],
        },
        // apply-preset passes the preset name as `typePreset`.
        {
          property: "subcommand",
          value: "apply-preset",
          required: ["typePreset"],
        },
      ],
    },
    profile: {
      required: ["subcommand"],
      // No --message: profile staging writes config/schema files, not item history.
      optional: ["name", "dryRun", "author", "force"],
      conditionalRequired: [
        { property: "subcommand", value: "show", required: ["name"] },
        { property: "subcommand", value: "apply", required: ["name"] },
        { property: "subcommand", value: "lint", required: ["name"] },
      ],
    },
    plan: {
      required: ["subcommand"],
      optional: [
        "id",
        "stepRef",
        "reorderTo",
        "title",
        "description",
        "scope",
        "parent",
        "related",
        "blocks",
        "blockedBy",
        "harness",
        "mode",
        "resumeContext",
        "tags",
        "priority",
        "status",
        "createMode",
        "deadline",
        "estimate",
        "acceptanceCriteria",
        "definitionOfReady",
        "order",
        "rank",
        "goal",
        "objective",
        "value",
        "impact",
        "outcome",
        "whyNow",
        "assignee",
        "reviewer",
        "risk",
        "confidence",
        "sprint",
        "release",
        "blockedReason",
        "unblockNote",
        "reporter",
        "severity",
        "environment",
        "reproSteps",
        "resolution",
        "expectedResult",
        "actualResult",
        "affectedVersion",
        "fixedVersion",
        "component",
        "regression",
        "customerImpact",
        "comment",
        "note",
        "learning",
        "reminder",
        "event",
        "typeOption",
        "body",
        "claim",
        "fromSearch",
        "stepTitle",
        "step",
        "stepBody",
        "stepOwner",
        "stepStatus",
        "stepEvidence",
        "stepBlockedReason",
        "stepReplacement",
        "dependsOn",
        "link",
        "linkKind",
        "linkNote",
        "promoteToItemDep",
        "allowMultipleActive",
        "file",
        "test",
        "doc",
        "decisionText",
        "decision",
        "decisionRationale",
        "decisionEvidence",
        "discoveryText",
        "discovery",
        "validationText",
        "validation",
        "validationCommand",
        "validationExpected",
        "depth",
        "fields",
        "steps",
        "materializeType",
        "materializeParent",
        "materializeTags",
        "field",
        ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
      ],
    },
    activity: { optional: ACTIVITY_CONTRACT_PARAMETER_KEYS },
    restore: {
      required: ["id", "target"],
      optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
    },
    update: { required: ["id"], optional: UPDATE_CONTRACT_PARAMETER_KEYS },
    "update-many": { optional: UPDATE_MANY_CONTRACT_PARAMETER_KEYS },
    close: {
      required: ["id"],
      optional: [
        ...CLOSE_ACTION_OPTION_KEYS,
        ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
      ],
    },
    "close-many": { optional: CLOSE_MANY_CONTRACT_PARAMETER_KEYS },
    delete: {
      required: ["id"],
      optional: ["dryRun", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS],
    },
    append: {
      required: ["id", "body"],
      optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
    },
    comments: {
      required: ["id"],
      optional: [
        "text",
        "add",
        "stdin",
        "edit",
        "delete",
        "limit",
        ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
      ],
    },
    notes: {
      required: ["id"],
      optional: [
        "text",
        "add",
        "stdin",
        "edit",
        "delete",
        "limit",
        ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
      ],
    },
    learnings: {
      required: ["id"],
      optional: [
        "text",
        "add",
        "stdin",
        "edit",
        "delete",
        "limit",
        ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
      ],
    },
    files: {
      required: ["id"],
      optional: [
        "add",
        "addGlob",
        "remove",
        "migrate",
        "list",
        // GH-170 (pm-pfnx): `addNote` is the MCP spelling of the CLI --note flag
        // (the shared `note` parameter is the array-typed create/update note
        // seed, so files/docs use a distinct single-string key).
        "addNote",
        "discover",
        "apply",
        "discoveryNote",
        "appendStable",
        "validatePaths",
        ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
      ],
      dependentAnyOfRequired: [
        { property: "addNote", anyOfRequired: [["add"], ["addGlob"]] },
      ],
    },
    docs: {
      required: ["id"],
      optional: [
        "add",
        "addGlob",
        "remove",
        "migrate",
        "addNote",
        "list",
        "validatePaths",
        ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
      ],
      dependentAnyOfRequired: [
        { property: "addNote", anyOfRequired: [["add"], ["addGlob"]] },
      ],
    },
    deps: {
      required: ["id"],
      optional: [
        "format",
        "maxDepth",
        "collapse",
        "summary",
        "nodeLimit",
        "edgeLimit",
        "tokenBudget",
        "cursor",
        "direction",
        "kind",
      ],
    },
    graph: {
      required: ["subcommand"],
      optional: [
        "id",
        "target",
        "kind",
        "maxDepth",
        "limit",
        "after",
        "direction",
        "maxPaths",
        "sample",
        "exemptIsolate",
        "exemptIsolateType",
        "saveBaseline",
        "rebuild",
        "clear",
        "summary",
      ],
    },
    test: {
      required: ["id"],
      optional: [
        "add",
        "addJson",
        "remove",
        "run",
        "match",
        "onlyIndex",
        "onlyLast",
        "background",
        "timeout",
        "progress",
        "envSet",
        "envClear",
        "sharedHostSafe",
        "pmContext",
        "overrideLinkedPmContext",
        "failOnContextMismatch",
        "failOnSkipped",
        "failOnEmptyTestRun",
        "requireAssertionsForPm",
        "checkContext",
        "autoPmContext",
        ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
      ],
    },
    "test-all": {
      optional: [
        "status",
        "limit",
        "offset",
        "background",
        "timeout",
        "progress",
        "envSet",
        "envClear",
        "sharedHostSafe",
        "pmContext",
        "overrideLinkedPmContext",
        "failOnContextMismatch",
        "failOnSkipped",
        "failOnEmptyTestRun",
        "requireAssertionsForPm",
        "checkContext",
        "autoPmContext",
      ],
    },
    telemetry: {
      optional: ["subcommand", "limit"],
    },
    "test-runs-list": {
      optional: ["status", "limit"],
    },
    "test-runs-status": {
      required: ["runId"],
    },
    "test-runs-logs": {
      required: ["runId"],
      optional: ["stream", "tail"],
    },
    "test-runs-stop": {
      required: ["runId"],
      optional: ["force"],
    },
    "test-runs-resume": {
      required: ["runId"],
      optional: ["author"],
    },
    stats: {
      optional: [
        "storage",
        "metadataCoverage",
        "fieldUtilization",
        "byAssignee",
        "byTag",
        "byPriority",
        "tagPrefix",
      ],
    },
    health: {
      optional: [
        "strictDirectories",
        "strictExit",
        "failOnWarn",
        "checkOnly",
        "checkTelemetry",
        "noRefresh",
        "refreshVectors",
        "verboseStaleItems",
        "brief",
        "summary",
        "skipVectors",
        "skipIntegrity",
        "skipDrift",
        "full",
      ],
    },
    validate: {
      optional: [
        "checkMetadata",
        "metadataProfile",
        "checkResolution",
        "checkLifecycle",
        "checkStaleBlockers",
        "dependencyCycleSeverity",
        "parentCycleSeverity",
        "checkFiles",
        "scanMode",
        "includePmInternals",
        "verboseFileLists",
        "verboseDiagnostics",
        "allAffectedIds",
        "strictExit",
        "failOnWarn",
        "fixHints",
        "autoFix",
        "dryRun",
        "fixScope",
        "pruneMissing",
        "checkHistoryDrift",
        "checkCommandReferences",
      ],
    },
    gc: { optional: ["dryRun", "gcScope"] },
    contracts: {
      optional: [
        "contractAction",
        "command",
        "summary",
        "schemaOnly",
        "flagsOnly",
        "availabilityOnly",
        "runtimeOnly",
        "activeOnly",
        "full",
      ],
      mutuallyExclusiveWhen: CONTRACTS_PROJECTION_MUTUALLY_EXCLUSIVE_GROUPS,
    },
    completion: { required: ["shell"], optional: ["eagerTags"] },
    claim: {
      optional: [
        "id",
        "next",
        "ifAvailable",
        "maxAttempts",
        "includeDecisions",
        ...NEXT_CONTRACT_PARAMETER_KEYS,
        ...LIFECYCLE_AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
      ],
      oneOfRequired: [["id"], ["next"]],
    },
    release: {
      required: ["id"],
      optional: LIFECYCLE_AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
    },
    "start-task": {
      required: ["id"],
      optional: LIFECYCLE_AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
    },
    "pause-task": {
      required: ["id"],
      optional: LIFECYCLE_AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
    },
    "close-task": {
      required: ["id"],
      optional: [
        "text",
        "validateClose",
        ...LIFECYCLE_AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
      ],
    },
  };

/** Public contract for pm tool action parameter contracts, shared by SDK and presentation-layer consumers. */
export const PM_TOOL_ACTION_PARAMETER_CONTRACTS: Readonly<
  Record<PmToolAction, PmActionSchemaContract>
> = Object.freeze(
  Object.fromEntries(
    PM_TOOL_ACTIONS.map((action) => [
      action,
      PM_TOOL_ACTION_SCHEMA_CONTRACTS[action],
    ]),
  ),
) as Readonly<Record<PmToolAction, PmActionSchemaContract>>;

function fallbackToolParameterDescription(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .trim()
    .replace(/^./, (value) => value.toUpperCase())
    .concat(".");
}

function decorateToolParameterDefinition(
  key: string,
  definition: unknown,
): Record<string, unknown> {
  const baseDefinition =
    typeof definition === "object" && definition !== null
      ? { ...(definition as Record<string, unknown>) }
      : {};
  const metadata = PM_TOOL_PARAMETER_METADATA[key];
  return {
    ...baseDefinition,
    description: metadata?.description ?? fallbackToolParameterDescription(key),
    ...(metadata?.examples ? { examples: metadata.examples } : {}),
  };
}

function actionScopedToolParameterMetadata(
  action: PmToolAction,
  key: string,
): { description: string; examples?: unknown[] } | undefined {
  if (
    action === "plan" &&
    Object.prototype.hasOwnProperty.call(PLAN_ACTION_PARAMETER_METADATA, key)
  ) {
    return PLAN_ACTION_PARAMETER_METADATA[key];
  }
  const actionOverrides = PM_TOOL_ACTION_SCOPED_PARAMETER_METADATA[action];
  if (
    actionOverrides &&
    Object.prototype.hasOwnProperty.call(actionOverrides, key)
  ) {
    return actionOverrides[key];
  }
  return PM_TOOL_PARAMETER_METADATA[key];
}

function decorateActionScopedToolParameterDefinition(
  action: PmToolAction,
  key: string,
  definition: unknown,
): Record<string, unknown> {
  const baseDefinition =
    typeof definition === "object" && definition !== null
      ? { ...(definition as Record<string, unknown>) }
      : {};
  const metadata = actionScopedToolParameterMetadata(action, key);
  return {
    ...baseDefinition,
    description: metadata?.description ?? fallbackToolParameterDescription(key),
    ...(metadata?.examples ? { examples: metadata.examples } : {}),
  };
}

function actionScopedToolParameterDefinition(
  action: PmToolAction,
  key: string,
): unknown {
  if (
    action === "plan" &&
    Object.prototype.hasOwnProperty.call(PLAN_ACTION_PARAMETER_PROPERTIES, key)
  ) {
    return PLAN_ACTION_PARAMETER_PROPERTIES[key];
  }
  if (
    (action === "get" || action === "history" || action === "search") &&
    key === "format"
  ) {
    return { type: "string", enum: ["json", "toon"] };
  }
  return PM_TOOL_PARAMETER_PROPERTIES[key];
}

/** Build the `properties` map for one action-scoped schema: the fixed `action` literal followed by every allowed parameter that resolves to a concrete definition, each decorated with its action-scoped description and examples. */
function buildActionScopedSchemaProperties(
  action: PmToolAction,
  allowedKeys: string[],
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    action: {
      const: action,
      description:
        PM_TOOL_PARAMETER_METADATA.action?.description ??
        "Tool action to execute.",
    },
  };
  for (const key of allowedKeys) {
    if (key === "action") {
      continue;
    }
    const definition = actionScopedToolParameterDefinition(action, key);
    if (definition) {
      properties[key] = decorateActionScopedToolParameterDefinition(
        action,
        key,
        definition,
      );
    }
  }
  return properties;
}

/** Build the `oneOf` branches for an action whose contract requires exactly one of several field groups. Each branch requires its own group and — when sibling groups exist — forbids any field drawn from them, so the schema rejects the same overlapping combinations the runtime rejects; `history-repair`'s `all` branch additionally pins `all` to the literal `true`. */
function buildOneOfSchemaEntries(
  action: PmToolAction,
  oneOfRequiredGroups: Array<string[]>,
): Array<Record<string, unknown>> {
  const allOneOfFields = oneOfRequiredGroups.flat();
  return oneOfRequiredGroups.map((requiredFields) => {
    const otherFields = allOneOfFields.filter(
      (field) => !requiredFields.includes(field),
    );
    return {
      required: [...requiredFields],
      ...(otherFields.length > 0
        ? {
            not: { anyOf: otherFields.map((field) => ({ required: [field] })) },
          }
        : {}),
      ...(action === "history-repair" && requiredFields.includes("all")
        ? { properties: { all: { const: true } } }
        : action === "claim" && requiredFields.includes("next")
          ? { properties: { next: { const: true } } }
          : {}),
    };
  });
}

/** Build the consolidated `allOf` constraint list for an action's contract, appending branches in a fixed order — conditional-required (`if`/`then`), then dependent any-of-required, then mutually-exclusive (`not`/`required`) — so a given contract always serializes to a byte-identical schema. Returns an empty array when the contract declares none of these constraints, letting the caller omit the `allOf` key entirely. */
function buildActionScopedAllOf(
  contract: PmActionSchemaContract,
): Array<Record<string, unknown>> {
  const allOf: Array<Record<string, unknown>> = [];
  if (contract.conditionalRequired && contract.conditionalRequired.length > 0) {
    for (const entry of contract.conditionalRequired) {
      allOf.push({
        if: {
          properties: {
            [entry.property]: { const: entry.value },
          },
          required: [entry.property],
        },
        // eslint-disable-next-line unicorn/no-thenable -- JSON Schema conditional keyword, not a Promise-like object.
        then: {
          required: entry.required,
        },
      });
    }
  }
  if (
    contract.dependentAnyOfRequired &&
    contract.dependentAnyOfRequired.length > 0
  ) {
    for (const entry of contract.dependentAnyOfRequired) {
      allOf.push({
        if: { required: [entry.property] },
        // eslint-disable-next-line unicorn/no-thenable -- JSON Schema conditional keyword, not a Promise-like object.
        then: {
          anyOf: entry.anyOfRequired.map((requiredFields) => ({
            required: [...requiredFields],
          })),
        },
      });
    }
  }
  if (contract.mutuallyExclusive && contract.mutuallyExclusive.length > 0) {
    for (const group of contract.mutuallyExclusive) {
      allOf.push({ not: { required: toSchemaKeyList(group) } });
    }
  }
  if (
    contract.mutuallyExclusiveWhen &&
    contract.mutuallyExclusiveWhen.length > 0
  ) {
    for (const group of contract.mutuallyExclusiveWhen) {
      allOf.push({
        not: {
          allOf: group.map((condition) => ({
            properties: { [condition.property]: condition.schema },
            required: [condition.property],
          })),
        },
      });
    }
  }
  return allOf;
}

/**
 * Return the complete allowed parameter-key set for one pm action — the fixed
 * `action` selector, global transport parameters, mutation projection keys,
 * and the action contract's required and optional keys — or `undefined` for
 * an action the contract tables do not describe (extension- and package-owned
 * actions accept arbitrary passthrough keys by design). This is the single
 * source of truth shared by the strict action-scoped schema builder and the
 * MCP server's unknown-option detection.
 */
export function pmToolActionParameterKeys(
  action: string,
): string[] | undefined {
  if (
    !Object.prototype.hasOwnProperty.call(
      PM_TOOL_ACTION_SCHEMA_CONTRACTS,
      action,
    )
  ) {
    return undefined;
  }
  const contract = PM_TOOL_ACTION_SCHEMA_CONTRACTS[action as PmToolAction];
  const mutationParameterKeys =
    PM_TOOL_ACTION_MUTATION_PARAMETER_KEYS[action as PmToolAction] ?? [];
  return toSchemaKeyList([
    "action",
    ...PM_TOOL_GLOBAL_PARAMETER_KEYS,
    ...mutationParameterKeys,
    ...(contract.required ?? []),
    ...(contract.optional ?? []),
  ]);
}

/**
 * Return every key the runtime consumes from a nested MCP `options` object.
 * Canonical action parameters remain the baseline; this adds only the
 * action-scoped compatibility grammar that is intentionally normalized before
 * dispatch (bulk list/update wrappers, legacy bulk aliases, and managed
 * extension/package scope aliases). Keeping these keys beside the strict
 * contracts prevents typo warnings from describing valid compatibility input
 * as a no-op without weakening detection on unrelated actions.
 */
export function pmToolActionNestedOptionKeys(
  action: string,
): string[] | undefined {
  const parameterKeys = pmToolActionParameterKeys(action);
  if (parameterKeys === undefined) return undefined;
  return toSchemaKeyList([
    ...parameterKeys,
    ...(PM_TOOL_ACTION_NESTED_OPTION_COMPATIBILITY_KEYS[action] ?? []),
  ]);
}

function buildActionScopedToolSchema(
  action: PmToolAction,
): Record<string, unknown> {
  const contract = PM_TOOL_ACTION_SCHEMA_CONTRACTS[action];
  const required = toSchemaKeyList(contract.required ?? []);
  const allowedKeys = pmToolActionParameterKeys(action)!;
  const schema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    required: ["action", ...required],
    title: `pm action "${action}" parameters`,
    properties: buildActionScopedSchemaProperties(action, allowedKeys),
  };
  if (contract.anyOfRequired && contract.anyOfRequired.length > 0) {
    schema.anyOf = contract.anyOfRequired.map((requiredFields) => ({
      required: [...requiredFields],
    }));
  }
  if (contract.oneOfRequired && contract.oneOfRequired.length > 0) {
    schema.oneOf = buildOneOfSchemaEntries(action, contract.oneOfRequired);
  }
  const allOf = buildActionScopedAllOf(contract);
  if (allOf.length > 0) {
    schema.allOf = allOf;
  }
  return schema;
}

// Building the full MCP tool-parameter schemas (one variant per action) is only
// needed by the MCP server, the `pm contracts` command, and SDK consumers — never
// on the hot CLI path that imports this module for flag contracts. Wrap them in a
// memoized lazy Proxy so the build is deferred until first property access and the
// object API (`.type`, `.oneOf`, spread, JSON.stringify) stays identical.
function createLazyContractSchema(
  build: () => Record<string, unknown>,
): Record<string, unknown> {
  let value: Record<string, unknown> | undefined;
  const resolve = (): Record<string, unknown> => (value ??= build());
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => resolve()[prop as string],
    has: (_target, prop) => prop in resolve(),
    ownKeys: () => Reflect.ownKeys(resolve()),
    getOwnPropertyDescriptor: (_target, prop) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(resolve(), prop);
      if (descriptor) {
        descriptor.configurable = true;
      }
      return descriptor;
    },
  });
}

/** Canonical version of the action-scoped strict MCP tool-parameters schema (`PM_TOOL_PARAMETERS_SCHEMA`). Exported as the single source of truth so the MCP server, the `pm contracts` command, SDK consumers, and the contract tests all bind to one constant instead of re-typing the `"4.0.2"` literal (pm-r9sz). Bump the patch/minor for additive, backward-compatible schema changes; bump the MAJOR for breaking changes — the major also drives the `$id` `tool-parameters-v{major}` slug, so the two never drift. */
export const PM_TOOL_PARAMETERS_SCHEMA_VERSION = "4.0.7" as const;

/**
 * Major component of {@link PM_TOOL_PARAMETERS_SCHEMA_VERSION}, used to build the
 * schema `$id` slug so a breaking version bump renames the document in lockstep.
 */
export const PM_TOOL_PARAMETERS_SCHEMA_MAJOR =
  PM_TOOL_PARAMETERS_SCHEMA_VERSION.split(".")[0];

/** Version of the provider-compatible flat tool-parameters schema (`PM_PROVIDER_TOOL_PARAMETERS_SCHEMA`). Tracked separately from the strict schema because the flat projection evolves independently. */
export const PM_PROVIDER_TOOL_PARAMETERS_SCHEMA_VERSION = "1.0.0" as const;

/** Public contract for pm tool parameters schema, shared by SDK and presentation-layer consumers. */
export const PM_TOOL_PARAMETERS_SCHEMA: Record<string, unknown> =
  createLazyContractSchema(() => ({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://schema.unbrained.dev/pm-cli/tool-parameters-v${PM_TOOL_PARAMETERS_SCHEMA_MAJOR}.schema.json`,
    title: "pm-cli tool parameters (action-scoped strict schema)",
    "x-schema-version": PM_TOOL_PARAMETERS_SCHEMA_VERSION,
    type: "object",
    oneOf: PM_TOOL_ACTIONS.map((action) => buildActionScopedToolSchema(action)),
  }));

function toProviderCompatibleParameterDefinition(
  key: string,
  definition: unknown,
): Record<string, unknown> {
  const decorated = decorateToolParameterDefinition(key, definition);
  if (typeof decorated.type === "string") {
    return decorated;
  }
  const anyOf = Array.isArray(decorated.anyOf)
    ? (decorated.anyOf as Array<Record<string, unknown>>)
    : [];
  const firstTypedVariant = anyOf.find(
    (variant) => typeof variant.type === "string",
  );
  if (firstTypedVariant) {
    const { anyOf: _anyOf, ...rest } = decorated;
    // Spread the whole typed variant (type plus any enum/minimum/maximum/pattern
    // constraints) so the flat provider schema keeps the variant's validation,
    // then let the decorated top-level fields (description, examples) win.
    return {
      ...firstTypedVariant,
      ...rest,
    };
  }
  const { anyOf: _anyOf, ...rest } = decorated;
  return {
    ...rest,
    type: "string",
  };
}

function buildProviderCompatibleToolSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    action: {
      type: "string",
      description:
        PM_TOOL_PARAMETER_METADATA.action?.description ??
        "Tool action to execute.",
    },
    options: {
      type: "object",
      additionalProperties: true,
      description:
        "Advanced command options object forwarded to the selected pm action.",
    },
  };
  for (const key of Object.keys(PM_TOOL_PARAMETER_PROPERTIES).sort()) {
    properties[key] = toProviderCompatibleParameterDefinition(
      key,
      PM_TOOL_PARAMETER_PROPERTIES[key],
    );
  }
  return {
    title: "pm-cli tool parameters (provider-compatible flat schema)",
    "x-schema-version": PM_PROVIDER_TOOL_PARAMETERS_SCHEMA_VERSION,
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties,
  };
}

/** Public contract for pm provider tool parameters schema, shared by SDK and presentation-layer consumers. */
export const PM_PROVIDER_TOOL_PARAMETERS_SCHEMA: Record<string, unknown> =
  createLazyContractSchema(buildProviderCompatibleToolSchema);

/** Public contract for test only cli contracts, shared by SDK and presentation-layer consumers. */
export const _testOnlyCliContracts = {
  buildActionScopedToolSchema,
  buildProviderCompatibleToolSchema,
  decorateActionScopedToolParameterDefinition,
  decorateToolParameterDefinition,
  toolActionSchemaContracts: PM_TOOL_ACTION_SCHEMA_CONTRACTS,
  toolParameterMetadata: PM_TOOL_PARAMETER_METADATA,
  toProviderCompatibleParameterDefinition,
  toUniqueFlagContracts,
  withFlagAliasMetadata,
};
