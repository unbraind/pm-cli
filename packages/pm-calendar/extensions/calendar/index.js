import { renderCalendarPackageOutput, runCalendarPackage } from "./runtime.js";

const CALENDAR_VIEW_NAMES = ["agenda", "day", "week", "month"];

// Standalone error class so the package stays self-contained when installed
// outside the pm-cli source tree. The class name "PmCliError" lines up with
// the Sentry beforeSend filter (isExpectedCliErrorEvent) so usage errors do
// not leak into Sentry as crashes.
class PmCliError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = "PmCliError";
    this.exitCode = exitCode;
  }
}

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
  { long: "--include", value_name: "value", value_type: "string", description: "Include sources: deadlines|reminders|events|scheduled|all." },
  { long: "--recurrence-lookahead-days", value_name: "n", value_type: "string", description: "Bound open-ended recurrence lookahead days." },
  { long: "--recurrence-lookback-days", value_name: "n", value_type: "string", description: "Bound open-ended recurrence lookback days." },
  { long: "--occurrence-limit", value_name: "n", value_type: "string", description: "Cap generated occurrences per recurring event." },
  { long: "--limit", value_name: "n", value_type: "string", description: "Limit returned event count." },
  { long: "--format", value_name: "value", value_type: "string", description: "Calendar output override: markdown|toon|json." },
];

function isCalendarView(arg) {
  return CALENDAR_VIEW_NAMES.includes(arg);
}

function buildPositionalViewError(positionalArgs) {
  const received = positionalArgs.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
  const receivedList = received.join(", ");
  // Check every received positional, not just the tail, so an invalid first
  // positional (e.g. `pm calendar totally-bogus week`) is still surfaced.
  const extras = received.filter((arg) => !isCalendarView(arg));
  // Fall back to the first valid view from `received` for the recovery hint;
  // recommend `agenda` only when none of the positionals are valid view names.
  const recoveryView = received.find(isCalendarView) ?? "agenda";
  const hintLines = [`Calendar accepts at most one positional view (agenda|day|week|month), but received: ${receivedList}.`];
  if (extras.length > 0) {
    hintLines.push(`Unknown view alias(es): ${extras.join(", ")}.`);
  }
  hintLines.push("Use a single view, or pass extra arguments via flags:");
  hintLines.push(`  pm calendar ${recoveryView}`);
  hintLines.push(`  pm calendar --view ${recoveryView} --date +7d`);
  return new PmCliError(hintLines.join("\n"), 2);
}

function calendarCommand(name) {
  return {
    name,
    action: "calendar",
    description: "Show deadline, reminder, and scheduled event calendar views.",
    arguments: [{ name: "view", required: false, description: "Calendar view: agenda|day|week|month." }],
    flags: [...calendarFlags],
    run: async (context) => {
      // Extension flags are parsed loosely, so context.args still contains flag
      // tokens (e.g. ["day", "--date", "+7d"]). Only the leading non-flag tokens
      // are true positionals, so a positional view combined with --date/--from/etc.
      // must not be mistaken for multiple positional views.
      const firstFlagIndex = context.args.findIndex((arg) => arg.startsWith("-"));
      const rawPositionalArgs = firstFlagIndex === -1 ? context.args : context.args.slice(0, firstFlagIndex);
      // Drop empty/whitespace-only positionals (e.g. from `pm calendar agenda ""`
      // when a shell variable is unset) so the count check stays meaningful.
      const positionalArgs = rawPositionalArgs.filter((arg) => arg.trim().length > 0);
      const positionalView = positionalArgs[0]?.trim();
      if (positionalArgs.length > 1) {
        throw buildPositionalViewError(positionalArgs);
      }
      return runCalendarPackage(
        {
          ...context.options,
          ...(positionalView && context.options.view === undefined ? { view: positionalView } : {}),
        },
        context.global,
      );
    },
  };
}

export function activate(api) {
  api.registerCommand(calendarCommand("calendar"));
  api.registerCommand(calendarCommand("cal"));
  api.registerService("output_format", (context) => {
    const rendered = renderCalendarPackageOutput(context);
    return rendered ?? null;
  });
}

export default {
  manifest,
  activate,
};
