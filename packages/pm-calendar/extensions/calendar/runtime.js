import path from "node:path";
import { pathToFileURL } from "node:url";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
let calendarCore = null;
let calendarCoreLoadPromise = null;

async function ensureCalendarCoreModule() {
  if (calendarCore) {
    return calendarCore;
  }
  if (!calendarCoreLoadPromise) {
    calendarCoreLoadPromise = loadCalendarCoreModule();
  }
  calendarCore = await calendarCoreLoadPromise;
  return calendarCore;
}

async function loadCalendarCoreModule() {
  const envRoot = process.env[PM_PACKAGE_ROOT_ENV];
  if (typeof envRoot !== "string" || envRoot.trim().length === 0) {
    throw new Error(
      `builtin-calendar requires ${PM_PACKAGE_ROOT_ENV} to locate core SDK runtime exports.`,
    );
  }
  const modulePath = path.join(path.resolve(envRoot.trim()), "dist", "sdk", "runtime.js");
  try {
    const loaded = await import(pathToFileURL(modulePath).href);
    if (
      typeof loaded.runCalendar === "function" &&
      typeof loaded.renderCalendarMarkdown === "function" &&
      typeof loaded.renderCalendarToon === "function" &&
      typeof loaded.resolveCalendarOutputFormat === "function"
    ) {
      return loaded;
    }
  } catch {
    // Fall through to deterministic failure message below.
  }
  throw new Error(
    `builtin-calendar failed to load calendar SDK runtime exports from ${modulePath}.`,
  );
}

function isCalendarResult(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    value.output_default === "markdown" &&
    Array.isArray(value.events) &&
    Array.isArray(value.days)
  );
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

function readPayloadCommandOptions(payload) {
  if (typeof payload === "object" && payload !== null) {
    const commandOptions = payload.command_options;
    if (typeof commandOptions === "object" && commandOptions !== null) {
      return commandOptions;
    }
  }
  return {};
}

function readPayloadGlobalOptions(payload) {
  if (typeof payload === "object" && payload !== null) {
    const global = payload.global;
    if (typeof global === "object" && global !== null) {
      return global;
    }
  }
  return {};
}

export async function runCalendarPackage(options, global) {
  const loaded = await ensureCalendarCoreModule();
  loaded.resolveCalendarOutputFormat(options, global);
  return loaded.runCalendar(options, global);
}

export function renderCalendarPackageOutput(context) {
  const result = readPayloadResult(context.payload);
  if (!calendarCore || !isCalendarResult(result)) {
    return null;
  }
  const options =
    context.options && Object.keys(context.options).length > 0
      ? context.options
      : readPayloadCommandOptions(context.payload);
  const global = context.global ?? readPayloadGlobalOptions(context.payload);
  const outputFormat = calendarCore.resolveCalendarOutputFormat(options, global);
  if (outputFormat === "markdown") {
    return `${calendarCore.renderCalendarMarkdown(result)}\n`;
  }
  if (outputFormat === "json" || readPayloadFormat(context.payload) === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (outputFormat === "toon") {
    const rendered = calendarCore.renderCalendarToon(result);
    return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
  }
  return null;
}

export const _testOnly = {
  readPayloadFormat,
  readPayloadCommandOptions,
  readPayloadGlobalOptions,
};
