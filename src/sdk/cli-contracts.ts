export interface CommanderOptionAliasContract {
  target: string;
  keys: string[];
}

export interface CliFlagContract {
  flag: string;
  short?: string;
}

export interface PiOptionFlagContract {
  param: string;
  flag: string;
  allowEmpty?: boolean;
  repeatable?: boolean;
  repeatableOrNone?: boolean;
  booleanish?: boolean;
}

export const PM_EXTENSION_CAPABILITY_CONTRACTS = [
  "commands",
  "renderers",
  "hooks",
  "schema",
  "importers",
  "search",
  "parser",
  "preflight",
  "services",
] as const;

export type PmExtensionCapabilityContract = (typeof PM_EXTENSION_CAPABILITY_CONTRACTS)[number];

export const PM_EXTENSION_SERVICE_NAME_CONTRACTS = [
  "output_format",
  "error_format",
  "help_format",
  "lock_acquire",
  "lock_release",
  "history_append",
  "item_store_write",
  "item_store_delete",
] as const;

export type PmExtensionServiceNameContract = (typeof PM_EXTENSION_SERVICE_NAME_CONTRACTS)[number];

function normalizeUniqueStringList(values: Iterable<string>): string[] {
  return [...new Set(Array.from(values).filter((value) => value.trim().length > 0))];
}

export const PM_CORE_COMMAND_NAMES = [
  "init",
  "config",
  "extension",
  "create",
  "list",
  "list-all",
  "list-draft",
  "list-open",
  "list-in-progress",
  "list-blocked",
  "list-closed",
  "list-canceled",
  "calendar",
  "cal",
  "context",
  "ctx",
  "get",
  "search",
  "reindex",
  "history",
  "activity",
  "restore",
  "update",
  "close",
  "delete",
  "append",
  "comments",
  "comments-audit",
  "notes",
  "learnings",
  "files",
  "docs",
  "deps",
  "test",
  "test-all",
  "test-runs",
  "stats",
  "health",
  "validate",
  "gc",
  "contracts",
  "claim",
  "release",
  "templates",
  "completion",
  "help",
] as const;

export const PM_TOOL_ACTIONS = [
  "init",
  "config",
  "extension-install",
  "extension-uninstall",
  "extension-explore",
  "extension-manage",
  "extension-doctor",
  "extension-adopt",
  "extension-adopt-all",
  "extension-activate",
  "extension-deactivate",
  "create",
  "list",
  "list-all",
  "list-draft",
  "list-open",
  "list-in-progress",
  "list-blocked",
  "list-closed",
  "list-canceled",
  "calendar",
  "context",
  "get",
  "search",
  "reindex",
  "history",
  "activity",
  "restore",
  "update",
  "close",
  "delete",
  "append",
  "comments",
  "comments-audit",
  "notes",
  "learnings",
  "files",
  "docs",
  "deps",
  "test",
  "test-all",
  "test-runs-list",
  "test-runs-status",
  "test-runs-logs",
  "test-runs-stop",
  "test-runs-resume",
  "stats",
  "health",
  "validate",
  "gc",
  "contracts",
  "completion",
  "templates-save",
  "templates-list",
  "templates-show",
  "claim",
  "release",
  "beads-import",
  "todos-import",
  "todos-export",
  "start-task",
  "pause-task",
  "close-task",
] as const;

export type PmToolAction = (typeof PM_TOOL_ACTIONS)[number];

export const PI_LIST_FILTER_OPTION_CONTRACTS: PiOptionFlagContract[] = [
  { param: "type", flag: "--type" },
  { param: "tag", flag: "--tag" },
  { param: "priority", flag: "--priority" },
  { param: "deadlineBefore", flag: "--deadline-before" },
  { param: "deadlineAfter", flag: "--deadline-after" },
  { param: "assignee", flag: "--assignee" },
  { param: "sprint", flag: "--sprint" },
  { param: "release", flag: "--release" },
  { param: "limit", flag: "--limit" },
  { param: "offset", flag: "--offset" },
];

export const PI_SEARCH_FILTER_OPTION_CONTRACTS: PiOptionFlagContract[] = [
  { param: "type", flag: "--type" },
  { param: "tag", flag: "--tag" },
  { param: "priority", flag: "--priority" },
  { param: "deadlineBefore", flag: "--deadline-before" },
  { param: "deadlineAfter", flag: "--deadline-after" },
  { param: "limit", flag: "--limit" },
];

export const PI_SHARED_CREATE_UPDATE_OPTION_CONTRACTS: PiOptionFlagContract[] = [
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
  { param: "definitionOfReady", flag: "--definition-of-ready", allowEmpty: true },
  { param: "order", flag: "--order" },
  { param: "goal", flag: "--goal" },
  { param: "objective", flag: "--objective" },
  { param: "value", flag: "--value" },
  { param: "impact", flag: "--impact" },
  { param: "outcome", flag: "--outcome" },
  { param: "whyNow", flag: "--why-now" },
];

export const PI_CREATE_OPTION_CONTRACTS: PiOptionFlagContract[] = [
  { param: "title", flag: "--title" },
  { param: "description", flag: "--description", allowEmpty: true },
  { param: "type", flag: "--type" },
  { param: "template", flag: "--template" },
  { param: "createMode", flag: "--create-mode" },
  { param: "status", flag: "--status" },
  { param: "priority", flag: "--priority" },
  { param: "tags", flag: "--tags", allowEmpty: true },
  { param: "body", flag: "--body", allowEmpty: true },
  { param: "deadline", flag: "--deadline" },
  { param: "estimate", flag: "--estimate" },
  { param: "acceptanceCriteria", flag: "--acceptance-criteria", allowEmpty: true },
  { param: "author", flag: "--author" },
  { param: "message", flag: "--message", allowEmpty: true },
  { param: "reminder", flag: "--reminder", repeatable: true },
  { param: "event", flag: "--event", repeatable: true },
  { param: "typeOption", flag: "--type-option", repeatable: true },
  { param: "dep", flag: "--dep", repeatableOrNone: true },
  { param: "comment", flag: "--comment", repeatableOrNone: true },
  { param: "note", flag: "--note", repeatableOrNone: true },
  { param: "learning", flag: "--learning", repeatableOrNone: true },
  { param: "linkedFile", flag: "--file", repeatableOrNone: true },
  { param: "linkedTest", flag: "--test", repeatableOrNone: true },
  { param: "doc", flag: "--doc", repeatableOrNone: true },
];

