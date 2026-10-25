/**
 * @module packages/pm-calendar/extensions/calendar/shortcuts
 *
 * Binds package-owned scheduling declarations to the public SDK mutation paths.
 */
import { runEvent, runMeet, runRemind, type CommandDefinition } from "@unbrained/pm-cli/sdk";
import { schedulingCommandDefinitions } from "./command-definitions.ts";

/** Preserve CLI focus for absent policy, explicit opt-out, and native SDK validation/history/receipts. */
export const schedulingCommands: CommandDefinition[] = schedulingCommandDefinitions.map((definition) => ({
  ...definition,
  run: (context) => (
    definition.name === "meet" ? runMeet : definition.name === "event" ? runEvent : runRemind
  )(context.args[0], { ...context.options, inheritFocus: (context.options.inheritFocus ?? true) === true }, context.global),
}));
