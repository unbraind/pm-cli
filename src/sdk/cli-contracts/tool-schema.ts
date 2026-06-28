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
  TOOL_NORMALIZE_FILTER_OPTION_CONTRACTS,
  TOOL_CONTEXT_OPTION_CONTRACTS,
  TOOL_ACTIVITY_OPTION_CONTRACTS,
  TOOL_LIST_FILTER_OPTION_CONTRACTS,
  TOOL_AGGREGATE_OPTION_CONTRACTS,
  TOOL_DEDUPE_AUDIT_OPTION_CONTRACTS,
  TOOL_SEARCH_FILTER_OPTION_CONTRACTS,
  TOOL_CLOSE_MANY_FILTER_OPTION_CONTRACTS,
} from "./tool-option-contracts.js";
import {
  PM_TOOL_PARAMETER_PROPERTIES,
  PM_TOOL_PARAMETER_METADATA,
  PLAN_ACTION_PARAMETER_PROPERTIES,
  PLAN_ACTION_PARAMETER_METADATA,
} from "./tool-parameter-tables.js";
import { toUniqueFlagContracts, withFlagAliasMetadata } from "./flag-contracts.js";

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

const PM_TOOL_ACTION_MUTATION_PARAMETER_KEYS: Partial<Record<PmToolAction, readonly string[]>> = {
  create: ["fullChangedFields", "idOnly"],
  copy: ["fullChangedFields", "idOnly"],
  update: ["fullChangedFields", "idOnly"],
  close: ["fullChangedFields", "idOnly"],
  append: ["fullChangedFields"],
  "update-many": ["fullChangedFields"],
  "close-many": ["fullChangedFields"],
};

/**
 * Declarative description of one pm action's MCP parameter constraints —
 * required/optional keys plus JSON-Schema-style cross-field rules (anyOf, oneOf,
 * conditional, dependent, and mutually-exclusive groups) — from which the strict
 * action-scoped tool schema is built.
 */
export interface PmActionSchemaContract {
  required?: string[];
  optional?: string[];
  anyOfRequired?: Array<string[]>;
  oneOfRequired?: Array<string[]>;
  dependentAnyOfRequired?: Array<{
    property: string;
    anyOfRequired: Array<string[]>;
  }>;
  conditionalRequired?: Array<{
    property: string;
    value: string;
    required: string[];
  }>;
  /**
   * Groups of parameters that must not be supplied together. Each group emits a
   * JSON Schema `not: { required: [...] }` constraint so MCP clients validating
   * against the contract reject the same combinations the runtime rejects
   * (e.g. focus `id` + `clear`), keeping schema and runtime in lock-step.
   */
  mutuallyExclusive?: Array<string[]>;
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

const NORMALIZE_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_NORMALIZE_FILTER_OPTION_CONTRACTS.map((entry) => entry.param),
  "dryRun",
  "apply",
  "author",
  "message",
  "allowAuditUpdate",
  "force",
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
const AGGREGATE_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_AGGREGATE_OPTION_CONTRACTS.map((entry) => entry.param),
  "count",
  "completion",
  "includeUnparented",
]);
const DEDUPE_AUDIT_CONTRACT_PARAMETER_KEYS = toSchemaKeyList(TOOL_DEDUPE_AUDIT_OPTION_CONTRACTS.map((entry) => entry.param));
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
]);

const AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS = ["author", "message", "force"];