export const PI_UPDATE_OPTION_CONTRACTS: PiOptionFlagContract[] = [
  { param: "title", flag: "--title" },
  { param: "description", flag: "--description", allowEmpty: true },
  { param: "body", flag: "--body", allowEmpty: true },
  { param: "status", flag: "--status" },
  { param: "closeReason", flag: "--close-reason" },
  { param: "priority", flag: "--priority" },
  { param: "type", flag: "--type" },
  { param: "tags", flag: "--tags", allowEmpty: true },
  { param: "deadline", flag: "--deadline" },
  { param: "estimate", flag: "--estimate" },
  { param: "acceptanceCriteria", flag: "--acceptance-criteria", allowEmpty: true },
  { param: "author", flag: "--author" },
  { param: "message", flag: "--message", allowEmpty: true },
  { param: "assignee", flag: "--assignee" },
  { param: "dep", flag: "--dep", repeatableOrNone: true },
  { param: "depRemove", flag: "--dep-remove", repeatable: true },
  { param: "comment", flag: "--comment", repeatableOrNone: true },
  { param: "note", flag: "--note", repeatableOrNone: true },
  { param: "learning", flag: "--learning", repeatableOrNone: true },
  { param: "linkedFile", flag: "--file", repeatableOrNone: true },
  { param: "linkedTest", flag: "--test", repeatableOrNone: true },
  { param: "doc", flag: "--doc", repeatableOrNone: true },
  { param: "reminder", flag: "--reminder", repeatable: true },
  { param: "event", flag: "--event", repeatable: true },
  { param: "typeOption", flag: "--type-option", repeatable: true },
];

export const PI_CALENDAR_OPTION_CONTRACTS: PiOptionFlagContract[] = [
  { param: "view", flag: "--view" },
  { param: "date", flag: "--date" },
  { param: "from", flag: "--from" },
  { param: "to", flag: "--to" },
  { param: "type", flag: "--type" },
  { param: "tag", flag: "--tag" },
  { param: "priority", flag: "--priority" },
  { param: "status", flag: "--status" },
  { param: "assignee", flag: "--assignee" },
  { param: "sprint", flag: "--sprint" },
  { param: "release", flag: "--release" },
  { param: "include", flag: "--include" },
  { param: "recurrenceLookaheadDays", flag: "--recurrence-lookahead-days" },
  { param: "recurrenceLookbackDays", flag: "--recurrence-lookback-days" },
  { param: "occurrenceLimit", flag: "--occurrence-limit" },
  { param: "limit", flag: "--limit" },
  { param: "format", flag: "--format" },
];

export const PI_CONTEXT_OPTION_CONTRACTS: PiOptionFlagContract[] = [
  { param: "date", flag: "--date" },
  { param: "from", flag: "--from" },
  { param: "to", flag: "--to" },
  { param: "type", flag: "--type" },
  { param: "tag", flag: "--tag" },
  { param: "priority", flag: "--priority" },
  { param: "assignee", flag: "--assignee" },
  { param: "sprint", flag: "--sprint" },
  { param: "release", flag: "--release" },
  { param: "limit", flag: "--limit" },
  { param: "format", flag: "--format" },
];

export const SUBCOMMAND_GLOBAL_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--json" },
  { flag: "--quiet" },
  { flag: "--path" },
  { flag: "--no-extensions" },
  { flag: "--profile" },
  { flag: "--help" },
];

export const GLOBAL_FLAG_CONTRACTS: CliFlagContract[] = [
  ...SUBCOMMAND_GLOBAL_FLAG_CONTRACTS,
  { flag: "--version" },
];

export const LIST_FILTER_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--type" },
  { flag: "--tag" },
  { flag: "--priority" },
  { flag: "--deadline-before" },
  { flag: "--deadline-after" },
  { flag: "--assignee" },
  { flag: "--sprint" },
  { flag: "--release" },
  { flag: "--limit" },
  { flag: "--offset" },
  { flag: "--include-body" },
  { flag: "--stream" },
];

export const REINDEX_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--mode" },
  { flag: "--progress" },
];

export const CLOSE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--validate-close" },
  { flag: "--force" },
];

export const TEST_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--add" },
  { flag: "--remove" },
  { flag: "--run" },
  { flag: "--background" },
  { flag: "--timeout" },
  { flag: "--progress" },
  { flag: "--env-set" },
  { flag: "--env-clear" },
  { flag: "--shared-host-safe" },
  { flag: "--pm-context" },
  { flag: "--fail-on-context-mismatch" },
  { flag: "--fail-on-skipped" },
  { flag: "--fail-on-empty-test-run" },
  { flag: "--require-assertions-for-pm" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const TEST_ALL_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--status" },
  { flag: "--background" },
  { flag: "--timeout" },
  { flag: "--progress" },
  { flag: "--env-set" },
  { flag: "--env-clear" },
  { flag: "--shared-host-safe" },
  { flag: "--pm-context" },
  { flag: "--fail-on-context-mismatch" },
  { flag: "--fail-on-skipped" },
  { flag: "--fail-on-empty-test-run" },
  { flag: "--require-assertions-for-pm" },
];

export const TEST_RUNS_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--status" },
  { flag: "--limit" },
  { flag: "--stream" },
  { flag: "--tail" },
  { flag: "--force" },
  { flag: "--author" },
];

export const HEALTH_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--strict-directories" },
  { flag: "--strict-exit" },
  { flag: "--fail-on-warn" },
];

export const VALIDATE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--check-metadata" },
  { flag: "--check-resolution" },
  { flag: "--check-files" },
  { flag: "--scan-mode" },
  { flag: "--include-pm-internals" },
  { flag: "--strict-exit" },
  { flag: "--fail-on-warn" },
  { flag: "--check-history-drift" },
  { flag: "--check-command-references" },
];

