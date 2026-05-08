import { fileURLToPath } from "node:url";
import {
  PM_TOOL_ACTIONS as SHARED_PM_TOOL_ACTIONS,
  PM_TOOL_PARAMETERS_SCHEMA as SHARED_PM_TOOL_PARAMETERS_SCHEMA,
  PI_ACTIVITY_OPTION_CONTRACTS,
  PI_AGGREGATE_OPTION_CONTRACTS,
  PI_CALENDAR_OPTION_CONTRACTS,
  PI_CONTEXT_OPTION_CONTRACTS,
  PI_CREATE_OPTION_CONTRACTS,
  PI_DEDUPE_AUDIT_OPTION_CONTRACTS,
  PI_LIST_FILTER_OPTION_CONTRACTS,
  PI_SEARCH_FILTER_OPTION_CONTRACTS,
  PI_SHARED_CREATE_UPDATE_OPTION_CONTRACTS,
  PI_NORMALIZE_FILTER_OPTION_CONTRACTS,
  PI_UPDATE_OPTION_CONTRACTS,
  PI_UPDATE_MANY_FILTER_OPTION_CONTRACTS,
  type PiOptionFlagContract,
} from "@unbrained/pm-cli/sdk";

export const PM_TOOL_ACTIONS = [...SHARED_PM_TOOL_ACTIONS] as const;

export type PmToolAction = (typeof PM_TOOL_ACTIONS)[number];
type NumericFlagInput = string | number;
type BooleanFlagInput = string | number | boolean;

const NODE_FALLBACK_CLI_PATH = fileURLToPath(new URL("../../../dist/cli.js", import.meta.url));

export interface PmToolParameters {
  action: string;
  json?: boolean;
  quiet?: boolean;
  profile?: boolean;
  noExtensions?: boolean;
  noPager?: boolean;
  path?: string;
  pmExecutable?: string;
  timeoutMs?: number;
  id?: string;
  target?: string;
  github?: string;
  ref?: string;
  query?: string;
  keywords?: string;
  prefix?: string;
  preset?: string;
  scope?: string;
  contractAction?: string;
  command?: string;
  schemaOnly?: boolean;
  flagsOnly?: boolean;
  availabilityOnly?: boolean;
  runtimeOnly?: boolean;
  activeOnly?: boolean;
  configAction?: string;
  key?: string;
  title?: string;
  description?: string;
  type?: string;
  template?: string;
  createMode?: string;
  schedulePreset?: string;
  status?: string;
  filterStatus?: string;
  filterType?: string;
  filterTag?: string;
  filterPriority?: NumericFlagInput;
  filterDeadlineBefore?: string;
  filterDeadlineAfter?: string;
  filterAssignee?: string;
  filterAssigneeFilter?: string;
  filterParent?: string;
  filterSprint?: string;
  filterRelease?: string;
  closeReason?: string;
  priority?: NumericFlagInput;
  tags?: string;
  body?: string;
  deadline?: string;
  estimate?: NumericFlagInput;
  acceptanceCriteria?: string;
  author?: string;
  message?: string;
  assignee?: string;
  parent?: string;
  reviewer?: string;
  risk?: string;
  confidence?: NumericFlagInput | string;
  sprint?: string;
  release?: string;
  blockedBy?: string;
  blockedReason?: string;
  unblockNote?: string;
  reporter?: string;
  severity?: string;
  environment?: string;
  reproSteps?: string;
  resolution?: string;
  expectedResult?: string;
  actualResult?: string;
  affectedVersion?: string;
  fixedVersion?: string;
  component?: string;
  regression?: BooleanFlagInput;
  customerImpact?: string;
  definitionOfReady?: string;
  order?: NumericFlagInput;
  goal?: string;
  objective?: string;
  value?: string;
  impact?: string;
  outcome?: string;
  whyNow?: string;
  mode?: string;
  view?: string;
  date?: string;
  from?: string;
  to?: string;
  past?: boolean;
  fullPeriod?: boolean;
  op?: string;
  include?: string;
  recurrenceLookaheadDays?: NumericFlagInput;
  recurrenceLookbackDays?: NumericFlagInput;
  occurrenceLimit?: NumericFlagInput;
  includeLinked?: boolean;
  titleExact?: boolean;
  phraseExact?: boolean;
  includeBody?: boolean;
  compact?: boolean;
  full?: boolean;
  fields?: string;
  sort?: string;
  tag?: string;
  deadlineBefore?: string;
  deadlineAfter?: string;
  limit?: NumericFlagInput;
  offset?: NumericFlagInput;
  limitItems?: NumericFlagInput;
  fullHistory?: boolean;
  latest?: NumericFlagInput;
  progress?: boolean;
  background?: boolean;
  runId?: string;
  stream?: string | boolean;
  tail?: NumericFlagInput;
  envSet?: string[];
  envClear?: string[];
  sharedHostSafe?: boolean;
  detail?: string;
  trace?: boolean;
  runtimeProbe?: boolean;
  fixManagedState?: boolean;
  pmContext?: string;
  overrideLinkedPmContext?: boolean;
  failOnContextMismatch?: boolean;
  failOnSkipped?: boolean;
  failOnEmptyTestRun?: boolean;
  requireAssertionsForPm?: boolean;
  checkContext?: boolean;
  autoPmContext?: boolean;
  dryRun?: boolean;
  rollback?: string;
  noCheckpoint?: boolean;
  gcScope?: string[];
  validateClose?: string;
  checkMetadata?: boolean;
  metadataProfile?: string;
  checkResolution?: boolean;
  checkLifecycle?: boolean;
  checkStaleBlockers?: boolean;
  dependencyCycleSeverity?: string;
  checkFiles?: boolean;
  strictDirectories?: boolean;
  checkOnly?: boolean;
  noRefresh?: boolean;
  refreshVectors?: boolean;
  verboseStaleItems?: boolean;
  scanMode?: string;
  includePmInternals?: boolean;
  verboseFileLists?: boolean;
  strictExit?: boolean;
  failOnWarn?: boolean;
  checkHistoryDrift?: boolean;
  checkCommandReferences?: boolean;
  diff?: boolean;
  verify?: boolean;
  timeout?: NumericFlagInput;
  allowAuditNote?: boolean;
  allowAuditLearning?: boolean;
  allowAuditComment?: boolean;
  allowAuditUpdate?: boolean;
  allowAuditDepUpdate?: boolean;
  allowAuditRelease?: boolean;
  force?: boolean;
  run?: boolean;
  count?: boolean;
  includeUnparented?: boolean;
  groupBy?: string;
  threshold?: NumericFlagInput;
  shell?: string;
  eagerTags?: boolean;
  file?: string;
  preserveSourceIds?: boolean;
  folder?: string;
  text?: string;
  stdin?: boolean;
  add?: string[];
  addGlob?: string[];
  remove?: string[];
  migrate?: string[];
  discover?: boolean;
  apply?: boolean;
  discoveryNote?: string;
  appendStable?: boolean;
  validatePaths?: boolean;
  audit?: boolean;
  dep?: string[];
  depRemove?: string[];
  replaceDeps?: boolean;
  replaceTests?: boolean;
  comment?: string[];
  note?: string[];
  learning?: string[];
  linkedFile?: string[];
  linkedTest?: string[];
  doc?: string[];
  reminder?: string[];
  event?: string[];
  typeOption?: string[];
  unset?: string[];
  clearDeps?: boolean;
  clearComments?: boolean;
  clearNotes?: boolean;
  clearLearnings?: boolean;
  clearFiles?: boolean;
  clearTests?: boolean;
  clearDocs?: boolean;
  clearReminders?: boolean;
  clearEvents?: boolean;
  clearTypeOptions?: boolean;
  criterion?: string[];
  clearCriteria?: boolean;
  format?: string;
  maxDepth?: NumericFlagInput;
  collapse?: string;
  summary?: boolean;
  policy?: string;
}

