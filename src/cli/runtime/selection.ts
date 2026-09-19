/**
 * @module cli/runtime/selection
 * Selects core registration families and refuses implicit corrections of mutating flags.
 */
import { Command } from "commander";
import { PM_RELOCATED_COMMAND_ALIASES,findPmNamespacedCommand } from "../../sdk/cli-contracts/command-aliases.js";
import {
  EXIT_CODE,
  PmCliError
} from "../../sdk/runtime-primitives.js";
import { redactSensitiveCommandArgs,renderPmCommand } from "../argv-utils.js";
import {
  normalizeBootstrapInvocation,
  parseBootstrapCommandName,
  parseBootstrapHelpRequest,
  stripGlobalBootstrapTokens
} from "../bootstrap-args.js";
import {
  isFullHelpDiscovery
} from "../help-content.js";

const VERSION_FLAG_TOKENS = new Set(["--version", "-V"]);

const SETUP_COMMAND_NAMES = new Set(["config", "extension", "init", "install", "package", "packages", "templates", "upgrade"]);

/** Core read command names used to select the list/query registration family. */
const LIST_QUERY_COMMAND_NAMES = new Set([
  "activity",
  "aggregate",
  "context",
  "ctx",
  "events",
  "get",
  "graph",
  "history",
  "list",
  "list-all",
  "list-blocked",
  "list-canceled",
  "list-closed",
  "list-draft",
  "list-in-progress",
  "list-open",
  "search",
]);

const MUTATION_COMMAND_NAMES = new Set([
  "append",
  "close",
  "close-many",
  "comments",
  "delete",
  "deps",
  "discover",
  "docs",
  "files",
  "history-repair",
  "history-redact",
  "history-compact",
  "learnings",
  "notes",
  "plan",
  "restore",
  "update",
  "update-many",
  "create",
]);

const OPERATION_COMMAND_NAMES = new Set([
  "claim",
  "close-task",
  "contracts",
  "duplicates",
  "gc",
  "health",
  "pause-task",
  "release",
  "start-task",
  "stats",
  "test",
  "test-all",
  "test-runs",
  "test-runs-worker",
  "validate",
]);

const MUTATING_OPERATION_COMMAND_NAMES = new Set(["claim", "close-task", "pause-task", "release", "start-task", "test"]);

/** Registration-family switches computed from one CLI invocation. */
interface CoreCommandRegistrationSelection {
  setup: boolean;
  listQuery: boolean;
  mutation: boolean;
  operation: boolean;
  targetCommandName?: string;
}

const REGISTER_ALL_CORE_COMMAND_FAMILIES: CoreCommandRegistrationSelection = {
  setup: true,
  listQuery: true,
  mutation: true,
  operation: true,
};

const RUNTIME_SCHEMA_FLAG_BOOTSTRAP_COMMANDS = new Set([
  "create",
  "update",
  "update-many",
  "list",
  "list-all",
  "list-draft",
  "list-open",
  "list-in-progress",
  "list-blocked",
  "list-closed",
  "list-canceled",
  "search",
  "calendar",
  "context",
  "templates",
]);

/** Recognize version requests before loading command families. */
function invocationRequestsVersion(invocationArgv: string[]): boolean {
  return invocationArgv.some((token) => VERSION_FLAG_TOKENS.has(token));
}

/** Load only the selected core registration family, retaining complete discovery for help and unknown paths. */
function resolveCoreCommandRegistrationSelection(invocationArgv: string[]): CoreCommandRegistrationSelection {
  if (invocationRequestsVersion(invocationArgv)) {
    return {
      setup: false,
      listQuery: false,
      mutation: false,
      operation: false,
    };
  }
  if (invocationArgv.length === 0 || parseBootstrapHelpRequest(invocationArgv).requested) {
    return REGISTER_ALL_CORE_COMMAND_FAMILIES;
  }
  const commandName = parseBootstrapCommandName(invocationArgv);
  if (!commandName) {
    return REGISTER_ALL_CORE_COMMAND_FAMILIES;
  }
  const normalizedCommand = commandName.trim().toLowerCase();
  const commandTokens = stripGlobalBootstrapTokens(invocationArgv);
  const semanticCommand = findPmNamespacedCommand(commandTokens)?.alias;
  if (PM_RELOCATED_COMMAND_ALIASES.some((alias) => alias.alias === semanticCommand)) {
    return { ...REGISTER_ALL_CORE_COMMAND_FAMILIES, targetCommandName: semanticCommand };
  }
  if (SETUP_COMMAND_NAMES.has(normalizedCommand)) {
    return {
      setup: true,
      listQuery: false,
      mutation: false,
      operation: false,
      targetCommandName: normalizedCommand,
    };
  }
  if (LIST_QUERY_COMMAND_NAMES.has(normalizedCommand)) {
    return {
      setup: false,
      listQuery: true,
      mutation: false,
      operation: false,
      targetCommandName: normalizedCommand,
    };
  }
  if (MUTATION_COMMAND_NAMES.has(normalizedCommand)) {
    return {
      setup: false,
      listQuery: false,
      mutation: true,
      operation: false,
      targetCommandName: normalizedCommand,
    };
  }
  if (OPERATION_COMMAND_NAMES.has(normalizedCommand)) {
    return {
      setup: false,
      listQuery: false,
      mutation: false,
      operation: true,
      targetCommandName: normalizedCommand,
    };
  }
  return REGISTER_ALL_CORE_COMMAND_FAMILIES;
}

