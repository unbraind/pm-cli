/**
 * @module core/output/output
 *
 * Formats compact human and machine output for Output.
 */
import {
  getActiveCommandContext,
  runActiveCommandOverride,
  runActiveRendererOverride,
  runActiveServiceOverrideSync,
  setActiveCommandResult,
} from "../extensions/index.js";
import { EXIT_CODE } from "../shared/constants.js";
import { isHostOutputSuppressed } from "./output-control.js";
import { projectMutationResult } from "./mutation-projection.js";
import { attachReadOutputContracts } from "../../sdk/context-intent-contracts.js";
import { attachOutputTokenAccounting } from "../../sdk/output-token-accounting.js";
import { resolveReadOutputEncoding } from "../../sdk/read-output-contracts.js";

/** Documents the output options payload exchanged by command, SDK, and package integrations. */
export interface OutputOptions {
  /** Value that configures or reports json for this contract. */
  json?: boolean;
  /** Value that configures or reports quiet for this contract. */
  quiet?: boolean;
  /** When true, mutation results drop the verbose changed_fields array (keeps changed_field_count). */
  noChangedFields?: boolean;
  /** When true, preserve the legacy full mutation envelope and changed-fields array. */
  fullChangedFields?: boolean;
  /** When true, single-item mutation results print only id and status. */
  idOnly?: boolean;
  /** When true, JSON output omits null, undefined, and empty containers recursively. */
  lean?: boolean;
  /** Attach a bounded receipt for the emitted output before the receipt itself. */
  tokenAccounting?: boolean;
  /** Canonical comma-separated fields or sections retained in read output. */
  outputInclude?: string;
  /** Canonical maximum row count retained in read output. */
  outputLimit?: string;
  /** Canonical estimated-token ceiling for read output. */
  outputBudget?: string;
  /** Canonical renderer encoding for read output. */
  outputFormat?: "toon" | "json";
  /** Fallback output format used when callers do not provide an override. */
  defaultOutputFormat?: "toon" | "json";
  /** Value that configures or reports command for this contract. */
  command?: string;
  /** Value that configures or reports command args for this contract. */
  commandArgs?: string[];
  /** Inputs that customize the command operation. */
  commandOptions?: Record<string, unknown>;
  /** Value that configures or reports pm root for this contract. */
  pmRoot?: string;
}

interface NodeLikeError {
  code?: string;
}

const NATIVE_OUTPUT_MARKER = "__pm_native_output";

let streamErrorHandlersInstalled = false;
type OutputStreamTarget = "stdout" | "stderr";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shouldUseNativeOutput(result: unknown): boolean {
  return isPlainObject(result) && result[NATIVE_OUTPUT_MARKER] === true;
}

function stripNativeOutputMarker<T>(result: T): T {
  if (!isPlainObject(result) || result[NATIVE_OUTPUT_MARKER] !== true) {
    return result;
  }
  const { [NATIVE_OUTPUT_MARKER]: _marker, ...rest } = result;
  return rest as T;
}

function isBrokenPipeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeLikeError).code === "EPIPE"
  );
}

function markStdoutBrokenPipeExitCode(): void {
  if (
    process.exitCode === undefined ||
    process.exitCode === EXIT_CODE.SUCCESS
  ) {
    process.exitCode = EXIT_CODE.SUCCESS;
  }
}

function markStderrBrokenPipeExitCode(): void {
  if (
    process.exitCode === undefined ||
    process.exitCode === EXIT_CODE.SUCCESS
  ) {
    process.exitCode = EXIT_CODE.GENERIC_FAILURE;
  }
}

function markBrokenPipeExitCode(target: OutputStreamTarget): void {
  if (target === "stdout") {
    markStdoutBrokenPipeExitCode();
    return;
  }
  markStderrBrokenPipeExitCode();
}

function handleUnhandledStreamError(error: unknown): void {
  const unhandled = error instanceof Error ? error : new Error(String(error));
  setImmediate(() => {
    throw unhandled;
  });
}

