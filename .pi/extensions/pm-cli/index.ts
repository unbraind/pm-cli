import { fileURLToPath } from "node:url";

export const PM_TOOL_ACTIONS = [
  "init",
  "config",
  "create",
  "list",
  "list-all",
  "list-draft",
  "list-open",
  "list-in-progress",
  "list-blocked",
  "list-closed",
  "list-canceled",
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
  "files",
  "docs",
  "test",
  "test-all",
  "stats",
  "health",
  "gc",
  "completion",
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
  query?: string;
  keywords?: string;
  prefix?: string;
  scope?: string;
  configAction?: string;
  key?: string;
  title?: string;
  description?: string;
  type?: string;
  status?: string;
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
  includeLinked?: boolean;
  tag?: string;
  deadlineBefore?: string;
  deadlineAfter?: string;
  limit?: NumericFlagInput;
  timeout?: NumericFlagInput;
  force?: boolean;
  run?: boolean;
  shell?: string;
  file?: string;
  folder?: string;
  text?: string;
  add?: string[];
  remove?: string[];
  dep?: string[];
  comment?: string[];
  note?: string[];
  learning?: string[];
  linkedFile?: string[];
  linkedTest?: string[];
  doc?: string[];
  criterion?: string[];
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

export const PM_TOOL_PARAMETERS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: [...PM_TOOL_ACTIONS] },
    json: { type: "boolean", default: true },
    quiet: { type: "boolean" },
    profile: { type: "boolean" },
    noExtensions: { type: "boolean" },
    path: { type: "string" },
    pmExecutable: { type: "string" },
    timeoutMs: { type: "number" },
    id: { type: "string" },
    target: { type: "string" },
    query: { type: "string" },
    keywords: { type: "string" },
    prefix: { type: "string" },
    scope: { type: "string" },
    configAction: { type: "string" },
    key: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    type: { type: "string" },
    status: { type: "string" },
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
    mode: { type: "string" },
    includeLinked: { type: "boolean" },
    tag: { type: "string" },
    deadlineBefore: { type: "string" },
    deadlineAfter: { type: "string" },
    limit: { anyOf: [{ type: "string" }, { type: "number" }] },
    timeout: { anyOf: [{ type: "string" }, { type: "number" }] },
    force: { type: "boolean" },
    run: { type: "boolean" },
    shell: { type: "string" },
    file: { type: "string" },
    folder: { type: "string" },
    text: { type: "string" },
    add: { type: "array", items: { type: "string" } },
    remove: { type: "array", items: { type: "string" } },
    dep: { type: "array", items: { type: "string" } },
    comment: { type: "array", items: { type: "string" } },
    note: { type: "array", items: { type: "string" } },
    learning: { type: "array", items: { type: "string" } },
    linkedFile: { type: "array", items: { type: "string" } },
    linkedTest: { type: "array", items: { type: "string" } },
    doc: { type: "array", items: { type: "string" } },
    criterion: { type: "array", items: { type: "string" } },
  },
};

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

