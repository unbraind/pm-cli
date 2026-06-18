/**
 * @module core/shared/conflict-markers
 *
 * Provides shared primitives and utilities for Conflict Markers.
 */
/**
 * Describes a detected unresolved merge-conflict marker and its source location.
 */
export interface ConflictMarkerMatch {
  line: number;
  marker: "<<<<<<<" | "=======" | ">>>>>>>";
  text: string;
}

const CONFLICT_MARKER_PATTERN = /^\s*(<<<<<<<|=======|>>>>>>>)(?:\s.*)?$/;

/**
 * Implements find merge conflict markers for the public runtime surface of this module.
 */
export function findMergeConflictMarkers(content: string): ConflictMarkerMatch[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split(/\r?\n/);
  const matches: ConflictMarkerMatch[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const markerMatch = line.match(CONFLICT_MARKER_PATTERN);
    if (!markerMatch) {
      continue;
    }
    const marker = markerMatch[1] as ConflictMarkerMatch["marker"];
    matches.push({
      line: index + 1,
      marker,
      text: line,
    });
  }
  return matches;
}

/**
 * Implements find first merge conflict marker for the public runtime surface of this module.
 */
export function findFirstMergeConflictMarker(content: string): ConflictMarkerMatch | undefined {
  const matches = findMergeConflictMarkers(content);
  return matches[0];
}