export const CREATE_FLAG_CONTRACTS: CliFlagContract[] = [
  { short: "-t", flag: "--title" },
  { short: "-d", flag: "--description" },
  { flag: "--type" },
  { flag: "--template" },
  { flag: "--create-mode" },
  { flag: "--create_mode" },
  { short: "-s", flag: "--status" },
  { short: "-p", flag: "--priority" },
  { flag: "--tags" },
  { short: "-b", flag: "--body" },
  { flag: "--deadline" },
  { flag: "--estimate" },
  { flag: "--estimated-minutes" },
  { flag: "--acceptance-criteria" },
  { flag: "--ac" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--assignee" },
  { flag: "--parent" },
  { flag: "--reviewer" },
  { flag: "--risk" },
  { flag: "--confidence" },
  { flag: "--sprint" },
  { flag: "--release" },
  { flag: "--blocked-by" },
  { flag: "--blocked-reason" },
  { flag: "--unblock-note" },
  { flag: "--reporter" },
  { flag: "--severity" },
  { flag: "--environment" },
  { flag: "--repro-steps" },
  { flag: "--resolution" },
  { flag: "--expected-result" },
  { flag: "--actual-result" },
  { flag: "--affected-version" },
  { flag: "--fixed-version" },
  { flag: "--component" },
  { flag: "--regression" },
  { flag: "--customer-impact" },
  { flag: "--definition-of-ready" },
  { flag: "--order" },
  { flag: "--rank" },
  { flag: "--goal" },
  { flag: "--objective" },
  { flag: "--value" },
  { flag: "--impact" },
  { flag: "--outcome" },
  { flag: "--why-now" },
  { flag: "--dep" },
  { flag: "--type-option" },
  { flag: "--type_option" },
  { flag: "--reminder" },
  { flag: "--event" },
  { flag: "--comment" },
  { flag: "--note" },
  { flag: "--learning" },
  { flag: "--file" },
  { flag: "--test" },
  { flag: "--doc" },
];

export const UPDATE_FLAG_CONTRACTS: CliFlagContract[] = [
  { short: "-t", flag: "--title" },
  { short: "-d", flag: "--description" },
  { short: "-b", flag: "--body" },
  { short: "-s", flag: "--status" },
  { flag: "--close-reason" },
  { flag: "--close_reason" },
  { short: "-p", flag: "--priority" },
  { flag: "--type" },
  { flag: "--tags" },
  { flag: "--deadline" },
  { flag: "--estimate" },
  { flag: "--estimated-minutes" },
  { flag: "--acceptance-criteria" },
  { flag: "--ac" },
  { flag: "--assignee" },
  { flag: "--parent" },
  { flag: "--reviewer" },
  { flag: "--risk" },
  { flag: "--confidence" },
  { flag: "--sprint" },
  { flag: "--release" },
  { flag: "--blocked-by" },
  { flag: "--blocked-reason" },
  { flag: "--unblock-note" },
  { flag: "--reporter" },
  { flag: "--severity" },
  { flag: "--environment" },
  { flag: "--repro-steps" },
  { flag: "--resolution" },
  { flag: "--expected-result" },
  { flag: "--actual-result" },
  { flag: "--affected-version" },
  { flag: "--fixed-version" },
  { flag: "--component" },
  { flag: "--regression" },
  { flag: "--customer-impact" },
  { flag: "--definition-of-ready" },
  { flag: "--order" },
  { flag: "--rank" },
  { flag: "--goal" },
  { flag: "--objective" },
  { flag: "--value" },
  { flag: "--impact" },
  { flag: "--outcome" },
  { flag: "--why-now" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--dep" },
  { flag: "--dep-remove" },
  { flag: "--dep_remove" },
  { flag: "--comment" },
  { flag: "--note" },
  { flag: "--learning" },
  { flag: "--file" },
  { flag: "--test" },
  { flag: "--doc" },
  { flag: "--reminder" },
  { flag: "--event" },
  { flag: "--type-option" },
  { flag: "--type_option" },
  { flag: "--force" },
];

export const CALENDAR_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--view" },
  { flag: "--date" },
  { flag: "--from" },
  { flag: "--to" },
  { flag: "--past" },
  { flag: "--type" },
  { flag: "--tag" },
  { flag: "--priority" },
  { flag: "--status" },
  { flag: "--assignee" },
  { flag: "--sprint" },
  { flag: "--release" },
  { flag: "--include" },
  { flag: "--recurrence-lookahead-days" },
  { flag: "--recurrence-lookback-days" },
  { flag: "--occurrence-limit" },
  { flag: "--limit" },
  { flag: "--format" },
];

export const CONTEXT_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--date" },
  { flag: "--from" },
  { flag: "--to" },
  { flag: "--past" },
  { flag: "--type" },
  { flag: "--tag" },
  { flag: "--priority" },
  { flag: "--assignee" },
  { flag: "--sprint" },
  { flag: "--release" },
  { flag: "--limit" },
  { flag: "--format" },
];

export const SEARCH_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--mode" },
  { flag: "--include-linked" },
  { flag: "--limit" },
  { flag: "--type" },
  { flag: "--tag" },
  { flag: "--priority" },
  { flag: "--deadline-before" },
  { flag: "--deadline-after" },
];

export const CONTRACTS_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--action" },
  { flag: "--command" },
  { flag: "--schema-only" },
  { flag: "--runtime-only" },
  { flag: "--active-only" },
];

export function toCompletionFlagString(flagContracts: CliFlagContract[], includeGlobal = true): string {
  const scoped = flagContracts.flatMap((entry) => [entry.short, entry.flag]).filter((value): value is string => Boolean(value));
  const all = includeGlobal
    ? [
        ...scoped,
        ...SUBCOMMAND_GLOBAL_FLAG_CONTRACTS.flatMap((entry) => [entry.short, entry.flag]).filter((value): value is string => Boolean(value)),
      ]
    : scoped;
  return normalizeUniqueStringList(all).join(" ");
}

