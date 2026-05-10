import type { PmCliErrorContext, PmCliErrorRecoveryPayload } from "../core/shared/errors.js";

interface GuidanceMessage {
  code: string;
  type: string;
  title: string;
  happened: string;
  required: string;
  why?: string;
  examples?: string[];
  nextSteps?: string[];
  recovery?: PmCliErrorRecoveryPayload;
}

export interface JsonErrorEnvelope {
  type: string;
  code: string;
  title: string;
  detail: string;
  required: string;
  exit_code: number;
  why?: string;
  examples?: string[];
  next_steps?: string[];
  recovery?: PmCliErrorRecoveryPayload;
}

export interface ErrorClassification {
  type: string;
  code: string;
  title: string;
  detail: string;
  required: string;
  why?: string;
  examples?: string[];
  next_steps?: string[];
  recovery?: PmCliErrorRecoveryPayload;
}

export interface CommanderGuidanceContext {
  unknownCommandExamples?: string[];
  unknownCommandNextSteps?: string[];
  attemptedCommand?: string;
  normalizedInvocationArgs?: string[];
  providedOptionFlags?: string[];
  unknownOptionSuggestions?: string[];
  suggestedRetryCommand?: string;
}

function errorType(code: string): string {
  return `urn:pm-cli:error:${code}`;
}

function makeGuidanceMessage(params: Omit<GuidanceMessage, "type">): GuidanceMessage {
  return {
    ...params,
    type: errorType(params.code),
  };
}

function renderList(title: string, entries: string[]): string[] {
  if (entries.length === 0) {
    return [];
  }
  return [title, ...entries.map((entry) => `  - ${entry}`)];
}

