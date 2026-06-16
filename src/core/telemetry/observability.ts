import { EXIT_CODE, type TelemetryErrorCategory } from "../shared/constants.js";

export type TelemetryResolutionStage = "parse" | "preflight" | "execute" | "unknown";

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

export interface TelemetryCommandTaxonomy {
  command_path: string;
  command_root: string;
  command_leaf: string;
  command_depth: number;
  command_family: "setup" | "query" | "mutation" | "testing" | "extension" | "diagnostics" | "other";
}

interface InferTelemetryErrorCodeParams {
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  exitCode?: number;
}

const SETUP_ROOT_COMMANDS = new Set(["init", "config", "completion", "completion-statuses", "completion-tags", "completion-types"]);
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
const TESTING_ROOT_COMMANDS = new Set(["test", "test-all", "test-runs", "test-verify", "trace-test", "test-ping"]);
const DIAGNOSTICS_ROOT_COMMANDS = new Set(["health", "validate", "normalize", "reindex", "gc", "telemetry", "extension-doctor"]);

function normalizeCommandPath(commandPath: string): string {
  return commandPath
    .trim()
    .replaceAll(/\s+/g, " ")
    .toLowerCase();
}

function normalizeErrorCode(errorCode: string | undefined): string | undefined {
  const normalized = errorCode?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function deriveTelemetryCommandTaxonomy(commandPath: string): TelemetryCommandTaxonomy {
  const normalizedPath = normalizeCommandPath(commandPath);
  // tokens always has at least one element (the fallback ["<unknown>"]), so the
  // first/last lookups are never undefined.
  const tokens = normalizedPath.length > 0 ? normalizedPath.split(" ") : ["<unknown>"];
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

export function inferTelemetryErrorCode(params: InferTelemetryErrorCodeParams): string | undefined {
  if (params.ok) {
    return undefined;
  }

  const explicit = normalizeErrorCode(params.errorCode);
  if (explicit) {
    return explicit;
  }

  const message = (params.errorMessage ?? "").trim().toLowerCase();
  if (message.includes("unknown command")) {
    return "unknown_command";
  }
  if (message.includes("unknown option")) {
    return "unknown_option";
  }
  if (message.includes("missing required options") || message.includes("missing required option")) {
    return "missing_required_option";
  }
  if (message.includes("missing required argument")) {
    return "missing_required_argument";
  }
  if (message.includes("no update flags provided")) {
    return "no_update_fields";
  }
  if (message.includes("is assigned to") && message.includes("use --force")) {
    return "ownership_conflict";
  }
  if (message.includes("is locked")) {
    return "lock_conflict";
  }
  if (message.includes("already terminal") && message.includes("use --force")) {
    return "terminal_state_conflict";
  }
  if (message.includes("tracker is not initialized")) {
    return "tracker_not_initialized";
  }
  if (message.includes(" not found")) {
    return "item_not_found";
  }
  if (
    message.includes("use \"pm close <id> <text>\" to close an item") ||
    (message.includes("invalid --status value") && message.includes("\"closed\""))
  ) {
    return "close_through_update";
  }
  if (message.startsWith("invalid ") || message.includes(" must be ") || message.includes(" requires ")) {
    return "invalid_argument_value";
  }
  // NOTE: A "strict create mode requires concrete values for --" message is always
  // classified as invalid_argument_value by the ` requires ` check above, so a
  // dedicated branch here would be unreachable and is intentionally omitted.
  if (message.includes("either as positional") && message.includes("not both")) {
    return "invalid_command_usage";
  }

  const exitCode = Number.isFinite(params.exitCode) ? Math.max(0, Math.trunc(params.exitCode as number)) : undefined;
  if (exitCode === EXIT_CODE.USAGE) {
    return "invalid_command_usage";
  }
  if (exitCode === EXIT_CODE.NOT_FOUND) {
    return "item_not_found";
  }
  if (exitCode === EXIT_CODE.CONFLICT) {
    return "lock_conflict";
  }
  if (exitCode === EXIT_CODE.DEPENDENCY_FAILED) {
    return "dependency_failed";
  }
  return "command_failed";
}

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
