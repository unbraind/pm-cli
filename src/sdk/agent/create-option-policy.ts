/**
 * @module sdk/create-option-policy
 *
 * Defines explicit-empty assertions for repeatable create options. A strict
 * schema can require that an agent considers a collection without forcing it
 * to invent an entry: the corresponding `--clear-*` flag is an auditable,
 * truthful answer that the collection is intentionally empty.
 */

const CREATE_REPEATABLE_CLEAR_FLAGS: Readonly<Record<string, string>> = {
  comment: "--clear-comments",
  dep: "--clear-deps",
  doc: "--clear-docs",
  event: "--clear-events",
  file: "--clear-files",
  learning: "--clear-learnings",
  note: "--clear-notes",
  reminder: "--clear-reminders",
  test: "--clear-tests",
  typeOption: "--clear-type-options",
};

/** Return the explicit-empty flag for a repeatable create option. */
export function resolveCreateExplicitEmptyFlag(
  optionKey: string,
): string | undefined {
  return CREATE_REPEATABLE_CLEAR_FLAGS[optionKey];
}

/** Return whether a create option can be satisfied by an explicit empty set. */
export function supportsCreateExplicitEmpty(optionKey: string): boolean {
  return resolveCreateExplicitEmptyFlag(optionKey) !== undefined;
}