function requireString(value: string | undefined, name: string, action: PmToolAction): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Action "${action}" requires "${name}".`);
  }
  return value;
}

function addListFilters(args: string[], params: PmToolParameters): void {
  pushOption(args, "--type", params.type);
  pushOption(args, "--tag", params.tag);
  pushOption(args, "--priority", params.priority);
  pushOption(args, "--deadline-before", params.deadlineBefore);
  pushOption(args, "--deadline-after", params.deadlineAfter);
  pushOption(args, "--limit", params.limit);
}

function addCreateFlags(args: string[], params: PmToolParameters): void {
  pushOption(args, "--title", params.title);
  pushOption(args, "--description", params.description, true);
  pushOption(args, "--type", params.type);
  pushOption(args, "--status", params.status);
  pushOption(args, "--priority", params.priority);
  pushOption(args, "--tags", params.tags, true);
  pushOption(args, "--body", params.body, true);
  pushOption(args, "--deadline", params.deadline);
  pushOption(args, "--estimate", params.estimate);
  pushOption(args, "--acceptance-criteria", params.acceptanceCriteria, true);
  pushOption(args, "--author", params.author);
  pushOption(args, "--message", params.message, true);
  const assignee = typeof params.assignee === "string" && params.assignee.length > 0 ? params.assignee : "none";
  pushOption(args, "--assignee", assignee);
  addSharedCreateUpdateFlags(args, params);
  pushRepeatableOrNone(args, "--dep", params.dep);
  pushRepeatableOrNone(args, "--comment", params.comment);
  pushRepeatableOrNone(args, "--note", params.note);
  pushRepeatableOrNone(args, "--learning", params.learning);
  pushRepeatableOrNone(args, "--file", params.linkedFile);
  pushRepeatableOrNone(args, "--test", params.linkedTest);
  pushRepeatableOrNone(args, "--doc", params.doc);
}

function addUpdateFlags(args: string[], params: PmToolParameters): void {
  pushOption(args, "--title", params.title);
  pushOption(args, "--description", params.description, true);
  pushOption(args, "--status", params.status);
  pushOption(args, "--priority", params.priority);
  pushOption(args, "--type", params.type);
  pushOption(args, "--tags", params.tags, true);
  pushOption(args, "--deadline", params.deadline);
  pushOption(args, "--estimate", params.estimate);
  pushOption(args, "--acceptance-criteria", params.acceptanceCriteria, true);
  pushOption(args, "--author", params.author);
  pushOption(args, "--message", params.message, true);
  pushOption(args, "--assignee", params.assignee);
  addSharedCreateUpdateFlags(args, params);
  if (params.force) {
    args.push("--force");
  }
}

function addSharedCreateUpdateFlags(args: string[], params: PmToolParameters): void {
  pushOption(args, "--parent", params.parent);
  pushOption(args, "--reviewer", params.reviewer);
  pushOption(args, "--risk", params.risk);
  pushOption(args, "--confidence", params.confidence);
  pushOption(args, "--sprint", params.sprint);
  pushOption(args, "--release", params.release);
  pushOption(args, "--blocked-by", params.blockedBy);
  pushOption(args, "--blocked-reason", params.blockedReason);
  pushOption(args, "--unblock-note", params.unblockNote);
  pushOption(args, "--reporter", params.reporter);
  pushOption(args, "--severity", params.severity);
  pushOption(args, "--environment", params.environment);
  pushOption(args, "--repro-steps", params.reproSteps);
  pushOption(args, "--resolution", params.resolution);
  pushOption(args, "--expected-result", params.expectedResult);
  pushOption(args, "--actual-result", params.actualResult);
  pushOption(args, "--affected-version", params.affectedVersion);
  pushOption(args, "--fixed-version", params.fixedVersion);
  pushOption(args, "--component", params.component);
  pushBooleanishOption(args, "--regression", params.regression);
  pushOption(args, "--customer-impact", params.customerImpact);
  pushOption(args, "--definition-of-ready", params.definitionOfReady, true);
  pushOption(args, "--order", params.order);
  pushOption(args, "--goal", params.goal);
  pushOption(args, "--objective", params.objective);
  pushOption(args, "--value", params.value);
  pushOption(args, "--impact", params.impact);
  pushOption(args, "--outcome", params.outcome);
  pushOption(args, "--why-now", params.whyNow);
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
    case "get":
      args.push("get", requireString(params.id, "id", action));
      return args;
    case "search":
      args.push("search", requireString(params.query ?? params.keywords, "query", action));
      pushOption(args, "--mode", params.mode);
      if (params.includeLinked) {
        args.push("--include-linked");
      }
      addListFilters(args, params);
      return args;
    case "reindex":
      args.push("reindex");
      pushOption(args, "--mode", params.mode);
      return args;
    case "history":
      args.push("history", requireString(params.id, "id", action));
      pushOption(args, "--limit", params.limit);
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
      addAuthorMessageForceFlags(args, params);
      return args;
    case "files":
      args.push("files", requireString(params.id, "id", action));
      pushRepeatable(args, "--add", params.add);
      pushRepeatable(args, "--remove", params.remove);
      addAuthorMessageForceFlags(args, params);
      return args;
    case "docs":
      args.push("docs", requireString(params.id, "id", action));
      pushRepeatable(args, "--add", params.add);
      pushRepeatable(args, "--remove", params.remove);
      addAuthorMessageForceFlags(args, params);
      return args;
    case "test":
      args.push("test", requireString(params.id, "id", action));
      pushRepeatable(args, "--add", params.add);
      pushRepeatable(args, "--remove", params.remove);
      if (params.run) {
        args.push("--run");
      }
      pushOption(args, "--timeout", params.timeout);
      addAuthorMessageForceFlags(args, params);
      return args;
    case "test-all":
      args.push("test-all");
      pushOption(args, "--status", params.status);
      pushOption(args, "--timeout", params.timeout);
      return args;
    case "stats":
    case "health":
    case "gc":
      args.push(action);
      return args;
    case "completion":
      args.push("completion", requireString(params.shell, "shell", action));
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
