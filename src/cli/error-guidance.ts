interface GuidanceMessage {
  title: string;
  happened: string;
  required: string;
  why?: string;
  examples?: string[];
  nextSteps?: string[];
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

function normalizeMessage(message: string): string {
  return message.replace(/\(outputHelp\)/g, "").trim();
}

export function formatPmCliErrorForDisplay(rawMessage: string): string {
  const message = normalizeMessage(rawMessage);

  const trackerNotInitialized = message.match(/^Tracker is not initialized at (.+)\. Run pm init first\.$/);
  if (trackerNotInitialized) {
    return renderGuidanceMessage({
      title: "Tracker is not initialized",
      happened: `pm data path does not contain initialized tracker metadata (${trackerNotInitialized[1]}).`,
      required: "Initialize tracker storage before running this command.",
      why: "Most commands require settings and tracker directories created by pm init.",
      examples: ["pm init", "pm init acme"],
      nextSteps: ['Run "pm init", then rerun your original command.'],
    });
  }

  const itemNotFound = message.match(/^Item ([^ ]+) not found$/);
  if (itemNotFound) {
    return renderGuidanceMessage({
      title: "Item ID not found",
      happened: `No item with id "${itemNotFound[1]}" exists in the active tracker scope.`,
      required: "Use an existing item ID from current tracker data.",
      why: "Mutation and read commands operate only on known IDs.",
      examples: ["pm list-open --limit 20", `pm get ${itemNotFound[1]}`],
      nextSteps: ["Confirm the active --path/PM_PATH scope, then retry with a valid id."],
    });
  }

  if (message.includes("is assigned to") && message.includes("Use --force to override")) {
    return renderGuidanceMessage({
      title: "Ownership conflict",
      happened: message,
      required: "Run as assigned owner or explicitly bypass with --force when appropriate.",
      why: "Ownership checks prevent accidental concurrent mutations on claimed items.",
      examples: ['pm claim pm-a1b2 --author "codex-agent"', 'pm update pm-a1b2 --status in_progress --force'],
    });
  }

  if (message.includes("is locked")) {
    return renderGuidanceMessage({
      title: "Lock conflict",
      happened: message,
      required: "Wait for lock release, or use --force where supported if lock is stale and safe to override.",
      why: "Locking protects item files from concurrent write races.",
      examples: ['pm update pm-a1b2 --status in_progress --force --author "codex-agent"'],
    });
  }

  if (message.startsWith("Missing required option ")) {
    return renderGuidanceMessage({
      title: "Missing required option",
      happened: message,
      required: "Provide every required option for this command invocation.",
      why: "Required options define command intent and enforce deterministic write contracts.",
      examples: [
        'pm create --title "Task title" --description "Task details" --type Task --status open --priority 1 --message "Create task" --dep none --comment none --note none --learning none --file none --test none --doc none',
      ],
      nextSteps: ['Run "pm <command> --help" to view required and recommended flags.'],
    });
  }

  if (message.startsWith("No update flags provided")) {
    return renderGuidanceMessage({
      title: "No update fields supplied",
      happened: "The update command was called without any field-changing flags.",
      required: "Provide at least one update field such as --status, --priority, --title, --tags, or --message.",
      why: "pm update mutates existing item fields; no-op invocations are rejected to avoid ambiguous history.",
      examples: ['pm update pm-a1b2 --status in_progress --message "Start implementation"'],
    });
  }

  if (message.startsWith("Invalid ") || message.includes(" must be ")) {
    return renderGuidanceMessage({
      title: "Invalid argument value",
      happened: message,
      required: "Use values that match documented command constraints.",
      why: "Validation protects data consistency and deterministic behavior across commands.",
      examples: ["pm create --help", "pm update --help", "pm calendar --help"],
      nextSteps: ["Check allowed values in command help, then rerun with corrected input."],
    });
  }

  return renderGuidanceMessage({
    title: "Command failed",
    happened: message,
    required: "Adjust command input or tracker state and retry.",
    why: "pm enforces explicit, deterministic contracts for data and command semantics.",
    examples: ["pm --help", "pm <command> --help"],
  });
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

export function formatCommanderErrorForDisplay(
  rawMessage: string,
  commandName: string | undefined,
  allowedTypes: string,
): string {
  const message = normalizeMessage(rawMessage);

  const requiredOption = message.match(/required option '([^']+)' not specified/);
  if (requiredOption) {
    const optionFlag = requiredOption[1];
    const isType = optionFlag.startsWith("--type");
    return renderGuidanceMessage({
      title: `Missing required option ${optionFlag}`,
      happened: `Commander rejected the command because ${optionFlag} was not provided.`,
      required: `Pass ${optionFlag} with a valid value before running the command.`,
      why: isType
        ? "--type selects item contract and policy routing, including required/disabled option rules."
        : "Required flags define mandatory command intent and prevent ambiguous execution.",
      examples: isType
        ? commandExampleForRequiredOption(commandName, optionFlag, allowedTypes)
        : commandExampleForRequiredOption(commandName, optionFlag, allowedTypes),
      nextSteps: isType
        ? [`Allowed type values: ${allowedTypes}`, `Run "pm ${commandName ?? "create"} --help --type <value>" for type-aware policy details.`]
        : [`Run "pm ${commandName ?? "<command>"} --help" for required option guidance.`],
    });
  }

  const missingArgument = message.match(/missing required argument '([^']+)'/);
  if (missingArgument) {
    const argumentName = missingArgument[1];
    return renderGuidanceMessage({
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
      return renderGuidanceMessage({
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
    return renderGuidanceMessage({
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
    return renderGuidanceMessage({
      title: `Unknown command ${commandToken}`,
      happened: `pm does not expose command path "${commandToken}" in current runtime configuration.`,
      required: "Use a valid command name or subcommand path.",
      why: "Command registry includes core commands plus active extension command handlers.",
      examples: ["pm --help", "pm beads --help", "pm todos --help"],
      nextSteps: ["Verify spelling and active extensions, then rerun."],
    });
  }

  return renderGuidanceMessage({
    title: "Invalid command usage",
    happened: message,
    required: "Use the command with valid arguments and options.",
    why: "Commander validates CLI contracts before execution.",
    examples: ["pm --help", `pm ${commandName ?? "<command>"} --help`],
  });
}
