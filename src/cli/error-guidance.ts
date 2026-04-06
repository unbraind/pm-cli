import type { PmCliErrorContext } from "../core/shared/errors.js";

interface GuidanceMessage {
  code: string;
  type: string;
  title: string;
  happened: string;
  required: string;
  why?: string;
  examples?: string[];
  nextSteps?: string[];
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
    return applyPmCliErrorContext(
      makeGuidanceMessage({
        code: "item_not_found",
        title: "Item ID not found",
        happened: `No item with id "${itemNotFound[1]}" exists in the active tracker scope.`,
        required: "Use an existing item ID from current tracker data.",
        why: "Mutation and read commands operate only on known IDs.",
        examples: ['pm list-open --limit 20', 'pm search "<keyword>" --limit 10'],
        nextSteps: ["Confirm the active --path/PM_PATH scope, then retry with a valid id."],
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
        required: "Run as assigned owner, claim the item when appropriate, or use --force only for approved override scenarios.",
        why: "Ownership checks prevent accidental concurrent mutations on claimed items and protect against conflicting writes.",
        examples: ['pm claim pm-a1b2 --author "codex-agent"', 'pm update pm-a1b2 --status in_progress --force'],
        nextSteps: [
          "Use --force for PM audits and systematic metadata updates performed by leads/maintainers.",
          "Use --force when correcting known stale metadata after coordinating ownership changes.",
          'For non-terminal reassignment, prefer "pm claim <ID> --author <you>" before running other mutations.',
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
    return applyPmCliErrorContext(
      makeGuidanceMessage({
        code: "missing_required_option",
        title: plural ? "Missing required options" : "Missing required option",
        happened: message,
        required: plural
          ? "Provide every required option for this command invocation."
          : "Provide the required option for this command invocation.",
        why: "Required options define command intent and enforce deterministic write contracts.",
        examples: [
          'pm create --title "Task title" --description "Task details" --type Task --status open --priority 1 --message "Create task" --dep none --comment none --note none --learning none --file none --test none --doc none',
          'pm create --title "Task title" --description "Task details" --type Task --create-mode progressive',
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
        required: "Provide at least one update field such as --status, --priority, --title, --tags, or --message.",
        why: "pm update mutates existing item fields; no-op invocations are rejected to avoid ambiguous history.",
        examples: ['pm update pm-a1b2 --status in_progress --message "Start implementation"'],
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
      `pm create --title "Example title" --description "Example description" --type ${firstAllowed} --status open --priority 1 --message "Create item" --dep none --comment none --note none --learning none --file none --test none --doc none`,
    ];
  }
  if (commandName === "update") {
    return ['pm update pm-a1b2 --status in_progress --message "Start implementation"'];
  }
  return [`pm ${commandName ?? "<command>"} --help`];
}

function buildCommanderErrorGuidance(rawMessage: string, commandName: string | undefined, allowedTypes: string): GuidanceMessage {
  const message = normalizeMessage(rawMessage);

  const requiredOption = message.match(/required option '([^']+)' not specified/);
  if (requiredOption) {
    const optionFlag = requiredOption[1];
    const isType = optionFlag.startsWith("--type");
    return makeGuidanceMessage({
      code: "missing_required_option",
      title: `Missing required option ${optionFlag}`,
      happened: `Commander rejected the command because ${optionFlag} was not provided.`,
      required: `Pass ${optionFlag} with a valid value before running the command.`,
      why: isType
        ? "--type selects item contract and policy routing, including required/disabled option rules."
        : "Required flags define mandatory command intent and prevent ambiguous execution.",
      examples: commandExampleForRequiredOption(commandName, optionFlag, allowedTypes),
      nextSteps: isType
        ? [`Allowed type values: ${allowedTypes}`, `Run "pm ${commandName ?? "create"} --help --type <value>" for type-aware policy details.`]
        : [`Run "pm ${commandName ?? "<command>"} --help" for required option guidance.`],
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
    });
  }

  const unknownOption = message.match(/unknown option '([^']+)'/);
  if (unknownOption) {
    const optionName = unknownOption[1];
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
      });
    }
    return makeGuidanceMessage({
      code: "unknown_option",
      title: `Unknown option ${optionName}`,
      happened: `Commander does not recognize option ${optionName} for this command path.`,
      required: "Use supported options only, or move option to the correct subcommand.",
      why: "Option contracts are command-specific and intentionally validated.",
      examples: [`pm ${commandName ?? "<command>"} --help`],
    });
  }

  const unknownCommand = message.match(/unknown command '([^']+)'/);
  if (unknownCommand) {
    const commandToken = unknownCommand[1];
    return makeGuidanceMessage({
      code: "unknown_command",
      title: `Unknown command ${commandToken}`,
      happened: `pm does not expose command path "${commandToken}" in current runtime configuration.`,
      required: "Use a valid command name or subcommand path.",
      why: "Command registry includes core commands plus active extension command handlers.",
      examples: ["pm --help", "pm beads --help", "pm todos --help"],
      nextSteps: ["Verify spelling and active extensions, then rerun."],
    });
  }

  return makeGuidanceMessage({
    code: "invalid_command_usage",
    title: "Invalid command usage",
    happened: message,
    required: "Use the command with valid arguments and options.",
    why: "Commander validates CLI contracts before execution.",
    examples: ["pm --help", `pm ${commandName ?? "<command>"} --help`],
  });
}

export function formatPmCliErrorForDisplay(rawMessage: string, context?: PmCliErrorContext): string {
  return renderGuidanceMessage(buildPmCliErrorGuidance(rawMessage, context));
}

export function formatPmCliErrorForJson(rawMessage: string, exitCode: number, context?: PmCliErrorContext): JsonErrorEnvelope {
  return guidanceToJsonEnvelope(buildPmCliErrorGuidance(rawMessage, context), exitCode);
}

export function formatCommanderErrorForDisplay(
  rawMessage: string,
  commandName: string | undefined,
  allowedTypes: string,
): string {
  return renderGuidanceMessage(buildCommanderErrorGuidance(rawMessage, commandName, allowedTypes));
}

export function formatCommanderErrorForJson(
  rawMessage: string,
  commandName: string | undefined,
  allowedTypes: string,
  exitCode: number,
): JsonErrorEnvelope {
  return guidanceToJsonEnvelope(buildCommanderErrorGuidance(rawMessage, commandName, allowedTypes), exitCode);
}

export function formatUnknownErrorForJson(rawMessage: string, exitCode: number): JsonErrorEnvelope {
  const guidance = makeGuidanceMessage({
    code: "unknown_error",
    title: "Unhandled error",
    happened: normalizeMessage(rawMessage),
    required: "Inspect command input and runtime state, then retry.",
    why: "Unexpected runtime failures can occur from environment or extension-level issues.",
    examples: ["pm --help", "pm health --json"],
  });
  return guidanceToJsonEnvelope(guidance, exitCode);
}