export interface PiExecResult {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  killed?: boolean;
}

export interface PiToolResultEnvelope {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: PmToolParameters,
    signal?: AbortSignal,
    onUpdate?: (update: { content?: Array<{ type: "text"; text: string }>; details?: unknown }) => void,
  ) => Promise<PiToolResultEnvelope>;
}

export interface PiExtensionApi {
  registerTool(definition: PiToolDefinition): void;
  exec(command: string, args: string[], options?: { signal?: AbortSignal; timeout?: number }): Promise<PiExecResult>;
}

export const PM_TOOL_PARAMETERS_SCHEMA: Record<string, unknown> = { ...SHARED_PM_TOOL_PARAMETERS_SCHEMA };

function isPmToolAction(action: string): action is PmToolAction {
  return (PM_TOOL_ACTIONS as readonly string[]).includes(action);
}

function pushOption(args: string[], flag: string, value: string | number | undefined, allowEmpty = false): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return;
    }
    args.push(flag, String(value));
    return;
  }
  if (typeof value !== "string") {
    return;
  }
  if (!allowEmpty && value.length === 0) {
    return;
  }
  args.push(flag, value);
}

function pushRepeatable(args: string[], flag: string, values: string[] | undefined): void {
  if (!Array.isArray(values)) {
    return;
  }
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      args.push(flag, value);
    }
  }
}

function pushBooleanishOption(args: string[], flag: string, value: BooleanFlagInput | undefined): void {
  if (typeof value === "boolean") {
    args.push(flag, value ? "true" : "false");
    return;
  }
  pushOption(args, flag, value);
}

function pushContractedFlags(args: string[], params: PmToolParameters, contracts: PiOptionFlagContract[]): void {
  const paramValues = params as unknown as Record<string, unknown>;
  for (const contract of contracts) {
    const value = paramValues[contract.param];
    if (contract.repeatable) {
      pushRepeatable(args, contract.flag, Array.isArray(value) ? (value as string[]) : undefined);
      continue;
    }
    if (contract.booleanish) {
      pushBooleanishOption(args, contract.flag, value as BooleanFlagInput | undefined);
      continue;
    }
    pushOption(args, contract.flag, value as string | number | undefined, contract.allowEmpty ?? false);
  }
}

