/**
 * @module sdk/cli-contracts/tool-option-contracts
 *
 * Defines SDK command-contract metadata for Tool Option Contracts.
 */
import type { ToolOptionFlagContract } from "./flag-contracts.js";

type SharedToolOptionFlagContract = Readonly<ToolOptionFlagContract>;

/** Returns fresh option contract objects so exported arrays cannot share mutable entries. */
function cloneOptionContracts(
  contracts: readonly SharedToolOptionFlagContract[],
): ToolOptionFlagContract[] {
  return contracts.map((contract) => ({ ...contract }));
}

const TOOL_ITEM_BASE_FILTER_OPTION_CONTRACTS: readonly SharedToolOptionFlagContract[] =
  [
    { param: "status", flag: "--status" },
    { param: "type", flag: "--type" },
    { param: "tag", flag: "--tag" },
    { param: "priority", flag: "--priority" },
    { param: "deadlineBefore", flag: "--deadline-before" },
    { param: "deadlineAfter", flag: "--deadline-after" },
  ];

const TOOL_ITEM_DATE_FILTER_OPTION_CONTRACTS: readonly SharedToolOptionFlagContract[] =
  [
    { param: "updatedAfter", flag: "--updated-after" },
    { param: "updatedBefore", flag: "--updated-before" },
    { param: "createdAfter", flag: "--created-after" },
    { param: "createdBefore", flag: "--created-before" },
  ];

const TOOL_LIST_WINDOW_FILTER_OPTION_CONTRACTS: readonly SharedToolOptionFlagContract[] =
  [
    { param: "today", flag: "--today", booleanish: true },
    { param: "recent", flag: "--recent", booleanish: true },
    ...TOOL_ITEM_DATE_FILTER_OPTION_CONTRACTS,
  ];

const TOOL_ITEM_RELATION_FILTER_OPTION_CONTRACTS: readonly SharedToolOptionFlagContract[] =
  [
    { param: "assignee", flag: "--assignee" },
    { param: "assigneeFilter", flag: "--assignee-filter" },
    { param: "parent", flag: "--parent" },
    { param: "sprint", flag: "--sprint" },
    { param: "release", flag: "--release" },
  ];

const TOOL_SEARCH_RELATION_FILTER_OPTION_CONTRACTS: readonly SharedToolOptionFlagContract[] =
  [
    { param: "assignee", flag: "--assignee" },
    { param: "sprint", flag: "--sprint" },
    { param: "release", flag: "--release" },
    { param: "parent", flag: "--parent" },
  ];

const TOOL_BASIC_ITEM_FILTER_OPTION_CONTRACTS: readonly SharedToolOptionFlagContract[] =
  [
    ...TOOL_ITEM_BASE_FILTER_OPTION_CONTRACTS,
    ...TOOL_ITEM_RELATION_FILTER_OPTION_CONTRACTS,
  ];

const TOOL_GOVERNANCE_MISSING_OPTION_CONTRACTS: readonly SharedToolOptionFlagContract[] =
  [
    { param: "filterReviewerMissing", flag: "--filter-reviewer-missing" },
    { param: "filterRiskMissing", flag: "--filter-risk-missing" },
    { param: "filterConfidenceMissing", flag: "--filter-confidence-missing" },
    { param: "filterSprintMissing", flag: "--filter-sprint-missing" },
    { param: "filterReleaseMissing", flag: "--filter-release-missing" },
  ];

const TOOL_CONTENT_PRESENCE_OPTION_CONTRACTS: readonly SharedToolOptionFlagContract[] =
  [
    { param: "hasNotes", flag: "--has-notes" },
    { param: "noNotes", flag: "--no-notes" },
    { param: "hasLearnings", flag: "--has-learnings" },
    { param: "noLearnings", flag: "--no-learnings" },
    { param: "hasFiles", flag: "--has-files" },
    { param: "noFiles", flag: "--no-files" },
    { param: "filterFilesMissing", flag: "--filter-files-missing" },
    { param: "hasDocs", flag: "--has-docs" },
    { param: "noDocs", flag: "--no-docs" },
    { param: "filterDocsMissing", flag: "--filter-docs-missing" },
    { param: "hasTests", flag: "--has-tests" },
    { param: "noTests", flag: "--no-tests" },
    { param: "hasComments", flag: "--has-comments" },
    { param: "noComments", flag: "--no-comments" },
    { param: "hasDeps", flag: "--has-deps" },
    { param: "noDeps", flag: "--no-deps" },
    { param: "hasBody", flag: "--has-body" },
    { param: "emptyBody", flag: "--empty-body" },
    { param: "hasLinkedCommand", flag: "--has-linked-command" },
    { param: "noLinkedCommand", flag: "--no-linked-command" },
  ];

