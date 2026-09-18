/**
 * @module packages/pm-calendar/extensions/calendar/shortcuts
 *
 * Binds package-owned scheduling declarations to the public SDK mutation paths.
 */
import { runEvent, runMeet, runRemind, type CommandDefinition } from "@unbrained/pm-cli/sdk";
import { schedulingCommandDefinitions } from "./command-definitions.ts";

/** Scheduling handlers preserve native SDK validation, history, and output receipts. */
export const schedulingCommands: CommandDefinition[] = schedulingCommandDefinitions.map((definition) => ({
  ...definition,
  run: (context) => (
    definition.name === "meet" ? runMeet : definition.name === "event" ? runEvent : runRemind
  )(context.args[0], context.options, context.global),
}));