function installStreamErrorHandlers(): void {
  if (streamErrorHandlersInstalled) {
    return;
  }
  streamErrorHandlersInstalled = true;
  process.stdout.on("error", (error: unknown) => {
    if (isBrokenPipeError(error)) {
      markBrokenPipeExitCode("stdout");
      return;
    }
    handleUnhandledStreamError(error);
  });
  process.stderr.on("error", (error: unknown) => {
    if (isBrokenPipeError(error)) {
      markBrokenPipeExitCode("stderr");
      return;
    }
    handleUnhandledStreamError(error);
  });
}

function writeToStream(target: OutputStreamTarget, text: string): boolean {
  installStreamErrorHandlers();
  try {
    if (target === "stdout") {
      process.stdout.write(text);
    } else {
      process.stderr.write(text);
    }
    return true;
  } catch (error: unknown) {
    if (isBrokenPipeError(error)) {
      markBrokenPipeExitCode(target);
      return false;
    }
    throw error;
  }
}

/** Implements write stdout for the public runtime surface of this module. */
export function writeStdout(text: string): boolean {
  return writeToStream("stdout", text);
}

/** Implements write stderr for the public runtime surface of this module. */
export function writeStderr(text: string): boolean {
  return writeToStream("stderr", text);
}

function renderScalar(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value === null) return "null";
  return JSON.stringify(value);
}

function compactToonValue(value: unknown): unknown | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const compactedEntries = value
      .map((entry) => compactToonValue(entry))
      .filter((entry): entry is unknown => entry !== undefined);
    return compactedEntries.length > 0 ? compactedEntries : undefined;
  }

  if (isPlainObject(value)) {
    const compacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (
        key === "omitted_field_groups" &&
        Array.isArray(entry) &&
        entry.length === 0
      ) {
        compacted[key] = [];
        continue;
      }
      const compactedEntry = compactToonValue(entry);
      if (compactedEntry !== undefined) {
        compacted[key] = compactedEntry;
      }
    }
    return Object.keys(compacted).length > 0 ? compacted : undefined;
  }

  return value;
}

function renderToonValue(value: unknown, depth: number): string {
  const indent = "  ".repeat(depth);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((entry) => {
        if (!isPlainObject(entry) && !Array.isArray(entry)) {
          return `${indent}- ${renderScalar(entry)}`;
        }
        const rendered = renderToonValue(entry, depth + 1);
        const lines = rendered.split("\n");
        const [firstLine, ...rest] = lines;
        if (rest.length === 0) {
          return `${indent}- ${firstLine.trimStart()}`;
        }
        return `${indent}- ${firstLine.trimStart()}\n${rest.join("\n")}`;
      })
      .join("\n");
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    return entries
      .map(([key, entry]) => {
        if (!isPlainObject(entry) && !Array.isArray(entry)) {
          return `${indent}${key}: ${renderScalar(entry)}`;
        }
        if (Array.isArray(entry) && entry.length === 0) {
          return `${indent}${key}: []`;
        }
        if (isPlainObject(entry) && Object.keys(entry).length === 0) {
          return `${indent}${key}: {}`;
        }
        return `${indent}${key}:\n${renderToonValue(entry, depth + 1)}`;
      })
      .join("\n");
  }

  return `${indent}${renderScalar(value)}`;
}

function renderDefaultMarkdownResult(value: unknown): string | null {
  if (!isPlainObject(value) || value.output_default !== "markdown") {
    return null;
  }
  if (
    typeof value.view !== "string" ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.days)
  ) {
    return null;
  }
  const lines = [`# pm calendar (${value.view})`, ""];
  const summary = isPlainObject(value.summary) ? value.summary : {};
  lines.push(`- events: ${String(summary.events ?? 0)}`);
  lines.push("");
  if (value.events.length === 0) {
    lines.push("No calendar events matched the selected filters.");
    return `${lines.join("\n")}\n`;
  }
  for (const event of value.events) {
    if (!isPlainObject(event)) {
      continue;
    }
    const kind = typeof event.kind === "string" ? event.kind : "event";
    const title = typeof event.item_title === "string" ? event.item_title : "";
    const itemId = typeof event.item_id === "string" ? event.item_id : "";
    const reminderText =
      typeof event.reminder_text === "string" && event.reminder_text.length > 0
        ? ` ${event.reminder_text}`
        : "";
    lines.push(`- [${kind}] ${itemId} ${title}${reminderText}`.trim());
  }
  return `${lines.join("\n")}\n`;
}