export const CREATE_COMMANDER_STRING_OPTION_CONTRACTS: CommanderOptionAliasContract[] = [
  { target: "title", keys: ["title"] },
  { target: "description", keys: ["description"] },
  { target: "type", keys: ["type"] },
  { target: "template", keys: ["template"] },
  { target: "createMode", keys: ["createMode", "create_mode"] },
  { target: "status", keys: ["status"] },
  { target: "priority", keys: ["priority"] },
  { target: "tags", keys: ["tags"] },
  { target: "body", keys: ["body"] },
  { target: "deadline", keys: ["deadline"] },
  { target: "estimatedMinutes", keys: ["estimate", "estimatedMinutes", "estimated_minutes"] },
  { target: "acceptanceCriteria", keys: ["acceptanceCriteria", "acceptance_criteria", "ac"] },
  { target: "definitionOfReady", keys: ["definitionOfReady", "definition_of_ready"] },
  { target: "order", keys: ["order"] },
  { target: "rank", keys: ["rank"] },
  { target: "goal", keys: ["goal"] },
  { target: "objective", keys: ["objective"] },
  { target: "value", keys: ["value"] },
  { target: "impact", keys: ["impact"] },
  { target: "outcome", keys: ["outcome"] },
  { target: "whyNow", keys: ["whyNow", "why_now"] },
  { target: "author", keys: ["author"] },
  { target: "message", keys: ["message"] },
  { target: "assignee", keys: ["assignee"] },
  { target: "parent", keys: ["parent"] },
  { target: "reviewer", keys: ["reviewer"] },
  { target: "risk", keys: ["risk"] },
  { target: "confidence", keys: ["confidence"] },
  { target: "sprint", keys: ["sprint"] },
  { target: "release", keys: ["release"] },
  { target: "blockedBy", keys: ["blockedBy", "blocked_by"] },
  { target: "blockedReason", keys: ["blockedReason", "blocked_reason"] },
  { target: "unblockNote", keys: ["unblockNote", "unblock_note"] },
  { target: "reporter", keys: ["reporter"] },
  { target: "severity", keys: ["severity"] },
  { target: "environment", keys: ["environment"] },
  { target: "reproSteps", keys: ["reproSteps", "repro_steps"] },
  { target: "resolution", keys: ["resolution"] },
  { target: "expectedResult", keys: ["expectedResult", "expected_result"] },
  { target: "actualResult", keys: ["actualResult", "actual_result"] },
  { target: "affectedVersion", keys: ["affectedVersion", "affected_version"] },
  { target: "fixedVersion", keys: ["fixedVersion", "fixed_version"] },
  { target: "component", keys: ["component"] },
  { target: "regression", keys: ["regression"] },
  { target: "customerImpact", keys: ["customerImpact", "customer_impact"] },
];

export const CREATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS: CommanderOptionAliasContract[] = [
  { target: "dep", keys: ["dep"] },
  { target: "comment", keys: ["comment"] },
  { target: "note", keys: ["note"] },
  { target: "learning", keys: ["learning"] },
  { target: "file", keys: ["file"] },
  { target: "test", keys: ["test"] },
  { target: "doc", keys: ["doc"] },
  { target: "reminder", keys: ["reminder"] },
  { target: "event", keys: ["event"] },
  { target: "typeOption", keys: ["typeOption", "type_option"] },
];

export const UPDATE_COMMANDER_STRING_OPTION_CONTRACTS: CommanderOptionAliasContract[] = [
  { target: "title", keys: ["title"] },
  { target: "description", keys: ["description"] },
  { target: "body", keys: ["body"] },
  { target: "status", keys: ["status"] },
  { target: "closeReason", keys: ["closeReason", "close_reason"] },
  { target: "priority", keys: ["priority"] },
  { target: "type", keys: ["type"] },
  { target: "tags", keys: ["tags"] },
  { target: "deadline", keys: ["deadline"] },
  { target: "estimatedMinutes", keys: ["estimate", "estimatedMinutes", "estimated_minutes"] },
  { target: "acceptanceCriteria", keys: ["acceptanceCriteria", "acceptance_criteria", "ac"] },
  { target: "definitionOfReady", keys: ["definitionOfReady", "definition_of_ready"] },
  { target: "order", keys: ["order"] },
  { target: "rank", keys: ["rank"] },
  { target: "goal", keys: ["goal"] },
  { target: "objective", keys: ["objective"] },
  { target: "value", keys: ["value"] },
  { target: "impact", keys: ["impact"] },
  { target: "outcome", keys: ["outcome"] },
  { target: "whyNow", keys: ["whyNow", "why_now"] },
  { target: "author", keys: ["author"] },
  { target: "message", keys: ["message"] },
  { target: "assignee", keys: ["assignee"] },
  { target: "parent", keys: ["parent"] },
  { target: "reviewer", keys: ["reviewer"] },
  { target: "risk", keys: ["risk"] },
  { target: "confidence", keys: ["confidence"] },
  { target: "sprint", keys: ["sprint"] },
  { target: "release", keys: ["release"] },
  { target: "blockedBy", keys: ["blockedBy", "blocked_by"] },
  { target: "blockedReason", keys: ["blockedReason", "blocked_reason"] },
  { target: "unblockNote", keys: ["unblockNote", "unblock_note"] },
  { target: "reporter", keys: ["reporter"] },
  { target: "severity", keys: ["severity"] },
  { target: "environment", keys: ["environment"] },
  { target: "reproSteps", keys: ["reproSteps", "repro_steps"] },
  { target: "resolution", keys: ["resolution"] },
  { target: "expectedResult", keys: ["expectedResult", "expected_result"] },
  { target: "actualResult", keys: ["actualResult", "actual_result"] },
  { target: "affectedVersion", keys: ["affectedVersion", "affected_version"] },
  { target: "fixedVersion", keys: ["fixedVersion", "fixed_version"] },
  { target: "component", keys: ["component"] },
  { target: "regression", keys: ["regression"] },
  { target: "customerImpact", keys: ["customerImpact", "customer_impact"] },
];

export const UPDATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS: CommanderOptionAliasContract[] = [
  { target: "dep", keys: ["dep"] },
  { target: "depRemove", keys: ["depRemove", "dep_remove"] },
  { target: "comment", keys: ["comment"] },
  { target: "note", keys: ["note"] },
  { target: "learning", keys: ["learning"] },
  { target: "file", keys: ["file"] },
  { target: "test", keys: ["test"] },
  { target: "doc", keys: ["doc"] },
  { target: "reminder", keys: ["reminder"] },
  { target: "event", keys: ["event"] },
  { target: "typeOption", keys: ["typeOption", "type_option"] },
];

export const LIST_COMMANDER_STRING_OPTION_CONTRACTS: CommanderOptionAliasContract[] = [
  { target: "type", keys: ["type"] },
  { target: "tag", keys: ["tag"] },
  { target: "priority", keys: ["priority"] },
  { target: "deadlineBefore", keys: ["deadlineBefore"] },
  { target: "deadlineAfter", keys: ["deadlineAfter"] },
  { target: "assignee", keys: ["assignee"] },
  { target: "sprint", keys: ["sprint"] },
  { target: "release", keys: ["release"] },
  { target: "limit", keys: ["limit"] },
  { target: "offset", keys: ["offset"] },
];