/** Public contract for tool list filter option contracts, shared by SDK and presentation-layer consumers. */
export const TOOL_LIST_FILTER_OPTION_CONTRACTS: ToolOptionFlagContract[] = [
  ...cloneOptionContracts(TOOL_ITEM_BASE_FILTER_OPTION_CONTRACTS),
  ...cloneOptionContracts(TOOL_LIST_WINDOW_FILTER_OPTION_CONTRACTS),
  { param: "ids", flag: "--ids" },
  ...cloneOptionContracts(TOOL_ITEM_RELATION_FILTER_OPTION_CONTRACTS),
  { param: "filterAcMissing", flag: "--filter-ac-missing" },
  { param: "filterEstimatesMissing", flag: "--filter-estimates-missing" },
  { param: "filterResolutionMissing", flag: "--filter-resolution-missing" },
  { param: "filterMetadataMissing", flag: "--filter-metadata-missing" },
  ...cloneOptionContracts(TOOL_GOVERNANCE_MISSING_OPTION_CONTRACTS),
  ...cloneOptionContracts(TOOL_CONTENT_PRESENCE_OPTION_CONTRACTS),
  { param: "limit", flag: "--limit" },
  { param: "offset", flag: "--offset" },
  { param: "after", flag: "--after" },
  { param: "fields", flag: "--fields" },
  { param: "sort", flag: "--sort" },
  { param: "order", flag: "--order" },
  { param: "tree", flag: "--tree" },
  { param: "treeDepth", flag: "--tree-depth" },
];

/** Public contract for tool aggregate option contracts, shared by SDK and presentation-layer consumers. */
export const TOOL_AGGREGATE_OPTION_CONTRACTS: ToolOptionFlagContract[] = [
  { param: "groupBy", flag: "--group-by" },
  { param: "sum", flag: "--sum" },
  { param: "avg", flag: "--avg" },
  ...cloneOptionContracts(TOOL_BASIC_ITEM_FILTER_OPTION_CONTRACTS),
];


/** Public contract for tool search filter option contracts, shared by SDK and presentation-layer consumers. */
export const TOOL_SEARCH_FILTER_OPTION_CONTRACTS: ToolOptionFlagContract[] = [
  { param: "matchMode", flag: "--match-mode" },
  { param: "minScore", flag: "--min-score" },
  { param: "count", flag: "--count", booleanish: true },
  { param: "semanticWeight", flag: "--semantic-weight" },
  ...cloneOptionContracts(TOOL_ITEM_BASE_FILTER_OPTION_CONTRACTS),
  ...cloneOptionContracts(TOOL_ITEM_DATE_FILTER_OPTION_CONTRACTS),
  ...cloneOptionContracts(TOOL_SEARCH_RELATION_FILTER_OPTION_CONTRACTS),
  ...cloneOptionContracts(TOOL_GOVERNANCE_MISSING_OPTION_CONTRACTS),
  ...cloneOptionContracts(TOOL_CONTENT_PRESENCE_OPTION_CONTRACTS),
  { param: "fields", flag: "--fields" },
  { param: "limit", flag: "--limit" },
  { param: "after", flag: "--after" },
];

/** Public contract for tool shared create update option contracts, shared by SDK and presentation-layer consumers. */
export const TOOL_SHARED_CREATE_UPDATE_OPTION_CONTRACTS: ToolOptionFlagContract[] =
  [
    { param: "parent", flag: "--parent" },
    { param: "reviewer", flag: "--reviewer" },
    { param: "risk", flag: "--risk" },
    { param: "confidence", flag: "--confidence" },
    { param: "sprint", flag: "--sprint" },
    { param: "release", flag: "--release" },
    { param: "blockedBy", flag: "--blocked-by" },
    { param: "blockedReason", flag: "--blocked-reason" },
    { param: "unblockNote", flag: "--unblock-note" },
    { param: "reporter", flag: "--reporter" },
    { param: "severity", flag: "--severity" },
    { param: "environment", flag: "--environment" },
    { param: "reproSteps", flag: "--repro-steps" },
    { param: "resolution", flag: "--resolution" },
    { param: "expectedResult", flag: "--expected-result" },
    { param: "actualResult", flag: "--actual-result" },
    { param: "affectedVersion", flag: "--affected-version" },
    { param: "fixedVersion", flag: "--fixed-version" },
    { param: "component", flag: "--component" },
    { param: "regression", flag: "--regression", booleanish: true },
    { param: "customerImpact", flag: "--customer-impact" },
    {
      param: "definitionOfReady",
      flag: "--definition-of-ready",
      allowEmpty: true,
    },
    { param: "order", flag: "--order" },
    { param: "goal", flag: "--goal" },
    { param: "objective", flag: "--objective" },
    { param: "value", flag: "--value" },
    { param: "impact", flag: "--impact" },
    { param: "outcome", flag: "--outcome" },
    { param: "whyNow", flag: "--why-now" },
  ];