function resolveOutputFormat(options: OutputOptions): "json" | "toon" {
  return options.json === true ||
    (options.json === undefined && options.defaultOutputFormat === "json")
    ? "json"
    : "toon";
}

const LEAN_READ_ENVELOPE_ECHO_KEYS = new Set([
  "filters",
  "now",
  "projection",
  "sorting",
]);

function projectLeanJsonValue(value: unknown): unknown {
  const compacted = compactToonValue(value);
  if (!isPlainObject(compacted) || !Array.isArray(compacted.items)) {
    return compacted ?? null;
  }
  const projected = Object.fromEntries(
    Object.entries(compacted).filter(
      ([key]) => !LEAN_READ_ENVELOPE_ECHO_KEYS.has(key),
    ),
  );
  if (projected.has_more !== true) {
    delete projected.next_cursor;
  }
  return projected;
}

/**
 * Hoist an invocation-wide linked-test sandbox context out of repeated result
 * rows. Lean output also removes successful-process streams while retaining
 * failure diagnostics, so agents pay once for context and only for actionable
 * evidence.
 */
function projectLinkedTestEvidence(value: unknown, lean: boolean): unknown {
  if (!isPlainObject(value) || !Array.isArray(value.run_results)) {
    return value;
  }
  if (!value.run_results.every(isPlainObject)) {
    return value;
  }
  const rows = value.run_results;
  const contexts = rows
    .map((row) => row.execution_context)
    .filter((context) => context !== undefined);
  const sharedContext =
    contexts.length === rows.length &&
    contexts.length > 0 &&
    contexts.every(
      (context) => JSON.stringify(context) === JSON.stringify(contexts[0]),
    )
      ? contexts[0]
      : undefined;
  const runResults = rows.map((row) => {
    const {
      execution_context: _executionContext,
      stdout,
      stderr,
      ...rest
    } = row;
    if (sharedContext === undefined) {
      return row;
    }
    if (!lean || row.status !== "passed") {
      return { ...rest, stdout, stderr };
    }
    return rest;
  });
  return {
    ...value,
    ...(sharedContext === undefined
      ? {}
      : { execution_context: sharedContext }),
    run_results: runResults,
  };
}

/**
 * Render a result with pm's built-in JSON or TOON formatter without invoking
 * extension overrides. SDK budget accounting uses this exact representation
 * so reported token cost describes the bytes the host emits by default.
 */
export function formatBuiltInOutput(
  result: unknown,
  format: "json" | "toon",
): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  const compactedToon = compactToonValue(result);
  return compactedToon === undefined
    ? "{}\n"
    : `${renderToonValue(compactedToon, 0)}\n`;
}

interface OutputServiceResolution {
  result: unknown;
  rendered: string | null;
}

/** Resolve extension service ownership before built-in projection and rendering. */
function resolveOutputService(
  effectiveResult: unknown,
  nativeOutput: boolean,
  options: OutputOptions,
  format: "json" | "toon",
): OutputServiceResolution {
  const serviceOverride = nativeOutput
    ? { handled: false, result: effectiveResult, warnings: [] }
    : runActiveServiceOverrideSync("output_format", {
        command: options.command,
        args: options.commandArgs,
        command_options: options.commandOptions,
        global: { ...options },
        pm_root: options.pmRoot,
        format,
        options: { ...options },
        result: effectiveResult,
      });
  const legacyPayloadEchoWarning = serviceOverride.warnings.find((warning) =>
    warning.startsWith("extension_output_format_payload_echo_deprecated:"),
  );
  if (legacyPayloadEchoWarning !== undefined) {
    writeStderr(
      `Warning: ${legacyPayloadEchoWarning}. Returning context.payload now declines safely for compatibility; migrate the override to declineServiceOverride() or { handled: false }.\n`,
    );
  }
  if (serviceOverride.handled && typeof serviceOverride.result === "string") {
    return {
      result: serviceOverride.result,
      rendered: serviceOverride.result.endsWith("\n")
        ? serviceOverride.result
        : `${serviceOverride.result}\n`,
    };
  }
  return {
    result: serviceOverride.handled ? serviceOverride.result : effectiveResult,
    rendered: null,
  };
}

