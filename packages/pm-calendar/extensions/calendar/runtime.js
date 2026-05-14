import {
  renderCalendarMarkdown,
  resolveCalendarOutputFormat,
  runCalendar,
} from "../../../../dist/sdk/index.js";

function isCalendarResult(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    value.output_default === "markdown" &&
    Array.isArray(value.events) &&
    Array.isArray(value.days)
  );
}

function isCalendarCommand(command) {
  return command === "calendar" || command === "cal";
}

function readPayloadFormat(payload) {
  if (typeof payload === "object" && payload !== null) {
    const format = payload.format;
    if (format === "json") {
      return "json";
    }
  }
  return "toon";
}

function readPayloadResult(payload) {
  if (typeof payload === "object" && payload !== null && "result" in payload) {
    return payload.result;
  }
  return payload;
}

export async function runCalendarPackage(options, global) {
  return runCalendar(options, global);
}

export function renderCalendarPackageOutput(context) {
  const result = readPayloadResult(context.payload);
  if (!isCalendarCommand(context.command) || !isCalendarResult(result)) {
    return null;
  }
  const options = context.options ?? {};
  const global = context.global ?? {};
  const outputFormat = resolveCalendarOutputFormat(options, global);
  if (outputFormat === "markdown") {
    return `${renderCalendarMarkdown(result)}\n`;
  }
  if (outputFormat === "json" || readPayloadFormat(context.payload) === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return null;
}