function requireString(value: string | undefined, name: string, action: PmToolAction): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Action "${action}" requires "${name}".`);
  }
  return value;
}

function addListFilters(args: string[], params: PmToolParameters): void {
  pushContractedFlags(args, params, PI_LIST_FILTER_OPTION_CONTRACTS);
  if (params.compact) {
    args.push("--compact");
  }
  if (params.includeBody) {
    args.push("--include-body");
  }
}

function addAggregateFilters(args: string[], params: PmToolParameters): void {
  pushContractedFlags(args, params, PI_AGGREGATE_OPTION_CONTRACTS);
  if (params.count) {
    args.push("--count");
  }
  if (params.includeUnparented) {
    args.push("--include-unparented");
  }
}

function addDedupeAuditFilters(args: string[], params: PmToolParameters): void {
  pushContractedFlags(args, params, PI_DEDUPE_AUDIT_OPTION_CONTRACTS);
}

function addCreateFlags(args: string[], params: PmToolParameters): void {
  const scalarContracts = PI_CREATE_OPTION_CONTRACTS.filter((entry) => !entry.repeatable);
  const repeatableContracts = PI_CREATE_OPTION_CONTRACTS.filter((entry) => entry.repeatable);
  pushContractedFlags(args, params, scalarContracts);
  addSharedCreateUpdateFlags(args, params);
  pushContractedFlags(args, params, repeatableContracts);
}

const TEMPLATE_SAVE_UNSUPPORTED_PARAMS = new Set([
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

function addTemplateSaveFlags(args: string[], params: PmToolParameters): void {
  const scalarContracts = PI_CREATE_OPTION_CONTRACTS.filter(
    (entry) => !entry.repeatable && !TEMPLATE_SAVE_UNSUPPORTED_PARAMS.has(entry.param),
  );
  const repeatableContracts = PI_CREATE_OPTION_CONTRACTS.filter(
    (entry) => entry.repeatable && !TEMPLATE_SAVE_UNSUPPORTED_PARAMS.has(entry.param),
  );
  const sharedContracts = PI_SHARED_CREATE_UPDATE_OPTION_CONTRACTS.filter(
    (entry) => !TEMPLATE_SAVE_UNSUPPORTED_PARAMS.has(entry.param),
  );
  pushContractedFlags(args, params, scalarContracts);
  pushContractedFlags(args, params, sharedContracts);
  pushContractedFlags(args, params, repeatableContracts);
}

function addUpdateFlags(args: string[], params: PmToolParameters): void {
  const scalarContracts = PI_UPDATE_OPTION_CONTRACTS.filter((entry) => !entry.repeatable);
  const repeatableContracts = PI_UPDATE_OPTION_CONTRACTS.filter((entry) => entry.repeatable);
  pushContractedFlags(args, params, scalarContracts);
  addSharedCreateUpdateFlags(args, params);
  pushContractedFlags(args, params, repeatableContracts);
  const presenceBooleanFlags: Array<{ enabled: boolean | undefined; flag: string }> = [
    { enabled: params.clearDeps, flag: "--clear-deps" },
    { enabled: params.clearComments, flag: "--clear-comments" },
    { enabled: params.clearNotes, flag: "--clear-notes" },
    { enabled: params.clearLearnings, flag: "--clear-learnings" },
    { enabled: params.clearFiles, flag: "--clear-files" },
    { enabled: params.clearTests, flag: "--clear-tests" },
    { enabled: params.clearDocs, flag: "--clear-docs" },
    { enabled: params.clearReminders, flag: "--clear-reminders" },
    { enabled: params.clearEvents, flag: "--clear-events" },
    { enabled: params.clearTypeOptions, flag: "--clear-type-options" },
    { enabled: params.allowAuditUpdate, flag: "--allow-audit-update" },
    { enabled: params.allowAuditDepUpdate, flag: "--allow-audit-dep-update" },
  ];
  for (const entry of presenceBooleanFlags) {
    if (entry.enabled) {
      args.push(entry.flag);
    }
  }
  if (params.replaceDeps) {
    args.push("--replace-deps");
  }
  if (params.replaceTests) {
    args.push("--replace-tests");
  }
  if (params.force) {
    args.push("--force");
  }
}

function addSharedCreateUpdateFlags(args: string[], params: PmToolParameters): void {
  pushContractedFlags(args, params, PI_SHARED_CREATE_UPDATE_OPTION_CONTRACTS);
}

function addAuthorMessageForceFlags(args: string[], params: PmToolParameters): void {
  pushOption(args, "--author", params.author);
  pushOption(args, "--message", params.message, true);
  if (params.force) {
    args.push("--force");
  }
}

function addGlobalFlags(args: string[], params: PmToolParameters): void {
  if (params.json !== false) {
    args.push("--json");
  }
  if (params.quiet) {
    args.push("--quiet");
  }
  if (params.profile) {
    args.push("--profile");
  }
  if (params.noExtensions) {
    args.push("--no-extensions");
  }
  if (params.noPager) {
    args.push("--no-pager");
  }
  pushOption(args, "--path", params.path);
}

function addExtensionScopeFlag(args: string[], params: PmToolParameters): void {
  if (typeof params.scope !== "string" || params.scope.trim().length === 0) {
    return;
  }
  if (params.scope === "project") {
    args.push("--project");
    return;
  }
  if (params.scope === "global") {
    args.push("--global");
    return;
  }
  throw new Error(`Unsupported extension scope "${params.scope}". Expected "project" or "global".`);
}

export function buildPmCliSequences(params: PmToolParameters): string[][] {
  const action = params.action.trim().toLowerCase();
  if (action === "start-task") {
    const globalArgs: string[] = [];
    addGlobalFlags(globalArgs, params);
    const id = requireString(params.id, "id", action);
    const startArgs = ["start-task", id];
    addAuthorMessageForceFlags(startArgs, params);
    return [[...globalArgs, ...startArgs]];
  }
  if (action === "pause-task") {
    const globalArgs: string[] = [];
    addGlobalFlags(globalArgs, params);
    const id = requireString(params.id, "id", action);
    const pauseArgs = ["pause-task", id];
    addAuthorMessageForceFlags(pauseArgs, params);
    return [[...globalArgs, ...pauseArgs]];
  }
  if (action === "close-task") {
    const globalArgs: string[] = [];
    addGlobalFlags(globalArgs, params);
    const id = requireString(params.id, "id", action);
    const closeArgs = ["close", id, requireString(params.text, "text", action)];
    addAuthorMessageForceFlags(closeArgs, params);
    const releaseArgs = ["release", id];
    addAuthorMessageForceFlags(releaseArgs, params);
    return [[...globalArgs, ...closeArgs], [...globalArgs, ...releaseArgs]];
  }
  return [buildPmCliArgs(params)];
}

export function buildPmCliArgs(params: PmToolParameters): string[] {
  const action = params.action.trim().toLowerCase();
  if (!isPmToolAction(action)) {
    throw new Error(`Unsupported action "${params.action}".`);
  }

  const args: string[] = [];
  addGlobalFlags(args, params);

  switch (action) {
    case "init":
      args.push("init");
      if (params.prefix) {
        args.push(params.prefix);
      }
      pushOption(args, "--preset", params.preset);
      return args;
    case "config":
      {
        const scope = requireString(params.scope, "scope", action);
        const configAction = requireString(params.configAction, "configAction", action);
        args.push("config", scope, configAction);
        if (configAction === "get" || configAction === "set") {
          args.push(requireString(params.key, "key", action));
        } else if (configAction !== "list" && configAction !== "export") {
          throw new Error(`Unsupported configAction "${configAction}". Expected get|set|list|export.`);
        }
      }
      pushRepeatable(args, "--criterion", params.criterion);
      if (params.clearCriteria === true) {
        args.push("--clear-criteria");
      }
      pushOption(args, "--format", params.format);
      pushOption(args, "--policy", params.policy);
      return args;
    case "extension-init":
      args.push("extension", "--init", requireString(params.target, "target", action));
      addExtensionScopeFlag(args, params);
      return args;
    case "extension-install": {
      args.push("extension", "--install");
      addExtensionScopeFlag(args, params);
      pushOption(args, "--github", params.github);
      pushOption(args, "--ref", params.ref);
      const target = params.target;
      if (typeof target === "string" && target.trim().length > 0) {
        args.push(target);
      } else if (typeof params.github !== "string" || params.github.trim().length === 0) {
        throw new Error(`Action "${action}" requires "target" or "github".`);
      }
      return args;
    }
    case "extension-uninstall":
      args.push("extension", "--uninstall", requireString(params.target, "target", action));
      addExtensionScopeFlag(args, params);
      return args;
    case "extension-explore":
      args.push("extension", "--explore");
      addExtensionScopeFlag(args, params);
      return args;
    case "extension-manage":
      args.push("extension", "--manage");
      addExtensionScopeFlag(args, params);
      if (params.runtimeProbe) {
        args.push("--runtime-probe");
      }
      if (params.fixManagedState) {
        args.push("--fix-managed-state");
      }
      return args;
    case "extension-doctor":
      args.push("extension", "--doctor");
      addExtensionScopeFlag(args, params);
      pushOption(args, "--detail", params.detail);
      if (params.trace) {
        args.push("--trace");
      }
      if (params.fixManagedState) {
        args.push("--fix-managed-state");
      }
      if (params.strictExit) {
        args.push("--strict-exit");
      }
      if (params.failOnWarn) {
        args.push("--fail-on-warn");
      }
      return args;
    case "extension-adopt":
      args.push("extension", "--adopt", requireString(params.target, "target", action));
      addExtensionScopeFlag(args, params);
      pushOption(args, "--github", params.github);
      pushOption(args, "--ref", params.ref);
      return args;
    case "extension-adopt-all":
      args.push("extension", "--adopt-all");
      addExtensionScopeFlag(args, params);
      return args;
    case "extension-activate":
      args.push("extension", "--activate", requireString(params.target, "target", action));
      addExtensionScopeFlag(args, params);
      return args;
    case "extension-deactivate":
      args.push("extension", "--deactivate", requireString(params.target, "target", action));
      addExtensionScopeFlag(args, params);
      return args;
    case "create":
      args.push("create");
      addCreateFlags(args, params);
      return args;
    case "list":
    case "list-all":
    case "list-draft":
    case "list-open":
    case "list-in-progress":
    case "list-blocked":
    case "list-closed":
    case "list-canceled":
      args.push(action);
      addListFilters(args, params);
      return args;
    case "aggregate":
      args.push("aggregate");
      addAggregateFilters(args, params);
      return args;
    case "dedupe-audit":
      args.push("dedupe-audit");
      addDedupeAuditFilters(args, params);
      return args;
    case "calendar":
      args.push("calendar");
      const calendarAnchors = PI_CALENDAR_OPTION_CONTRACTS.filter((entry) =>
        ["view", "date", "from", "to"].includes(entry.param),
      );
      const calendarRemainder = PI_CALENDAR_OPTION_CONTRACTS.filter(
        (entry) => !["view", "date", "from", "to"].includes(entry.param),
      );
      pushContractedFlags(args, params, calendarAnchors);
      if (params.past) {
        args.push("--past");
      }
      if (params.fullPeriod) {
        args.push("--full-period");
      }
      pushContractedFlags(args, params, calendarRemainder);
      return args;
    case "context":
      args.push("context");
      const contextAnchors = PI_CONTEXT_OPTION_CONTRACTS.filter((entry) => ["date", "from", "to"].includes(entry.param));
      const contextRemainder = PI_CONTEXT_OPTION_CONTRACTS.filter(
        (entry) => !["date", "from", "to"].includes(entry.param),
      );
      pushContractedFlags(args, params, contextAnchors);
      if (params.past) {
        args.push("--past");
      }
      pushContractedFlags(args, params, contextRemainder);
      return args;
    case "get":
      args.push("get", requireString(params.id, "id", action));
      return args;
    case "search":
      args.push("search", requireString(params.query ?? params.keywords, "query", action));
      pushOption(args, "--mode", params.mode);
      if (params.includeLinked) {
        args.push("--include-linked");
      }
      if (params.titleExact) {
        args.push("--title-exact");
      }
      if (params.phraseExact) {
        args.push("--phrase-exact");
      }
      if (params.compact) {
        args.push("--compact");
      }
      if (params.full) {
        args.push("--full");
      }
      pushContractedFlags(args, params, PI_SEARCH_FILTER_OPTION_CONTRACTS);
      return args;
    case "reindex":
      args.push("reindex");
      pushOption(args, "--mode", params.mode);
      if (params.progress) {
        args.push("--progress");
      }
      return args;
    case "history":
      args.push("history", requireString(params.id, "id", action));
      pushOption(args, "--limit", params.limit);
      if (params.diff) {
        args.push("--diff");
      }
      if (params.verify) {
        args.push("--verify");
      }
      return args;
    case "activity":
      args.push("activity");
      pushContractedFlags(args, params, PI_ACTIVITY_OPTION_CONTRACTS);
      if (params.stream === true) {
        args.push("--stream");
      } else if (typeof params.stream === "string" && params.stream.trim().length > 0) {
        args.push("--stream", params.stream.trim());
      }
      return args;
    case "restore":
      args.push("restore", requireString(params.id, "id", action), requireString(params.target, "target", action));
      addAuthorMessageForceFlags(args, params);
      return args;
    case "update":
      args.push("update", requireString(params.id, "id", action));
      addUpdateFlags(args, params);
      return args;
    case "update-many":
      args.push("update-many");
      pushContractedFlags(args, params, PI_UPDATE_MANY_FILTER_OPTION_CONTRACTS);
      if (params.dryRun) {
        args.push("--dry-run");
      }
      pushOption(args, "--rollback", params.rollback);
      if (params.noCheckpoint) {
        args.push("--no-checkpoint");
      }
      addUpdateFlags(args, params);
      return args;
    case "normalize":
      args.push("normalize");
      pushContractedFlags(args, params, PI_NORMALIZE_FILTER_OPTION_CONTRACTS);
      if (params.dryRun) {
        args.push("--dry-run");
      }
      if (params.apply) {
        args.push("--apply");
      }
      if (params.allowAuditUpdate) {
        args.push("--allow-audit-update");
      }
      addAuthorMessageForceFlags(args, params);
      return args;
    case "close":
      args.push("close", requireString(params.id, "id", action), requireString(params.text, "text", action));
      pushOption(args, "--validate-close", params.validateClose);
      addAuthorMessageForceFlags(args, params);
      return args;
    case "delete":
      args.push("delete", requireString(params.id, "id", action));
      addAuthorMessageForceFlags(args, params);
      return args;
    case "append":
      args.push("append", requireString(params.id, "id", action));
      pushOption(args, "--body", params.body, true);
      addAuthorMessageForceFlags(args, params);
      return args;
    case "comments":
      args.push("comments", requireString(params.id, "id", action));
      pushOption(args, "--add", params.text ?? params.add?.[0]);
      if (params.stdin) {
        args.push("--stdin");
      }
      pushOption(args, "--file", params.file);
      pushOption(args, "--limit", params.limit);
      if (params.allowAuditComment) {
        args.push("--allow-audit-comment");
      }
      addAuthorMessageForceFlags(args, params);
      return args;
    case "comments-audit":
      args.push("comments-audit");
      pushOption(args, "--status", params.status);
      pushOption(args, "--type", params.type);
      pushOption(args, "--assignee", params.assignee);
      pushOption(args, "--assignee-filter", params.assigneeFilter);
      pushOption(args, "--parent", params.parent);
      pushOption(args, "--tag", params.tag);
      pushOption(args, "--sprint", params.sprint);
      pushOption(args, "--release", params.release);
      pushOption(args, "--priority", params.priority);
      pushOption(args, "--limit-items", params.limitItems);
      pushOption(args, "--limit", params.limit);
      if (params.fullHistory) {
        args.push("--full-history");
      }
      pushOption(args, "--latest", params.latest);
      return args;
    case "notes":
      args.push("notes", requireString(params.id, "id", action));
      pushOption(args, "--add", params.text ?? params.add?.[0]);
      pushOption(args, "--limit", params.limit);
      if (params.allowAuditNote) {
        args.push("--allow-audit-note");
      } else if (params.allowAuditComment) {
        args.push("--allow-audit-comment");
      }
      addAuthorMessageForceFlags(args, params);
      return args;
    case "learnings":
      args.push("learnings", requireString(params.id, "id", action));
      pushOption(args, "--add", params.text ?? params.add?.[0]);
      pushOption(args, "--limit", params.limit);
      if (params.allowAuditLearning) {
        args.push("--allow-audit-learning");
      } else if (params.allowAuditComment) {
        args.push("--allow-audit-comment");
      }
      addAuthorMessageForceFlags(args, params);
      return args;
    case "files":
      if (params.discover) {
        args.push("files", "discover", requireString(params.id, "id", action));
        if (params.apply) {
          args.push("--apply");
        }
        pushOption(args, "--note", params.discoveryNote);
        if (params.appendStable) {
          args.push("--append-stable");
        }
        addAuthorMessageForceFlags(args, params);
        return args;
      }
      args.push("files", requireString(params.id, "id", action));
      pushRepeatable(args, "--add", params.add);
      pushRepeatable(args, "--add-glob", params.addGlob);
      pushRepeatable(args, "--remove", params.remove);
      pushRepeatable(args, "--migrate", params.migrate);
      if (params.appendStable) {
        args.push("--append-stable");
      }
      if (params.validatePaths) {
        args.push("--validate-paths");
      }
      if (params.audit) {
        args.push("--audit");
      }
      addAuthorMessageForceFlags(args, params);
      return args;
    case "docs":
      args.push("docs", requireString(params.id, "id", action));
      pushRepeatable(args, "--add", params.add);
      pushRepeatable(args, "--add-glob", params.addGlob);
      pushRepeatable(args, "--remove", params.remove);
      pushRepeatable(args, "--migrate", params.migrate);
      if (params.validatePaths) {
        args.push("--validate-paths");
      }
      if (params.audit) {
        args.push("--audit");
      }
      addAuthorMessageForceFlags(args, params);
      return args;
    case "deps":
      args.push("deps", requireString(params.id, "id", action));
      pushOption(args, "--format", params.format);
      pushOption(args, "--max-depth", params.maxDepth);
      pushOption(args, "--collapse", params.collapse);
      if (params.summary) {
        args.push("--summary");
      }
      return args;
    case "test":
      args.push("test", requireString(params.id, "id", action));
      pushRepeatable(args, "--add", params.add);
      pushRepeatable(args, "--remove", params.remove);
      if (params.run) {
        args.push("--run");
      }
      if (params.background) {
        args.push("--background");
      }
      pushOption(args, "--timeout", params.timeout);
      if (params.progress) {
        args.push("--progress");
      }
      pushRepeatable(args, "--env-set", params.envSet);
      pushRepeatable(args, "--env-clear", params.envClear);
      if (params.sharedHostSafe) {
        args.push("--shared-host-safe");
      }
      pushOption(args, "--pm-context", params.pmContext);
      if (params.overrideLinkedPmContext) {
        args.push("--override-linked-pm-context");
      }
      if (params.failOnContextMismatch) {
        args.push("--fail-on-context-mismatch");
      }
      if (params.failOnSkipped) {
        args.push("--fail-on-skipped");
      }
      if (params.failOnEmptyTestRun) {
        args.push("--fail-on-empty-test-run");
      }
      if (params.requireAssertionsForPm) {
        args.push("--require-assertions-for-pm");
      }
      if (params.checkContext) {
        args.push("--check-context");
      }
      if (params.autoPmContext) {
        args.push("--auto-pm-context");
      }
      addAuthorMessageForceFlags(args, params);
      return args;
    case "test-all":
      args.push("test-all");
      pushOption(args, "--status", params.status);
      pushOption(args, "--limit", params.limit);
      pushOption(args, "--offset", params.offset);
      if (params.background) {
        args.push("--background");
      }
      pushOption(args, "--timeout", params.timeout);
      if (params.progress) {
        args.push("--progress");
      }
      pushRepeatable(args, "--env-set", params.envSet);
      pushRepeatable(args, "--env-clear", params.envClear);
      if (params.sharedHostSafe) {
        args.push("--shared-host-safe");
      }
      pushOption(args, "--pm-context", params.pmContext);
      if (params.overrideLinkedPmContext) {
        args.push("--override-linked-pm-context");
      }
      if (params.failOnContextMismatch) {
        args.push("--fail-on-context-mismatch");
      }
      if (params.failOnSkipped) {
        args.push("--fail-on-skipped");
      }
      if (params.failOnEmptyTestRun) {
        args.push("--fail-on-empty-test-run");
      }
      if (params.requireAssertionsForPm) {
        args.push("--require-assertions-for-pm");
      }
      if (params.checkContext) {
        args.push("--check-context");
      }
      if (params.autoPmContext) {
        args.push("--auto-pm-context");
      }
      return args;
    case "test-runs-list":
      args.push("test-runs", "list");
      pushOption(args, "--status", params.status);
      pushOption(args, "--limit", params.limit);
      return args;
    case "test-runs-status":
      args.push("test-runs", "status", requireString(params.runId, "runId", action));
      return args;
    case "test-runs-logs":
      args.push("test-runs", "logs", requireString(params.runId, "runId", action));
      pushOption(args, "--stream", typeof params.stream === "string" ? params.stream : undefined);
      pushOption(args, "--tail", params.tail);
      return args;
    case "test-runs-stop":
      args.push("test-runs", "stop", requireString(params.runId, "runId", action));
      if (params.force) {
        args.push("--force");
      }
      return args;
    case "test-runs-resume":
      args.push("test-runs", "resume", requireString(params.runId, "runId", action));
      pushOption(args, "--author", params.author);
      return args;
    case "stats":
      args.push(action);
      return args;
    case "gc":
      args.push(action);
      if (params.dryRun) {
        args.push("--dry-run");
      }
      pushRepeatable(args, "--scope", params.gcScope);
      return args;
    case "health":
      args.push("health");
      if (params.strictDirectories) {
        args.push("--strict-directories");
      }
      if (params.strictExit) {
        args.push("--strict-exit");
      }
      if (params.failOnWarn) {
        args.push("--fail-on-warn");
      }
      if (params.checkOnly) {
        args.push("--check-only");
      }
      if (params.noRefresh) {
        args.push("--no-refresh");
      }
      if (params.refreshVectors) {
        args.push("--refresh-vectors");
      }
      if (params.verboseStaleItems) {
        args.push("--verbose-stale-items");
      }
      return args;
    case "validate":
      args.push("validate");
      if (params.checkMetadata) {
        args.push("--check-metadata");
      }
      pushOption(args, "--metadata-profile", params.metadataProfile);
      if (params.checkResolution) {
        args.push("--check-resolution");
      }
      if (params.checkLifecycle) {
        args.push("--check-lifecycle");
      }
      if (params.checkStaleBlockers) {
        args.push("--check-stale-blockers");
      }
      pushOption(args, "--dependency-cycle-severity", params.dependencyCycleSeverity);
      if (params.checkFiles) {
        args.push("--check-files");
      }
      pushOption(args, "--scan-mode", params.scanMode);
      if (params.includePmInternals) {
        args.push("--include-pm-internals");
      }
      if (params.verboseFileLists) {
        args.push("--verbose-file-lists");
      }
      if (params.strictExit) {
        args.push("--strict-exit");
      }
      if (params.failOnWarn) {
        args.push("--fail-on-warn");
      }
      if (params.checkHistoryDrift) {
        args.push("--check-history-drift");
      }
      if (params.checkCommandReferences) {
        args.push("--check-command-references");
      }
      return args;
    case "contracts":
      args.push("contracts");
      pushOption(args, "--action", params.contractAction);
      pushOption(args, "--command", params.command);
      if (params.schemaOnly) {
        args.push("--schema-only");
      }
      if (params.flagsOnly) {
        args.push("--flags-only");
      }
      if (params.availabilityOnly) {
        args.push("--availability-only");
      }
      if (params.runtimeOnly) {
        args.push("--runtime-only");
      }
      if (params.activeOnly) {
        args.push("--active-only");
      }
      return args;
    case "completion":
      args.push("completion", requireString(params.shell, "shell", action));
      if (params.eagerTags) {
        args.push("--eager-tags");
      }
      return args;
    case "templates-save": {
      args.push("templates", "save", requireString(params.template, "template", action));
      const templateSaveParams: PmToolParameters = { ...params, template: undefined };
      addTemplateSaveFlags(args, templateSaveParams);
      return args;
    }
    case "templates-list":
      args.push("templates", "list");
      return args;
    case "templates-show":
      args.push("templates", "show", requireString(params.template, "template", action));
      return args;
    case "claim":
      args.push(action, requireString(params.id, "id", action));
      addAuthorMessageForceFlags(args, params);
      return args;
    case "release":
      args.push(action, requireString(params.id, "id", action));
      if (params.allowAuditRelease) {
        args.push("--allow-audit-release");
      }
      addAuthorMessageForceFlags(args, params);
      return args;
    case "start-task":
    case "pause-task":
    case "close-task":
      throw new Error(`Action "${action}" is a workflow preset and must be built via buildPmCliSequences().`);
    case "beads-import":
      args.push("beads", "import");
      pushOption(args, "--file", params.file);
      pushOption(args, "--author", params.author);
      pushOption(args, "--message", params.message);
      if (params.preserveSourceIds) {
        args.push("--preserve-source-ids");
      }
      return args;
    case "todos-import":
      args.push("todos", "import");
      pushOption(args, "--folder", params.folder);
      pushOption(args, "--author", params.author);
      pushOption(args, "--message", params.message);
      return args;
    case "todos-export":
      args.push("todos", "export");
      pushOption(args, "--folder", params.folder);
      return args;
  }
}

function looksLikeCommandNotFound(stderr: string, command: string, code: number | null | undefined): boolean {
  if (code === 127) {
    return true;
  }
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("not found") ||
    normalized.includes("enoent") ||
    normalized.includes(`${command.toLowerCase()}: command not found`) ||
    normalized.includes(`'${command.toLowerCase()}' is not recognized`)
  );
}

function parseJsonOutput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function renderContentText(stdout: string, stderr: string, code: number | null | undefined): string {
  if (stdout.length > 0) {
    return stdout;
  }
  if (stderr.length > 0) {
    return stderr;
  }
  return `pm command exited with code ${code ?? "unknown"}.`;
}

function commandToDisplay(command: string, args: string[]): string {
  return [command, ...args].join(" ").trim();
}

export async function runPmToolAction(
  pi: PiExtensionApi,
  params: PmToolParameters,
  signal?: AbortSignal,
): Promise<PiToolResultEnvelope> {
  const sequences = buildPmCliSequences(params);
  const timeout = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) ? params.timeoutMs : undefined;

  let lastResult: PiExecResult = {
    code: 1,
    stdout: "",
    stderr: "No pm invocation attempts were configured.",
  };
  let selectedAttempt: { command: string; args: string[]; display: string } | undefined;
  const tried: string[] = [];
  const allStdout: string[] = [];
  const allStderr: string[] = [];
  let parsed: unknown = null;
  let exitCode = 1;

  for (const cliArgs of sequences) {
    const attempts: Array<{ command: string; args: string[]; display: string }> = [];
    if (typeof params.pmExecutable === "string" && params.pmExecutable.length > 0) {
      attempts.push({
        command: params.pmExecutable,
        args: cliArgs,
        display: commandToDisplay(params.pmExecutable, cliArgs),
      });
    } else {
      attempts.push(
        {
          command: "pm",
          args: cliArgs,
          display: commandToDisplay("pm", cliArgs),
        },
        {
          command: "node",
          args: [NODE_FALLBACK_CLI_PATH, ...cliArgs],
          display: commandToDisplay("node", [NODE_FALLBACK_CLI_PATH, ...cliArgs]),
        },
      );
    }

    let sequenceResult: PiExecResult = {
      code: 1,
      stdout: "",
      stderr: "No pm invocation attempts were configured.",
    };

    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index];
      selectedAttempt = attempt;
      tried.push(attempt.display);
      try {
        sequenceResult = await pi.exec(attempt.command, attempt.args, { signal, timeout });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        sequenceResult = {
          code: 1,
          stdout: "",
          stderr: message,
        };
      }

      const code = sequenceResult.code ?? 1;
      const stderr = (sequenceResult.stderr ?? "").trim();
      if (code === 0) {
        break;
      }

      if (!looksLikeCommandNotFound(stderr, attempt.command, code) || index === attempts.length - 1) {
        break;
      }
    }

    lastResult = sequenceResult;
    exitCode = lastResult.code ?? 1;

    const currentStdout = (lastResult.stdout ?? "").trim();
    const currentStderr = (lastResult.stderr ?? "").trim();
    if (currentStdout) allStdout.push(currentStdout);
    if (currentStderr) allStderr.push(currentStderr);
    parsed = parseJsonOutput(currentStdout);

    if (exitCode !== 0) {
      break;
    }
  }

  const stdout = allStdout.join("\n\n");
  const stderr = allStderr.join("\n\n");
  const contentText = renderContentText(stdout, stderr, exitCode);

  return {
    content: [{ type: "text", text: contentText }],
    details: {
      action: params.action,
      invocation: selectedAttempt ? {
        command: selectedAttempt.command,
        args: selectedAttempt.args,
        display: selectedAttempt.display,
      } : { command: "unknown", args: [], display: "unknown" },
      tried,
      exit_code: exitCode,
      ok: exitCode === 0,
      stdout,
      stderr,
      parsed,
    },
    isError: exitCode !== 0,
  };
}

export function createPmToolDefinition(pi: PiExtensionApi): PiToolDefinition {
  return {
    name: "pm",
    label: "pm",
    description: "Run pm-cli actions through a Pi tool wrapper.",
    parameters: PM_TOOL_PARAMETERS_SCHEMA,
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({
        content: [{ type: "text", text: `Running pm action: ${params.action}` }],
      });
      return runPmToolAction(pi, params, signal);
    },
  };
}

export function registerPmTool(pi: PiExtensionApi): void {
  pi.registerTool(createPmToolDefinition(pi));
}

export default function pmPiExtension(pi: PiExtensionApi): void {
  registerPmTool(pi);
}
