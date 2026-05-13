export interface CommanderOptionAliasContract {
  target: string;
  keys: string[];
}

export interface CliFlagContract {
  flag: string;
  short?: string;
  aliases?: string[];
}

export interface ToolOptionFlagContract {
  param: string;
  flag: string;
  allowEmpty?: boolean;
  repeatable?: boolean;
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

export const PM_EXTENSION_POLICY_MODE_CONTRACTS = ["off", "warn", "enforce"] as const;
export type PmExtensionPolicyModeContract = (typeof PM_EXTENSION_POLICY_MODE_CONTRACTS)[number];
export const PM_EXTENSION_TRUST_MODE_CONTRACTS = ["off", "warn", "enforce"] as const;
export type PmExtensionTrustModeContract = (typeof PM_EXTENSION_TRUST_MODE_CONTRACTS)[number];
export const PM_EXTENSION_SANDBOX_PROFILE_CONTRACTS = ["none", "restricted", "strict"] as const;
export type PmExtensionSandboxProfileContract = (typeof PM_EXTENSION_SANDBOX_PROFILE_CONTRACTS)[number];

export const PM_EXTENSION_POLICY_SURFACE_CONTRACTS = [
  "commands.override",
  "commands.handler",
  "hooks.beforecommand",
  "hooks.aftercommand",
  "hooks.onwrite",
  "hooks.onread",
  "hooks.onindex",
  "schema.flags",
  "schema.itemfields",
  "schema.itemtypes",
  "schema.migrations",
  "parser.override",
  "preflight.override",
  "services.override",
  "renderers.override",
  "importers.importer",
  "importers.exporter",
  "search.provider",
  "search.vectorstore",
] as const;
export type PmExtensionPolicySurfaceContract = (typeof PM_EXTENSION_POLICY_SURFACE_CONTRACTS)[number];

function normalizeUniqueStringList(values: Iterable<string>): string[] {
  return [...new Set(Array.from(values).filter((value) => value.trim().length > 0))];
}

function normalizeFlagAliasKey(flag: string): string {
  if (!flag.startsWith("--")) {
    return flag;
  }
  return `--${flag.slice(2).replaceAll("_", "-")}`;
}

export function withFlagAliasMetadata(flagContracts: CliFlagContract[]): CliFlagContract[] {
  const aliasesByCanonical = new Map<string, Set<string>>();
  for (const contract of flagContracts) {
    const canonical = normalizeFlagAliasKey(contract.flag);
    const bucket = aliasesByCanonical.get(canonical) ?? new Set<string>();
    if (contract.flag !== canonical) {
      bucket.add(contract.flag);
    }
    for (const alias of contract.aliases ?? []) {
      if (alias !== canonical) {
        bucket.add(alias);
      }
    }
    aliasesByCanonical.set(canonical, bucket);
  }

  return flagContracts.map((contract) => {
    const canonical = normalizeFlagAliasKey(contract.flag);
    if (contract.flag !== canonical) {
      return contract;
    }
    const aliases = normalizeUniqueStringList([...(contract.aliases ?? []), ...(aliasesByCanonical.get(canonical) ?? [])]).filter(
      (alias) => alias !== canonical,
    );
    if (aliases.length === 0) {
      return contract;
    }
    return {
      ...contract,
      aliases,
    };
  });
}

export function compactFlagAliasContracts(flagContracts: CliFlagContract[]): CliFlagContract[] {
  const withAliases = withFlagAliasMetadata(flagContracts);
  const canonicalFlags = new Set(withAliases.map((contract) => contract.flag));
  return withAliases.filter((contract) => {
    const canonical = normalizeFlagAliasKey(contract.flag);
    return contract.flag === canonical || !canonicalFlags.has(canonical);
  });
}

export const PM_CORE_COMMAND_NAMES = [
  "init",
  "config",
  "extension",
  "package",
  "packages",
  "install",
  "upgrade",
  "create",
  "list",
  "list-all",
  "list-draft",
  "list-open",
  "list-in-progress",
  "list-blocked",
  "list-closed",
  "list-canceled",
  "aggregate",
  "dedupe-audit",
  "guide",
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
  "update-many",
  "normalize",
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
  "start-task",
  "pause-task",
  "close-task",
  "templates",
  "completion",
  "help",
] as const;

export const PM_TOOL_ACTIONS = [
  "init",
  "config",
  "extension-init",
  "extension-install",
  "extension-uninstall",
  "extension-explore",
  "extension-manage",
  "extension-reload",
  "extension-doctor",
  "extension-catalog",
  "extension-adopt",
  "extension-adopt-all",
  "extension-activate",
  "extension-deactivate",
  "extension",
  "package-init",
  "package-install",
  "package-uninstall",
  "package-explore",
  "package-manage",
  "package-reload",
  "package-doctor",
  "package-catalog",
  "package-adopt",
  "package-adopt-all",
  "package-activate",
  "package-deactivate",
  "package",
  "install",
  "upgrade",
  "create",
  "list",
  "list-all",
  "list-draft",
  "list-open",
  "list-in-progress",
  "list-blocked",
  "list-closed",
  "list-canceled",
  "aggregate",
  "dedupe-audit",
  "guide",
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
  "update-many",
  "normalize",
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
  "start-task",
  "pause-task",
  "close-task",
] as const;

export type PmToolAction = (typeof PM_TOOL_ACTIONS)[number];

export function isPmToolAction(value: string): value is PmToolAction {
  return PM_TOOL_ACTIONS.includes(value as PmToolAction);
}

export function isPmExtensionCapabilityContract(value: string): value is PmExtensionCapabilityContract {
  return PM_EXTENSION_CAPABILITY_CONTRACTS.includes(value as PmExtensionCapabilityContract);
}

export function isPmExtensionServiceNameContract(value: string): value is PmExtensionServiceNameContract {
  return PM_EXTENSION_SERVICE_NAME_CONTRACTS.includes(value as PmExtensionServiceNameContract);
}

export function isPmExtensionPolicyModeContract(value: string): value is PmExtensionPolicyModeContract {
  return PM_EXTENSION_POLICY_MODE_CONTRACTS.includes(value as PmExtensionPolicyModeContract);
}

export function isPmExtensionPolicySurfaceContract(value: string): value is PmExtensionPolicySurfaceContract {
  return PM_EXTENSION_POLICY_SURFACE_CONTRACTS.includes(value as PmExtensionPolicySurfaceContract);
}

export const TOOL_LIST_FILTER_OPTION_CONTRACTS: ToolOptionFlagContract[] = [
  { param: "type", flag: "--type" },
  { param: "tag", flag: "--tag" },
  { param: "priority", flag: "--priority" },
  { param: "deadlineBefore", flag: "--deadline-before" },
  { param: "deadlineAfter", flag: "--deadline-after" },
  { param: "assignee", flag: "--assignee" },
  { param: "assigneeFilter", flag: "--assignee-filter" },
  { param: "parent", flag: "--parent" },
  { param: "sprint", flag: "--sprint" },
  { param: "release", flag: "--release" },
  { param: "limit", flag: "--limit" },
  { param: "offset", flag: "--offset" },
  { param: "fields", flag: "--fields" },
  { param: "sort", flag: "--sort" },
  { param: "order", flag: "--order" },
];

export const TOOL_AGGREGATE_OPTION_CONTRACTS: ToolOptionFlagContract[] = [
  { param: "groupBy", flag: "--group-by" },
  { param: "status", flag: "--status" },
  { param: "type", flag: "--type" },
  { param: "tag", flag: "--tag" },
  { param: "priority", flag: "--priority" },
  { param: "deadlineBefore", flag: "--deadline-before" },
  { param: "deadlineAfter", flag: "--deadline-after" },
  { param: "assignee", flag: "--assignee" },
  { param: "assigneeFilter", flag: "--assignee-filter" },
  { param: "parent", flag: "--parent" },
  { param: "sprint", flag: "--sprint" },
  { param: "release", flag: "--release" },
];

export const TOOL_DEDUPE_AUDIT_OPTION_CONTRACTS: ToolOptionFlagContract[] = [
  { param: "mode", flag: "--mode" },
  { param: "limit", flag: "--limit" },
  { param: "threshold", flag: "--threshold" },
  { param: "status", flag: "--status" },
  { param: "type", flag: "--type" },
  { param: "tag", flag: "--tag" },
  { param: "priority", flag: "--priority" },
  { param: "deadlineBefore", flag: "--deadline-before" },
  { param: "deadlineAfter", flag: "--deadline-after" },
  { param: "assignee", flag: "--assignee" },
  { param: "assigneeFilter", flag: "--assignee-filter" },
  { param: "parent", flag: "--parent" },
  { param: "sprint", flag: "--sprint" },
  { param: "release", flag: "--release" },
];

export const TOOL_SEARCH_FILTER_OPTION_CONTRACTS: ToolOptionFlagContract[] = [
  { param: "type", flag: "--type" },
  { param: "tag", flag: "--tag" },
  { param: "priority", flag: "--priority" },
  { param: "deadlineBefore", flag: "--deadline-before" },
  { param: "deadlineAfter", flag: "--deadline-after" },
  { param: "fields", flag: "--fields" },
  { param: "limit", flag: "--limit" },
];

export const TOOL_SHARED_CREATE_UPDATE_OPTION_CONTRACTS: ToolOptionFlagContract[] = [
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
  { param: "body", flag: "--body", allowEmpty: true },
  { param: "deadline", flag: "--deadline" },
  { param: "estimate", flag: "--estimate" },
  { param: "acceptanceCriteria", flag: "--acceptance-criteria", allowEmpty: true },
  { param: "author", flag: "--author" },
  { param: "message", flag: "--message", allowEmpty: true },
  { param: "assignee", flag: "--assignee" },
  { param: "reminder", flag: "--reminder", repeatable: true },
  { param: "event", flag: "--event", repeatable: true },
  { param: "typeOption", flag: "--type-option", repeatable: true },
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
  { param: "allowAuditUpdate", flag: "--allow-audit-update" },
];

export const TOOL_UPDATE_OPTION_CONTRACTS: ToolOptionFlagContract[] = [
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
  { param: "allowAuditDepUpdate", flag: "--allow-audit-dep-update" },
];

export const TOOL_UPDATE_MANY_FILTER_OPTION_CONTRACTS: ToolOptionFlagContract[] = [
  { param: "filterStatus", flag: "--filter-status" },
  { param: "filterType", flag: "--filter-type" },
  { param: "filterTag", flag: "--filter-tag" },
  { param: "filterPriority", flag: "--filter-priority" },
  { param: "filterDeadlineBefore", flag: "--filter-deadline-before" },
  { param: "filterDeadlineAfter", flag: "--filter-deadline-after" },
  { param: "filterAssignee", flag: "--filter-assignee" },
  { param: "filterAssigneeFilter", flag: "--filter-assignee-filter" },
  { param: "filterParent", flag: "--filter-parent" },
  { param: "filterSprint", flag: "--filter-sprint" },
  { param: "filterRelease", flag: "--filter-release" },
  { param: "limit", flag: "--limit" },
  { param: "offset", flag: "--offset" },
];

export const TOOL_NORMALIZE_FILTER_OPTION_CONTRACTS: ToolOptionFlagContract[] = [...TOOL_UPDATE_MANY_FILTER_OPTION_CONTRACTS];

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
  { param: "format", flag: "--format" },
];

