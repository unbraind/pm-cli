/**
 * @module core/schema/type-inference
 *
 * Resolves configurable schema, fields, statuses, and workflows for Type Inference.
 */
import { matchBuiltinTypeName } from "./item-types-file.js";

/**
 * Pure logic for `pm schema add-type --infer`: scan existing item titles for
 * stable `PREFIX-`/`PREFIX:` conventions and propose them as custom item types.
 * The CLI command file (schema.ts) owns IO and the optional registration; this
 * module only derives candidates from a list of titles so it is fully testable
 * and coverage-gated to 100%.
 *
 * Conventions recognized (case-insensitive, first run wins per title):
 *  - `INFRA- ...`  / `SECURITY-...`  (hyphen-delimited prefix)
 *  - `BUG: ...`    / `SPIKE: ...`    (colon-delimited prefix)
 * The prefix token must be a letter-led identifier of letters, digits, and
 * internal hyphens/underscores so it maps cleanly to a single PascalCase type
 * name. Purely numeric or sequence-style prefixes (e.g. `S001-`, `E12-`) are
 * intentionally skipped: they index items, they are not type boundaries.
 */

const PREFIX_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*?)\s*[-:]\s+\S/;

/**
 * Documents the inferred type candidate payload exchanged by command, SDK, and package integrations.
 */
export interface InferredTypeCandidate {
  /** Suggested PascalCase type name derived from the prefix. */
  name: string;
  /** The normalized prefix token (lowercase) the items share. */
  prefix: string;
  /** How many scanned titles carry this prefix. */
  count: number;
  /** A few example titles (capped) for human/agent review. */
  examples: string[];
  /** True when `name` already resolves to a reserved built-in type. */
  shadows_builtin: boolean;
}

/**
 * Documents the infer types options payload exchanged by command, SDK, and package integrations.
 */
export interface InferTypesOptions {
  /** Minimum number of titles that must share a prefix to surface it (default 10). */
  minCount?: number;
  /** Maximum example titles retained per candidate (default 3). */
  maxExamples?: number;
}

/**
 * Extracts the leading prefix token from a title, or undefined when the title has
 * no stable letter-led `PREFIX-`/`PREFIX:` convention.
 */
export function extractTitlePrefix(title: string): string | undefined {
  const match = PREFIX_PATTERN.exec(title.trim());
  if (!match) {
    return undefined;
  }
  const token = match[1];
  // Reject single-character prefixes (e.g. "S-", "E-"): they are sequence/index
  // markers far more often than genuine type boundaries.
  if (token.length < 2) {
    return undefined;
  }
  // Reject sequence/index-style prefixes — a single leading letter followed by
  // only digits (e.g. "S001-", "E12-", "V1-"). These index items rather than
  // mark a type boundary, matching the convention documented above.
  if (/^[A-Za-z]\d+$/.test(token)) {
    return undefined;
  }
  return token.toLowerCase();
}

/**
 * Converts a normalized prefix token into a PascalCase type name. Internal
 * hyphen/underscore runs become word boundaries; each word is capitalized.
 */
export function prefixToTypeName(prefix: string): string {
  return prefix
    .split(/[-_]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment.slice(0, 1).toUpperCase()}${segment.slice(1).toLowerCase()}`)
    .join("");
}

/**
 * Scans titles for shared prefix conventions and returns candidate custom types,
 * sorted by descending frequency then name. Only prefixes carried by at least
 * `minCount` titles are returned.
 */
export function inferTypesFromTitles(titles: string[], options: InferTypesOptions = {}): InferredTypeCandidate[] {
  const minCount = typeof options.minCount === "number" && options.minCount > 0 ? Math.trunc(options.minCount) : 10;
  const maxExamples = typeof options.maxExamples === "number" && options.maxExamples > 0 ? Math.trunc(options.maxExamples) : 3;
  const byPrefix = new Map<string, { count: number; examples: string[] }>();
  for (const rawTitle of titles) {
    const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
    if (title.length === 0) {
      continue;
    }
    const prefix = extractTitlePrefix(title);
    if (prefix === undefined) {
      continue;
    }
    const bucket = byPrefix.get(prefix) ?? { count: 0, examples: [] };
    bucket.count += 1;
    if (bucket.examples.length < maxExamples) {
      bucket.examples.push(title);
    }
    byPrefix.set(prefix, bucket);
  }
  const candidates: InferredTypeCandidate[] = [];
  for (const [prefix, bucket] of byPrefix.entries()) {
    if (bucket.count < minCount) {
      continue;
    }
    const name = prefixToTypeName(prefix);
    candidates.push({
      name,
      prefix,
      count: bucket.count,
      examples: bucket.examples,
      shadows_builtin: matchBuiltinTypeName(name) !== undefined,
    });
  }
  candidates.sort((left, right) => (right.count - left.count) || left.name.localeCompare(right.name));
  return candidates;
}
