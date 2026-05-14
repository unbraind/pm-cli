import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  CalendarOptions,
  CalendarResult,
  CommandDefinition,
  ExtensionApi,
  GlobalOptions,
  ServiceOverrideContext,
} from "../../../../src/sdk/index.js";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
const CURRENT_EXTENSION_ROOT = path.dirname(fileURLToPath(import.meta.url));

export const manifest = {
  name: "builtin-calendar",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands", "schema", "services"],
};

type RuntimeModule = {
  runCalendarPackage?: (options: CalendarOptions, global: GlobalOptions) => Promise<CalendarResult>;
  renderCalendarPackageOutput?: (context: ServiceOverrideContext) => string | null;
};

let cachedRuntimeModule: RuntimeModule | null = null;

function resolvePackageRootCandidates(): string[] {
  const candidates: string[] = [];
  const envRoot = process.env[PM_PACKAGE_ROOT_ENV];
  if (typeof envRoot === "string" && envRoot.trim().length > 0) {
    candidates.push(path.resolve(envRoot.trim()));
  }
  const argvEntry = typeof process.argv[1] === "string" ? process.argv[1].trim() : "";
  if (argvEntry.length > 0) {
    const resolvedEntry = path.resolve(argvEntry);
    const entryDir = path.dirname(resolvedEntry);
    candidates.push(path.resolve(entryDir, ".."));
    candidates.push(path.resolve(entryDir, "../.."));
    candidates.push(path.resolve(entryDir, "../../.."));
  }
  return [...new Set(candidates)];
}

async function loadRuntimeModule(): Promise<RuntimeModule> {
  if (cachedRuntimeModule) {
    return cachedRuntimeModule;
  }
  const attempted: string[] = [];
  for (const packageRoot of resolvePackageRootCandidates()) {
    const modulePaths = [
      path.join(packageRoot, "packages", "pm-calendar", "extensions", "calendar", "runtime.js"),
    ];
    for (const modulePath of modulePaths) {
      attempted.push(modulePath);
      try {
        cachedRuntimeModule = await import(pathToFileURL(modulePath).href) as RuntimeModule;
        return cachedRuntimeModule;
      } catch {
        // Try the next package-root candidate.
      }
    }
  }

  const localRuntimePath = path.join(CURRENT_EXTENSION_ROOT, "runtime.js");
  attempted.push(localRuntimePath);
  try {
    cachedRuntimeModule = await import(pathToFileURL(localRuntimePath).href) as RuntimeModule;
    return cachedRuntimeModule;
  } catch {
    // Fall through to the diagnostic below.
  }

  throw new Error(
    "Unable to resolve packaged calendar extension runtime module. " +
      `Tried: ${attempted.join(", ")}. Ensure the installed extension includes runtime.js or PM_CLI_PACKAGE_ROOT points to an installed pm package root.`,
  );
}

async function runCalendarFromRuntime(options: CalendarOptions, global: GlobalOptions): Promise<CalendarResult> {
  const runtime = await loadRuntimeModule();
  if (typeof runtime.runCalendarPackage !== "function") {
    throw new Error("Bundled calendar runtime module is missing runCalendarPackage().");
  }
  return runtime.runCalendarPackage(options, global);
}

function renderCalendarOutput(context: ServiceOverrideContext): string | null {
  const runtime = cachedRuntimeModule;
  if (!runtime || typeof runtime.renderCalendarPackageOutput !== "function") {
    return null;
  }
  return runtime.renderCalendarPackageOutput(context);
}

const calendarFlags = [
  { long: "--view", value_name: "value", value_type: "string", description: "Calendar view: agenda|day|week|month." },
  { long: "--date", value_name: "value", value_type: "string", description: "Anchor date/time for view calculations." },
  { long: "--from", value_name: "value", value_type: "string", description: "Agenda lower bound." },
  { long: "--to", value_name: "value", value_type: "string", description: "Agenda upper bound." },
  { long: "--past", value_type: "boolean", description: "Include past entries." },
  { long: "--full-period", value_type: "boolean", description: "Include the full anchored day/week/month period." },
  { long: "--type", value_name: "value", value_type: "string", description: "Filter by item type." },
  { long: "--tag", value_name: "value", value_type: "string", description: "Filter by tag." },
  { long: "--priority", value_name: "value", value_type: "string", description: "Filter by priority." },
  { long: "--status", value_name: "value", value_type: "string", description: "Filter by status." },
  { long: "--assignee", value_name: "value", value_type: "string", description: "Filter by assignee." },
  { long: "--assignee-filter", value_name: "value", value_type: "string", description: "Filter assignee presence." },
  { long: "--sprint", value_name: "value", value_type: "string", description: "Filter by sprint." },
  { long: "--release", value_name: "value", value_type: "string", description: "Filter by release." },
  { long: "--include", value_name: "value", value_type: "string", description: "Include sources: deadlines|reminders|events|all." },
  { long: "--recurrence-lookahead-days", value_name: "n", value_type: "string", description: "Bound open-ended recurrence lookahead days." },
  { long: "--recurrence-lookback-days", value_name: "n", value_type: "string", description: "Bound open-ended recurrence lookback days." },
  { long: "--occurrence-limit", value_name: "n", value_type: "string", description: "Cap generated occurrences per recurring event." },
  { long: "--limit", value_name: "n", value_type: "string", description: "Limit returned event count." },
  { long: "--format", value_name: "value", value_type: "string", description: "Calendar output override: markdown|toon|json." },
] as const;

function calendarCommand(name: "calendar" | "cal"): CommandDefinition {
  return {
    name,
    action: "calendar",
    description: "Show deadline, reminder, and scheduled event calendar views.",
    flags: [...calendarFlags],
    run: async (context) => runCalendarFromRuntime(context.options as CalendarOptions, context.global),
  };
}

export function activate(api: ExtensionApi): void {
  api.registerCommand(calendarCommand("calendar"));
  api.registerCommand(calendarCommand("cal"));
  api.registerService("output_format", (context) => {
    const rendered = renderCalendarOutput(context);
    return rendered ?? context.payload;
  });
}

export default {
  manifest,
  activate,
};