/** Formats a command result after command-level output ownership is resolved. */
function formatEffectiveOutput(
  effectiveResult: unknown,
  nativeOutput: boolean,
  options: OutputOptions,
): string {
  const activeCommandContext = getActiveCommandContext();
  const command = options.command ?? activeCommandContext?.command;
  const commandOptions = {
    ...activeCommandContext?.options,
    ...options.commandOptions,
    ...Object.fromEntries(
      [
        ["outputInclude", options.outputInclude],
        ["outputLimit", options.outputLimit],
        ["outputBudget", options.outputBudget],
        ["outputFormat", options.outputFormat],
      ].filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  };
  const format =
    resolveReadOutputEncoding(command ?? "", commandOptions) ??
    resolveOutputFormat(options);
  const service = resolveOutputService(
    effectiveResult,
    nativeOutput,
    options,
    format,
  );
  if (service.rendered !== null) return service.rendered;
  const outputResult = service.result;
  const projectedOutputResult =
    options.command === "test"
      ? projectLinkedTestEvidence(outputResult, options.lean === true)
      : outputResult;
  const intentOutputResult = attachReadOutputContracts(
    command,
    commandOptions,
    projectedOutputResult,
  );
  const renderResolvedOutput = (value: unknown): string => {
    if (format === "toon") {
      const markdownDefault = renderDefaultMarkdownResult(value);
      if (markdownDefault !== null) return markdownDefault;
    }
    const rendererOverride = nativeOutput
      ? { rendered: null }
      : runActiveRendererOverride(format, value);
    if (rendererOverride.rendered !== null) {
      return rendererOverride.rendered.endsWith("\n")
        ? rendererOverride.rendered
        : `${rendererOverride.rendered}\n`;
    }
    if (format === "json") {
      return formatBuiltInOutput(
        options.lean === true ? projectLeanJsonValue(value) : value,
        "json",
      );
    }
    return formatBuiltInOutput(value, "toon");
  };
  const accountedOutputResult =
    options.tokenAccounting === true
      ? attachOutputTokenAccounting(intentOutputResult, renderResolvedOutput)
      : intentOutputResult;
  return renderResolvedOutput(accountedOutputResult);
}

/** Implements format output for the public runtime surface of this module. */
export function formatOutput(result: unknown, options: OutputOptions): string {
  const commandOverride = runActiveCommandOverride(result);
  const suppressedOutput = isHostOutputSuppressed(commandOverride.result)
    ? commandOverride.result
    : null;
  const nativeOutput = shouldUseNativeOutput(commandOverride.result);
  const effectiveResult = suppressedOutput
    ? suppressedOutput.result
    : stripNativeOutputMarker(commandOverride.result);
  setActiveCommandResult(effectiveResult);
  return suppressedOutput
    ? ""
    : formatEffectiveOutput(effectiveResult, nativeOutput, options);
}

/** Implements print result for the public runtime surface of this module. */
export function printResult(result: unknown, options: OutputOptions): void {
  const projected = options.idOnly
    ? projectMutationResult(result, { idOnly: true })
    : options.fullChangedFields
      ? result
      : options.noChangedFields
        ? projectMutationResult(result, { changedFields: "compact" })
        : projectMutationResult(result, { compactEnvelope: true });
  const rendered = formatOutput(projected, options);
  if (options.quiet) {
    return;
  }
  writeStdout(rendered);
}

/** Implements print error for the public runtime surface of this module. */
export function printError(message: string): void {
  const override = runActiveServiceOverrideSync("error_format", {
    message,
  });
  const rendered =
    override.handled && typeof override.result === "string"
      ? override.result
      : message;
  writeStderr(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
}

/** Public contract for output test only, shared by SDK and presentation-layer consumers. */
export const outputTestOnly = {
  compactToonValue,
  renderToonValue,
};