/** Public contract for tool create option contracts, shared by SDK and presentation-layer consumers. */
export const TOOL_CREATE_OPTION_CONTRACTS: ToolOptionFlagContract[] = [
  { param: "title", flag: "--title" },
  { param: "description", flag: "--description", allowEmpty: true },
  { param: "type", flag: "--type" },
  { param: "template", flag: "--template" },
  { param: "createMode", flag: "--create-mode" },
  { param: "schedulePreset", flag: "--schedule-preset" },
  { param: "status", flag: "--status" },
  { param: "priority", flag: "--priority" },
  { param: "tags", flag: "--tags", allowEmpty: true },
  { param: "addTags", flag: "--add-tags", repeatable: true },
  { param: "body", flag: "--body", allowEmpty: true },
  { param: "deadline", flag: "--deadline" },
  { param: "estimate", flag: "--estimate" },
  {
    param: "acceptanceCriteria",
    flag: "--acceptance-criteria",
    allowEmpty: true,
  },
  { param: "author", flag: "--author" },
  { param: "message", flag: "--message", allowEmpty: true },
  { param: "assignee", flag: "--assignee" },
  { param: "allowMissingParent", flag: "--allow-missing-parent" },
  { param: "reminder", flag: "--reminder", repeatable: true },
  { param: "event", flag: "--event", repeatable: true },
  { param: "typeOption", flag: "--type-option", repeatable: true },
  { param: "field", flag: "--field", repeatable: true },
  { param: "dep", flag: "--dep", repeatable: true },
  { param: "comment", flag: "--comment", repeatable: true },
  { param: "note", flag: "--note", repeatable: true },
  { param: "learning", flag: "--learning", repeatable: true },
  { param: "linkedFile", flag: "--file", repeatable: true },
  { param: "linkedTest", flag: "--test", repeatable: true },
  { param: "doc", flag: "--doc", repeatable: true },
  { param: "unset", flag: "--unset", repeatable: true },
  { param: "clearDeps", flag: "--clear-deps" },
  { param: "clearComments", flag: "--clear-comments" },
  { param: "clearNotes", flag: "--clear-notes" },
  { param: "clearLearnings", flag: "--clear-learnings" },
  { param: "clearFiles", flag: "--clear-files" },
  { param: "clearTests", flag: "--clear-tests" },
  { param: "clearDocs", flag: "--clear-docs" },
  { param: "clearReminders", flag: "--clear-reminders" },
  { param: "clearEvents", flag: "--clear-events" },
  { param: "clearTypeOptions", flag: "--clear-type-options" },
];

/** Public contract for tool update option contracts, shared by SDK and presentation-layer consumers. */
export const TOOL_UPDATE_OPTION_CONTRACTS: ToolOptionFlagContract[] = [
  { param: "title", flag: "--title" },
  { param: "description", flag: "--description", allowEmpty: true },
  { param: "body", flag: "--body", allowEmpty: true },
  { param: "status", flag: "--status" },
  { param: "closeReason", flag: "--close-reason" },
  { param: "priority", flag: "--priority" },
  { param: "type", flag: "--type" },
  { param: "tags", flag: "--tags", allowEmpty: true },
  { param: "addTags", flag: "--add-tags", repeatable: true },
  { param: "removeTags", flag: "--remove-tags", repeatable: true },
  { param: "deadline", flag: "--deadline" },
  { param: "estimate", flag: "--estimate" },
  {
    param: "acceptanceCriteria",
    flag: "--acceptance-criteria",
    allowEmpty: true,
  },
  { param: "author", flag: "--author" },
  { param: "message", flag: "--message", allowEmpty: true },
  { param: "assignee", flag: "--assignee" },
  { param: "dep", flag: "--dep", repeatable: true },
  { param: "depRemove", flag: "--dep-remove", repeatable: true },
  { param: "replaceDeps", flag: "--replace-deps" },
  { param: "replaceTests", flag: "--replace-tests" },
  { param: "comment", flag: "--comment", repeatable: true },
  { param: "note", flag: "--note", repeatable: true },
  { param: "learning", flag: "--learning", repeatable: true },
  { param: "linkedFile", flag: "--file", repeatable: true },
  { param: "linkedTest", flag: "--test", repeatable: true },
  { param: "doc", flag: "--doc", repeatable: true },
  { param: "reminder", flag: "--reminder", repeatable: true },
  { param: "event", flag: "--event", repeatable: true },
  { param: "typeOption", flag: "--type-option", repeatable: true },
  { param: "field", flag: "--field", repeatable: true },
  { param: "unset", flag: "--unset", repeatable: true },
  { param: "clearDeps", flag: "--clear-deps" },
  { param: "clearComments", flag: "--clear-comments" },
  { param: "clearNotes", flag: "--clear-notes" },
  { param: "clearLearnings", flag: "--clear-learnings" },
  { param: "clearFiles", flag: "--clear-files" },
  { param: "clearTests", flag: "--clear-tests" },
  { param: "clearDocs", flag: "--clear-docs" },
  { param: "clearReminders", flag: "--clear-reminders" },
  { param: "clearEvents", flag: "--clear-events" },
  { param: "clearTypeOptions", flag: "--clear-type-options" },
];

