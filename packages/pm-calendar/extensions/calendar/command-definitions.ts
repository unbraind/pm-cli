/**
 * @module packages/pm-calendar/extensions/calendar/command-definitions
 *
 * Declares pure calendar command metadata shared by runtime and contract gates. The host
 * supplies alias routing, argument validation, mutation receipts, and telemetry.
 */
import type { CommandDefinition, FlagDefinition } from "@unbrained/pm-cli/sdk";

const commonFlags: FlagDefinition[] = [
  { long: "--parent", value_name: "id", value_type: "string", description: "Parent item id" },
  { long: "--allow-missing-parent", value_type: "boolean", description: "Permit a parent id that does not exist yet" },
  { long: "--tags", value_name: "list", value_type: "string", description: "Comma-separated tags" },
  { long: "--priority", value_name: "value", value_type: "string", description: "Priority" },
  { long: "--body", value_name: "text", value_type: "string", description: "Body/markdown content" },
  { long: "--description", value_name: "text", value_type: "string", description: "Short description" },
  { long: "--message", value_name: "value", value_type: "string", description: "History message" },
];

const eventFlags: FlagDefinition[] = [
  { long: "--start", value_name: "when", value_type: "string", description: "Start time (ISO, now, or relative +1h/+2d); defaults to now" },
  { long: "--duration", value_name: "span", value_type: "string", description: "Duration: min|mins|minute|minutes, h, d, w, mo, or ISO PT time; bare m is ambiguous; defaults to 1h" },
  { long: "--end", value_name: "when", value_type: "string", description: "End time (ISO or relative); overrides --duration" },
  { long: "--location", value_name: "value", value_type: "string", description: "Location" },
  { long: "--timezone", value_name: "value", value_type: "string", description: "IANA timezone (for example America/New_York)" },
  { long: "--all-day", value_type: "boolean", description: "Mark as an all-day event" },
];

/** Package-owned shortcuts retain the public SDK operation identities and flags. */
export const schedulingCommandDefinitions: Omit<CommandDefinition, "run">[] = [
  ...(["meet", "event"] as const).map((name): Omit<CommandDefinition, "run"> => ({
    name,
    action: name,
    tier: "standard",
    family: "automation",
    description: `Create a ${name === "meet" ? "Meeting" : "Event"} with a start time and duration.`,
    arguments: [{ name: "title", required: true, description: "Item title" }],
    flags: [...eventFlags, ...commonFlags],
  })),
  {
    name: "remind",
    action: "remind",
    tier: "standard",
    family: "automation",
    description: "Create a Reminder from a single point in time.",
    arguments: [{ name: "title", required: true, description: "Item title" }],
    flags: [
      { long: "--at", value_name: "when", value_type: "string", description: "Reminder time (ISO, now, or relative +2d); defaults to +1d" },
      { long: "--text", value_name: "value", value_type: "string", description: "Reminder text; defaults to the title" },
      ...commonFlags,
    ],
  },
];
