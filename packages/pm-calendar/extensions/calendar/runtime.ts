import {
  renderCalendarMarkdown,
  resolveCalendarOutputFormat,
  runCalendar,
  type CalendarOptions,
  type CalendarResult,
  type GlobalOptions,
  type ServiceOverrideContext,
} from "../../../../src/sdk/index.js";

function isCalendarResult(value: unknown): value is CalendarResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { output_default?: unknown }).output_default === "markdown" &&
    Array.isArray((value as { events?: unknown }).events) &&
    Array.isArray((value as { days?: unknown }).days)
  );
}

function isCalendarCommand(command: unknown): boolean {
  return command === "calendar" || command === "cal";
}

function readPayloadFormat(payload: unknown): "toon" | "json" {
  if (typeof payload === "object" && payload !== null) {
    const format = (payload as { format?: unknown }).format;
    if (format === "json") {
      return "json";
    }
  }
  return "toon";
}

function readPayloadResult(payload: unknown): unknown {
  if (typeof payload === "object" && payload !== null && "result" in payload) {
    return (payload as { result?: unknown }).result;
  }
  return payload;
}

export async function runCalendarPackage(options: CalendarOptions, global: GlobalOptions): Promise<CalendarResult> {
  return runCalendar(options, global);
}

export function renderCalendarPackageOutput(context: ServiceOverrideContext): string | null {
  const result = readPayloadResult(context.payload);
  if (!isCalendarCommand(context.command) || !isCalendarResult(result)) {
    return null;
  }
  const options = (context.options ?? {}) as CalendarOptions;
  const global = (context.global ?? {}) as GlobalOptions;
  const outputFormat = resolveCalendarOutputFormat(options, global);
  if (outputFormat === "markdown") {
    return `${renderCalendarMarkdown(result)}\n`;
  }
  if (outputFormat === "json" || readPayloadFormat(context.payload) === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return null;
}
