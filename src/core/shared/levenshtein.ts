// Optimal String Alignment (OSA) Damerau–Levenshtein: counts a single adjacent
// transposition as one edit (e.g. "titel" vs "title", "lst" vs "lts" -> "list")
// so flag/command typo suggestions catch transpositions at the same maxDistance
// budget plain Levenshtein uses for substitutions. pm-fl0c #6 (2026-05-28):
// fixed because plain Levenshtein scored "titel"->"title" at 2, defeating the
// length-5 maxDistance=1 ceiling in suggestNearestLongFlags.
export function levenshteinDistanceWithinLimit(left: string, right: string, limit: number): number | null {
  if (left === right) {
    return 0;
  }
  if (Math.abs(left.length - right.length) > limit) {
    return null;
  }
  const width = right.length + 1;
  const beforePrevious = new Array<number>(width);
  const previous = new Array<number>(width);
  const current = new Array<number>(width);
  for (let column = 0; column < width; column += 1) {
    beforePrevious[column] = 0;
    previous[column] = column;
  }
  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    let rowMin = current[0];
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      const substitution = previous[column - 1] + cost;
      const insertion = current[column - 1] + 1;
      const deletion = previous[column] + 1;
      let candidate = Math.min(substitution, insertion, deletion);
      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        candidate = Math.min(candidate, beforePrevious[column - 2] + 1);
      }
      current[column] = candidate;
      if (candidate < rowMin) {
        rowMin = candidate;
      }
    }
    if (rowMin > limit) {
      return null;
    }
    for (let column = 0; column < width; column += 1) {
      beforePrevious[column] = previous[column];
      previous[column] = current[column];
    }
  }
  const result = previous[right.length];
  return result <= limit ? result : null;
}
