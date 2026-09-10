/**
 * @module cli/command-namespaces
 *
 * Places existing Commander handlers under SDK-declared nouns. Moving the
 * actual node preserves its parser, action closure, flags, and nested verbs.
 */
import type { Command } from "commander";
import { PM_RELOCATED_COMMAND_ALIASES } from "../sdk/cli-contracts/command-aliases.js";

/** Install available namespace leaves after core and package command registration. */
export function installCommandNamespaces(program: Command): void {
  if (!program.commands.some((command) => command.name() === "ops")) program.command("ops").description("Discover workspace diagnostics and maintenance operations.");
  for (const { alias, canonical_argv: [noun, verb] } of PM_RELOCATED_COMMAND_ALIASES) {
    const sourceIndex = program.commands.findIndex((command) => command.name() === alias);
    if (sourceIndex < 0) continue;
    const source = program.commands[sourceIndex];
    const parent = program.commands.find((command) => command.name() === noun) ?? program.command(noun).description(`Discover ${noun} operations.`);
    if (parent.commands.some((command) => command.name() === verb)) {
      throw new Error(`Cannot install canonical command ${noun} ${verb}: destination already exists.`);
    }
    // Commander exposes this mutable registration array as readonly in its
    // public types and has no removeCommand API. Keep the cast at this boundary.
    (program.commands as Command[]).splice(sourceIndex, 1);
    source.name(verb);
    // Parent mutation flags must not consume identically named bulk flags
    // after the leaf token; the leaf owns its complete parser and defaults.
    parent.enablePositionalOptions();
    parent.addCommand(source);
  }
}