export const TOOL_ACTIVITY_OPTION_CONTRACTS: ToolOptionFlagContract[] = [
  { param: "id", flag: "--id" },
  { param: "op", flag: "--op" },
  { param: "author", flag: "--author" },
  { param: "from", flag: "--from" },
  { param: "to", flag: "--to" },
  { param: "limit", flag: "--limit" },
];

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
  { param: "limit", flag: "--limit" },
  { param: "format", flag: "--format" },
  { param: "depth", flag: "--depth" },
  { param: "section", flag: "--section", repeatable: true },
  { param: "activityLimit", flag: "--activity-limit" },
  { param: "staleThreshold", flag: "--stale-threshold" },
];

export const TOOL_DEPS_OPTION_CONTRACTS: ToolOptionFlagContract[] = [
  { param: "format", flag: "--format" },
  { param: "maxDepth", flag: "--max-depth" },
  { param: "collapse", flag: "--collapse" },
  { param: "summary", flag: "--summary" },
];

export const SUBCOMMAND_GLOBAL_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--json" },
  { flag: "--quiet" },
  { flag: "--path" },
  { flag: "--no-extensions" },
  { flag: "--no-pager" },
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
  { flag: "--assignee-filter" },
  { flag: "--assignee_filter" },
  { flag: "--parent" },
  { flag: "--sprint" },
  { flag: "--release" },
  { flag: "--limit" },
  { flag: "--offset" },
  { flag: "--compact" },
  { flag: "--fields" },
  { flag: "--sort" },
  { flag: "--order" },
  { flag: "--include-body" },
  { flag: "--stream" },
];

export const AGGREGATE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--group-by" },
  { flag: "--count" },
  { flag: "--include-unparented" },
  { flag: "--include_unparented" },
  { flag: "--status" },
  { flag: "--type" },
  { flag: "--tag" },
  { flag: "--priority" },
  { flag: "--deadline-before" },
  { flag: "--deadline-after" },
  { flag: "--assignee" },
  { flag: "--assignee-filter" },
  { flag: "--assignee_filter" },
  { flag: "--parent" },
  { flag: "--sprint" },
  { flag: "--release" },
];

export const DEDUPE_AUDIT_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--mode" },
  { flag: "--limit" },
  { flag: "--threshold" },
  { flag: "--status" },
  { flag: "--type" },
  { flag: "--tag" },
  { flag: "--priority" },
  { flag: "--deadline-before" },
  { flag: "--deadline-after" },
  { flag: "--assignee" },
  { flag: "--assignee-filter" },
  { flag: "--assignee_filter" },
  { flag: "--parent" },
  { flag: "--sprint" },
  { flag: "--release" },
];

export const COMMENTS_AUDIT_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--status" },
  { flag: "--type" },
  { flag: "--assignee" },
  { flag: "--assignee-filter" },
  { flag: "--assignee_filter" },
  { flag: "--parent" },
  { flag: "--tag" },
  { flag: "--sprint" },
  { flag: "--release" },
  { flag: "--priority" },
  { flag: "--limit-items" },
  { flag: "--limit" },
  { flag: "--full-history" },
  { flag: "--latest" },
];

export const COMMENTS_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--add" },
  { flag: "--stdin" },
  { flag: "--file" },
  { flag: "--limit" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--allow-audit-comment" },
  { flag: "--force" },
];

export const NOTES_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--add" },
  { flag: "--limit" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--allow-audit-note" },
  { flag: "--allow-audit-comment" },
  { flag: "--force" },
];

export const LEARNINGS_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--add" },
  { flag: "--limit" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--allow-audit-learning" },
  { flag: "--allow-audit-comment" },
  { flag: "--force" },
];

export const FILES_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--add" },
  { flag: "--add-glob" },
  { flag: "--remove" },
  { flag: "--migrate" },
  { flag: "--list" },
  { flag: "--apply" },
  { flag: "--note" },
  { flag: "--append-stable" },
  { flag: "--validate-paths" },
  { flag: "--audit" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const DOCS_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--add" },
  { flag: "--add-glob" },
  { flag: "--remove" },
  { flag: "--migrate" },
  { flag: "--validate-paths" },
  { flag: "--audit" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const HISTORY_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--limit" },
  { flag: "--diff" },
  { flag: "--verify" },
];

export const INIT_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--preset" },
];

export const CONFIG_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--criterion" },
  { flag: "--clear-criteria" },
  { flag: "--format" },
  { flag: "--policy" },
  { flag: "--default-depth" },
  { flag: "--activity-limit" },
  { flag: "--stale-threshold-days" },
  { flag: "--section-hierarchy" },
  { flag: "--section-activity" },
  { flag: "--section-progress" },
  { flag: "--section-blockers" },
  { flag: "--section-files" },
  { flag: "--section-workload" },
  { flag: "--section-staleness" },
  { flag: "--section-tests" },
];

export const EXTENSION_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--init" },
  { flag: "--scaffold" },
  { flag: "--install" },
  { flag: "--uninstall" },
  { flag: "--explore" },
  { flag: "--manage" },
  { flag: "--reload" },
  { flag: "--watch" },
  { flag: "--doctor" },
  { flag: "--catalog" },
  { flag: "--adopt" },
  { flag: "--adopt-all" },
  { flag: "--activate" },
  { flag: "--deactivate" },
  { flag: "--project" },
  { flag: "--local" },
  { flag: "--global" },
  { flag: "--gh" },
  { flag: "--github" },
  { flag: "--ref" },
  { flag: "--detail" },
  { flag: "--trace" },
  { flag: "--runtime-probe" },
  { flag: "--fix-managed-state" },
  { flag: "--strict-exit" },
  { flag: "--fail-on-warn" },
];