export const SEARCH_COMMANDER_STRING_OPTION_CONTRACTS: CommanderOptionAliasContract[] = [
  { target: "mode", keys: ["mode"] },
  { target: "type", keys: ["type"] },
  { target: "tag", keys: ["tag"] },
  { target: "priority", keys: ["priority"] },
  { target: "deadlineBefore", keys: ["deadlineBefore"] },
  { target: "deadlineAfter", keys: ["deadlineAfter"] },
  { target: "limit", keys: ["limit"] },
];

export const CALENDAR_COMMANDER_STRING_OPTION_CONTRACTS: CommanderOptionAliasContract[] = [
  { target: "view", keys: ["view"] },
  { target: "date", keys: ["date"] },
  { target: "from", keys: ["from"] },
  { target: "to", keys: ["to"] },
  { target: "limit", keys: ["limit"] },
  { target: "type", keys: ["type"] },
  { target: "tag", keys: ["tag"] },
  { target: "priority", keys: ["priority"] },
  { target: "status", keys: ["status"] },
  { target: "assignee", keys: ["assignee"] },
  { target: "sprint", keys: ["sprint"] },
  { target: "release", keys: ["release"] },
  { target: "include", keys: ["include"] },
  { target: "recurrenceLookaheadDays", keys: ["recurrenceLookaheadDays", "recurrence_lookahead_days"] },
  { target: "recurrenceLookbackDays", keys: ["recurrenceLookbackDays", "recurrence_lookback_days"] },
  { target: "occurrenceLimit", keys: ["occurrenceLimit", "occurrence_limit"] },
  { target: "format", keys: ["format"] },
];

export const CONTEXT_COMMANDER_STRING_OPTION_CONTRACTS: CommanderOptionAliasContract[] = [
  { target: "date", keys: ["date"] },
  { target: "from", keys: ["from"] },
  { target: "to", keys: ["to"] },
  { target: "type", keys: ["type"] },
  { target: "tag", keys: ["tag"] },
  { target: "priority", keys: ["priority"] },
  { target: "assignee", keys: ["assignee"] },
  { target: "sprint", keys: ["sprint"] },
  { target: "release", keys: ["release"] },
  { target: "limit", keys: ["limit"] },
  { target: "format", keys: ["format"] },
];

