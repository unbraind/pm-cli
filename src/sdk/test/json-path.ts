/**
 * @module sdk/test/json-path
 * Own-data lookup for linked-test assertions.
 */

/** Parse the linked-test dotted and bracket-index path grammar. */
export function splitJsonPathSegments(fieldPath: string): Array<string | number> {
  const segments: Array<string | number> = [];
  const tokens = fieldPath.match(/[^.[\]]+|\[\d+\]/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith("[") && token.endsWith("]")) {
      const parsedIndex = Number.parseInt(token.slice(1, -1), 10);
      if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
        return [];
      }
      segments.push(parsedIndex);
      continue;
    }
    segments.push(token);
  }
  return segments;
}

/** Read own JSON data properties without invoking getters or following prototypes. */
export function readJsonPathValue(
  root: unknown,
  fieldPath: string,
): { found: boolean; value: unknown } {
  const normalizedPath = fieldPath.trim();
  if (normalizedPath.length === 0) {
    return { found: false, value: undefined };
  }
  const segments = splitJsonPathSegments(normalizedPath);
  if (segments.length === 0) {
    return { found: false, value: undefined };
  }
  let current: unknown = root;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) {
      return { found: false, value: undefined };
    }
    if (
      typeof segment === "number" &&
      (!Array.isArray(current) || segment >= current.length)
    ) {
      return { found: false, value: undefined };
    }
    const property = Object.getOwnPropertyDescriptor(current, segment);
    if (!property || !Object.hasOwn(property, "value")) {
      return { found: false, value: undefined };
    }
    current = property.value;
  }
  return { found: true, value: current };
}
