/**
 * @module core/telemetry/observability
 *
 * Captures consent-aware telemetry and observability events for Observability.
 */
import { EXIT_CODE, type TelemetryErrorCategory } from "../shared/constants.js";

/** Restricts telemetry resolution stage values accepted by command, SDK, and storage contracts. */
export type TelemetryResolutionStage =
  | "parse"
  | "preflight"
  | "execute"
  | "unknown";

/** Restricts telemetry command resolution values accepted by command, SDK, and storage contracts. */
export type TelemetryCommandResolution =
  | "success"
  | "nonexistent_command"
  | "invalid_option"
  | "missing_required_option"
  | "missing_required_argument"
  | "invalid_usage"
  | "validation_failed"
  | "health_findings"
  | "validation_findings"
  | "conflict"
  | "runtime_failed"
  | "unknown_failed";

/** Documents the telemetry command taxonomy payload exchanged by command, SDK, and package integrations. */
export interface TelemetryCommandTaxonomy {
  /** Filesystem path used for command resolution. */
  command_path: string;
  /** Value that configures or reports command root for this contract. */
  command_root: string;
  /** Value that configures or reports command leaf for this contract. */
  command_leaf: string;
  /** Value that configures or reports command depth for this contract. */
  command_depth: number;
  /** Value that configures or reports command family for this contract. */
  command_family:
    | "setup"
    | "query"
    | "mutation"
    | "testing"
    | "extension"
    | "diagnostics"
    | "other";
}

interface InferTelemetryErrorCodeParams {
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  exitCode?: number;
}

interface TelemetryErrorMessageClassifier {
  code: string;
  matches: (message: string) => boolean;
}

const SETUP_ROOT_COMMANDS = new Set([
  "init",
  "config",
  "completion",
  "completion-statuses",
  "completion-tags",
  "completion-types",
]);
const QUERY_ROOT_COMMANDS = new Set([
  "list",
  "list-all",
  "list-open",
  "list-in-progress",
  "list-blocked",
  "list-closed",
  "list-canceled",
  "list-draft",
  "search",
  "get",
  "context",
  "calendar",
  "history",
  "activity",
  "aggregate",
  "deps",
  "contracts",
  "stats",
  "dedupe-audit",
]);
const MUTATION_ROOT_COMMANDS = new Set([
  "create",
  "update",
  "update-many",
  "close-many",
  "append",
  "close",
  "delete",
  "restore",
  "claim",
  "release",
  "comments",
  "notes",
  "learnings",
  "files",
  "docs",
  "start-task",
  "pause-task",
  "close-task",
]);
const TESTING_ROOT_COMMANDS = new Set([
  "test",
  "test-all",
  "test-runs",
  "test-verify",
  "trace-test",
  "test-ping",
]);
const DIAGNOSTICS_ROOT_COMMANDS = new Set([
  "health",
  "validate",
  "normalize",
  "reindex",
  "gc",
  "telemetry",
  "extension-doctor",
]);

