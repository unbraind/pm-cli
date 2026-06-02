import {
  runActiveCommandOverride,
  runActiveRendererOverride,
  runActiveServiceOverrideSync,
  setActiveCommandResult,
} from "../extensions/index.js";
import { EXIT_CODE } from "../shared/constants.js";
import { projectMutationResult } from "./mutation-projection.js";

export interface OutputOptions {
  json?: boolean;
  quiet?: boolean;
  /** When true, mutation results drop the verbose changed_fields array (keeps changed_field_count). */
  noChangedFields?: boolean;
  defaultOutputFormat?: "toon" | "json";
  command?: string;
  commandArgs?: string[];
  commandOptions?: Record<string, unknown>;
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
  return typeof error === "object" && error !== null && (error as NodeLikeError).code === "EPIPE";
}

function markStdoutBrokenPipeExitCode(): void {
  if (process.exitCode === undefined || process.exitCode === EXIT_CODE.SUCCESS) {
    process.exitCode = EXIT_CODE.SUCCESS;
  }
}

function markStderrBrokenPipeExitCode(): void {
  if (process.exitCode === undefined || process.exitCode === EXIT_CODE.SUCCESS) {
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

export function writeStdout(text: string): boolean {
  return writeToStream("stdout", text);
}

export function writeStderr(text: string): boolean {
  return writeToStream("stderr", text);
}

function renderScalar(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
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
  if (typeof value.view !== "string" || !Array.isArray(value.events) || !Array.isArray(value.days)) {
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
    const reminderText = typeof event.reminder_text === "string" && event.reminder_text.length > 0 ? ` ${event.reminder_text}` : "";
    lines.push(`- [${kind}] ${itemId} ${title}${reminderText}`.trim());
  }
  return `${lines.join("\n")}\n`;
}

export function formatOutput(result: unknown, options: OutputOptions): string {
  const commandOverride = runActiveCommandOverride(result);
  const nativeOutput = shouldUseNativeOutput(commandOverride.result);
  const effectiveResult = stripNativeOutputMarker(commandOverride.result);
  setActiveCommandResult(effectiveResult);
  const format =
    options.json === true
      ? "json"
      : options.json === false
        ? "toon"
        : options.defaultOutputFormat === "json"
        ? "json"
        : "toon";
  const serviceOverride = nativeOutput ? { handled: false, result: effectiveResult } : runActiveServiceOverrideSync("output_format", {
    command: options.command,
    args: options.commandArgs,
    command_options: options.commandOptions,
    global: { ...options },
    pm_root: options.pmRoot,
    format,
    options: { ...options },
    result: effectiveResult,
  });
  if (serviceOverride.handled && typeof serviceOverride.result === "string") {
    return serviceOverride.result.endsWith("\n") ? serviceOverride.result : `${serviceOverride.result}\n`;
  }
  const outputResult = serviceOverride.handled ? serviceOverride.result : effectiveResult;
  if (format === "toon") {
    const markdownDefault = renderDefaultMarkdownResult(outputResult);
    if (markdownDefault !== null) {
      return markdownDefault;
    }
  }
  const rendererOverride = nativeOutput ? { rendered: null } : runActiveRendererOverride(format, outputResult);
  if (rendererOverride.rendered !== null) {
    return rendererOverride.rendered.endsWith("\n") ? rendererOverride.rendered : `${rendererOverride.rendered}\n`;
  }
  if (format === "json") {
    return `${JSON.stringify(outputResult, null, 2)}\n`;
  }
  const compactedToon = compactToonValue(outputResult);
  if (compactedToon === undefined) {
    return "{}\n";
  }
  return `${renderToonValue(compactedToon, 0)}\n`;
}

export function printResult(result: unknown, options: OutputOptions): void {
  const projected = options.noChangedFields ? projectMutationResult(result, { changedFields: "compact" }) : result;
  const rendered = formatOutput(projected, options);
  if (options.quiet) {
    return;
  }
  writeStdout(rendered);
}

export function printError(message: string): void {
  const override = runActiveServiceOverrideSync("error_format", {
    message,
  });
  const rendered = override.handled && typeof override.result === "string" ? override.result : message;
  writeStderr(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
}
