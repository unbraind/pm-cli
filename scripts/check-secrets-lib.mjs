import { SECRET_RULES } from "../src/core/shared/secret-rules.ts";

// Clone descriptors so test or consumer customization cannot change SDK policy.
export const RULES = SECRET_RULES.filter((rule) => !("mutationOnlyReason" in rule))
  .map((rule) => ({ ...rule, regex: new RegExp(rule.regex.source, rule.regex.flags) }));

/** Index line starts once so multiple detectors share the same offset lookup. */
function lineStartIndexes(content) {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      starts.push(index + 1);
    }
  }
  return starts;
}

/** Convert a match offset to its one-based diagnostic line by binary search. */
function lineNumberFromIndex(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (starts[mid] <= index) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return high + 1;
}

/** Return only rule names and source locations, honoring repository-only fixture exemptions. */
export function scanContent(file, content) {
  const findings = [];
  const lineStarts = lineStartIndexes(content);
  for (const rule of RULES) {
    if (rule.includeFiles && !rule.includeFiles.test(file)) {
      continue;
    }
    if (rule.excludeFiles && rule.excludeFiles.test(file)) {
      continue;
    }
    rule.regex.lastIndex = 0;
    const matches = content.matchAll(rule.regex);
    for (const match of matches) {
      /* c8 ignore next -- String.prototype.matchAll always sets match.index; ?? 0 is unreachable defensive default */
      const index = match.index ?? 0;
      findings.push({
        file,
        rule: rule.name,
        line: lineNumberFromIndex(lineStarts, index),
      });
    }
  }
  return findings;
}
