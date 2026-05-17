import type {
  CommandDefinition,
  ExtensionApi,
  ServiceOverrideContext,
} from "../../../../src/sdk/index.js";
import type { CalendarOptions } from "../../../../src/sdk/runtime.js";
import { renderCalendarPackageOutput, runCalendarPackage } from "./runtime.js";

export const manifest = {
  name: "builtin-calendar",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands", "schema", "services"],
};

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
    run: async (context) => runCalendarPackage(context.options as CalendarOptions, context.global),
  };
}

export function activate(api: ExtensionApi): void {
  api.registerCommand(calendarCommand("calendar"));
  api.registerCommand(calendarCommand("cal"));
  api.registerService("output_format", (context) => {
    const rendered = renderCalendarPackageOutput(context as ServiceOverrideContext);
    return rendered ?? null;
  });
}

export default {
  manifest,
  activate,
};
