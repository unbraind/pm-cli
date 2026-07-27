/**
 * Runtime contracts and behavior for packages/pm calendar/extensions/calendar/runtime.
 *
 * @module packages/pm-calendar/extensions/calendar/runtime
 */
import {
  renderCalendarMarkdown,
  renderCalendarToon,
  resolveCalendarOutputFormat,
  runCalendar,
  type CalendarOptions,
  type CalendarResult,
  type GlobalOptions,
} from "@unbrained/pm-cli/sdk/runtime";
import type { ServiceOverrideContext } from "@unbrained/pm-cli/sdk";

function isCalendarResult(value: unknown): value is CalendarResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { output_default?: unknown }).output_default === "markdown" &&
    Array.isArray((value as { events?: unknown }).events) &&
    Array.isArray((value as { days?: unknown }).days)
  );
}

function readObjectPayload(payload: unknown): Record<string, unknown> | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }
  return payload as Record<string, unknown>;
}

function readPayloadFormat(payload: unknown): "toon" | "json" {
  const record = readObjectPayload(payload);
  if (record?.format === "json") {
    return "json";
  }
  return "toon";
}

function readPayloadResult(payload: unknown): unknown {
  const record = readObjectPayload(payload);
  if (!record || !Object.hasOwn(record, "result")) {
    return payload;
  }
  return record.result;
}

function readPayloadCommandOptions(payload: unknown): CalendarOptions {
  const commandOptions = readObjectPayload(payload)?.command_options;
  if (
    typeof commandOptions === "object" &&
    commandOptions !== null &&
    !Array.isArray(commandOptions)
  ) {
    return commandOptions as CalendarOptions;
  }
  return {};
}

function readPayloadGlobalOptions(payload: unknown): GlobalOptions {
  const global = readObjectPayload(payload)?.global;
  if (typeof global === "object" && global !== null && !Array.isArray(global)) {
    return global as GlobalOptions;
  }
  return {};
}

/** Executes the calendar package operation through the package runtime. */
export async function runCalendarPackage(
  options: CalendarOptions,
  global: GlobalOptions,
): Promise<CalendarResult> {
  resolveCalendarOutputFormat(options, global);
  return runCalendar(options, global);
}

/** Formats calendar package output data for the selected output mode. */
export function renderCalendarPackageOutput(
  context: ServiceOverrideContext,
): string | null {
  const result = readPayloadResult(context.payload);
  if (!isCalendarResult(result)) {
    return null;
  }
  const options =
    context.options && Object.keys(context.options).length > 0
      ? (context.options as CalendarOptions)
      : readPayloadCommandOptions(context.payload);
  const global = context.global ?? readPayloadGlobalOptions(context.payload);
  const outputFormat = resolveCalendarOutputFormat(
    options,
    global,
  );
  if (outputFormat === "markdown") {
    return `${renderCalendarMarkdown(result)}\n`;
  }
  if (
    outputFormat === "json" ||
    readPayloadFormat(context.payload) === "json"
  ) {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (outputFormat === "toon") {
    const rendered = renderCalendarToon(result);
    return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
  }
  return null;
}

/** Test-only seam exposing the internal payload readers. Their non-object guard arms are defensively present but unreachable through `renderCalendarPackageOutput` (the only caller validates payload via `isCalendarResult` first), so this seam lets the suite drive those branches directly without weakening the runtime guards. */
export const _testOnly = {
  readPayloadFormat,
  readPayloadResult,
  readPayloadCommandOptions,
  readPayloadGlobalOptions,
};