export const UPGRADE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--dry-run" },
  { flag: "--cli-only" },
  { flag: "--packages-only" },
  { flag: "--project" },
  { flag: "--local" },
  { flag: "--global" },
  { flag: "--repair" },
  { flag: "--tag" },
  { flag: "--package-name" },
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

export const APPEND_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--body", short: "-b" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const CLAIM_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const RESTORE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const DELETE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const RELEASE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--allow-audit-release" },
  { flag: "--force" },
];

export const START_TASK_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const PAUSE_TASK_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const CLOSE_TASK_FLAG_CONTRACTS: CliFlagContract[] = [
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
  { flag: "--override-linked-pm-context" },
  { flag: "--fail-on-context-mismatch" },
  { flag: "--fail-on-skipped" },
  { flag: "--fail-on-empty-test-run" },
  { flag: "--require-assertions-for-pm" },
  { flag: "--check-context" },
  { flag: "--auto-pm-context" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const TEST_ALL_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--status" },
  { flag: "--limit" },
  { flag: "--offset" },
  { flag: "--background" },
  { flag: "--timeout" },
  { flag: "--progress" },
  { flag: "--env-set" },
  { flag: "--env-clear" },
  { flag: "--shared-host-safe" },
  { flag: "--pm-context" },
  { flag: "--override-linked-pm-context" },
  { flag: "--fail-on-context-mismatch" },
  { flag: "--fail-on-skipped" },
  { flag: "--fail-on-empty-test-run" },
  { flag: "--require-assertions-for-pm" },
  { flag: "--check-context" },
  { flag: "--auto-pm-context" },
];

export const TEST_RUNS_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--status" },
  { flag: "--limit" },
  { flag: "--stream" },
  { flag: "--tail" },
  { flag: "--force" },
  { flag: "--author" },
];

export const GC_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--dry-run" },
  { flag: "--scope" },
];

export const HEALTH_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--strict-directories" },
  { flag: "--strict-exit" },
  { flag: "--fail-on-warn" },
  { flag: "--check-only" },
  { flag: "--check-telemetry" },
  { flag: "--no-refresh" },
  { flag: "--refresh-vectors" },
  { flag: "--verbose-stale-items" },
];

export const VALIDATE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--check-metadata" },
  { flag: "--metadata-profile" },
  { flag: "--check-resolution" },
  { flag: "--check-lifecycle" },
  { flag: "--check-stale-blockers" },
  { flag: "--dependency-cycle-severity" },
  { flag: "--check-files" },
  { flag: "--scan-mode" },
  { flag: "--include-pm-internals" },
  { flag: "--verbose-file-lists" },
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
  { flag: "--schedule-preset" },
  { flag: "--schedule_preset" },
  { short: "-s", flag: "--status" },
  { short: "-p", flag: "--priority" },
  { flag: "--tags" },
  { short: "-b", flag: "--body" },
  { flag: "--deadline" },
  { flag: "--estimate" },
  { flag: "--estimated-minutes" },
  { flag: "--estimated_minutes" },
  { flag: "--acceptance-criteria" },
  { flag: "--acceptance_criteria" },
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
  { flag: "--customer_impact" },
  { flag: "--definition-of-ready" },
  { flag: "--definition_of_ready" },
  { flag: "--order" },
  { flag: "--rank" },
  { flag: "--goal" },
  { flag: "--objective" },
  { flag: "--value" },
  { flag: "--impact" },
  { flag: "--outcome" },
  { flag: "--why-now" },
  { flag: "--why_now" },
  { flag: "--blocked_by" },
  { flag: "--blocked_reason" },
  { flag: "--unblock_note" },
  { flag: "--repro_steps" },
  { flag: "--expected_result" },
  { flag: "--actual_result" },
  { flag: "--affected_version" },
  { flag: "--fixed_version" },
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
  { flag: "--unset" },
  { flag: "--clear-deps" },
  { flag: "--clear-comments" },
  { flag: "--clear-notes" },
  { flag: "--clear-learnings" },
  { flag: "--clear-files" },
  { flag: "--clear-tests" },
  { flag: "--clear-docs" },
  { flag: "--clear-reminders" },
  { flag: "--clear-events" },
  { flag: "--clear-type-options" },
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
  { flag: "--estimated_minutes" },
  { flag: "--acceptance-criteria" },
  { flag: "--acceptance_criteria" },
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
  { flag: "--fixed_version" },
  { flag: "--component" },
  { flag: "--regression" },
  { flag: "--customer-impact" },
  { flag: "--customer_impact" },
  { flag: "--definition-of-ready" },
  { flag: "--definition_of_ready" },
  { flag: "--order" },
  { flag: "--rank" },
  { flag: "--goal" },
  { flag: "--objective" },
  { flag: "--value" },
  { flag: "--impact" },
  { flag: "--outcome" },
  { flag: "--why-now" },
  { flag: "--why_now" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--blocked_by" },
  { flag: "--blocked_reason" },
  { flag: "--unblock_note" },
  { flag: "--repro_steps" },
  { flag: "--expected_result" },
  { flag: "--actual_result" },
  { flag: "--affected_version" },
  { flag: "--dep" },
  { flag: "--dep-remove" },
  { flag: "--dep_remove" },
  { flag: "--replace-deps" },
  { flag: "--replace-tests" },
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
  { flag: "--unset" },
  { flag: "--clear-deps" },
  { flag: "--clear-comments" },
  { flag: "--clear-notes" },
  { flag: "--clear-learnings" },
  { flag: "--clear-files" },
  { flag: "--clear-tests" },
  { flag: "--clear-docs" },
  { flag: "--clear-reminders" },
  { flag: "--clear-events" },
  { flag: "--clear-type-options" },
  { flag: "--allow-audit-update" },
  { flag: "--allow_audit_update" },
  { flag: "--allow-audit-dep-update" },
  { flag: "--allow_audit_dep_update" },
  { flag: "--force" },
];