function normalizeRecoveryPayload(payload: PmCliErrorRecoveryPayload | undefined): PmCliErrorRecoveryPayload | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const normalized: PmCliErrorRecoveryPayload = {};
  if (typeof payload.attempted_command === "string" && payload.attempted_command.trim().length > 0) {
    normalized.attempted_command = payload.attempted_command.trim();
  }
  if (Array.isArray(payload.normalized_args)) {
    const args = payload.normalized_args.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    if (args.length > 0) {
      normalized.normalized_args = args;
    }
  }
  if (Array.isArray(payload.provided_fields)) {
    const fields = payload.provided_fields.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    if (fields.length > 0) {
      normalized.provided_fields = fields;
    }
  }
  if (Array.isArray(payload.missing)) {
    const missing = payload.missing.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    if (missing.length > 0) {
      normalized.missing = missing;
    }
  }
  if (typeof payload.suggested_retry === "string" && payload.suggested_retry.trim().length > 0) {
    normalized.suggested_retry = payload.suggested_retry.trim();
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function renderRecoveryBundle(recovery: PmCliErrorRecoveryPayload | undefined): string[] {
  const normalized = normalizeRecoveryPayload(recovery);
  if (!normalized) {
    return [];
  }
  const lines = ["Recovery bundle:"];
  if (normalized.attempted_command) {
    lines.push(`  attempted_command: ${normalized.attempted_command}`);
  }
  if (normalized.normalized_args && normalized.normalized_args.length > 0) {
    lines.push(`  normalized_args: ${normalized.normalized_args.join(" ")}`);
  }
  if (normalized.provided_fields && normalized.provided_fields.length > 0) {
    lines.push(`  provided_fields: ${normalized.provided_fields.join(", ")}`);
  }
  if (normalized.missing && normalized.missing.length > 0) {
    lines.push(`  missing: ${normalized.missing.join(", ")}`);
  }
  if (normalized.suggested_retry) {
    lines.push(`  suggested_retry: ${normalized.suggested_retry}`);
  }
  return lines;
}

export function renderGuidanceMessage(message: GuidanceMessage): string {
  const lines: string[] = [
    `Error: ${message.title}`,
    "",
    "What happened:",
    `  ${message.happened}`,
    "",
    "What is required:",
    `  ${message.required}`,
  ];
  if (message.why) {
    lines.push("", "Why:");
    lines.push(`  ${message.why}`);
  }
  if (message.examples && message.examples.length > 0) {
    lines.push("");
    lines.push(...renderList("Examples:", message.examples));
  }
  if (message.nextSteps && message.nextSteps.length > 0) {
    lines.push("");
    lines.push(...renderList("Next steps:", message.nextSteps));
  }
  const recoveryLines = renderRecoveryBundle(message.recovery);
  if (recoveryLines.length > 0) {
    lines.push("");
    lines.push(...recoveryLines);
  }
  return lines.join("\n");
}

function guidanceToJsonEnvelope(message: GuidanceMessage, exitCode: number): JsonErrorEnvelope {
  const payload: JsonErrorEnvelope = {
    type: message.type,
    code: message.code,
    title: message.title,
    detail: message.happened,
    required: message.required,
    exit_code: exitCode,
  };
  if (message.why) {
    payload.why = message.why;
  }
  if (message.examples && message.examples.length > 0) {
    payload.examples = message.examples;
  }
  if (message.nextSteps && message.nextSteps.length > 0) {
    payload.next_steps = message.nextSteps;
  }
  if (message.recovery) {
    payload.recovery = message.recovery;
  }
  return payload;
}

function guidanceToClassification(message: GuidanceMessage): ErrorClassification {
  const payload: ErrorClassification = {
    type: message.type,
    code: message.code,
    title: message.title,
    detail: message.happened,
    required: message.required,
  };
  if (message.why) {
    payload.why = message.why;
  }
  if (message.examples && message.examples.length > 0) {
    payload.examples = message.examples;
  }
  if (message.nextSteps && message.nextSteps.length > 0) {
    payload.next_steps = message.nextSteps;
  }
  if (message.recovery) {
    payload.recovery = message.recovery;
  }
  return payload;
}

function normalizeMessage(message: string): string {
  return message.replace(/\(outputHelp\)/g, "").trim();
}

function normalizeContextList(values: string[] | undefined): string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function buildFallbackTitleFromMessage(message: string): string | undefined {
  const firstLine = message.split(/\r?\n/)[0]?.trim() ?? "";
  if (firstLine.length === 0) {
    return undefined;
  }
  if (firstLine.length <= 120) {
    return firstLine;
  }
  return `${firstLine.slice(0, 117)}...`;
}

function applyPmCliErrorContext(
  guidance: GuidanceMessage,
  rawMessage: string,
  context: PmCliErrorContext | undefined,
): GuidanceMessage {
  if (!context) {
    return guidance;
  }
  const normalizedRawMessage = normalizeMessage(rawMessage);
  const code = typeof context.code === "string" && context.code.trim().length > 0 ? context.code.trim() : guidance.code;
  const type = typeof context.type === "string" && context.type.trim().length > 0 ? context.type.trim() : errorType(code);
  const examples = normalizeContextList(context.examples) ?? guidance.examples;
  const nextSteps = normalizeContextList(context.nextSteps) ?? guidance.nextSteps;
  const fallbackTitle = guidance.code === "command_failed" && context.code ? buildFallbackTitleFromMessage(normalizedRawMessage) : undefined;
  const recovery = normalizeRecoveryPayload(context.recovery) ?? guidance.recovery;
  return {
    ...guidance,
    code,
    type,
    title: fallbackTitle ?? guidance.title,
    happened: normalizedRawMessage.length > 0 ? normalizedRawMessage : guidance.happened,
    required: typeof context.required === "string" && context.required.trim().length > 0 ? context.required.trim() : guidance.required,
    why: typeof context.why === "string" && context.why.trim().length > 0 ? context.why.trim() : guidance.why,
    examples,
    nextSteps,
    recovery,
  };
}

function buildPmCliErrorGuidance(rawMessage: string, context?: PmCliErrorContext): GuidanceMessage {
  const message = normalizeMessage(rawMessage);

  const trackerNotInitialized = message.match(/^Tracker is not initialized at (.+)\. Run pm init first\.$/);
  if (trackerNotInitialized) {
    return applyPmCliErrorContext(
      makeGuidanceMessage({
        code: "tracker_not_initialized",
        title: "Tracker is not initialized",
        happened: `pm data path does not contain initialized tracker metadata (${trackerNotInitialized[1]}).`,
        required: "Initialize tracker storage before running this command.",
        why: "Most commands require settings and tracker directories created by pm init.",
        examples: ["pm init", "pm init acme"],
        nextSteps: ['Run "pm init", then rerun your original command.'],
      }),
      rawMessage,
      context,
    );
  }

  const itemNotFound = message.match(/^Item ([^ ]+) not found$/);
  if (itemNotFound) {
    const badId = itemNotFound[1];
    const isPlaceholder = /^(undefined|null|<.*>|\[.*\]|{.*}|)$/.test(badId);
    const happened = isPlaceholder
      ? `The item ID "${badId}" looks like a placeholder or unresolved variable. Ensure the ID argument is resolved before calling pm.`
      : `No item with id "${badId}" exists in the active tracker scope.`;
    const nextSteps = isPlaceholder
      ? [
          "Check that the variable holding the item ID is defined before passing it to pm.",
          'Use "pm list-open --limit 20" to find valid IDs.',
        ]
      : ["Confirm the active --path/PM_PATH scope, then retry with a valid id."];
    return applyPmCliErrorContext(
      makeGuidanceMessage({
        code: "item_not_found",
        title: "Item ID not found",
        happened,
        required: "Use an existing item ID from current tracker data.",
        why: "Mutation and read commands operate only on known IDs.",
        examples: ['pm list-open --limit 20', 'pm search "<keyword>" --limit 10'],
        nextSteps,
      }),
      rawMessage,
      context,
    );
  }

  if (message.includes("is assigned to") && message.includes("Use --force to override")) {
    return applyPmCliErrorContext(
      makeGuidanceMessage({
        code: "ownership_conflict",
        title: "Ownership conflict",
        happened: message,
        required:
          "Run as assigned owner, use audit flags for safe non-owner updates, or use --force only for approved override scenarios.",
        why: "Ownership checks prevent accidental concurrent mutations on claimed items and protect against conflicting writes.",
        examples: [
          'pm update pm-a1b2 --allow-audit-update --description "..." --author "audit-agent"',
          'pm update pm-a1b2 --allow-audit-dep-update --dep "..." --author "audit-agent"',
          'pm comments pm-a1b2 "..." --allow-audit-comment --author "audit-agent"',
          'pm claim pm-a1b2 --author "codex-agent"',
          'pm release pm-a1b2 --allow-audit-release --author "reviewer"',
          'pm update pm-a1b2 --status in_progress --force',
        ],
        nextSteps: [
          "Use --allow-audit-update for metadata-only non-owner updates (excludes lifecycle/ownership fields).",
          "Use --allow-audit-dep-update for dependency-only non-owner additions.",
          "Use --allow-audit-comment on comments/notes/learnings for append-only audit entries.",
          "Use --force for PM audits and systematic metadata updates performed by leads/maintainers.",
          "Use --force when correcting known stale metadata after coordinating ownership changes.",
          'For non-terminal reassignment, prefer "pm claim <ID> --author <you>" before running other mutations.',
          'For assignee handoff release workflows, prefer "pm release <ID> --allow-audit-release --author <you>" before using --force.',
        ],
      }),
      rawMessage,
      context,
    );
  }

  if (message.includes("is locked")) {
    return applyPmCliErrorContext(
      makeGuidanceMessage({
        code: "lock_conflict",
        title: "Lock conflict",
        happened: message,
        required: "Wait for lock release, or use --force where supported if lock is stale and safe to override.",
        why: "Locking protects item files from concurrent write races.",
        examples: ['pm update pm-a1b2 --status in_progress --force --author "codex-agent"'],
      }),
      rawMessage,
      context,
    );
  }

  const missingRequiredOption = message.match(/^Missing required option /);
  const missingRequiredOptions = message.match(/^Missing required options /);
  if (missingRequiredOption || missingRequiredOptions) {
    const plural = Boolean(missingRequiredOptions);
    const missingOptionFlag = !plural ? message.replace(/^Missing required option\s+/, "").trim() : null;
    const missingOptionRequired = missingOptionFlag
      ? `Pass ${missingOptionFlag} with a valid value before running the command.`
      : "Provide the required option for this command invocation.";
    return applyPmCliErrorContext(
      makeGuidanceMessage({
        code: "missing_required_option",
        title: plural ? "Missing required options" : missingOptionFlag ? `Missing required option ${missingOptionFlag}` : "Missing required option",
        happened: message,
        required: plural
          ? "Provide every required option for this command invocation."
          : missingOptionRequired,
        why: "Required options define command intent and enforce deterministic write contracts.",
        examples: [
          'pm create --title "Task title" --description "Task details" --type Task --create-mode progressive',
          'pm create --title "Task title" --description "Task details" --type Task --status open --priority 1 --message "Create task" --dep "id=pm-epic01,kind=parent,author=codex-agent,created_at=now" --comment "author=codex-agent,created_at=now,text=Why this task exists." --note "author=codex-agent,created_at=now,text=Initial implementation note." --learning "author=codex-agent,created_at=now,text=Durable lesson placeholder." --file "path=src/example.ts,scope=project" --test "command=node scripts/run-tests.mjs test,scope=project,timeout_seconds=240" --doc "path=README.md,scope=project"',
        ],
        nextSteps: [
          'Run "pm <command> --help" to view required and recommended flags.',
          "For staged triage without placeholder linkage values, use --create-mode progressive.",
        ],
      }),
      rawMessage,
      context,
    );
  }

  if (message.startsWith("No update flags provided")) {
    return applyPmCliErrorContext(
      makeGuidanceMessage({
        code: "no_update_fields",
        title: "No update fields supplied",
        happened: "The update command was called without any field-changing flags.",
        required:
          "Provide at least one field-changing flag such as --status, --priority, --title, --tags, --description, or --body. Use --message only to label a real mutation.",
        why: "pm update mutates existing item fields; no-op invocations are rejected to avoid ambiguous history.",
        examples: [
          'pm update pm-a1b2 --status in_progress --message "Start implementation"',
          'pm update pm-a1b2 --description "Clarified implementation scope" --message "Clarify task intent"',
          'pm append pm-a1b2 --body "Detailed progress notes" --message "Append progress notes"',
        ],
        nextSteps: [
          "Choose the item field you intend to change, then pair that change with --message for history context.",
          "Use pm comments, pm notes, pm learnings, or pm append when you only need to add narrative context.",
        ],
      }),
      rawMessage,
      context,
    );
  }

  if (message.startsWith("Invalid ") || message.includes(" must be ")) {
    return applyPmCliErrorContext(
      makeGuidanceMessage({
        code: "invalid_argument_value",
        title: "Invalid argument value",
        happened: message,
        required: "Use values that match documented command constraints.",
        why: "Validation protects data consistency and deterministic behavior across commands.",
        examples: ["pm create --help", "pm update --help", "pm calendar --help"],
        nextSteps: ["Check allowed values in command help, then rerun with corrected input."],
      }),
      rawMessage,
      context,
    );
  }

  return applyPmCliErrorContext(
    makeGuidanceMessage({
      code: "command_failed",
      title: "Command failed",
      happened: message,
      required: "Adjust command input or tracker state and retry.",
      why: "pm enforces explicit, deterministic contracts for data and command semantics.",
      examples: ["pm --help", "pm <command> --help"],
    }),
    rawMessage,
    context,
  );
}

function commandExampleForRequiredOption(commandName: string | undefined, optionFlag: string, allowedTypes: string): string[] {
  if (commandName === "create" && optionFlag.startsWith("--type")) {
    const firstAllowed = allowedTypes.split("|")[0] || "Task";
    return [
      `pm create --title "Example title" --description "Example description" --type ${firstAllowed} --status open --priority 1 --message "Create item" --create-mode progressive`,
    ];
  }
  if (commandName === "update") {
    return ['pm update pm-a1b2 --status in_progress --message "Start implementation"'];
  }
  return [`pm ${commandName ?? "<command>"} --help`];
}

function quoteCommandArg(arg: string): string {
  if (/^[A-Za-z0-9._:/@=-]+$/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

function renderPmCommandFromArgs(argv: string[] | undefined): string | undefined {
  if (!Array.isArray(argv) || argv.length === 0) {
    return undefined;
  }
  return `pm ${argv.map((arg) => quoteCommandArg(arg)).join(" ")}`;
}

function normalizeOptionFlags(values: string[] | undefined): string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function buildCommanderRecoveryPayload(
  context: CommanderGuidanceContext | undefined,
  overrides: Partial<PmCliErrorRecoveryPayload> = {},
): PmCliErrorRecoveryPayload | undefined {
  const providedFields = normalizeOptionFlags(context?.providedOptionFlags);
  const normalizedArgs =
    Array.isArray(context?.normalizedInvocationArgs) && context?.normalizedInvocationArgs.length > 0
      ? context.normalizedInvocationArgs
      : undefined;
  const attemptedCommand = typeof context?.attemptedCommand === "string" ? context.attemptedCommand : renderPmCommandFromArgs(normalizedArgs);
  const retryCommand = typeof context?.suggestedRetryCommand === "string" ? context.suggestedRetryCommand : undefined;
  return normalizeRecoveryPayload({
    attempted_command: attemptedCommand,
    normalized_args: normalizedArgs,
    provided_fields: providedFields,
    suggested_retry: retryCommand,
    ...overrides,
  });
}

function appendIfMissing(entries: string[], value: string | undefined): string[] {
  if (!value || entries.includes(value)) {
    return entries;
  }
  return [...entries, value];
}

function buildCommanderErrorGuidance(
  rawMessage: string,
  commandName: string | undefined,
  allowedTypes: string,
  context?: CommanderGuidanceContext,
): GuidanceMessage {
  const message = normalizeMessage(rawMessage);

  const requiredOption = message.match(/required option '([^']+)' not specified/);
  if (requiredOption) {
    const optionFlag = requiredOption[1];
    const isType = optionFlag.startsWith("--type");
    const retryCommand = context?.suggestedRetryCommand;
    const providedFlags = normalizeOptionFlags(context?.providedOptionFlags);
    const missing = [optionFlag];
    const examples = commandExampleForRequiredOption(commandName, optionFlag, allowedTypes);
    const examplesWithRetry = retryCommand ? appendIfMissing(examples, retryCommand) : examples;
    const nextStepsBase = isType
      ? [`Allowed type values: ${allowedTypes}`, `Run "pm ${commandName ?? "create"} --help --type <value>" for type-aware policy details.`]
      : [`Run "pm ${commandName ?? "<command>"} --help" for required option guidance.`];
    const nextStepsWithRetry = retryCommand
      ? appendIfMissing(nextStepsBase, `Replay with preserved arguments: ${retryCommand}`)
      : nextStepsBase;
    const nextSteps =
      providedFlags && providedFlags.length > 0
        ? appendIfMissing(nextStepsWithRetry, `Already provided options: ${providedFlags.join(", ")}`)
        : nextStepsWithRetry;
    return makeGuidanceMessage({
      code: "missing_required_option",
      title: `Missing required option ${optionFlag}`,
      happened: `Commander rejected the command because ${optionFlag} was not provided.`,
      required: `Pass ${optionFlag} with a valid value before running the command.`,
      why: isType
        ? "--type selects item contract and policy routing, including required/disabled option rules."
        : "Required flags define mandatory command intent and prevent ambiguous execution.",
      examples: examplesWithRetry,
      nextSteps,
      recovery: buildCommanderRecoveryPayload(context, { missing }),
    });
  }

  const missingArgument = message.match(/missing required argument '([^']+)'/);
  if (missingArgument) {
    const argumentName = missingArgument[1];
    return makeGuidanceMessage({
      code: "missing_required_argument",
      title: `Missing required argument ${argumentName}`,
      happened: `Command invocation omitted positional argument ${argumentName}.`,
      required: `Provide ${argumentName} in the expected command position.`,
      why: "Positional arguments identify the target entity or action context for the command.",
      examples: [`pm ${commandName ?? "<command>"} --help`],
      recovery: buildCommanderRecoveryPayload(context, { missing: [argumentName] }),
    });
  }

  const unknownOption = message.match(/unknown option '([^']+)'/);
  if (unknownOption) {
    const optionName = unknownOption[1];
    const suggestions = normalizeOptionFlags(context?.unknownOptionSuggestions);
    const retryCommand = context?.suggestedRetryCommand;
    if (commandName === "update" && (optionName === "--file" || optionName === "--doc")) {
      return makeGuidanceMessage({
        code: "unsupported_update_option",
        title: `Unsupported option ${optionName} for update`,
        happened: `pm update does not accept ${optionName} for linked artifact mutations.`,
        required: "Use dedicated linked-artifact commands instead of pm update for files/docs changes.",
        why: "pm update manages scalar item metadata, while linked files/docs are managed by pm files and pm docs.",
        examples: [
          'pm files pm-a1b2 --add "path=src/cli/main.ts,scope=project,note=implementation surface"',
          'pm docs pm-a1b2 --add "path=README.md,scope=project,note=user-facing contract"',
        ],
        nextSteps: ['Run "pm files --help" and "pm docs --help" for add/remove payload formats.'],
        recovery: buildCommanderRecoveryPayload(context, {
          missing: suggestions,
        }),
      });
    }
    const nextSteps = [
      "Run command help to confirm the exact option contracts for this command path.",
      ...(suggestions && suggestions.length > 0 ? [`Nearest supported options: ${suggestions.join(", ")}`] : []),
      ...(retryCommand ? [`Replay with suggested correction: ${retryCommand}`] : []),
    ];
    const examples = [
      ...(retryCommand ? [retryCommand] : []),
      `pm ${commandName ?? "<command>"} --help`,
    ];
    return makeGuidanceMessage({
      code: "unknown_option",
      title: `Unknown option ${optionName}`,
      happened: `Commander does not recognize option ${optionName} for this command path.`,
      required: "Use supported options only, or move option to the correct subcommand.",
      why: "Option contracts are command-specific and intentionally validated.",
      examples,
      nextSteps,
      recovery: buildCommanderRecoveryPayload(context, {
        missing: suggestions,
      }),
    });
  }

  const unknownCommand = message.match(/unknown command '([^']+)'/);
  if (unknownCommand) {
    const commandToken = unknownCommand[1];
    const runtimeExamples = normalizeContextList(context?.unknownCommandExamples);
    const runtimeNextSteps = normalizeContextList(context?.unknownCommandNextSteps);
    return makeGuidanceMessage({
      code: "unknown_command",
      title: `Unknown command ${commandToken}`,
      happened: `pm does not expose command path "${commandToken}" in current runtime configuration.`,
      required: "Use a valid command name or subcommand path.",
      why: "Command registry includes core commands plus active extension command handlers.",
      examples: runtimeExamples ?? ["pm --help"],
      nextSteps: runtimeNextSteps ?? ["Verify spelling and active extensions, then rerun."],
      recovery: buildCommanderRecoveryPayload(context),
    });
  }

  return makeGuidanceMessage({
    code: "invalid_command_usage",
    title: "Invalid command usage",
    happened: message,
    required: "Use the command with valid arguments and options.",
    why: "Commander validates CLI contracts before execution.",
    examples: ["pm --help", `pm ${commandName ?? "<command>"} --help`],
    recovery: buildCommanderRecoveryPayload(context),
  });
}

