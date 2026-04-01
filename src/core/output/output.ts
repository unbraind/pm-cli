import {
  runActiveCommandOverride,
  runActiveRendererOverride,
  runActiveServiceOverrideSync,
  setActiveCommandResult,
} from "../extensions/index.js";

export interface OutputOptions {
  json?: boolean;
  quiet?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
        const nested = rest.map((line) => `${indent}  ${line}`).join("\n");
        return `${indent}- ${firstLine.trimStart()}\n${nested}`;
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

export function formatOutput(result: unknown, options: OutputOptions): string {
  const commandOverride = runActiveCommandOverride(result);
  const effectiveResult = commandOverride.result;
  setActiveCommandResult(effectiveResult);
  const format = options.json ? "json" : "toon";
  const serviceOverride = runActiveServiceOverrideSync("output_format", {
    format,
    options: { ...options },
    result: effectiveResult,
  });
  if (serviceOverride.handled && typeof serviceOverride.result === "string") {
    return serviceOverride.result.endsWith("\n") ? serviceOverride.result : `${serviceOverride.result}\n`;
  }
  const rendererOverride = runActiveRendererOverride(format, effectiveResult);
  if (rendererOverride.rendered !== null) {
    return rendererOverride.rendered.endsWith("\n") ? rendererOverride.rendered : `${rendererOverride.rendered}\n`;
  }
  if (options.json) {
    return `${JSON.stringify(effectiveResult, null, 2)}\n`;
  }
  const compactedToon = compactToonValue(effectiveResult);
  if (compactedToon === undefined) {
    return "{}\n";
  }
  return `${renderToonValue(compactedToon, 0)}\n`;
}

export function printResult(result: unknown, options: OutputOptions): void {
  const rendered = formatOutput(result, options);
  if (options.quiet) {
    return;
  }
  process.stdout.write(rendered);
}

export function printError(message: string): void {
  const override = runActiveServiceOverrideSync("error_format", {
    message,
  });
  const rendered = override.handled && typeof override.result === "string" ? override.result : message;
  process.stderr.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
}