const TOOL_BULK_MUTATION_FILTER_OPTION_CONTRACTS: readonly SharedToolOptionFlagContract[] =
  [
    { param: "filterStatus", flag: "--filter-status" },
    { param: "filterType", flag: "--filter-type" },
    { param: "filterTag", flag: "--filter-tag" },
    { param: "filterPriority", flag: "--filter-priority" },
    { param: "filterDeadlineBefore", flag: "--filter-deadline-before" },
    { param: "filterDeadlineAfter", flag: "--filter-deadline-after" },
    { param: "filterUpdatedAfter", flag: "--filter-updated-after" },
    { param: "filterUpdatedBefore", flag: "--filter-updated-before" },
    { param: "filterCreatedAfter", flag: "--filter-created-after" },
    { param: "filterCreatedBefore", flag: "--filter-created-before" },
    { param: "filterAssignee", flag: "--filter-assignee" },
    { param: "filterAssigneeFilter", flag: "--filter-assignee-filter" },
    { param: "filterParent", flag: "--filter-parent" },
    { param: "filterSprint", flag: "--filter-sprint" },
    { param: "filterRelease", flag: "--filter-release" },
    { param: "filterReviewerMissing", flag: "--filter-reviewer-missing" },
    { param: "filterRiskMissing", flag: "--filter-risk-missing" },
    { param: "filterConfidenceMissing", flag: "--filter-confidence-missing" },
    { param: "filterSprintMissing", flag: "--filter-sprint-missing" },
    { param: "filterReleaseMissing", flag: "--filter-release-missing" },
    { param: "filterHasNotes", flag: "--filter-has-notes" },
    { param: "filterNoNotes", flag: "--filter-no-notes" },
    { param: "filterHasLearnings", flag: "--filter-has-learnings" },
    { param: "filterNoLearnings", flag: "--filter-no-learnings" },
    { param: "filterHasFiles", flag: "--filter-has-files" },
    { param: "filterNoFiles", flag: "--filter-no-files" },
    { param: "filterHasDocs", flag: "--filter-has-docs" },
    { param: "filterNoDocs", flag: "--filter-no-docs" },
    { param: "filterHasTests", flag: "--filter-has-tests" },
    { param: "filterNoTests", flag: "--filter-no-tests" },
    { param: "filterHasComments", flag: "--filter-has-comments" },
    { param: "filterNoComments", flag: "--filter-no-comments" },
    { param: "filterHasDeps", flag: "--filter-has-deps" },
    { param: "filterNoDeps", flag: "--filter-no-deps" },
    { param: "filterHasBody", flag: "--filter-has-body" },
    { param: "filterEmptyBody", flag: "--filter-empty-body" },
    { param: "filterHasLinkedCommand", flag: "--filter-has-linked-command" },
    { param: "filterNoLinkedCommand", flag: "--filter-no-linked-command" },
    { param: "ids", flag: "--ids" },
    { param: "limit", flag: "--limit" },
    { param: "offset", flag: "--offset" },
  ];

/** Public contract for tool update many filter option contracts, shared by SDK and presentation-layer consumers. */
export const TOOL_UPDATE_MANY_FILTER_OPTION_CONTRACTS: ToolOptionFlagContract[] =
  [...cloneOptionContracts(TOOL_BULK_MUTATION_FILTER_OPTION_CONTRACTS)];


