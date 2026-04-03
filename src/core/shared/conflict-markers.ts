export interface ConflictMarkerMatch {
  line: number;
  marker: "<<<<<<<" | "=======" | ">>>>>>>";
  text: string;
}

const CONFLICT_MARKER_PATTERN = /^\s*(<<<<<<<|=======|>>>>>>>)(?:\s.*)?$/;

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

export function findFirstMergeConflictMarker(content: string): ConflictMarkerMatch | undefined {
  const matches = findMergeConflictMarkers(content);
  return matches[0];
}
