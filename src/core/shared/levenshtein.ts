export function levenshteinDistanceWithinLimit(left: string, right: string, limit: number): number | null {
  if (left === right) {
    return 0;
  }
  if (Math.abs(left.length - right.length) > limit) {
    return null;
  }
  const previous = new Array<number>(right.length + 1);
  const current = new Array<number>(right.length + 1);
  for (let column = 0; column <= right.length; column += 1) {
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
      const candidate = Math.min(substitution, insertion, deletion);
      current[column] = candidate;
      if (candidate < rowMin) {
        rowMin = candidate;
      }
    }
    if (rowMin > limit) {
      return null;
    }
    for (let column = 0; column <= right.length; column += 1) {
      previous[column] = current[column];
    }
  }
  const result = previous[right.length];
  return result <= limit ? result : null;
}
