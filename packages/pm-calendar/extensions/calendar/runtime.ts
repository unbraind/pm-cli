import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CalendarOptions, CalendarResult } from "../../../../src/sdk/runtime.js";
import type { GlobalOptions, ServiceOverrideContext } from "../../../../src/sdk/index.js";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

interface CalendarCoreModule {
  runCalendar: (options: CalendarOptions, global: GlobalOptions) => Promise<CalendarResult>;
  renderCalendarMarkdown: (result: CalendarResult) => string;
  resolveCalendarOutputFormat: (options: CalendarOptions, global: GlobalOptions) => "markdown" | "toon" | "json";
}

let calendarCore: CalendarCoreModule | null = null;
let calendarCoreLoadPromise: Promise<CalendarCoreModule> | null = null;

async function ensureCalendarCoreModule(): Promise<CalendarCoreModule> {
  if (calendarCore) {
    return calendarCore;
  }
  if (!calendarCoreLoadPromise) {
    calendarCoreLoadPromise = loadCalendarCoreModule();
  }
  calendarCore = await calendarCoreLoadPromise;
  return calendarCore;
}

async function loadCalendarCoreModule(): Promise<CalendarCoreModule> {
  const envRoot = process.env[PM_PACKAGE_ROOT_ENV];
  if (typeof envRoot !== "string" || envRoot.trim().length === 0) {
    throw new Error(
      `builtin-calendar requires ${PM_PACKAGE_ROOT_ENV} to locate core SDK runtime exports.`,
    );
  }
  const modulePath = path.join(path.resolve(envRoot.trim()), "dist", "sdk", "runtime.js");
  try {
    const loaded = (await import(pathToFileURL(modulePath).href)) as Partial<CalendarCoreModule>;
    if (
      typeof loaded.runCalendar === "function" &&
      typeof loaded.renderCalendarMarkdown === "function" &&
      typeof loaded.resolveCalendarOutputFormat === "function"
    ) {
      return loaded as CalendarCoreModule;
    }
  } catch {
    // Fall through to deterministic failure message below.
  }
  throw new Error(
    `builtin-calendar failed to load calendar SDK runtime exports from ${modulePath}.`,
  );
}

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
  const loaded = await ensureCalendarCoreModule();
  return loaded.runCalendar(options, global);
}

export function renderCalendarPackageOutput(context: ServiceOverrideContext): string | null {
  const result = readPayloadResult(context.payload);
  if (!calendarCore || !isCalendarCommand(context.command) || !isCalendarResult(result)) {
    return null;
  }
  const options = (context.options ?? {}) as CalendarOptions;
  const global = (context.global ?? {}) as GlobalOptions;
  const outputFormat = calendarCore.resolveCalendarOutputFormat(options, global);
  if (outputFormat === "markdown") {
    return `${calendarCore.renderCalendarMarkdown(result)}\n`;
  }
  if (outputFormat === "json" || readPayloadFormat(context.payload) === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return null;
}