export function readFirstStringFromCommanderOptions(
  options: Record<string, unknown>,
  contract: CommanderOptionAliasContract,
): string | undefined {
  for (const key of contract.keys) {
    const candidate = options[key];
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return undefined;
}

export function readStringArrayFromCommanderOptions(
  options: Record<string, unknown>,
  contract: CommanderOptionAliasContract,
): string[] | undefined {
  for (const key of contract.keys) {
    const candidate = options[key];
    if (Array.isArray(candidate)) {
      return candidate as string[];
    }
  }
  return undefined;
}

const PM_TOOL_PARAMETER_PROPERTIES: Record<string, unknown> = {
  json: { type: "boolean", default: true },
  quiet: { type: "boolean" },
  profile: { type: "boolean" },
  noExtensions: { type: "boolean" },
  path: { type: "string" },
  pmExecutable: { type: "string" },
  timeoutMs: { type: "number" },
  id: { type: "string" },
  target: { type: "string" },
  github: { type: "string" },
  ref: { type: "string" },
  query: { type: "string" },
  keywords: { type: "string" },
  prefix: { type: "string" },
  scope: { type: "string", enum: ["project", "global"] },
  contractAction: { type: "string" },
  command: { type: "string" },
  schemaOnly: { type: "boolean" },
  runtimeOnly: { type: "boolean" },
  activeOnly: { type: "boolean" },
  configAction: { type: "string", enum: ["get", "set", "list", "export"] },
  key: { type: "string" },
  title: { type: "string" },
  description: { type: "string" },
  type: { type: "string" },
  template: { type: "string" },
  createMode: { type: "string", enum: ["strict", "progressive"] },
  status: { type: "string", enum: ["draft", "open", "in_progress", "blocked", "closed", "canceled", "in-progress"] },
  closeReason: { type: "string" },
  priority: { anyOf: [{ type: "string" }, { type: "number" }] },
  tags: { type: "string" },
  body: { type: "string" },
  deadline: { type: "string" },
  estimate: { anyOf: [{ type: "string" }, { type: "number" }] },
  acceptanceCriteria: { type: "string" },
  author: { type: "string" },
  message: { type: "string" },
  assignee: { type: "string" },
  parent: { type: "string" },
  reviewer: { type: "string" },
  risk: { type: "string" },
  confidence: { anyOf: [{ type: "string" }, { type: "number" }] },
  sprint: { type: "string" },
  release: { type: "string" },
  blockedBy: { type: "string" },
  blockedReason: { type: "string" },
  unblockNote: { type: "string" },
  reporter: { type: "string" },
  severity: { type: "string" },
  environment: { type: "string" },
  reproSteps: { type: "string" },
  resolution: { type: "string" },
  expectedResult: { type: "string" },
  actualResult: { type: "string" },
  affectedVersion: { type: "string" },
  fixedVersion: { type: "string" },
  component: { type: "string" },
  regression: { anyOf: [{ type: "boolean" }, { type: "string" }, { type: "number" }] },
  customerImpact: { type: "string" },
  definitionOfReady: { type: "string" },
  order: { anyOf: [{ type: "string" }, { type: "number" }] },
  goal: { type: "string" },
  objective: { type: "string" },
  value: { type: "string" },
  impact: { type: "string" },
  outcome: { type: "string" },
  whyNow: { type: "string" },
  mode: { type: "string", enum: ["keyword", "semantic", "hybrid"] },
  view: { type: "string", enum: ["agenda", "day", "week", "month"] },
  date: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  past: { type: "boolean" },
  include: { type: "string" },
  recurrenceLookaheadDays: { anyOf: [{ type: "string" }, { type: "number" }] },
  recurrenceLookbackDays: { anyOf: [{ type: "string" }, { type: "number" }] },
  occurrenceLimit: { anyOf: [{ type: "string" }, { type: "number" }] },
  includeLinked: { type: "boolean" },
  tag: { type: "string" },
  deadlineBefore: { type: "string" },
  deadlineAfter: { type: "string" },
  limit: { anyOf: [{ type: "string" }, { type: "number" }] },
  limitItems: { anyOf: [{ type: "string" }, { type: "number" }] },
  fullHistory: { type: "boolean" },
  latest: { anyOf: [{ type: "string" }, { type: "number" }] },
  offset: { anyOf: [{ type: "string" }, { type: "number" }] },
  progress: { type: "boolean" },
  background: { type: "boolean" },
  runId: { type: "string" },
  stream: { type: "string", enum: ["stdout", "stderr", "both"] },
  tail: { anyOf: [{ type: "string" }, { type: "number" }] },
  envSet: { type: "array", items: { type: "string" } },
  envClear: { type: "array", items: { type: "string" } },
  sharedHostSafe: { type: "boolean" },
  detail: { type: "string", enum: ["summary", "deep"] },
  trace: { type: "boolean" },
  runtimeProbe: { type: "boolean" },
  fixManagedState: { type: "boolean" },
  pmContext: { type: "string", enum: ["schema", "tracker", "auto"] },
  failOnContextMismatch: { type: "boolean" },
  failOnSkipped: { type: "boolean" },
  failOnEmptyTestRun: { type: "boolean" },
  requireAssertionsForPm: { type: "boolean" },
  diff: { type: "boolean" },
  verify: { type: "boolean" },
  timeout: { anyOf: [{ type: "string" }, { type: "number" }] },
  validateClose: { type: "string", enum: ["warn", "strict"] },
  checkMetadata: { type: "boolean" },
  metadataProfile: { type: "string", enum: ["core", "strict", "custom"] },
  checkResolution: { type: "boolean" },
  checkLifecycle: { type: "boolean" },
  checkStaleBlockers: { type: "boolean" },
  checkFiles: { type: "boolean" },
  strictDirectories: { type: "boolean" },
  scanMode: { type: "string", enum: ["default", "tracked-all", "tracked-all-strict"] },
  includePmInternals: { type: "boolean" },
  strictExit: { type: "boolean" },
  failOnWarn: { type: "boolean" },
  checkHistoryDrift: { type: "boolean" },
  checkCommandReferences: { type: "boolean" },
  allowAuditComment: { type: "boolean" },
  force: { type: "boolean" },
  run: { type: "boolean" },
  shell: { type: "string", enum: ["bash", "zsh", "fish"] },
  file: { type: "string" },
  preserveSourceIds: { type: "boolean" },
  folder: { type: "string" },
  text: { type: "string" },
  add: { type: "array", items: { type: "string" } },
  addGlob: { type: "array", items: { type: "string" } },
  remove: { type: "array", items: { type: "string" } },
  migrate: { type: "array", items: { type: "string" } },
  appendStable: { type: "boolean" },
  validatePaths: { type: "boolean" },
  audit: { type: "boolean" },
  dep: { type: "array", items: { type: "string" } },
  depRemove: { type: "array", items: { type: "string" } },
  comment: { type: "array", items: { type: "string" } },
  note: { type: "array", items: { type: "string" } },
  learning: { type: "array", items: { type: "string" } },
  linkedFile: { type: "array", items: { type: "string" } },
  linkedTest: { type: "array", items: { type: "string" } },
  doc: { type: "array", items: { type: "string" } },
  reminder: { type: "array", items: { type: "string" } },
  event: { type: "array", items: { type: "string" } },
  typeOption: { type: "array", items: { type: "string" } },
  criterion: { type: "array", items: { type: "string" } },
  format: { type: "string" },
  policy: { type: "string" },
};

const PM_TOOL_GLOBAL_PARAMETER_KEYS = ["json", "quiet", "profile", "noExtensions", "path", "pmExecutable", "timeoutMs"] as const;

interface PmActionSchemaContract {
  required?: string[];
  optional?: string[];
  anyOfRequired?: Array<string[]>;
}

function toSchemaKeyList(values: string[]): string[] {
  return normalizeUniqueStringList(values);
}

const CREATE_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...PI_CREATE_OPTION_CONTRACTS.map((entry) => entry.param),
  ...PI_SHARED_CREATE_UPDATE_OPTION_CONTRACTS.map((entry) => entry.param),
  "assignee",
]);

const UPDATE_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...PI_UPDATE_OPTION_CONTRACTS.map((entry) => entry.param),
  ...PI_SHARED_CREATE_UPDATE_OPTION_CONTRACTS.map((entry) => entry.param),
  "force",
]);

const CALENDAR_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...PI_CALENDAR_OPTION_CONTRACTS.map((entry) => entry.param),
  "past",
]);

const CONTEXT_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...PI_CONTEXT_OPTION_CONTRACTS.map((entry) => entry.param),
  "past",
]);

const LIST_CONTRACT_PARAMETER_KEYS = toSchemaKeyList(PI_LIST_FILTER_OPTION_CONTRACTS.map((entry) => entry.param));
const SEARCH_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  "query",
  "keywords",
  "mode",
  "includeLinked",
  ...PI_SEARCH_FILTER_OPTION_CONTRACTS.map((entry) => entry.param),
]);

const AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS = ["author", "message", "force"];