function normalizeCommandPath(commandPath: string): string {
  return commandPath.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

function normalizeErrorCode(errorCode: string | undefined): string | undefined {
  const normalized = errorCode?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

const TELEMETRY_ERROR_MESSAGE_CLASSIFIERS: readonly TelemetryErrorMessageClassifier[] =
  [
    {
      code: "unknown_command",
      matches: (message) => message.includes("unknown command"),
    },
    {
      code: "unknown_option",
      matches: (message) => message.includes("unknown option"),
    },
    {
      code: "missing_required_option",
      matches: (message) =>
        message.includes("missing required options") ||
        message.includes("missing required option"),
    },
    {
      code: "missing_required_argument",
      matches: (message) => message.includes("missing required argument"),
    },
    {
      code: "no_update_fields",
      matches: (message) => message.includes("no update flags provided"),
    },
    {
      code: "ownership_conflict",
      matches: (message) =>
        message.includes("is assigned to") && message.includes("use --force"),
    },
    {
      code: "lock_conflict",
      matches: (message) => message.includes("is locked"),
    },
    {
      code: "terminal_state_conflict",
      matches: (message) =>
        message.includes("already terminal") && message.includes("use --force"),
    },
    {
      code: "tracker_not_initialized",
      matches: (message) => message.includes("tracker is not initialized"),
    },
    {
      code: "item_not_found",
      matches: (message) => message.includes(" not found"),
    },
    {
      code: "close_through_update",
      matches: (message) =>
        message.includes('use "pm close <id> <text>" to close an item') ||
        (message.includes("invalid --status value") &&
          message.includes('"closed"')),
    },
    {
      code: "invalid_argument_value",
      matches: (message) =>
        message.startsWith("invalid ") ||
        message.includes(" must be ") ||
        message.includes(" requires "),
    },
    {
      code: "invalid_command_usage",
      matches: (message) =>
        message.includes("either as positional") &&
        message.includes("not both"),
    },
  ];

const TELEMETRY_EXIT_CODE_FALLBACKS: ReadonlyMap<number, string> = new Map([
  [EXIT_CODE.USAGE, "invalid_command_usage"],
  [EXIT_CODE.NOT_FOUND, "item_not_found"],
  [EXIT_CODE.CONFLICT, "lock_conflict"],
  [EXIT_CODE.DEPENDENCY_FAILED, "dependency_failed"],
]);

/** Implements derive telemetry command taxonomy for the public runtime surface of this module. */
export function deriveTelemetryCommandTaxonomy(
  commandPath: string,
): TelemetryCommandTaxonomy {
  const normalizedPath = normalizeCommandPath(commandPath);
  // tokens always has at least one element (the fallback ["<unknown>"]), so the
  // first/last lookups are never undefined.
  const tokens =
    normalizedPath.length > 0 ? normalizedPath.split(" ") : ["<unknown>"];
  const root = tokens[0] as string;
  const leaf = tokens[tokens.length - 1] as string;

  let family: TelemetryCommandTaxonomy["command_family"] = "other";
  if (SETUP_ROOT_COMMANDS.has(root)) {
    family = "setup";
  } else if (QUERY_ROOT_COMMANDS.has(root)) {
    family = "query";
  } else if (MUTATION_ROOT_COMMANDS.has(root)) {
    family = "mutation";
  } else if (TESTING_ROOT_COMMANDS.has(root)) {
    family = "testing";
  } else if (root === "extension") {
    family = "extension";
  } else if (DIAGNOSTICS_ROOT_COMMANDS.has(root)) {
    family = "diagnostics";
  }

  return {
    command_path: normalizedPath.length > 0 ? normalizedPath : "<unknown>",
    command_root: root,
    command_leaf: leaf,
    command_depth: tokens.length,
    command_family: family,
  };
}

/** Implements infer telemetry error code for the public runtime surface of this module. */
export function inferTelemetryErrorCode(
  params: InferTelemetryErrorCodeParams,
): string | undefined {
  if (params.ok) {
    return undefined;
  }

  const explicit = normalizeErrorCode(params.errorCode);
  if (explicit) {
    return explicit;
  }

  const message = (params.errorMessage ?? "").trim().toLowerCase();
  // NOTE: A "strict create mode requires concrete values for --" message is always
  // classified as invalid_argument_value by the ordered ` requires ` classifier,
  // so a dedicated branch would be unreachable and is intentionally omitted.
  for (const classifier of TELEMETRY_ERROR_MESSAGE_CLASSIFIERS) {
    if (classifier.matches(message)) {
      return classifier.code;
    }
  }

  const exitCode = Number.isFinite(params.exitCode)
    ? Math.max(0, Math.trunc(params.exitCode as number))
    : undefined;
  if (exitCode !== undefined) {
    return TELEMETRY_EXIT_CODE_FALLBACKS.get(exitCode) ?? "command_failed";
  }
  return "command_failed";
}

/** Implements derive telemetry command resolution for the public runtime surface of this module. */
export function deriveTelemetryCommandResolution(params: {
  ok: boolean;
  errorCode?: string;
  errorCategory?: TelemetryErrorCategory;
}): TelemetryCommandResolution {
  if (params.ok) {
    return "success";
  }

  const normalizedCode = normalizeErrorCode(params.errorCode);
  if (normalizedCode === "unknown_command") {
    return "nonexistent_command";
  }
  if (normalizedCode === "unknown_option") {
    return "invalid_option";
  }
  if (normalizedCode === "missing_required_option") {
    return "missing_required_option";
  }
  if (normalizedCode === "missing_required_argument") {
    return "missing_required_argument";
  }
  if (normalizedCode === "health_findings") {
    return "health_findings";
  }
  if (normalizedCode === "validation_findings") {
    return "validation_findings";
  }

  if (params.errorCategory === "usage") {
    return "invalid_usage";
  }
  if (params.errorCategory === "validation") {
    return "validation_failed";
  }
  if (params.errorCategory === "conflict") {
    return "conflict";
  }
  if (params.errorCategory === "runtime") {
    return "runtime_failed";
  }
  return "unknown_failed";
}
