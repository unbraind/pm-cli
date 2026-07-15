/**
 * @module sdk/cli-contracts/command-aliases
 *
 * Defines executable command aliases shared by bootstrap parsing and SDK package scaffolding.
 */

/** High-frequency executable aliases whose targets accept the same positional and flag contracts. */
export const EXECUTABLE_COMMAND_ALIASES: Readonly<Record<string, string>> = {
  show: "get",
  view: "get",
  comment: "comments",
  note: "notes",
  learning: "learnings",
};
