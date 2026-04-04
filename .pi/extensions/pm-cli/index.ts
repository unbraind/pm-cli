import { fileURLToPath } from "node:url";
import {
  PM_TOOL_ACTIONS as SHARED_PM_TOOL_ACTIONS,
  PM_TOOL_PARAMETERS_SCHEMA as SHARED_PM_TOOL_PARAMETERS_SCHEMA,
  PI_CALENDAR_OPTION_CONTRACTS,
  PI_CONTEXT_OPTION_CONTRACTS,
  PI_CREATE_OPTION_CONTRACTS,
  PI_LIST_FILTER_OPTION_CONTRACTS,
  PI_SEARCH_FILTER_OPTION_CONTRACTS,
  PI_SHARED_CREATE_UPDATE_OPTION_CONTRACTS,
  PI_UPDATE_OPTION_CONTRACTS,
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
  scope?: string;
  contractAction?: string;
  command?: string;
  schemaOnly?: boolean;
  configAction?: string;
  key?: string;
  title?: string;
  description?: string;
  type?: string;
  template?: string;
  createMode?: string;
  status?: string;
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
  include?: string;
  recurrenceLookaheadDays?: NumericFlagInput;
  recurrenceLookbackDays?: NumericFlagInput;
  occurrenceLimit?: NumericFlagInput;
  includeLinked?: boolean;
  tag?: string;
  deadlineBefore?: string;
  deadlineAfter?: string;
  limit?: NumericFlagInput;
  offset?: NumericFlagInput;
  progress?: boolean;
  envSet?: string[];
  envClear?: string[];
  sharedHostSafe?: boolean;
  detail?: string;
  pmContext?: string;
  failOnContextMismatch?: boolean;
  failOnSkipped?: boolean;
  requireAssertionsForPm?: boolean;
  validateClose?: string;
  checkMetadata?: boolean;
  checkResolution?: boolean;
  checkFiles?: boolean;
  scanMode?: string;
  includePmInternals?: boolean;
  checkHistoryDrift?: boolean;
  checkCommandReferences?: boolean;
  diff?: boolean;
  verify?: boolean;
  timeout?: NumericFlagInput;
  allowAuditComment?: boolean;
  force?: boolean;
  run?: boolean;
  shell?: string;
  file?: string;
  preserveSourceIds?: boolean;
  folder?: string;
  text?: string;
  add?: string[];
  addGlob?: string[];
  remove?: string[];
  migrate?: string[];
  appendStable?: boolean;
  validatePaths?: boolean;
  audit?: boolean;
  dep?: string[];
  depRemove?: string[];
  comment?: string[];
  note?: string[];
  learning?: string[];
  linkedFile?: string[];
  linkedTest?: string[];
  doc?: string[];
  reminder?: string[];
  event?: string[];
  typeOption?: string[];
  criterion?: string[];
  format?: string;
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

function pushRepeatableOrNone(args: string[], flag: string, values: string[] | undefined): void {
  const validValues = Array.isArray(values) ? values.filter((value) => typeof value === "string" && value.length > 0) : [];
  if (validValues.length === 0) {
    args.push(flag, "none");
    return;
  }
  for (const value of validValues) {
    args.push(flag, value);
  }
}

function pushContractedFlags(args: string[], params: PmToolParameters, contracts: PiOptionFlagContract[]): void {
  const paramValues = params as unknown as Record<string, unknown>;
  for (const contract of contracts) {
    const value = paramValues[contract.param];
    if (contract.repeatableOrNone) {
      pushRepeatableOrNone(args, contract.flag, Array.isArray(value) ? (value as string[]) : undefined);
      continue;
    }
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
}

function addCreateFlags(args: string[], params: PmToolParameters): void {
  const scalarContracts = PI_CREATE_OPTION_CONTRACTS.filter((entry) => !entry.repeatable && !entry.repeatableOrNone);
  const repeatableContracts = PI_CREATE_OPTION_CONTRACTS.filter((entry) => entry.repeatable || entry.repeatableOrNone);
  pushContractedFlags(args, params, scalarContracts);
  const assignee = typeof params.assignee === "string" && params.assignee.length > 0 ? params.assignee : "none";
  pushOption(args, "--assignee", assignee);
  addSharedCreateUpdateFlags(args, params);
  pushContractedFlags(args, params, repeatableContracts);
}

function addUpdateFlags(args: string[], params: PmToolParameters): void {
  const scalarContracts = PI_UPDATE_OPTION_CONTRACTS.filter((entry) => !entry.repeatable && !entry.repeatableOrNone);
  const repeatableContracts = PI_UPDATE_OPTION_CONTRACTS.filter((entry) => entry.repeatable || entry.repeatableOrNone);
  pushContractedFlags(args, params, scalarContracts);
  addSharedCreateUpdateFlags(args, params);
  pushContractedFlags(args, params, repeatableContracts);
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
    const claimArgs = ["claim", id];
    addAuthorMessageForceFlags(claimArgs, params);
    const updateArgs = ["update", id, "--status", "in_progress"];
    addAuthorMessageForceFlags(updateArgs, params);
    return [[...globalArgs, ...claimArgs], [...globalArgs, ...updateArgs]];
  }
  if (action === "pause-task") {
    const globalArgs: string[] = [];
    addGlobalFlags(globalArgs, params);
    const id = requireString(params.id, "id", action);
    const updateArgs = ["update", id, "--status", "open"];
    addAuthorMessageForceFlags(updateArgs, params);
    const releaseArgs = ["release", id];
    addAuthorMessageForceFlags(releaseArgs, params);
    return [[...globalArgs, ...updateArgs], [...globalArgs, ...releaseArgs]];
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
      return args;
    case "config":
      args.push(
        "config",
        requireString(params.scope, "scope", action),
        requireString(params.configAction, "configAction", action),
        requireString(params.key, "key", action),
      );
      pushRepeatable(args, "--criterion", params.criterion);
      pushOption(args, "--format", params.format);
      pushOption(args, "--policy", params.policy);
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
      return args;
    case "extension-doctor":
      args.push("extension", "--doctor");
      addExtensionScopeFlag(args, params);
      pushOption(args, "--detail", params.detail);
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
      pushOption(args, "--limit", params.limit);
      return args;
    case "restore":
      args.push("restore", requireString(params.id, "id", action), requireString(params.target, "target", action));
      addAuthorMessageForceFlags(args, params);
      return args;
    case "update":
      args.push("update", requireString(params.id, "id", action));
      addUpdateFlags(args, params);
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
      pushOption(args, "--limit", params.limit);
      if (params.allowAuditComment) {
        args.push("--allow-audit-comment");
      }
      addAuthorMessageForceFlags(args, params);
      return args;
    case "notes":
      args.push("notes", requireString(params.id, "id", action));
      pushOption(args, "--add", params.text ?? params.add?.[0]);
      pushOption(args, "--limit", params.limit);
      addAuthorMessageForceFlags(args, params);
      return args;
    case "learnings":
      args.push("learnings", requireString(params.id, "id", action));
      pushOption(args, "--add", params.text ?? params.add?.[0]);
      pushOption(args, "--limit", params.limit);
      addAuthorMessageForceFlags(args, params);
      return args;
    case "files":
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
      return args;
    case "test":
      args.push("test", requireString(params.id, "id", action));
      pushRepeatable(args, "--add", params.add);
      pushRepeatable(args, "--remove", params.remove);
      if (params.run) {
        args.push("--run");
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
      if (params.failOnContextMismatch) {
        args.push("--fail-on-context-mismatch");
      }
      if (params.failOnSkipped) {
        args.push("--fail-on-skipped");
      }
      if (params.requireAssertionsForPm) {
        args.push("--require-assertions-for-pm");
      }
      addAuthorMessageForceFlags(args, params);
      return args;
    case "test-all":
      args.push("test-all");
      pushOption(args, "--status", params.status);
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
      if (params.failOnContextMismatch) {
        args.push("--fail-on-context-mismatch");
      }
      if (params.failOnSkipped) {
        args.push("--fail-on-skipped");
      }
      if (params.requireAssertionsForPm) {
        args.push("--require-assertions-for-pm");
      }
      return args;
    case "stats":
    case "health":
    case "gc":
      args.push(action);
      return args;
    case "validate":
      args.push("validate");
      if (params.checkMetadata) {
        args.push("--check-metadata");
      }
      if (params.checkResolution) {
        args.push("--check-resolution");
      }
      if (params.checkFiles) {
        args.push("--check-files");
      }
      pushOption(args, "--scan-mode", params.scanMode);
      if (params.includePmInternals) {
        args.push("--include-pm-internals");
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
      return args;
    case "completion":
      args.push("completion", requireString(params.shell, "shell", action));
      return args;
    case "templates-save": {
      args.push("templates", "save", requireString(params.template, "template", action));
      const templateSaveParams: PmToolParameters = { ...params, template: undefined };
      addCreateFlags(args, templateSaveParams);
      return args;
    }
    case "templates-list":
      args.push("templates", "list");
      return args;
    case "templates-show":
      args.push("templates", "show", requireString(params.template, "template", action));
      return args;
    case "claim":
    case "release":
      args.push(action, requireString(params.id, "id", action));
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