const PM_TOOL_ACTION_SCHEMA_CONTRACTS: Record<string, PmActionSchemaContract> = {
  init: { optional: ["prefix", "preset", "typePreset", "defaults", "author", "agentGuidance", "withPackages", "force", "verbose"] },
  config: {
    required: ["scope", "configAction"],
    optional: ["key", "value", "criterion", "clearCriteria", "format", "policy"],
  },
  "extension-init": { required: ["target"], optional: ["scope"] },
  "extension-install": {
    optional: ["target", "github", "scope", "ref"],
    anyOfRequired: [["target"], ["github"]],
  },
  "extension-uninstall": { required: ["target"], optional: ["scope"] },
  "extension-explore": { optional: ["scope"] },
  "extension-manage": { optional: ["scope", "runtimeProbe", "fixManagedState"] },
  "extension-describe": { optional: ["target", "scope", "markdown", "output"] },
  "extension-reload": { optional: ["scope", "watch"] },
  "extension-doctor": { optional: ["scope", "detail", "trace", "fixManagedState", "strictExit", "failOnWarn"] },
  "extension-catalog": { optional: ["scope", "fields"] },
  "extension-adopt": { required: ["target"], optional: ["scope", "github", "ref"] },
  "extension-adopt-all": { optional: ["scope"] },
  "extension-activate": { required: ["target"], optional: ["scope"] },
  "extension-deactivate": { required: ["target"], optional: ["scope"] },
  extension: {
    optional: [
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
      "detail",
      "trace",
      "watch",
      "strictExit",
      "failOnWarn",
    ],
  },
  "package-init": { required: ["target"], optional: ["scope"] },
  "package-install": {
    optional: ["target", "github", "scope", "ref"],
    anyOfRequired: [["target"], ["github"]],
  },
  "package-uninstall": { required: ["target"], optional: ["scope"] },
  "package-explore": { optional: ["scope"] },
  "package-manage": { optional: ["scope", "runtimeProbe", "fixManagedState"] },
  "package-describe": { optional: ["target", "scope", "markdown", "output"] },
  "package-reload": { optional: ["scope", "watch"] },
  "package-doctor": { optional: ["scope", "detail", "trace", "fixManagedState", "strictExit", "failOnWarn"] },
  "package-catalog": { optional: ["scope", "fields"] },
  "package-adopt": { required: ["target"], optional: ["scope", "github", "ref"] },
  "package-adopt-all": { optional: ["scope"] },
  "package-activate": { required: ["target"], optional: ["scope"] },
  "package-deactivate": { required: ["target"], optional: ["scope"] },
  package: {
    optional: [
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
      "detail",
      "trace",
      "watch",
      "strictExit",
      "failOnWarn",
    ],
  },
  install: {
    optional: ["target", "github", "scope", "ref"],
    anyOfRequired: [["target"], ["github"]],
  },
  upgrade: {
    optional: ["target", "scope", "dryRun", "cliOnly", "packagesOnly", "repair", "tag", "packageName"],
  },
  create: {
    required: ["title", "description", "type", "status", "priority", "message"],
    optional: CREATE_CONTRACT_PARAMETER_KEYS,
  },
  copy: { required: ["id"], optional: ["title", "author", "message"] },
  focus: { optional: ["id", "clear"], mutuallyExclusive: [["id", "clear"]] },
  list: { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-all": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-draft": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-open": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-in-progress": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-blocked": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-closed": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-canceled": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  aggregate: { optional: AGGREGATE_CONTRACT_PARAMETER_KEYS },
  "dedupe-audit": { optional: DEDUPE_AUDIT_CONTRACT_PARAMETER_KEYS },
  guide: { optional: ["format", "depth"] },
  context: { optional: CONTEXT_CONTRACT_PARAMETER_KEYS },
  ctx: { optional: CONTEXT_CONTRACT_PARAMETER_KEYS },
  get: { required: ["id"], optional: ["depth", "full", "fields", "tree", "treeDepth", "format"] },
  search: {
    optional: SEARCH_CONTRACT_PARAMETER_KEYS,
    anyOfRequired: [["query"], ["keywords"]],
  },
  next: { optional: NEXT_CONTRACT_PARAMETER_KEYS },
  reindex: { optional: ["mode", "progress"] },
  history: { required: ["id"], optional: ["limit", "compact", "full", "diff", "verify", "format"] },
  "history-redact": {
    required: ["id"],
    optional: ["literal", "regex", "replacement", "dryRun", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS],
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
    optional: ["id", "before", "ids", "allOver", "closed", "allStreams", "minEntries", "dryRun", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS],
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
      // apply-preset passes the preset name as `typePreset`.
      { property: "subcommand", value: "apply-preset", required: ["typePreset"] },
    ],
  },
  profile: {
    required: ["subcommand"],
    // No --message: profile staging writes config/schema files, not item history.
    optional: ["name", "dryRun", "author", "force"],
    conditionalRequired: [
      { property: "subcommand", value: "show", required: ["name"] },
      { property: "subcommand", value: "apply", required: ["name"] },
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
      ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
    ],
  },
  activity: { optional: ACTIVITY_CONTRACT_PARAMETER_KEYS },
  restore: { required: ["id", "target"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  update: { required: ["id"], optional: UPDATE_CONTRACT_PARAMETER_KEYS },
  "update-many": { optional: UPDATE_MANY_CONTRACT_PARAMETER_KEYS },
  normalize: { optional: NORMALIZE_CONTRACT_PARAMETER_KEYS },
  close: { required: ["id"], optional: ["text", "duplicateOf", "validateClose", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS] },
  "close-many": { optional: CLOSE_MANY_CONTRACT_PARAMETER_KEYS },
  delete: { required: ["id"], optional: ["dryRun", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS] },
  append: { required: ["id", "body"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  comments: {
    required: ["id"],
    optional: ["text", "add", "stdin", "file", "edit", "delete", "limit", "allowAuditComment", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS],
  },
  "comments-audit": {
    optional: [
      "status",
      "type",
      "assignee",
      "assigneeFilter",
      "parent",
      "tag",
      "sprint",
      "release",
      "priority",
      "limitItems",
      "limit",
      "fullHistory",
      "latest",
    ],
  },
  notes: {
    required: ["id"],
    optional: ["text", "add", "limit", "allowAuditNote", "allowAuditComment", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS],
  },
  learnings: {
    required: ["id"],
    optional: ["text", "add", "limit", "allowAuditLearning", "allowAuditComment", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS],
  },
  files: {
    required: ["id"],
    optional: [
      "add",
      "addGlob",
      "remove",
      "migrate",
      // GH-170 (pm-pfnx): `addNote` is the MCP spelling of the CLI --note flag
      // (the shared `note` parameter is the array-typed create/update note
      // seed, so files/docs use a distinct single-string key).
      "addNote",
      "discover",
      "apply",
      "discoveryNote",
      "appendStable",
      "validatePaths",
      "audit",
      ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
    ],
    dependentAnyOfRequired: [{ property: "addNote", anyOfRequired: [["add"], ["addGlob"]] }],
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
      "audit",
      ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
    ],
    dependentAnyOfRequired: [{ property: "addNote", anyOfRequired: [["add"], ["addGlob"]] }],
  },
  deps: { required: ["id"], optional: ["format", "maxDepth", "collapse", "summary"] },
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
  stats: { optional: ["storage", "metadataCoverage", "fieldUtilization", "byAssignee", "byTag", "byPriority", "tagPrefix"] },
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
  contracts: { optional: ["contractAction", "command", "schemaOnly", "flagsOnly", "availabilityOnly", "runtimeOnly", "activeOnly"] },
  completion: { required: ["shell"], optional: ["eagerTags"] },
  claim: { required: ["id"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  release: { required: ["id"], optional: ["allowAuditRelease", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS] },
  "start-task": { required: ["id"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  "pause-task": { required: ["id"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  "close-task": { required: ["id"], optional: ["text", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS] },
};

export const PM_TOOL_ACTION_PARAMETER_CONTRACTS: Readonly<Record<PmToolAction, PmActionSchemaContract>> =
  Object.freeze(
    Object.fromEntries(PM_TOOL_ACTIONS.map((action) => [action, PM_TOOL_ACTION_SCHEMA_CONTRACTS[action]])),
  ) as Readonly<Record<PmToolAction, PmActionSchemaContract>>;

function fallbackToolParameterDescription(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .trim()
    .replace(/^./, (value) => value.toUpperCase())
    .concat(".");
}

function decorateToolParameterDefinition(key: string, definition: unknown): Record<string, unknown> {
  const baseDefinition = typeof definition === "object" && definition !== null ? { ...(definition as Record<string, unknown>) } : {};
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
  if (action === "plan" && Object.prototype.hasOwnProperty.call(PLAN_ACTION_PARAMETER_METADATA, key)) {
    return PLAN_ACTION_PARAMETER_METADATA[key];
  }
  return PM_TOOL_PARAMETER_METADATA[key];
}

function decorateActionScopedToolParameterDefinition(
  action: PmToolAction,
  key: string,
  definition: unknown,
): Record<string, unknown> {
  const baseDefinition = typeof definition === "object" && definition !== null ? { ...(definition as Record<string, unknown>) } : {};
  const metadata = actionScopedToolParameterMetadata(action, key);
  return {
    ...baseDefinition,
    description: metadata?.description ?? fallbackToolParameterDescription(key),
    ...(metadata?.examples ? { examples: metadata.examples } : {}),
  };
}

function actionScopedToolParameterDefinition(action: PmToolAction, key: string): unknown {
  if (action === "plan" && Object.prototype.hasOwnProperty.call(PLAN_ACTION_PARAMETER_PROPERTIES, key)) {
    return PLAN_ACTION_PARAMETER_PROPERTIES[key];
  }
  if ((action === "get" || action === "history" || action === "search") && key === "format") {
    return { type: "string", enum: ["json", "toon"] };
  }
  return PM_TOOL_PARAMETER_PROPERTIES[key];
}

function buildActionScopedToolSchema(action: PmToolAction): Record<string, unknown> {
  const contract = PM_TOOL_ACTION_SCHEMA_CONTRACTS[action];
  const required = toSchemaKeyList(contract.required ?? []);
  const optional = toSchemaKeyList(contract.optional ?? []);
  const mutationParameterKeys = PM_TOOL_ACTION_MUTATION_PARAMETER_KEYS[action] ?? [];
  const allowedKeys = toSchemaKeyList(["action", ...PM_TOOL_GLOBAL_PARAMETER_KEYS, ...mutationParameterKeys, ...required, ...optional]);
  const properties: Record<string, unknown> = {
    action: {
      const: action,
      description: PM_TOOL_PARAMETER_METADATA.action?.description ?? "Tool action to execute.",
    },
  };
  for (const key of allowedKeys) {
    if (key === "action") {
      continue;
    }
    const definition = actionScopedToolParameterDefinition(action, key);
    if (definition) {
      properties[key] = decorateActionScopedToolParameterDefinition(action, key, definition);
    }
  }
  const schema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    required: ["action", ...required],
    title: `pm action "${action}" parameters`,
    properties,
  };
  if (contract.anyOfRequired && contract.anyOfRequired.length > 0) {
    schema.anyOf = contract.anyOfRequired.map((requiredFields) => ({
      required: [...requiredFields],
    }));
  }
  const oneOfRequiredGroups = contract.oneOfRequired;
  if (oneOfRequiredGroups && oneOfRequiredGroups.length > 0) {
    const allOneOfFields = oneOfRequiredGroups.flat();
    schema.oneOf = oneOfRequiredGroups.map((requiredFields) => {
      const otherFields = allOneOfFields.filter((field) => !requiredFields.includes(field));
      return {
        required: [...requiredFields],
        ...(otherFields.length > 0 ? { not: { anyOf: otherFields.map((field) => ({ required: [field] })) } } : {}),
        ...(action === "history-repair" && requiredFields.includes("all") ? { properties: { all: { const: true } } } : {}),
      };
    });
  }
  if (contract.conditionalRequired && contract.conditionalRequired.length > 0) {
    schema.allOf = contract.conditionalRequired.map((entry) => ({
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
    }));
  }
  if (contract.dependentAnyOfRequired && contract.dependentAnyOfRequired.length > 0) {
    const allOf = Array.isArray(schema.allOf) ? [...(schema.allOf as Array<Record<string, unknown>>)] : [];
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
    schema.allOf = allOf;
  }
  if (contract.mutuallyExclusive && contract.mutuallyExclusive.length > 0) {
    const allOf = Array.isArray(schema.allOf) ? [...(schema.allOf as Array<Record<string, unknown>>)] : [];
    for (const group of contract.mutuallyExclusive) {
      allOf.push({ not: { required: toSchemaKeyList(group) } });
    }
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

/**
 * Canonical version of the action-scoped strict MCP tool-parameters schema
 * (`PM_TOOL_PARAMETERS_SCHEMA`). Exported as the single source of truth so the
 * MCP server, the `pm contracts` command, SDK consumers, and the contract tests
 * all bind to one constant instead of re-typing the `"4.0.2"` literal (pm-r9sz).
 * Bump the patch/minor for additive, backward-compatible schema changes; bump
 * the MAJOR for breaking changes — the major also drives the `$id`
 * `tool-parameters-v{major}` slug, so the two never drift.
 */
export const PM_TOOL_PARAMETERS_SCHEMA_VERSION = "4.0.4" as const;

/**
 * Major component of {@link PM_TOOL_PARAMETERS_SCHEMA_VERSION}, used to build the
 * schema `$id` slug so a breaking version bump renames the document in lockstep.
 */
export const PM_TOOL_PARAMETERS_SCHEMA_MAJOR = PM_TOOL_PARAMETERS_SCHEMA_VERSION.split(".")[0];

/**
 * Version of the provider-compatible flat tool-parameters schema
 * (`PM_PROVIDER_TOOL_PARAMETERS_SCHEMA`). Tracked separately from the strict
 * schema because the flat projection evolves independently.
 */
export const PM_PROVIDER_TOOL_PARAMETERS_SCHEMA_VERSION = "1.0.0" as const;

export const PM_TOOL_PARAMETERS_SCHEMA: Record<string, unknown> = createLazyContractSchema(() => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `https://schema.unbrained.dev/pm-cli/tool-parameters-v${PM_TOOL_PARAMETERS_SCHEMA_MAJOR}.schema.json`,
  title: "pm-cli tool parameters (action-scoped strict schema)",
  "x-schema-version": PM_TOOL_PARAMETERS_SCHEMA_VERSION,
  type: "object",
  oneOf: PM_TOOL_ACTIONS.map((action) => buildActionScopedToolSchema(action)),
}));

function toProviderCompatibleParameterDefinition(key: string, definition: unknown): Record<string, unknown> {
  const decorated = decorateToolParameterDefinition(key, definition);
  if (typeof decorated.type === "string") {
    return decorated;
  }
  const anyOf = Array.isArray(decorated.anyOf) ? (decorated.anyOf as Array<Record<string, unknown>>) : [];
  const firstTypedVariant = anyOf.find((variant) => typeof variant.type === "string");
  if (firstTypedVariant) {
    const { anyOf: _anyOf, ...rest } = decorated;
    return {
      ...rest,
      type: firstTypedVariant.type,
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
      description: PM_TOOL_PARAMETER_METADATA.action?.description ?? "Tool action to execute.",
    },
    options: {
      type: "object",
      additionalProperties: true,
      description: "Advanced command options object forwarded to the selected pm action.",
    },
  };
  for (const key of Object.keys(PM_TOOL_PARAMETER_PROPERTIES).sort()) {
    properties[key] = toProviderCompatibleParameterDefinition(key, PM_TOOL_PARAMETER_PROPERTIES[key]);
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

export const PM_PROVIDER_TOOL_PARAMETERS_SCHEMA: Record<string, unknown> = createLazyContractSchema(
  buildProviderCompatibleToolSchema,
);

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
