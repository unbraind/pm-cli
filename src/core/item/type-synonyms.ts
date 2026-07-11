/**
 * Common type synonyms agents type that are not item types themselves. Telemetry
 * shows real users repeatedly run e.g. `pm create Bug "..."` and `pm create Change
 * "..."` and hit a hard "invalid type" error. Rather than block, `create` maps an
 * unregistered type through this table to its closest canonical built-in type (and
 * prints a note). The mapping is only a FALLBACK: it applies after the real type
 * registry fails to resolve the name, and the canonical target is itself resolved
 * through the live registry — so a project that defines its own `Bug` type keeps it,
 * and a project that has removed `Issue` will simply fall through to the normal error.
 *
 * Keys are compared case-insensitively after trimming. Values are canonical built-in
 * type names (resolved through the registry, never written verbatim).
 */
/** Public contract for type synonyms, shared by SDK and presentation-layer consumers. */
export const TYPE_SYNONYMS: Readonly<Record<string, string>> = {
  bug: "Issue",
  bugfix: "Issue",
  defect: "Issue",
  incident: "Issue",
  enhancement: "Feature",
  story: "Feature",
  userstory: "Feature",
  "user-story": "Feature",
  "user story": "Feature",
  change: "Chore",
  ticket: "Task",
  todo: "Task",
};

/** Map a free-form type token to its canonical built-in type synonym, or `undefined` when there is no synonym. The caller must still confirm the canonical target exists in the active type registry before using it. */
export function resolveTypeSynonym(
  rawType: string | undefined,
): string | undefined {
  if (rawType === undefined) {
    return undefined;
  }
  return TYPE_SYNONYMS[rawType.trim().toLowerCase()];
}