export const UPDATE_MANY_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--filter-status" },
  { flag: "--filter-type" },
  { flag: "--filter-tag" },
  { flag: "--filter-priority" },
  { flag: "--filter-deadline-before" },
  { flag: "--filter-deadline-after" },
  { flag: "--filter-assignee" },
  { flag: "--filter-assignee-filter" },
  { flag: "--filter-assignee_filter" },
  { flag: "--filter-parent" },
  { flag: "--filter-sprint" },
  { flag: "--filter-release" },
  { flag: "--limit" },
  { flag: "--offset" },
  { flag: "--dry-run" },
  { flag: "--rollback" },
  { flag: "--no-checkpoint" },
  { short: "-t", flag: "--title" },
  { short: "-d", flag: "--description" },
  { short: "-b", flag: "--body" },
  { short: "-p", flag: "--priority" },
  { flag: "--type" },
  { flag: "--tags" },
  { flag: "--deadline" },
  { flag: "--estimate" },
  { flag: "--estimated-minutes" },
  { flag: "--estimated_minutes" },
  { flag: "--acceptance-criteria" },
  { flag: "--acceptance_criteria" },
  { flag: "--ac" },
  { flag: "--definition-of-ready" },
  { flag: "--definition_of_ready" },
  { flag: "--order" },
  { flag: "--rank" },
  { flag: "--goal" },
  { flag: "--objective" },
  { flag: "--value" },
  { flag: "--impact" },
  { flag: "--outcome" },
  { flag: "--why-now" },
  { flag: "--why_now" },
  { flag: "--reviewer" },
  { flag: "--risk" },
  { flag: "--confidence" },
  { flag: "--sprint" },
  { flag: "--release" },
  { flag: "--reporter" },
  { flag: "--severity" },
  { flag: "--environment" },
  { flag: "--repro-steps" },
  { flag: "--repro_steps" },
  { flag: "--resolution" },
  { flag: "--expected-result" },
  { flag: "--expected_result" },
  { flag: "--actual-result" },
  { flag: "--actual_result" },
  { flag: "--affected-version" },
  { flag: "--affected_version" },
  { flag: "--fixed-version" },
  { flag: "--fixed_version" },
  { flag: "--component" },
  { flag: "--regression" },
  { flag: "--customer-impact" },
  { flag: "--customer_impact" },
  { flag: "--dep" },
  { flag: "--dep-remove" },
  { flag: "--dep_remove" },
  { flag: "--replace-deps" },
  { flag: "--replace-tests" },
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
  { flag: "--unset" },
  { flag: "--clear-deps" },
  { flag: "--clear-comments" },
  { flag: "--clear-notes" },
  { flag: "--clear-learnings" },
  { flag: "--clear-files" },
  { flag: "--clear-tests" },
  { flag: "--clear-docs" },
  { flag: "--clear-reminders" },
  { flag: "--clear-events" },
  { flag: "--clear-type-options" },
  { flag: "--allow-audit-update" },
  { flag: "--allow_audit_update" },
  { flag: "--allow-audit-dep-update" },
  { flag: "--allow_audit_dep_update" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const NORMALIZE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--filter-status" },
  { flag: "--filter-type" },
  { flag: "--filter-tag" },
  { flag: "--filter-priority" },
  { flag: "--filter-deadline-before" },
  { flag: "--filter-deadline-after" },
  { flag: "--filter-assignee" },
  { flag: "--filter-assignee-filter" },
  { flag: "--filter-assignee_filter" },
  { flag: "--filter-parent" },
  { flag: "--filter-sprint" },
  { flag: "--filter-release" },
  { flag: "--limit" },
  { flag: "--offset" },
  { flag: "--dry-run" },
  { flag: "--apply" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--allow-audit-update" },
  { flag: "--allow_audit_update" },
  { flag: "--force" },
];

export const CALENDAR_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--view" },
  { flag: "--date" },
  { flag: "--from" },
  { flag: "--to" },
  { flag: "--past" },
  { flag: "--full-period" },
  { flag: "--full_period" },
  { flag: "--type" },
  { flag: "--tag" },
  { flag: "--priority" },
  { flag: "--status" },
  { flag: "--assignee" },
  { flag: "--assignee-filter" },
  { flag: "--assignee_filter" },
  { flag: "--sprint" },
  { flag: "--release" },
  { flag: "--include" },
  { flag: "--recurrence-lookahead-days" },
  { flag: "--recurrence-lookback-days" },
  { flag: "--occurrence-limit" },
  { flag: "--limit" },
  { flag: "--format" },
];

export const ACTIVITY_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--id" },
  { flag: "--op" },
  { flag: "--author" },
  { flag: "--from" },
  { flag: "--to" },
  { flag: "--limit" },
  { flag: "--stream" },
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
  { flag: "--assignee-filter" },
  { flag: "--assignee_filter" },
  { flag: "--sprint" },
  { flag: "--release" },
  { flag: "--limit" },
  { flag: "--format" },
  { flag: "--depth" },
  { flag: "--section" },
  { flag: "--activity-limit" },
  { flag: "--stale-threshold" },
];

export const GUIDE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--list" },
  { flag: "--format" },
  { flag: "--depth" },
];

export const DEPS_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--format" },
  { flag: "--max-depth" },
  { flag: "--collapse" },
  { flag: "--summary" },
];

export const SEARCH_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--mode" },
  { flag: "--include-linked" },
  { flag: "--title-exact" },
  { flag: "--phrase-exact" },
  { flag: "--compact" },
  { flag: "--full" },
  { flag: "--fields" },
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
  { flag: "--flags-only" },
  { flag: "--availability-only" },
  { flag: "--runtime-only" },
  { flag: "--active-only" },
];

export const COMPLETION_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--eager-tags" },
];

