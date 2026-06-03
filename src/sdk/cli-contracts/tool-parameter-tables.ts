import {
  PLAN_HARNESS_VALUES,
  PLAN_MODE_VALUES,
  PLAN_STEP_LINK_KIND_VALUES,
  PLAN_STEP_STATUS_VALUES,
} from "../../types/index.js";

export const PM_TOOL_PARAMETER_PROPERTIES: Record<string, unknown> = {
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
  typePreset: { type: "string", enum: ["agile", "ops", "research"] },
  defaults: { type: "boolean" },
  agentGuidance: { type: "string", enum: ["ask", "add", "skip", "status"] },
  withPackages: { type: "boolean" },
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
  status: { type: "string" },
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
  addTags: { type: "array", items: { type: "string" } },
  removeTags: { type: "array", items: { type: "string" } },
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
  brief: { type: "boolean" },
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
  semantic: { type: "boolean" },
  hybrid: { type: "boolean" },
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
  literal: { type: "array", items: { type: "string" } },
  regex: { type: "array", items: { type: "string" } },
  replacement: { type: "string" },
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
  skipVectors: { type: "boolean" },
  skipIntegrity: { type: "boolean" },
  skipDrift: { type: "boolean" },
  verboseDiagnostics: { type: "boolean" },
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
  subcommand: { type: "string" },
  name: { type: "string" },
  defaultStatus: { type: "string" },
  alias: { type: "array", items: { type: "string" } },
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
  field: { type: "array", items: { type: "string" } },
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

export const PLAN_SUBCOMMAND_VALUES = [
  "create",
  "show",
  "add-step",
  "update-step",
  "complete-step",
  "block-step",
  "reorder-step",
  "remove-step",
  "link",
  "unlink",
  "decision",
  "discovery",
  "validation",
  "resume",
  "approve",
  "materialize",
] as const;

export const PLAN_ACTION_PARAMETER_PROPERTIES: Record<string, unknown> = {
  subcommand: { type: "string", enum: [...PLAN_SUBCOMMAND_VALUES] },
  stepRef: { type: "string" },
  reorderTo: { anyOf: [{ type: "string" }, { type: "number" }] },
  scope: { type: "string" },
  harness: { type: "string", enum: [...PLAN_HARNESS_VALUES] },
  mode: { type: "string", enum: [...PLAN_MODE_VALUES] },
  resumeContext: { type: "string" },
  related: { type: "string" },
  blocks: { type: "string" },
  claim: { type: "boolean" },
  fromSearch: { type: "string" },
  stepTitle: { type: "string" },
  stepBody: { type: "string" },
  stepOwner: { type: "string" },
  stepStatus: { type: "string", enum: [...PLAN_STEP_STATUS_VALUES] },
  stepEvidence: { type: "string" },
  stepBlockedReason: { type: "string" },
  stepReplacement: { type: "string" },
  dependsOn: { type: "string" },
  link: { type: "string" },
  linkKind: { type: "string", enum: [...PLAN_STEP_LINK_KIND_VALUES] },
  linkNote: { type: "string" },
  promoteToItemDep: { type: "boolean" },
  allowMultipleActive: { type: "boolean" },
  file: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
  test: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
  doc: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
  decisionText: { type: "string" },
  decision: { type: "string" },
  decisionRationale: { type: "string" },
  decisionEvidence: { type: "string" },
  discoveryText: { type: "string" },
  discovery: { type: "string" },
  validationText: { type: "string" },
  validation: { type: "string" },
  validationCommand: { type: "string" },
  validationExpected: { type: "string" },
  steps: { type: "array", items: { type: "string" } },
  materializeType: { type: "string" },
  materializeParent: { type: "string" },
  materializeTags: { type: "string" },
};

export const PLAN_ACTION_PARAMETER_METADATA: Record<string, { description: string; examples?: unknown[] }> = {
  subcommand: {
    description: "Plan workflow operation to run.",
    examples: ["create", "show", "add-step", "approve"],
  },
  stepRef: {
    description: "Plan step id or order for step lifecycle subcommands.",
    examples: ["plan-step-001", "1"],
  },
  reorderTo: {
    description: "New integer order for reorder-step.",
    examples: [1, "2"],
  },
  scope: {
    description: "Short free-text scope statement describing what the Plan covers.",
    examples: ["Release readiness audit", "Search package migration"],
  },
  mode: {
    description: "Plan lifecycle mode.",
    examples: ["draft", "research", "approved"],
  },
  file: {
    description: "File link to attach while creating or materializing a Plan.",
    examples: ["path=src/cli.ts,note=implementation surface"],
  },
  test: {
    description: "Test command link to attach while creating or materializing a Plan.",
    examples: ["command=pnpm build,timeout_seconds=300"],
  },
  doc: {
    description: "Documentation link to attach while creating or materializing a Plan.",
    examples: ["path=docs/SDK.md,note=public API reference"],
  },
};

export const PM_TOOL_PARAMETER_METADATA: Record<string, { description: string; examples?: unknown[] }> = {
  action: {
    description: "Tool action to execute.",
  },
  path: {
    description: "Optional PM data root override for this invocation.",
    examples: [".agents/pm"],
  },
  scope: {
    description: "Scope selector for commands that operate on project or global state. Linked files, docs, and tests default to project scope when omitted.",
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
  subcommand: {
    description: "Subcommand for the schema action.",
    examples: ["list", "show", "add-type"],
  },
  name: {
    description: "Custom item type name to register (for schema add-type).",
    examples: ["Spike"],
  },
  defaultStatus: {
    description: "Default status hint recorded for a custom item type.",
    examples: ["open"],
  },
  alias: {
    description: "Aliases for the custom item type (repeatable).",
    examples: [["spike", "research"]],
  },
  preset: {
    description: "Governance preset for initialization flows.",
    examples: ["minimal", "default", "strict"],
  },
  typePreset: {
    description: "Domain item-type preset registered during initialization.",
    examples: ["agile", "ops", "research"],
  },
  defaults: {
    description: "Use non-interactive setup defaults during initialization.",
  },
  agentGuidance: {
    description: "Control AGENTS.md/CLAUDE.md guidance behavior during init: ask, add, skip, or status.",
    examples: ["ask", "add", "skip", "status"],
  },
  withPackages: {
    description: "Install all bundled first-party pm packages during initialization.",
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
    description:
      "Item status value. Statuses are project-configurable via .agents/pm/settings.json (schema block); the built-in defaults are draft, open, in_progress, blocked, closed, canceled. Custom statuses defined for the project are accepted — discover the active set with the pm_contracts tool (workspace.statuses) or `pm contracts`. Unknown statuses are rejected at runtime with a did-you-mean hint rather than blocked by a fixed schema enum.",
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
  addTags: {
    description: "Tags to add to the existing list without replacing it. Each entry may be CSV or a JSON array.",
    examples: [["agent-ux"], ["fix", "security"]],
  },
  removeTags: {
    description: "Tags to remove from the existing list. Each entry may be CSV or a JSON array.",
    examples: [["stale"], ["legacy", "wontfix"]],
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
  literal: {
    description: "Repeatable literal matcher used by history-redact to scrub exact string values.",
    examples: ["[redacted_path_prefix]/private/path"],
  },
  regex: {
    description:
      "Repeatable regex matcher used by history-redact. Accepts either /pattern/flags or a raw pattern (global mode is auto-enabled).",
    examples: ["/192\\\\.168\\\\.[0-9.]+/g", "token=[A-Za-z0-9_-]+"],
  },
  replacement: {
    description: 'Replacement text used by history-redact (defaults to "[redacted]").',
    examples: ["[scrubbed_path]"],
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
  skipVectors: {
    description: "For health action, skip vectorization checks for a faster diagnostic run.",
  },
  skipIntegrity: {
    description: "For health action, skip item/history file integrity checks for a faster diagnostic run.",
  },
  skipDrift: {
    description: "For health action, skip history drift hash checks for a faster diagnostic run.",
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
  verboseDiagnostics: {
    description: "For validate action, include full diagnostic ID lists instead of compact summaries.",
  },
  strictExit: {
    description: "Return non-zero exit when health/validate/extension-doctor warnings are present.",
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
    description: "Enable command-specific full/detail output mode when supported, such as deep item reads for get or full payload mode for search/history.",
  },
  fields: {
    description: "Comma-separated projection fields for get, search, or list-family outputs.",
    examples: ["id,title,status,parent,type", "id,title,score,matched_fields"],
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