/** Public contract for tool close many filter option contracts, shared by SDK and presentation-layer consumers. */
export const TOOL_CLOSE_MANY_FILTER_OPTION_CONTRACTS: ToolOptionFlagContract[] =
  [...cloneOptionContracts(TOOL_BULK_MUTATION_FILTER_OPTION_CONTRACTS)];

/** Public contract for tool calendar option contracts, shared by SDK and presentation-layer consumers. */
export const TOOL_CALENDAR_OPTION_CONTRACTS: ToolOptionFlagContract[] = [
  { param: "view", flag: "--view" },
  { param: "date", flag: "--date" },
  { param: "from", flag: "--from" },
  { param: "to", flag: "--to" },
  { param: "type", flag: "--type" },
  { param: "tag", flag: "--tag" },
  { param: "priority", flag: "--priority" },
  { param: "status", flag: "--status" },
  { param: "assignee", flag: "--assignee" },
  { param: "assigneeFilter", flag: "--assignee-filter" },
  { param: "sprint", flag: "--sprint" },
  { param: "release", flag: "--release" },
  { param: "include", flag: "--include" },
  { param: "recurrenceLookaheadDays", flag: "--recurrence-lookahead-days" },
  { param: "recurrenceLookbackDays", flag: "--recurrence-lookback-days" },
  { param: "occurrenceLimit", flag: "--occurrence-limit" },
  { param: "limit", flag: "--limit" },
  { param: "after", flag: "--after" },
  { param: "format", flag: "--format" },
];

/** Public contract for tool activity option contracts, shared by SDK and presentation-layer consumers. */
export const TOOL_ACTIVITY_OPTION_CONTRACTS: ToolOptionFlagContract[] = [
  { param: "id", flag: "--id" },
  { param: "op", flag: "--op" },
  { param: "author", flag: "--author" },
  { param: "from", flag: "--from" },
  { param: "to", flag: "--to" },
  { param: "limit", flag: "--limit" },
  { param: "compact", flag: "--compact" },
  { param: "full", flag: "--full" },
];

/** Public contract for tool context option contracts, shared by SDK and presentation-layer consumers. */
export const TOOL_CONTEXT_OPTION_CONTRACTS: ToolOptionFlagContract[] = [
  { param: "date", flag: "--date" },
  { param: "from", flag: "--from" },
  { param: "to", flag: "--to" },
  { param: "type", flag: "--type" },
  { param: "tag", flag: "--tag" },
  { param: "priority", flag: "--priority" },
  { param: "assignee", flag: "--assignee" },
  { param: "assigneeFilter", flag: "--assignee-filter" },
  { param: "sprint", flag: "--sprint" },
  { param: "release", flag: "--release" },
  { param: "parent", flag: "--parent" },
  { param: "limit", flag: "--limit" },
  { param: "after", flag: "--after" },
  { param: "format", flag: "--format" },
  { param: "depth", flag: "--depth" },
  { param: "fields", flag: "--fields" },
  { param: "section", flag: "--section", repeatable: true },
  { param: "activityLimit", flag: "--activity-limit" },
  { param: "staleThreshold", flag: "--stale-threshold" },
];

/** Public contract for tool deps option contracts, shared by SDK and presentation-layer consumers. */
export const TOOL_DEPS_OPTION_CONTRACTS: ToolOptionFlagContract[] = [
  { param: "format", flag: "--format" },
  { param: "maxDepth", flag: "--max-depth" },
  { param: "collapse", flag: "--collapse" },
  { param: "summary", flag: "--summary" },
  { param: "nodeLimit", flag: "--node-limit" },
  { param: "edgeLimit", flag: "--edge-limit" },
  { param: "tokenBudget", flag: "--token-budget" },
  { param: "cursor", flag: "--cursor" },
  { param: "direction", flag: "--direction" },
  { param: "kind", flag: "--kind", repeatable: true },
];

/** Maps pm_graph tool parameters onto graph CLI flag spellings. */
export const TOOL_GRAPH_OPTION_CONTRACTS: ToolOptionFlagContract[] = [
  { param: "kind", flag: "--kind", repeatable: true },
  { param: "maxDepth", flag: "--max-depth" },
  { param: "limit", flag: "--limit" },
  { param: "after", flag: "--after" },
  { param: "direction", flag: "--direction" },
  { param: "maxPaths", flag: "--max-paths" },
  { param: "sample", flag: "--sample" },
  { param: "exemptIsolate", flag: "--exempt-isolate", repeatable: true },
  { param: "summary", flag: "--summary" },
];