/** Decide whether the invocation needs the expanded help text attached to registered commands. */
function shouldAttachRichHelpTextForInvocation(invocationArgv: string[]): boolean {
  return (
    invocationArgv.length === 0 ||
    parseBootstrapHelpRequest(invocationArgv).requested ||
    (invocationArgv.includes("--explain") &&
      parseBootstrapCommandName(invocationArgv) === undefined)
  );
}

/** Decide whether extension command paths must be registered for this invocation. */
function shouldRegisterDynamicExtensionPaths(_rootProgram: Command, invocationArgv: string[]): boolean {
  if (invocationRequestsVersion(invocationArgv)) {
    return false;
  }
  if (isFullHelpDiscovery(invocationArgv)) {
    return true;
  }
  const helpRequest = parseBootstrapHelpRequest(invocationArgv);
  if (helpRequest.requested) {
    return true;
  }
  const commandName = parseBootstrapCommandName(invocationArgv);
  if (!commandName) {
    return false;
  }
  return true;
}

/** Decide whether the invocation needs flags supplied by the runtime item schema. */
function shouldRegisterRuntimeSchemaFlags(invocationArgv: string[]): boolean {
  if (invocationRequestsVersion(invocationArgv)) {
    return false;
  }
  const commandName = parseBootstrapCommandName(invocationArgv);
  if (!commandName) {
    return false;
  }
  return RUNTIME_SCHEMA_FLAG_BOOTSTRAP_COMMANDS.has(commandName);
}

/**
 * Project a typo trace and its canonical target into disclosure-safe source,
 * target, and retry values before they are copied into error diagnostics.
 */
function redactSensitiveFlagTypo(params: { argv: string[]; normalizedDisplay: string; normalizedTokens: string[]; rawFrom: unknown }): {
  argv: string[];
  normalizedDisplay: string;
  sourceDisplay: string;
} {
  const rawTypoToken = String(params.rawFrom ?? "");
  const rawTypoEqualsIndex = rawTypoToken.indexOf("=");
  const rawTypoFlag = rawTypoEqualsIndex >= 0 ? rawTypoToken.slice(0, rawTypoEqualsIndex) : rawTypoToken;
  const sensitiveCanonicalFlag = params.normalizedTokens
    .map((token) => {
      const equalsIndex = token.indexOf("=");
      return equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
    })
    .find((token) => token === "--literal" || token === "--regex" || token === "--replacement");
  const typoNormalizedArgv = sensitiveCanonicalFlag
    ? params.argv.map((token) => {
        const equalsIndex = token.indexOf("=");
        const flag = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
        return flag === rawTypoFlag ? (equalsIndex >= 0 ? `${sensitiveCanonicalFlag}${token.slice(equalsIndex)}` : sensitiveCanonicalFlag) : token;
      })
    : params.argv;
  const safeArgv = redactSensitiveCommandArgs(typoNormalizedArgv);
  const safeTypoDisplay = sensitiveCanonicalFlag && rawTypoEqualsIndex >= 0 ? `${rawTypoFlag}=[redacted]` : rawTypoToken;
  const safeNormalizedDisplay = sensitiveCanonicalFlag && params.normalizedDisplay.includes("=") ? `${sensitiveCanonicalFlag}=[redacted]` : params.normalizedDisplay;
  return {
    argv: safeArgv,
    normalizedDisplay: safeNormalizedDisplay,
    sourceDisplay: safeTypoDisplay,
  };
}

/** Refuse unknown flags with correction guidance while requiring an explicit retry for mutations. */
function enforceExplicitRetryForFlagTypos(bootstrapInvocation: ReturnType<typeof normalizeBootstrapInvocation>): void {
  const commandName = bootstrapInvocation.commandName;
  if (!commandName) {
    return;
  }
  const typoEvent = bootstrapInvocation.trace.find((entry) => entry.reason === "flag_typo");
  if (!typoEvent) {
    return;
  }
  const normalizedTokens = Array.isArray(typoEvent.to) ? typoEvent.to : [String(typoEvent.to ?? "")].filter((entry) => entry.length > 0);
  const normalizedDisplay = normalizedTokens.length > 0 ? normalizedTokens.join(" ") : "the canonical flag";
  const mutatingCommand = MUTATION_COMMAND_NAMES.has(commandName) || MUTATING_OPERATION_COMMAND_NAMES.has(commandName);
  const code = mutatingCommand ? "mutating_flag_typo_requires_retry" : "flag_typo_requires_retry";
  const commandScope = mutatingCommand ? "mutating option" : "option";
  const safeTypo = redactSensitiveFlagTypo({
    argv: bootstrapInvocation.argv,
    normalizedDisplay,
    normalizedTokens,
    rawFrom: typoEvent.from,
  });
  throw new PmCliError(
    `Refusing to auto-correct ${commandScope} ${safeTypo.sourceDisplay} to ${safeTypo.normalizedDisplay}. Retry with the canonical flag so the command is explicit.`,
    EXIT_CODE.USAGE,
    {
      code,
      examples: [renderPmCommand(safeTypo.argv)],
      nextSteps: ["Retry the command with the canonical flag shown in examples."],
      recovery: {
        normalized_args: safeTypo.argv,
        suggested_retry: renderPmCommand(safeTypo.argv),
      },
    },
  );
}

export { CoreCommandRegistrationSelection,LIST_QUERY_COMMAND_NAMES,enforceExplicitRetryForFlagTypos,invocationRequestsVersion,resolveCoreCommandRegistrationSelection,shouldAttachRichHelpTextForInvocation,shouldRegisterDynamicExtensionPaths,shouldRegisterRuntimeSchemaFlags };
