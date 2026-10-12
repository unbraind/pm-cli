/**
 * @module sdk/lifecycle/mutation-facet-contracts
 * Shares stored collection names, mutation option identities, and serialized entry fields.
 */

/** Authoritative collection-to-option mapping for structured item IO and core-field recovery. */
export const ITEM_MUTATION_FACET_OPTION_MAPPINGS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ["dependencies", "dep", ["id", "kind", "created_at", "author", "source_kind"]],
  ["comments", "comment", ["text", "created_at", "author"]],
  ["notes", "note", ["text", "created_at", "author"]],
  ["learnings", "learning", ["text", "created_at", "author"]],
  ["files", "file", ["path", "scope", "note"]],
  ["tests", "test", ["command", "scope", "timeout_seconds"]],
  ["docs", "doc", ["path", "scope", "note"]],
  ["reminders", "reminder", ["at", "text", "created_at"]],
  ["events", "event", ["start_at", "end_at", "title", "location"]],
  ["type_options", "typeOption", ["key", "value"]],
];