export function formatPmCliErrorForDisplay(rawMessage: string, context?: PmCliErrorContext): string {
  return renderGuidanceMessage(buildPmCliErrorGuidance(rawMessage, context));
}

export function classifyPmCliError(rawMessage: string, context?: PmCliErrorContext): ErrorClassification {
  return guidanceToClassification(buildPmCliErrorGuidance(rawMessage, context));
}

export function formatPmCliErrorForJson(rawMessage: string, exitCode: number, context?: PmCliErrorContext): JsonErrorEnvelope {
  return guidanceToJsonEnvelope(buildPmCliErrorGuidance(rawMessage, context), exitCode);
}

export function formatCommanderErrorForDisplay(
  rawMessage: string,
  commandName: string | undefined,
  allowedTypes: string,
  context?: CommanderGuidanceContext,
): string {
  return renderGuidanceMessage(buildCommanderErrorGuidance(rawMessage, commandName, allowedTypes, context));
}

export function classifyCommanderError(
  rawMessage: string,
  commandName: string | undefined,
  allowedTypes: string,
  context?: CommanderGuidanceContext,
): ErrorClassification {
  return guidanceToClassification(buildCommanderErrorGuidance(rawMessage, commandName, allowedTypes, context));
}

export function formatCommanderErrorForJson(
  rawMessage: string,
  commandName: string | undefined,
  allowedTypes: string,
  exitCode: number,
  context?: CommanderGuidanceContext,
): JsonErrorEnvelope {
  return guidanceToJsonEnvelope(buildCommanderErrorGuidance(rawMessage, commandName, allowedTypes, context), exitCode);
}

export function formatUnknownErrorForJson(rawMessage: string, exitCode: number): JsonErrorEnvelope {
  const guidance = buildUnknownErrorGuidance(rawMessage);
  return guidanceToJsonEnvelope(guidance, exitCode);
}

function buildUnknownErrorGuidance(rawMessage: string): GuidanceMessage {
  return makeGuidanceMessage({
    code: "unknown_error",
    title: "Unhandled error",
    happened: normalizeMessage(rawMessage),
    required: "Inspect command input and runtime state, then retry.",
    why: "Unexpected runtime failures can occur from environment or extension-level issues.",
    examples: ["pm --help", "pm health --json"],
  });
}

export function classifyUnknownError(rawMessage: string): ErrorClassification {
  return guidanceToClassification(buildUnknownErrorGuidance(rawMessage));
}