function toUniqueFlagContracts(contracts: CliFlagContract[]): CliFlagContract[] {
  const seen = new Set<string>();
  const unique: CliFlagContract[] = [];
  for (const contract of contracts) {
    const aliasKey = (contract.aliases ?? []).join(",");
    const key = `${contract.flag}|${contract.short ?? ""}|${aliasKey}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(contract);
  }
  return unique;
}

function withSubcommandGlobalFlags(contracts: CliFlagContract[]): CliFlagContract[] {
  return withFlagAliasMetadata(toUniqueFlagContracts([...SUBCOMMAND_GLOBAL_FLAG_CONTRACTS, ...contracts]));
}

const LIST_COMMAND_NAME_CONTRACTS = new Set([
  "list",
  "list-all",
  "list-draft",
  "list-open",
  "list-in-progress",
  "list-blocked",
  "list-closed",
  "list-canceled",
]);

const NO_SURFACE_COMMAND_NAME_CONTRACTS = new Set([
  "get",
  "stats",
  "reindex",
  "help",
]);

function normalizeCommandNameForContracts(commandName: string | undefined): string {
  if (typeof commandName !== "string") {
    return "";
  }
  return commandName.trim().toLowerCase();
}

export function resolveSubcommandFlagContractsForCommand(commandName: string | undefined): CliFlagContract[] {
  const normalized = normalizeCommandNameForContracts(commandName);
  if (normalized.length === 0) {
    return withSubcommandGlobalFlags([]);
  }
  if (LIST_COMMAND_NAME_CONTRACTS.has(normalized)) {
    return withSubcommandGlobalFlags(LIST_FILTER_FLAG_CONTRACTS);
  }
  if (NO_SURFACE_COMMAND_NAME_CONTRACTS.has(normalized)) {
    return withSubcommandGlobalFlags([]);
  }
  if (normalized === "templates") {
    return withSubcommandGlobalFlags(CREATE_FLAG_CONTRACTS);
  }
  if (normalized === "cal") {
    return withSubcommandGlobalFlags(CALENDAR_FLAG_CONTRACTS);
  }
  if (normalized === "ctx") {
    return withSubcommandGlobalFlags(CONTEXT_FLAG_CONTRACTS);
  }
  if (normalized === "test-runs-worker") {
    return withSubcommandGlobalFlags(TEST_RUNS_FLAG_CONTRACTS);
  }
  switch (normalized) {
    case "init":
      return withSubcommandGlobalFlags(INIT_FLAG_CONTRACTS);
    case "config":
      return withSubcommandGlobalFlags(CONFIG_FLAG_CONTRACTS);
    case "extension":
    case "package":
    case "packages":
    case "install":
      return withSubcommandGlobalFlags(EXTENSION_FLAG_CONTRACTS);
    case "upgrade":
      return withSubcommandGlobalFlags(UPGRADE_FLAG_CONTRACTS);
    case "create":
      return withSubcommandGlobalFlags(CREATE_FLAG_CONTRACTS);
    case "aggregate":
      return withSubcommandGlobalFlags(AGGREGATE_FLAG_CONTRACTS);
    case "dedupe-audit":
      return withSubcommandGlobalFlags(DEDUPE_AUDIT_FLAG_CONTRACTS);
    case "comments-audit":
      return withSubcommandGlobalFlags(COMMENTS_AUDIT_FLAG_CONTRACTS);
    case "calendar":
      return withSubcommandGlobalFlags(CALENDAR_FLAG_CONTRACTS);
    case "context":
      return withSubcommandGlobalFlags(CONTEXT_FLAG_CONTRACTS);
    case "search":
      return withSubcommandGlobalFlags(SEARCH_FLAG_CONTRACTS);
    case "history":
      return withSubcommandGlobalFlags(HISTORY_FLAG_CONTRACTS);
    case "activity":
      return withSubcommandGlobalFlags(ACTIVITY_FLAG_CONTRACTS);
    case "restore":
      return withSubcommandGlobalFlags(RESTORE_FLAG_CONTRACTS);
    case "update":
      return withSubcommandGlobalFlags(UPDATE_FLAG_CONTRACTS);
    case "update-many":
      return withSubcommandGlobalFlags(UPDATE_MANY_FLAG_CONTRACTS);
    case "normalize":
      return withSubcommandGlobalFlags(NORMALIZE_FLAG_CONTRACTS);
    case "close":
      return withSubcommandGlobalFlags(CLOSE_FLAG_CONTRACTS);
    case "delete":
      return withSubcommandGlobalFlags(DELETE_FLAG_CONTRACTS);
    case "append":
      return withSubcommandGlobalFlags(APPEND_FLAG_CONTRACTS);
    case "comments":
      return withSubcommandGlobalFlags(COMMENTS_FLAG_CONTRACTS);
    case "notes":
      return withSubcommandGlobalFlags(NOTES_FLAG_CONTRACTS);
    case "learnings":
      return withSubcommandGlobalFlags(LEARNINGS_FLAG_CONTRACTS);
    case "files":
      return withSubcommandGlobalFlags(FILES_FLAG_CONTRACTS);
    case "docs":
      return withSubcommandGlobalFlags(DOCS_FLAG_CONTRACTS);
    case "deps":
      return withSubcommandGlobalFlags(DEPS_FLAG_CONTRACTS);
    case "test":
      return withSubcommandGlobalFlags(TEST_FLAG_CONTRACTS);
    case "test-all":
      return withSubcommandGlobalFlags(TEST_ALL_FLAG_CONTRACTS);
    case "test-runs":
      return withSubcommandGlobalFlags(TEST_RUNS_FLAG_CONTRACTS);
    case "health":
      return withSubcommandGlobalFlags(HEALTH_FLAG_CONTRACTS);
    case "validate":
      return withSubcommandGlobalFlags(VALIDATE_FLAG_CONTRACTS);
    case "gc":
      return withSubcommandGlobalFlags(GC_FLAG_CONTRACTS);
    case "contracts":
      return withSubcommandGlobalFlags(CONTRACTS_FLAG_CONTRACTS);
    case "claim":
      return withSubcommandGlobalFlags(CLAIM_FLAG_CONTRACTS);
    case "release":
      return withSubcommandGlobalFlags(RELEASE_FLAG_CONTRACTS);
    case "start-task":
      return withSubcommandGlobalFlags(START_TASK_FLAG_CONTRACTS);
    case "pause-task":
      return withSubcommandGlobalFlags(PAUSE_TASK_FLAG_CONTRACTS);
    case "close-task":
      return withSubcommandGlobalFlags(CLOSE_TASK_FLAG_CONTRACTS);
    case "guide":
      return withSubcommandGlobalFlags(GUIDE_FLAG_CONTRACTS);
    case "completion":
      return withSubcommandGlobalFlags(COMPLETION_FLAG_CONTRACTS);
    default:
      return withSubcommandGlobalFlags([]);
  }
}

export function toCompletionFlagString(flagContracts: CliFlagContract[], includeGlobal = true): string {
  const aliasAwareContracts = withFlagAliasMetadata(flagContracts);
  const scoped = aliasAwareContracts
    .flatMap((entry) => [entry.short, entry.flag, ...(entry.aliases ?? [])])
    .filter((value): value is string => Boolean(value));
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
  { target: "schedulePreset", keys: ["schedulePreset", "schedule_preset"] },
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
  { target: "unset", keys: ["unset"] },
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
  { target: "unset", keys: ["unset"] },
];

export const LIST_COMMANDER_STRING_OPTION_CONTRACTS: CommanderOptionAliasContract[] = [
  { target: "status", keys: ["status"] },
  { target: "type", keys: ["type"] },
  { target: "tag", keys: ["tag"] },
  { target: "priority", keys: ["priority"] },
  { target: "deadlineBefore", keys: ["deadlineBefore"] },
  { target: "deadlineAfter", keys: ["deadlineAfter"] },
  { target: "assignee", keys: ["assignee"] },
  { target: "assigneeFilter", keys: ["assigneeFilter", "assignee_filter"] },
  { target: "parent", keys: ["parent"] },
  { target: "sprint", keys: ["sprint"] },
  { target: "release", keys: ["release"] },
  { target: "limit", keys: ["limit"] },
  { target: "offset", keys: ["offset"] },
  { target: "fields", keys: ["fields"] },
  { target: "sort", keys: ["sort"] },
  { target: "order", keys: ["order"] },
];

export const SEARCH_COMMANDER_STRING_OPTION_CONTRACTS: CommanderOptionAliasContract[] = [
  { target: "mode", keys: ["mode"] },
  { target: "type", keys: ["type"] },
  { target: "tag", keys: ["tag"] },
  { target: "priority", keys: ["priority"] },
  { target: "deadlineBefore", keys: ["deadlineBefore"] },
  { target: "deadlineAfter", keys: ["deadlineAfter"] },
  { target: "fields", keys: ["fields"] },
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
  { target: "assigneeFilter", keys: ["assigneeFilter", "assignee_filter"] },
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
  { target: "assigneeFilter", keys: ["assigneeFilter", "assignee_filter"] },
  { target: "sprint", keys: ["sprint"] },
  { target: "release", keys: ["release"] },
  { target: "limit", keys: ["limit"] },
  { target: "format", keys: ["format"] },
  { target: "depth", keys: ["depth"] },
  { target: "activityLimit", keys: ["activityLimit", "activity_limit"] },
  { target: "staleThreshold", keys: ["staleThreshold", "stale_threshold"] },
];

export const ACTIVITY_COMMANDER_STRING_OPTION_CONTRACTS: CommanderOptionAliasContract[] = [
  { target: "id", keys: ["id"] },
  { target: "op", keys: ["op"] },
  { target: "author", keys: ["author"] },
  { target: "from", keys: ["from"] },
  { target: "to", keys: ["to"] },
  { target: "limit", keys: ["limit"] },
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
  noPager: { type: "boolean" },
  path: { type: "string" },
  pmExecutable: { type: "string" },
  timeoutMs: { type: "number" },
  id: { type: "string" },
  target: { type: "string" },
  github: { type: "string" },
  ref: { type: "string" },
  query: { type: "string" },
  keywords: { type: "string" },
  fields: { type: "string" },
  sort: { type: "string", enum: ["priority", "deadline", "updated_at", "created_at", "title", "parent"] },
  prefix: { type: "string" },
  preset: { type: "string", enum: ["minimal", "default", "strict", "custom"] },
  scope: { type: "string", enum: ["project", "global"] },
  contractAction: { type: "string" },
  command: { type: "string" },
  schemaOnly: { type: "boolean" },
  flagsOnly: { type: "boolean" },
  availabilityOnly: { type: "boolean" },
  runtimeOnly: { type: "boolean" },
  activeOnly: { type: "boolean" },
  eagerTags: { type: "boolean" },
  configAction: { type: "string", enum: ["get", "set", "list", "export"] },
  key: { type: "string" },
  title: { type: "string" },
  description: { type: "string" },
  type: { type: "string" },
  template: { type: "string" },
  createMode: { type: "string", enum: ["strict", "progressive"] },
  schedulePreset: { type: "string", enum: ["lightweight"] },
  status: { type: "string", enum: ["draft", "open", "in_progress", "blocked", "closed", "canceled", "in-progress"] },
  filterStatus: { type: "string" },
  filterType: { type: "string" },
  filterTag: { type: "string" },
  filterPriority: { anyOf: [{ type: "string" }, { type: "number" }] },
  filterDeadlineBefore: { type: "string" },
  filterDeadlineAfter: { type: "string" },
  filterAssignee: { type: "string" },
  filterAssigneeFilter: { type: "string", enum: ["assigned", "unassigned"] },
  filterParent: { type: "string" },
  filterSprint: { type: "string" },
  filterRelease: { type: "string" },
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
  assigneeFilter: { type: "string", enum: ["assigned", "unassigned"] },
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
  mode: {
    type: "string",
    enum: ["keyword", "semantic", "hybrid", "title_exact", "title_fuzzy", "parent_scope"],
  },
  op: { type: "string" },
  compact: { type: "boolean" },
  full: { type: "boolean" },
  view: { type: "string", enum: ["agenda", "day", "week", "month"] },
  date: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  past: { type: "boolean" },
  fullPeriod: { type: "boolean" },
  include: { type: "string" },
  recurrenceLookaheadDays: { anyOf: [{ type: "string" }, { type: "number" }] },
  recurrenceLookbackDays: { anyOf: [{ type: "string" }, { type: "number" }] },
  occurrenceLimit: { anyOf: [{ type: "string" }, { type: "number" }] },
  includeLinked: { type: "boolean" },
  titleExact: { type: "boolean" },
  phraseExact: { type: "boolean" },
  includeBody: { type: "boolean" },
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
  stream: {
    anyOf: [{ type: "boolean" }, { type: "string", enum: ["stdout", "stderr", "both", "rows", "ndjson", "jsonl"] }],
  },
  tail: { anyOf: [{ type: "string" }, { type: "number" }] },
  envSet: { type: "array", items: { type: "string" } },
  envClear: { type: "array", items: { type: "string" } },
  sharedHostSafe: { type: "boolean" },
  detail: { type: "string", enum: ["summary", "deep"] },
  trace: { type: "boolean" },
  reload: { type: "boolean" },
  watch: { type: "boolean" },
  runtimeProbe: { type: "boolean" },
  fixManagedState: { type: "boolean" },
  pmContext: { type: "string", enum: ["schema", "tracker", "auto"] },
  overrideLinkedPmContext: { type: "boolean" },
  failOnContextMismatch: { type: "boolean" },
  failOnSkipped: { type: "boolean" },
  failOnEmptyTestRun: { type: "boolean" },
  requireAssertionsForPm: { type: "boolean" },
  checkContext: { type: "boolean" },
  autoPmContext: { type: "boolean" },
  diff: { type: "boolean" },
  verify: { type: "boolean" },
  timeout: { anyOf: [{ type: "string" }, { type: "number" }] },
  validateClose: { type: "string", enum: ["off", "warn", "strict"] },
  checkMetadata: { type: "boolean" },
  metadataProfile: { type: "string", enum: ["core", "strict", "custom"] },
  checkResolution: { type: "boolean" },
  checkLifecycle: { type: "boolean" },
  checkStaleBlockers: { type: "boolean" },
  dependencyCycleSeverity: { type: "string", enum: ["off", "warn", "error"] },
  checkFiles: { type: "boolean" },
  strictDirectories: { type: "boolean" },
  checkOnly: { type: "boolean" },
  checkTelemetry: { type: "boolean" },
  noRefresh: { type: "boolean" },
  refreshVectors: { type: "boolean" },
  verboseStaleItems: { type: "boolean" },
  scanMode: { type: "string", enum: ["default", "tracked-all", "tracked-all-strict"] },
  includePmInternals: { type: "boolean" },
  verboseFileLists: { type: "boolean" },
  strictExit: { type: "boolean" },
  failOnWarn: { type: "boolean" },
  checkHistoryDrift: { type: "boolean" },
  checkCommandReferences: { type: "boolean" },
  allowAuditNote: { type: "boolean" },
  allowAuditLearning: { type: "boolean" },
  allowAuditComment: { type: "boolean" },
  allowAuditUpdate: { type: "boolean" },
  allowAuditDepUpdate: { type: "boolean" },
  allowAuditRelease: { type: "boolean" },
  dryRun: { type: "boolean" },
  cliOnly: { type: "boolean" },
  packagesOnly: { type: "boolean" },
  repair: { type: "boolean" },
  packageName: { type: "string" },
  rollback: { type: "string" },
  noCheckpoint: { type: "boolean" },
  force: { type: "boolean" },
  run: { type: "boolean" },
  count: { type: "boolean" },
  includeUnparented: { type: "boolean" },
  gcScope: {
    type: "array",
    items: { type: "string", enum: ["index", "embeddings", "runtime"] },
  },
  maxDepth: { anyOf: [{ type: "string" }, { type: "number" }] },
  collapse: { type: "string", enum: ["none", "repeated"] },
  summary: { type: "boolean" },
  shell: { type: "string", enum: ["bash", "zsh", "fish"] },
  stdin: { type: "boolean" },
  file: { type: "string" },
  preserveSourceIds: { type: "boolean" },
  folder: { type: "string" },
  text: { type: "string" },
  add: { type: "array", items: { type: "string" } },
  addGlob: { type: "array", items: { type: "string" } },
  remove: { type: "array", items: { type: "string" } },
  migrate: { type: "array", items: { type: "string" } },
  discover: { type: "boolean" },
  apply: { type: "boolean" },
  discoveryNote: { type: "string" },
  appendStable: { type: "boolean" },
  validatePaths: { type: "boolean" },
  audit: { type: "boolean" },
  dep: { type: "array", items: { type: "string" } },
  depRemove: { type: "array", items: { type: "string" } },
  replaceDeps: { type: "boolean" },
  replaceTests: { type: "boolean" },
  comment: { type: "array", items: { type: "string" } },
  note: { type: "array", items: { type: "string" } },
  learning: { type: "array", items: { type: "string" } },
  linkedFile: { type: "array", items: { type: "string" } },
  linkedTest: { type: "array", items: { type: "string" } },
  doc: { type: "array", items: { type: "string" } },
  reminder: { type: "array", items: { type: "string" } },
  event: { type: "array", items: { type: "string" } },
  typeOption: { type: "array", items: { type: "string" } },
  unset: { type: "array", items: { type: "string" } },
  clearDeps: { type: "boolean" },
  clearComments: { type: "boolean" },
  clearNotes: { type: "boolean" },
  clearLearnings: { type: "boolean" },
  clearFiles: { type: "boolean" },
  clearTests: { type: "boolean" },
  clearDocs: { type: "boolean" },
  clearReminders: { type: "boolean" },
  clearEvents: { type: "boolean" },
  clearTypeOptions: { type: "boolean" },
  criterion: { type: "array", items: { type: "string" } },
  clearCriteria: { type: "boolean" },
  groupBy: { type: "string" },
  threshold: { anyOf: [{ type: "string" }, { type: "number" }] },
  format: { type: "string" },
  depth: { type: "string", enum: ["brief", "standard", "deep"] },
  section: { type: "array", items: { type: "string", enum: ["hierarchy", "activity", "progress", "blockers", "files", "workload", "staleness", "tests"] } },
  activityLimit: { anyOf: [{ type: "string" }, { type: "number" }] },
  staleThreshold: { type: "string" },
  policy: { type: "string" },
};

const PM_TOOL_GLOBAL_PARAMETER_KEYS = ["json", "quiet", "profile", "noExtensions", "noPager", "path", "pmExecutable", "timeoutMs"] as const;

export interface PmActionSchemaContract {
  required?: string[];
  optional?: string[];
  anyOfRequired?: Array<string[]>;
}

function toSchemaKeyList(values: string[]): string[] {
  return normalizeUniqueStringList(values);
}

const CREATE_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_CREATE_OPTION_CONTRACTS.map((entry) => entry.param),
  ...TOOL_SHARED_CREATE_UPDATE_OPTION_CONTRACTS.map((entry) => entry.param),
  "assignee",
]);

const TEMPLATE_SAVE_UNSUPPORTED_PARAMETER_KEYS = new Set([
  "createMode",
  "schedulePreset",
  "unset",
  "clearDeps",
  "clearComments",
  "clearNotes",
  "clearLearnings",
  "clearFiles",
  "clearTests",
  "clearDocs",
  "clearReminders",
  "clearEvents",
  "clearTypeOptions",
]);

const TEMPLATE_SAVE_CONTRACT_PARAMETER_KEYS = toSchemaKeyList(
  CREATE_CONTRACT_PARAMETER_KEYS.filter((key) => !TEMPLATE_SAVE_UNSUPPORTED_PARAMETER_KEYS.has(key)),
);

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

const CALENDAR_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_CALENDAR_OPTION_CONTRACTS.map((entry) => entry.param),
  "past",
  "fullPeriod",
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
  "compact",
]);
const AGGREGATE_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_AGGREGATE_OPTION_CONTRACTS.map((entry) => entry.param),
  "count",
  "includeUnparented",
]);
const DEDUPE_AUDIT_CONTRACT_PARAMETER_KEYS = toSchemaKeyList(TOOL_DEDUPE_AUDIT_OPTION_CONTRACTS.map((entry) => entry.param));
const SEARCH_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  "query",
  "keywords",
  "mode",
  "includeLinked",
  "titleExact",
  "phraseExact",
  "compact",
  "full",
  ...TOOL_SEARCH_FILTER_OPTION_CONTRACTS.map((entry) => entry.param),
]);

const AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS = ["author", "message", "force"];

const PM_TOOL_ACTION_SCHEMA_CONTRACTS: Record<PmToolAction, PmActionSchemaContract> = {
  init: { optional: ["prefix", "preset"] },
  config: {
    required: ["scope", "configAction"],
    optional: ["key", "criterion", "clearCriteria", "format", "policy"],
  },
  "extension-init": { required: ["target"], optional: ["scope"] },
  "extension-install": {
    optional: ["target", "github", "scope", "ref"],
    anyOfRequired: [["target"], ["github"]],
  },
  "extension-uninstall": { required: ["target"], optional: ["scope"] },
  "extension-explore": { optional: ["scope"] },
  "extension-manage": { optional: ["scope", "runtimeProbe", "fixManagedState"] },
  "extension-reload": { optional: ["scope", "watch"] },
  "extension-doctor": { optional: ["scope", "detail", "trace", "fixManagedState", "strictExit", "failOnWarn"] },
  "extension-catalog": { optional: ["scope"] },
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
  "package-reload": { optional: ["scope", "watch"] },
  "package-doctor": { optional: ["scope", "detail", "trace", "fixManagedState", "strictExit", "failOnWarn"] },
  "package-catalog": { optional: ["scope"] },
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
  calendar: { optional: CALENDAR_CONTRACT_PARAMETER_KEYS },
  cal: { optional: CALENDAR_CONTRACT_PARAMETER_KEYS },
  context: { optional: CONTEXT_CONTRACT_PARAMETER_KEYS },
  ctx: { optional: CONTEXT_CONTRACT_PARAMETER_KEYS },
  get: { required: ["id"] },
  search: {
    optional: SEARCH_CONTRACT_PARAMETER_KEYS,
    anyOfRequired: [["query"], ["keywords"]],
  },
  reindex: { optional: ["mode", "progress"] },
  history: { required: ["id"], optional: ["limit", "diff", "verify"] },
  activity: { optional: ACTIVITY_CONTRACT_PARAMETER_KEYS },
  restore: { required: ["id", "target"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  update: { required: ["id"], optional: UPDATE_CONTRACT_PARAMETER_KEYS },
  "update-many": { optional: UPDATE_MANY_CONTRACT_PARAMETER_KEYS },
  normalize: { optional: NORMALIZE_CONTRACT_PARAMETER_KEYS },
  close: { required: ["id", "text"], optional: ["validateClose", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS] },
  delete: { required: ["id"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  append: { required: ["id", "body"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  comments: {
    required: ["id"],
    optional: ["text", "add", "stdin", "file", "limit", "allowAuditComment", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS],
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
      "discover",
      "apply",
      "discoveryNote",
      "appendStable",
      "validatePaths",
      "audit",
      ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
    ],
  },
  docs: {
    required: ["id"],
    optional: ["add", "addGlob", "remove", "migrate", "validatePaths", "audit", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS],
  },
  deps: { required: ["id"], optional: ["format", "maxDepth", "collapse", "summary"] },
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
      "strictExit",
      "failOnWarn",
      "checkHistoryDrift",
      "checkCommandReferences",
    ],
  },
  gc: { optional: ["dryRun", "gcScope"] },
  contracts: { optional: ["contractAction", "command", "schemaOnly", "flagsOnly", "availabilityOnly", "runtimeOnly", "activeOnly"] },
  completion: { required: ["shell"], optional: ["eagerTags"] },
  "templates-save": {
    required: ["template"],
    optional: TEMPLATE_SAVE_CONTRACT_PARAMETER_KEYS,
  },
  "templates-list": {},
  "templates-show": { required: ["template"] },
  claim: { required: ["id"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  release: { required: ["id"], optional: ["allowAuditRelease", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS] },
  "start-task": { required: ["id"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  "pause-task": { required: ["id"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  "close-task": { required: ["id", "text"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
};

export const PM_TOOL_ACTION_PARAMETER_CONTRACTS: Readonly<Record<PmToolAction, PmActionSchemaContract>> =
  PM_TOOL_ACTION_SCHEMA_CONTRACTS;

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
  reload: {
    description: "When true for extension action payloads, trigger cache-busted extension module reload.",
  },
  watch: {
    description: "When true for extension-reload/extension action payloads, enable watch mode semantics.",
  },
  runtimeProbe: {
    description: "When true for extension-manage, run a doctor-like runtime activation probe for parity fields.",
  },
  fixManagedState: {
    description: "When true for extension-manage/extension-doctor, adopt unmanaged extensions before diagnostics/update checks.",
  },
  target: {
    description: "Positional target argument for the selected action (ID, source, package source, or extension name).",
    examples: ["pm-a1b2", ".agents/pm/extensions/sample", "sample-extension"],
  },
  github: {
    description: "GitHub shorthand owner/repo[/path] source for package/extension install actions.",
    examples: ["org/repo/extensions/sample"],
  },
  ref: {
    description: "Git ref/branch/tag used when installing from GitHub shorthand/URL sources.",
    examples: ["main", "v1.0.0"],
  },
  cliOnly: {
    description: "Restrict upgrade to the pm CLI/SDK npm package.",
  },
  packagesOnly: {
    description: "Restrict upgrade to managed installable pm packages.",
  },
  repair: {
    description: "Force npm global reinstall semantics when upgrading the pm CLI/SDK.",
  },
  tag: {
    description: "npm version or dist-tag used for CLI and registry package upgrades.",
    examples: ["latest", "next", "2026.5.11"],
  },
  packageName: {
    description: "Override the pm CLI package name for self-upgrade automation and tests.",
    examples: ["@unbrained/pm-cli"],
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
  noPager: {
    description: "Disable pager integration for help and long output.",
  },
  profile: {
    description: "Emit deterministic timing diagnostics to stderr.",
  },
  timeoutMs: {
    description: "Tool execution timeout in milliseconds.",
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
  preset: {
    description: "Governance preset for initialization flows.",
    examples: ["minimal", "default", "strict"],
  },
  createMode: {
    description: "Create required-option policy mode.",
    examples: ["strict", "progressive"],
  },
  schedulePreset: {
    description: "Schedule-centric create preset for Reminder, Meeting, and Event types.",
    examples: ["lightweight"],
  },
  status: {
    description: "Item status value.",
    examples: ["open", "in_progress"],
  },
  priority: {
    description: "Priority value in range 0..4.",
    examples: [0, 1, "2"],
  },
  order: {
    description: "Planning order/rank value for create/update, or sort direction (asc|desc) for list-family sorting.",
    examples: [0, 1, "2", "asc", "desc"],
  },
  sort: {
    description: "List-family sort field selector.",
    examples: ["priority", "deadline", "updated_at", "created_at", "title", "parent"],
  },
  tags: {
    description: "Comma-delimited tag list.",
    examples: ["pm-cli,agent-ux"],
  },
  deadline: {
    description: "ISO/date timestamp or relative offset (+6h/+1d/+2w/+6m).",
    examples: ["2026-04-01T00:00:00.000Z", "+1d"],
  },
  estimate: {
    description: "Estimated effort in minutes.",
    examples: [60, "120"],
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
    description: "Assignee identity.",
    examples: ["codex-agent"],
  },
  assigneeFilter: {
    description: "Assignee presence selector for list/calendar/context/comments-audit filters.",
    examples: ["assigned", "unassigned"],
  },
  parent: {
    description: "Parent item ID filter for hierarchical list queries.",
    examples: ["pm-epic01"],
  },
  unset: {
    description: "Repeatable list of front-matter fields to clear explicitly during create/update mutations.",
    examples: [["deadline", "assignee"], ["close-reason"]],
  },
  clearDeps: {
    description: "When true, clear linked dependencies.",
  },
  replaceDeps: {
    description: "When true for update, atomically replace dependencies with the supplied --dep values.",
  },
  replaceTests: {
    description: "When true for update, atomically replace linked tests with the supplied --test values.",
  },
  clearComments: {
    description: "When true, clear item comments.",
  },
  clearNotes: {
    description: "When true, clear item notes.",
  },
  clearLearnings: {
    description: "When true, clear item learnings.",
  },
  clearFiles: {
    description: "When true, clear linked files.",
  },
  clearTests: {
    description: "When true, clear linked tests.",
  },
  clearDocs: {
    description: "When true, clear linked docs.",
  },
  clearReminders: {
    description: "When true, clear reminders.",
  },
  clearEvents: {
    description: "When true, clear events.",
  },
  clearTypeOptions: {
    description: "When true, clear type option metadata.",
  },
  clearCriteria: {
    description:
      "When true for config set criteria-list keys (definition-of-done, metadata-required-fields, lifecycle pattern lists), clear the criteria list.",
  },
  mode: {
    description:
      "Mode selector for search/reindex (keyword|semantic|hybrid) and dedupe-audit (title_exact|title_fuzzy|parent_scope).",
    examples: ["keyword", "hybrid", "title_exact"],
  },
  op: {
    description: "History operation filter for activity output.",
    examples: ["create", "update", "close", "update_audit"],
  },
  fullPeriod: {
    description: "For day/week/month calendar views, include the full anchored period instead of clipping the start to now.",
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
  overrideLinkedPmContext: {
    description: "Force run-level --pm-context to override per-linked-test pm_context_mode metadata for all linked-test entries.",
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
  checkContext: {
    description: "Run linked PM command context preflight diagnostics before command execution.",
  },
  autoPmContext: {
    description:
      "Auto-remediate PM tracker-read linked commands by routing those entries through tracker context regardless of linked-test pm_context_mode overrides.",
  },
  dryRun: {
    description: "Preview command effects without mutating storage artifacts.",
  },
  gcScope: {
    description: "Repeatable gc scope selector values (index, embeddings, runtime).",
    examples: [["index", "embeddings"], ["runtime"]],
  },
  offset: {
    description: "Number of matching rows to skip before limit is applied.",
    examples: [0, 50, "100"],
  },
  limitItems: {
    description: "Maximum number of filtered items to include in comments-audit output (alias: --limit).",
    examples: [10, "25"],
  },
  fullHistory: {
    description: "When true for comments-audit, export full per-item comment history rows; cannot be combined with latest.",
  },
  latest: {
    description: "Number of most recent comments to include per item in comments-audit output (use 0 for summary-only item rows).",
    examples: [0, 1, "3"],
  },
  validateClose: {
    description: 'Close-time metadata validation mode ("off", "warn", or "strict").',
    examples: ["off", "warn", "strict"],
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
  dependencyCycleSeverity: {
    description: "Set dependency-cycle warning policy for lifecycle checks.",
    examples: ["off", "warn", "error"],
  },
  checkFiles: {
    description: "Run linked-file and orphaned-file checks.",
  },
  strictDirectories: {
    description: "Treat optional item-type directories as required health failures.",
  },
  checkOnly: {
    description: "For health action, run read-only diagnostics without refreshing vectors.",
  },
  checkTelemetry: {
    description: "For health action, probe telemetry endpoint health and include network diagnostics.",
  },
  noRefresh: {
    description: "For health action, skip vector refresh while still running checks.",
  },
  refreshVectors: {
    description: "For health action, explicitly refresh stale vectors.",
  },
  verboseStaleItems: {
    description: "For health action, include full stale-item arrays in vectorization details.",
  },
  scanMode: {
    description: "Select file candidate scan mode for --check-files.",
    examples: ["default", "tracked-all", "tracked-all-strict"],
  },
  includePmInternals: {
    description: "Include PM storage internals in tracked-all candidate scans.",
  },
  verboseFileLists: {
    description: "For validate action, include full file-path lists for --check-files details.",
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
  allowAuditNote: {
    description: "For notes action, allow non-owner append-only note audits without requiring --force.",
  },
  allowAuditLearning: {
    description: "For learnings action, allow non-owner append-only learning audits without requiring --force.",
  },
  allowAuditComment: {
    description: "For comments action, allow non-owner append-only comment audits without requiring --force.",
  },
  stdin: {
    description: "When true for comments action, read comment text from piped stdin (supports multiline markdown).",
  },
  file: {
    description: "Path to input file for actions that read payload text, such as comments --file.",
    examples: ["notes/comment.md"],
  },
  allowAuditUpdate: {
    description: "Allow non-owner metadata-only update audits without requiring --force.",
  },
  allowAuditDepUpdate: {
    description: "Allow non-owner append-only dependency update audits without requiring --force.",
  },
  allowAuditRelease: {
    description: "Allow non-owner release handoffs that clear assignee metadata without requiring --force.",
  },
  preserveSourceIds: {
    description: "Preserve explicit source IDs during Beads imports instead of normalizing to tracker prefix.",
    examples: [true],
  },
  appendStable: {
    description: "When true for files action, preserve existing linked-file order and append new links without full-array resorting.",
  },
  discover: {
    description: "When true for files action, use `pm files discover <id>` to scan item text for referenced file paths.",
  },
  apply: {
    description: "When true for files discovery, add missing discovered file links instead of returning a dry-run preview.",
  },
  discoveryNote: {
    description: "Note attached to file links added by files discovery.",
    examples: ["discovered from item text"],
  },
  stream: {
    description:
      "Stream selector: test-runs logs accepts stdout|stderr|both; activity accepts boolean/rows|ndjson|jsonl for line-delimited output.",
    examples: ["stderr", "stdout", "both", "rows", "ndjson", "jsonl", true],
  },
  tail: {
    description: "Number of lines to tail for background run logs.",
    examples: [100],
  },
  query: {
    description: "Search query text for search action.",
  },
  keywords: {
    description: "Alias for query in search action payloads.",
  },
  includeLinked: {
    description: "Include readable linked docs/files/tests content in keyword and hybrid lexical scoring.",
  },
  titleExact: {
    description: "For search action, require exact normalized title match for the full query string.",
  },
  phraseExact: {
    description: "For search action, require exact normalized query phrase match in item text fields.",
  },
  includeBody: {
    description: "When true for list-family actions, include item body text in projected rows.",
  },
  compact: {
    description: "Render compact projection output for search and list-family actions.",
  },
  full: {
    description: "Render full nested search hit payload output.",
  },
  fields: {
    description: "Comma-separated projection fields for search or list-family outputs.",
    examples: ["id,title,score,matched_fields", "id,title,parent,type"],
  },
  groupBy: {
    description:
      "Comma-separated aggregate grouping fields (supported: parent,type,priority,status,assignee,tags,sprint,release).",
    examples: ["parent,type", "type,status", "priority,assignee", "tags", "sprint,release"],
  },
  count: {
    description: "Enable grouped count output for aggregate action.",
  },
  includeUnparented: {
    description: "Include unparented rows when aggregate grouping includes parent.",
  },
  maxDepth: {
    description: "Maximum dependency traversal depth for deps action (0 keeps only the root node).",
    examples: [0, 1, "2"],
  },
  collapse: {
    description: 'Dependency tree collapse mode for deps action ("none" or "repeated").',
    examples: ["none", "repeated"],
  },
  summary: {
    description: "When true for deps action, return counts only without full tree/graph payloads.",
  },
  threshold: {
    description: "Dedupe-audit fuzzy title similarity threshold between 0 and 1.",
    examples: [0.5, "0.75"],
  },
  shell: {
    description: "Shell target for completion generation.",
    examples: ["bash"],
  },
  eagerTags: {
    description: "When true for completion, eagerly embed current tracker tags into generated scripts (legacy mode).",
  },
  contractAction: {
    description: "Filter contracts schema to one tool action.",
    examples: ["create", "update"],
  },
  command: {
    description: "Scope contracts output to one CLI command name; action/schema surfaces narrow by default.",
    examples: ["create", "search", "list"],
  },
  schemaOnly: {
    description: "When true, contracts action returns schema-focused payloads (mutually exclusive with flagsOnly/availabilityOnly).",
  },
  flagsOnly: {
    description: "When true, contracts action returns only command flag surface payloads (mutually exclusive projection mode).",
  },
  availabilityOnly: {
    description: "When true, contracts action returns only action availability payloads (mutually exclusive projection mode).",
  },
  runtimeOnly: {
    description: "When true, contracts action only includes actions invocable in the current runtime.",
  },
  activeOnly: {
    description: "Alias for runtimeOnly in contracts action payloads.",
  },
  depth: {
    description: "Context depth level controlling how many sections are included (brief=focus+agenda, standard=+hierarchy/activity/progress/workload, deep=all sections).",
    examples: ["brief", "standard", "deep"],
  },
  section: {
    description: "Repeatable section selector for context; overrides --depth when provided.",
    examples: [["hierarchy", "activity"], ["blockers", "files", "staleness"]],
  },
  activityLimit: {
    description: "Maximum number of recent activity entries to include in context output.",
    examples: [5, 10, "20"],
  },
  staleThreshold: {
    description: "Staleness cutoff in days for context staleness section (e.g. 7 or 7d).",
    examples: ["7", "14d", "30"],
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
  $id: "https://schema.unbrained.dev/pm-cli/tool-parameters-v4.schema.json",
  title: "pm-cli tool parameters (action-scoped strict schema)",
  "x-schema-version": "4.0.1",
  type: "object",
  oneOf: PM_TOOL_ACTIONS.map((action) => buildActionScopedToolSchema(action)),
};

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
    "x-schema-version": "1.0.0",
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties,
  };
}

export const PM_PROVIDER_TOOL_PARAMETERS_SCHEMA: Record<string, unknown> = buildProviderCompatibleToolSchema();