const PM_TOOL_ACTION_SCHEMA_CONTRACTS: Record<PmToolAction, PmActionSchemaContract> = {
  init: { optional: ["prefix"] },
  config: {
    required: ["scope", "configAction"],
    optional: ["key", "criterion", "format", "policy"],
  },
  "extension-install": {
    optional: ["target", "github", "scope", "ref"],
    anyOfRequired: [["target"], ["github"]],
  },
  "extension-uninstall": { required: ["target"], optional: ["scope"] },
  "extension-explore": { optional: ["scope"] },
  "extension-manage": { optional: ["scope", "runtimeProbe", "fixManagedState"] },
  "extension-doctor": { optional: ["scope", "detail", "trace", "fixManagedState", "strictExit", "failOnWarn"] },
  "extension-adopt": { required: ["target"], optional: ["scope", "github", "ref"] },
  "extension-adopt-all": { optional: ["scope"] },
  "extension-activate": { required: ["target"], optional: ["scope"] },
  "extension-deactivate": { required: ["target"], optional: ["scope"] },
  create: {
    required: ["title", "description", "type", "status", "priority", "message"],
    optional: CREATE_CONTRACT_PARAMETER_KEYS,
  },
  list: { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-all": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-draft": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-open": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-in-progress": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-blocked": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-closed": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-canceled": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  calendar: { optional: CALENDAR_CONTRACT_PARAMETER_KEYS },
  context: { optional: CONTEXT_CONTRACT_PARAMETER_KEYS },
  get: { required: ["id"] },
  search: {
    optional: SEARCH_CONTRACT_PARAMETER_KEYS,
    anyOfRequired: [["query"], ["keywords"]],
  },
  reindex: { optional: ["mode", "progress"] },
  history: { required: ["id"], optional: ["limit", "diff", "verify"] },
  activity: { optional: ["limit"] },
  restore: { required: ["id", "target"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  update: { required: ["id"], optional: UPDATE_CONTRACT_PARAMETER_KEYS },
  close: { required: ["id", "text"], optional: ["validateClose", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS] },
  delete: { required: ["id"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  append: { required: ["id", "body"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  comments: { required: ["id"], optional: ["text", "add", "limit", "allowAuditComment", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS] },
  "comments-audit": { optional: ["status", "type", "assignee", "limitItems", "fullHistory", "latest"] },
  notes: { required: ["id"], optional: ["text", "add", "limit", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS] },
  learnings: { required: ["id"], optional: ["text", "add", "limit", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS] },
  files: {
    required: ["id"],
    optional: ["add", "addGlob", "remove", "migrate", "appendStable", "validatePaths", "audit", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS],
  },
  docs: {
    required: ["id"],
    optional: ["add", "addGlob", "remove", "migrate", "validatePaths", "audit", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS],
  },
  deps: { required: ["id"], optional: ["format"] },
  test: {
    required: ["id"],
    optional: [
      "add",
      "remove",
      "run",
      "background",
      "timeout",
      "progress",
      "envSet",
      "envClear",
      "sharedHostSafe",
      "pmContext",
      "failOnContextMismatch",
      "failOnSkipped",
      "failOnEmptyTestRun",
      "requireAssertionsForPm",
      ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
    ],
  },
  "test-all": {
    optional: [
      "status",
      "background",
      "timeout",
      "progress",
      "envSet",
      "envClear",
      "sharedHostSafe",
      "pmContext",
      "failOnContextMismatch",
      "failOnSkipped",
      "failOnEmptyTestRun",
      "requireAssertionsForPm",
    ],
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
  stats: {},
  health: { optional: ["strictDirectories", "strictExit", "failOnWarn"] },
  validate: {
    optional: [
      "checkMetadata",
      "metadataProfile",
      "checkResolution",
      "checkLifecycle",
      "checkStaleBlockers",
      "checkFiles",
      "scanMode",
      "includePmInternals",
      "strictExit",
      "failOnWarn",
      "checkHistoryDrift",
      "checkCommandReferences",
    ],
  },
  gc: {},
  contracts: { optional: ["contractAction", "command", "schemaOnly", "runtimeOnly", "activeOnly"] },
  completion: { required: ["shell"] },
  "templates-save": {
    required: ["template"],
    optional: CREATE_CONTRACT_PARAMETER_KEYS,
  },
  "templates-list": {},
  "templates-show": { required: ["template"] },
  claim: { required: ["id"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  release: { required: ["id"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  "beads-import": { optional: ["file", "author", "message", "preserveSourceIds"] },
  "todos-import": { optional: ["folder", "author", "message"] },
  "todos-export": { optional: ["folder"] },
  "start-task": { required: ["id"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  "pause-task": { required: ["id"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  "close-task": { required: ["id", "text"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
};

const PM_TOOL_PARAMETER_METADATA: Record<string, { description: string; examples?: unknown[] }> = {
  action: {
    description: "Tool action to execute.",
  },
  path: {
    description: "Optional PM data root override for this invocation.",
    examples: [".agents/pm"],
  },
  scope: {
    description: "Scope selector for commands that operate on project or global state.",
    examples: ["project", "global"],
  },
  detail: {
    description: "Detail mode for commands that support concise and deep diagnostics.",
    examples: ["summary", "deep"],
  },
  trace: {
    description: "When true for extension-doctor, include actionable registration traces in deep diagnostics.",
  },
  runtimeProbe: {
    description: "When true for extension-manage, run a doctor-like runtime activation probe for parity fields.",
  },
  fixManagedState: {
    description: "When true for extension-manage/extension-doctor, adopt unmanaged extensions before diagnostics/update checks.",
  },
  target: {
    description: "Positional target argument for the selected action (ID, source, or extension name).",
    examples: ["pm-a1b2", ".agents/pm/extensions/sample", "sample-extension"],
  },
  github: {
    description: "GitHub shorthand owner/repo[/path] source for extension install actions.",
    examples: ["unbraind/pm-cli/pi"],
  },
  ref: {
    description: "Git ref/branch/tag used when installing from GitHub shorthand/URL sources.",
    examples: ["main", "v1.0.0"],
  },
  json: {
    description: "Emit machine-readable JSON output.",
  },
  quiet: {
    description: "Suppress stdout payload output.",
  },
  noExtensions: {
    description: "Disable extension loading for this invocation.",
  },
  profile: {
    description: "Emit deterministic timing diagnostics to stderr.",
  },
  timeoutMs: {
    description: "Pi wrapper execution timeout in milliseconds.",
    examples: [120000],
  },
  id: {
    description: "Item identifier for read or mutation actions.",
    examples: ["pm-a1b2"],
  },
  runId: {
    description: "Background test run identifier.",
    examples: ["tr-kq9x3f-93acde"],
  },
  title: {
    description: "Item title text.",
  },
  description: {
    description: "Item description text.",
  },
  type: {
    description: "Item type name from the active runtime type registry.",
    examples: ["Task", "Feature"],
  },
  createMode: {
    description: "Create required-option policy mode.",
    examples: ["strict", "progressive"],
  },
  status: {
    description: "Item status value.",
    examples: ["open", "in_progress"],
  },
  priority: {
    description: "Priority value in range 0..4.",
    examples: [0, 1, "2"],
  },
  tags: {
    description: "Comma-delimited tag list, or 'none' to clear when supported.",
    examples: ["pm-cli,agent-ux"],
  },
  deadline: {
    description: "ISO/date timestamp or relative offset (+6h/+1d/+2w/+6m), or 'none' where supported.",
    examples: ["2026-04-01T00:00:00.000Z", "+1d", "none"],
  },
  estimate: {
    description: "Estimated effort in minutes, or 'none' where supported.",
    examples: [60, "120", "none"],
  },
  acceptanceCriteria: {
    description: "Acceptance criteria text.",
  },
  author: {
    description: "Mutation author identity.",
    examples: ["codex-agent"],
  },
  message: {
    description: "History message for mutation audit trail.",
  },
  assignee: {
    description: "Assignee identity or 'none' to unset.",
    examples: ["codex-agent", "none"],
  },
  mode: {
    description: "Search/reindex mode selector.",
    examples: ["keyword", "hybrid"],
  },
  progress: {
    description: "Emit progress diagnostics to stderr for long-running operations.",
  },
  background: {
    description: "Run linked tests in managed background mode.",
  },
  envSet: {
    description: "Repeatable runtime environment KEY=VALUE overrides for linked-test execution.",
    examples: [["PORT=0", "PLAYWRIGHT_HTML_OPEN=never"]],
  },
  envClear: {
    description: "Repeatable runtime environment variable names to clear before linked-test execution.",
    examples: [["PLAYWRIGHT_BASE_URL"]],
  },
  sharedHostSafe: {
    description: "Apply additive shared-host-safe runtime defaults during linked-test execution.",
  },
  pmContext: {
    description:
      "PM linked-test context mode (schema keeps isolated tracker data; tracker seeds source tracker data; auto uses tracker for PM tracker-read linked commands).",
    examples: ["schema", "tracker", "auto"],
  },
  failOnContextMismatch: {
    description: "Fail linked PM command runs when source and sandbox tracker item counts differ.",
  },
  failOnSkipped: {
    description: "Treat skipped linked tests as dependency-failed policy violations.",
  },
  failOnEmptyTestRun: {
    description: "Treat successful linked-test commands that report zero executed tests as failures.",
  },
  requireAssertionsForPm: {
    description: "Require assertion metadata for linked PM command test entries during run execution.",
  },
  offset: {
    description: "Number of matching rows to skip before limit is applied.",
    examples: [0, 50, "100"],
  },
  limitItems: {
    description: "Maximum number of filtered items to include in comments-audit output.",
    examples: [10, "25"],
  },
  fullHistory: {
    description: "When true for comments-audit, export full per-item comment history rows and ignore latest-snapshot truncation.",
  },
  latest: {
    description: "Number of most recent comments to include per item in comments-audit output.",
    examples: [1, "3"],
  },
  validateClose: {
    description: 'Close-time metadata validation mode ("warn" or "strict").',
    examples: ["warn", "strict"],
  },
  checkMetadata: {
    description: "Run metadata completeness checks.",
  },
  metadataProfile: {
    description: "Select metadata validation profile for --check-metadata.",
    examples: ["core", "strict", "custom"],
  },
  checkResolution: {
    description: "Run closed-item resolution metadata checks.",
  },
  checkLifecycle: {
    description: "Run active-item lifecycle governance drift checks.",
  },
  checkStaleBlockers: {
    description: "Include stale blocker-pattern diagnostics in lifecycle checks.",
  },
  checkFiles: {
    description: "Run linked-file and orphaned-file checks.",
  },
  strictDirectories: {
    description: "Treat optional item-type directories as required health failures.",
  },
  scanMode: {
    description: "Select file candidate scan mode for --check-files.",
    examples: ["default", "tracked-all", "tracked-all-strict"],
  },
  includePmInternals: {
    description: "Include PM storage internals in tracked-all candidate scans.",
  },
  strictExit: {
    description: "Return non-zero exit when health/validate/extension-doctor warnings are present (ok=false).",
  },
  failOnWarn: {
    description: "Alias for strictExit in health/validate/extension-doctor action payloads.",
  },
  checkHistoryDrift: {
    description: "Run item/history hash drift checks.",
  },
  checkCommandReferences: {
    description: "Run linked-command PM-ID reference checks.",
  },
  allowAuditComment: {
    description: "Allow non-owner append-only comment audits without requiring --force.",
  },
  preserveSourceIds: {
    description: "Preserve explicit source IDs during Beads imports instead of normalizing to tracker prefix.",
    examples: [true],
  },
  appendStable: {
    description: "When true for files action, preserve existing linked-file order and append new links without full-array resorting.",
  },
  stream: {
    description: "Background run log stream selector.",
    examples: ["stderr", "stdout", "both"],
  },
  tail: {
    description: "Number of lines to tail for background run logs.",
    examples: [100],
  },
  query: {
    description: "Search query text for search action.",
  },
  shell: {
    description: "Shell target for completion generation.",
    examples: ["bash"],
  },
  contractAction: {
    description: "Filter contracts schema to one tool action.",
    examples: ["create", "update"],
  },
  command: {
    description: "Filter command-level flag contracts to one CLI command name.",
    examples: ["create", "search"],
  },
  schemaOnly: {
    description: "When true, contracts action omits command flag and alias surfaces.",
  },
  runtimeOnly: {
    description: "When true, contracts action only includes actions invocable in the current runtime.",
  },
  activeOnly: {
    description: "Alias for runtimeOnly in contracts action payloads.",
  },
};

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

function buildActionScopedToolSchema(action: PmToolAction): Record<string, unknown> {
  const contract = PM_TOOL_ACTION_SCHEMA_CONTRACTS[action];
  const required = toSchemaKeyList(contract.required ?? []);
  const optional = toSchemaKeyList(contract.optional ?? []);
  const allowedKeys = toSchemaKeyList([...PM_TOOL_GLOBAL_PARAMETER_KEYS, ...required, ...optional]);
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
    const definition = PM_TOOL_PARAMETER_PROPERTIES[key];
    if (definition) {
      properties[key] = decorateToolParameterDefinition(key, definition);
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
  return schema;
}

export const PM_TOOL_PARAMETERS_SCHEMA: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://unbrained.dev/schemas/pm-cli/tool-parameters-v4.schema.json",
  title: "pm-cli Pi wrapper parameters (action-scoped strict schema)",
  "x-schema-version": "4.0.0",
  oneOf: PM_TOOL_ACTIONS.map((action) => buildActionScopedToolSchema(action)),
};
