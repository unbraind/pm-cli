/**
 * @module core/item/parse
 *
 * Defines item parsing, formatting, and lifecycle helpers for Parse.
 */
import { PmCliError } from "../shared/errors.js";
import { EXIT_CODE } from "../shared/constants.js";

const STDIN_TOKEN = "-";
const CONTINUABLE_VALUE_KEYS = new Set([
  "actual_result",
  "body",
  "cmd",
  "command",
  "customer_impact",
  "description",
  "environment",
  "expected_result",
  "impact",
  "location",
  "message",
  "note",
  "outcome",
  "repro_steps",
  "resolution",
  "text",
  "title",
  "unblock_note",
  "value",
  "why_now",
]);

/** Implements parse tags for the public runtime surface of this module. */
export function parseTags(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return [];
  }
  const source = coerceJsonTagArray(trimmed) ?? trimmed;
  const tags = source
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => tag.toLowerCase());
  return Array.from(new Set(tags)).sort((a, b) => a.localeCompare(b));
}

/** Merge repeated `--add-tags` / `--remove-tags` values into a single normalized tag list. Each entry can itself be CSV or a JSON array, mirroring the format accepted by `--tags`. Returns a deterministically sorted, deduped list. */
export function collectTagFlagValues(
  values: readonly string[] | undefined,
): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }
  const collected: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string") {
      continue;
    }
    for (const tag of parseTags(raw)) {
      collected.push(tag);
    }
  }
  return Array.from(new Set(collected)).sort((a, b) => a.localeCompare(b));
}

/** Normalize a base tag list to the canonical form pm stores: trimmed, lowercased, non-empty. Existing front-matter tags are almost always already canonical (parseTags lowercases on write), but legacy or hand-edited `.toon` files can carry mixed-case entries — normalizing here keeps additive and subtractive mutations case-insensitive (so `--add-tags beta` dedupes against an existing `Beta`, and `--remove-tags alpha` removes an existing `Alpha`). */
function normalizeBaseTags(baseTags: readonly string[]): string[] {
  // Defensive: front-matter parsed from corrupted/hand-edited `.toon` (or an
  // external SDK caller) could pass a non-array or non-string entries despite
  // the `string[]` type — guard the array and skip non-strings rather than
  // throwing on `.filter`/`.trim()`.
  if (!Array.isArray(baseTags)) {
    return [];
  }
  return baseTags
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
}

/** Apply an additive tag mutation to a base tag list. Used by `pm create` and `pm update` so `--add-tags` extends `--tags` (or the existing tags) without replacing them. Output is sorted + deduped lowercase, matching `parseTags`. */
export function mergeAdditiveTags(
  baseTags: readonly string[],
  add: readonly string[] | undefined,
): string[] {
  const normalizedBase = normalizeBaseTags(baseTags);
  if (!add || add.length === 0) {
    return Array.from(new Set(normalizedBase)).sort((a, b) =>
      a.localeCompare(b),
    );
  }
  const merged = new Set<string>(normalizedBase);
  for (const tag of collectTagFlagValues(add)) {
    merged.add(tag);
  }
  return Array.from(merged).sort((a, b) => a.localeCompare(b));
}

/** Apply a subtractive tag mutation to a base tag list. Used by `pm update` so `--remove-tags x,y` prunes those entries without rewriting the full set. Removal is case-insensitive: both the base list and the removal selectors are normalized to canonical lowercase before matching. */
export function applyTagRemovals(
  baseTags: readonly string[],
  remove: readonly string[] | undefined,
): string[] {
  const normalizedBase = Array.from(new Set(normalizeBaseTags(baseTags))).sort(
    (a, b) => a.localeCompare(b),
  );
  if (!remove || remove.length === 0) {
    return normalizedBase;
  }
  const removeSet = new Set(collectTagFlagValues(remove));
  if (removeSet.size === 0) {
    return normalizedBase;
  }
  return normalizedBase.filter((tag) => !removeSet.has(tag));
}

// Agents and MCP callers frequently pass --tags as a JSON array (e.g.
// `--tags '["a","b"]'`). The MCP server normalizes that upstream, but direct
// CLI invocations used to write the raw bracket string into front matter,
// silently corrupting tags. Accept JSON arrays of primitives transparently.
function coerceJsonTagArray(trimmed: string): string | null {
  if (!trimmed.startsWith("[")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const parsedArray = parsed as unknown[];
  return parsedArray
    .map((entry) =>
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean"
        ? String(entry).replace(/,/g, " ")
        : "",
    )
    .filter((entry) => entry.length > 0)
    .join(",");
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function stripCodeFenceEnvelope(value: string): string {
  const normalized = normalizeLineEndings(value).trim();
  if (!normalized.startsWith("```")) {
    return value;
  }
  const lines = normalized.split("\n");
  if (lines.length < 2) {
    return value;
  }
  if (lines.at(-1)?.trim() !== "```") {
    return value;
  }
  return lines.slice(1, -1).join("\n");
}

function splitCsvSegments(raw: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaped = false;

  for (const char of raw) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === "," && !inQuotes) {
      segments.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    segments.push(current.trim());
  }
  return segments;
}

function unquoteValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

function findKeyValueDelimiter(segment: string): number {
  const equalsIndex = segment.indexOf("=");
  const colonIndex = segment.indexOf(":");
  const hasEquals = equalsIndex > 0;
  const hasColon = colonIndex > 0;
  if (hasEquals && hasColon) {
    return Math.min(equalsIndex, colonIndex);
  }
  if (hasEquals) {
    return equalsIndex;
  }
  if (hasColon) {
    return colonIndex;
  }
  return -1;
}

function buildOptionSpecificKvGuidance(
  raw: string,
  optionName: string,
): string {
  if (optionName === "--add" || optionName === "--add-glob") {
    const looksLikePath =
      /[./\\]/.test(raw) || /\.[a-z]{1,6}$/i.test(raw.trim());
    if (looksLikePath) {
      return "For file/doc paths use: path=<file-path>[,scope=project|global]. The scope field is optional and defaults to project (example: path=src/api.ts or path=README.md,scope=project). ";
    }
  }
  if (optionName !== "--event") {
    return "";
  }
  const lowered = raw.toLowerCase();
  const recurrenceHint =
    lowered.includes("recur_") || lowered.includes("recurrence")
      ? ' Recurrence list values must stay in one field and use "|" delimiters (for example recur_by_weekday=mon|wed or recur_by_month_day=1|15).'
      : "";
  const weekdayAliasHint = lowered.includes("recur_byweekday")
    ? " Use recur_by_weekday (with underscores) for weekday recurrence filters."
    : "";
  return `${recurrenceHint}${weekdayAliasHint}`;
}

function buildInvalidKvMessage(raw: string, optionName: string): string {
  const condensed = raw.replaceAll(/\s+/g, " ").trim();
  const preview =
    condensed.length > 160 ? `${condensed.slice(0, 157)}...` : condensed;
  const optionSpecificGuidance = buildOptionSpecificKvGuidance(raw, optionName);
  return (
    `Invalid ${optionName} value "${preview}". Expected key=value entries separated by commas. ` +
    optionSpecificGuidance +
    'Also accepts markdown-style key/value lines (for example "- path: README.md"). ' +
    `Use ${optionName} ${STDIN_TOKEN} to read piped stdin input.`
  );
}

function parseMarkdownKeyValueLines(
  raw: string,
): Record<string, string> | null {
  const normalized = stripCodeFenceEnvelope(raw).trim();
  if (normalized.length === 0) {
    return null;
  }
  if (
    !normalized.includes("\n") &&
    !normalized.startsWith("-") &&
    !normalized.startsWith("*") &&
    !normalized.startsWith("+")
  ) {
    return null;
  }

  const result: Record<string, string> = {};
  let activeKey: string | undefined;
  const lines = normalizeLineEndings(normalized)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    const match = line.match(/^(?:[-*+]\s+)?([a-zA-Z0-9_.-]+)\s*(=|:)\s*(.*)$/);
    if (match) {
      const key = match[1].trim();
      result[key] = unquoteValue(match[3].trim());
      activeKey = key;
      continue;
    }
    if (activeKey && CONTINUABLE_VALUE_KEYS.has(activeKey.toLowerCase())) {
      result[activeKey] = `${result[activeKey]}\n${line}`;
      continue;
    }
    return null;
  }

  return result;
}

/** Implements parse csv kv for the public runtime surface of this module. */
export function parseCsvKv(
  raw: string,
  optionName: string,
): Record<string, string> {
  const trimmed = stripCodeFenceEnvelope(raw).trim();
  if (!trimmed) {
    throw new PmCliError(`${optionName} cannot be empty`, EXIT_CODE.USAGE);
  }

  const markdownStyle = parseMarkdownKeyValueLines(trimmed);
  if (markdownStyle) {
    return markdownStyle;
  }

  const result: Record<string, string> = {};
  let activeKey: string | undefined;
  const segments = splitCsvSegments(trimmed);

  for (const segment of segments) {
    const delimiterIndex = findKeyValueDelimiter(segment);
    if (delimiterIndex > 0) {
      const key = segment.slice(0, delimiterIndex).trim();
      const value = unquoteValue(segment.slice(delimiterIndex + 1).trim());
      result[key] = value;
      activeKey = key;
      continue;
    }
    if (activeKey && CONTINUABLE_VALUE_KEYS.has(activeKey.toLowerCase())) {
      result[activeKey] = `${result[activeKey]},${segment.trim()}`;
      continue;
    }
    throw new PmCliError(
      buildInvalidKvMessage(raw, optionName),
      EXIT_CODE.USAGE,
    );
  }

  return result;
}

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const GENERIC_LEADING_KV_KEY_PATTERN =
  /^(?:[-*+]\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=/;

/**
 * Detect a CSV/markdown entry that opens with a generic `key=` token even when
 * that key is unknown (e.g. a typo like `lable=main,path=README.md`). Callers
 * combine this with their known-key prefix check so a first-key typo is routed
 * through structured parsing and rejected by {@link assertNoUnknownCsvKeys}
 * (GH-258) instead of being silently swallowed as a bare path/value.
 *
 * Windows absolute paths (`C:\…`) are excluded so a drive-lettered bare path is
 * never misread as a `C=…` key/value entry.
 */
export function looksLikeGenericKeyValueEntry(raw: string): boolean {
  const trimmed = raw.trim();
  if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmed)) {
    return false;
  }
  return GENERIC_LEADING_KV_KEY_PATTERN.test(trimmed);
}

/**
 * Reject any key in a parsed CSV/markdown key/value map that is not part of the
 * caller's allowed-key contract, mirroring the strict `test --add` behavior
 * (see linked-test-parsers). This closes the cross-command consistency defect
 * (GH-258) where structured link/metadata parsers silently DROPPED typoed keys
 * (e.g. `lable=` instead of `label=`), storing data the author never intended.
 *
 * Comparison is case-insensitive so a key the downstream reader would accept
 * (e.g. `Path`) is never falsely rejected; the emitted "Allowed keys" list
 * preserves the canonical casing the caller passes in. Recognized keys are then
 * normalized in-place to their lowercase canonical form so downstream readers
 * (`kv.path`, `kv.id`, `kv.at`, …) see the value even when the input used mixed
 * casing — otherwise `Path=README.md` would pass validation yet read back as an
 * undefined `path` and surface a confusing "requires path" error. A key that
 * collides with another after normalization (e.g. `path=a,Path=b`) is rejected.
 *
 * Parsers with an intentional plaintext fallback (`--comment`/`--note`/
 * `--learning`, annotation `--add`) deliberately do NOT call this — there an
 * unrecognized key means "treat the whole entry as plaintext", not an error.
 */
export function assertNoUnknownCsvKeys(
  kv: Record<string, string>,
  optionName: string,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys.map((key) => key.toLowerCase()));
  const unknownKeys = Object.keys(kv).filter(
    (key) => !allowed.has(key.toLowerCase()),
  );
  if (unknownKeys.length > 0) {
    throw new PmCliError(
      `${optionName} does not recognize key${unknownKeys.length > 1 ? "s" : ""} ${unknownKeys
        .map((key) => `"${key}"`)
        .join(", ")}. Allowed keys: ${allowedKeys.join(", ")}.`,
      EXIT_CODE.USAGE,
    );
  }
  for (const key of Object.keys(kv)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === key) {
      continue;
    }
    if (Object.hasOwn(kv, normalizedKey)) {
      throw new PmCliError(
        `${optionName} provides key "${key}" more than once after case normalization.`,
        EXIT_CODE.USAGE,
      );
    }
    kv[normalizedKey] = kv[key];
    delete kv[key];
  }
}

async function readStdinText(optionName: string): Promise<string> {
  if (process.stdin.isTTY === true) {
    throw new PmCliError(
      `${optionName} value "${STDIN_TOKEN}" requires piped stdin input. Pipe content into the command, or end manual stdin with Ctrl+D (Unix/macOS) or Ctrl+Z then Enter (Windows).`,
      EXIT_CODE.USAGE,
    );
  }
  process.stdin.setEncoding("utf8");
  return await new Promise<string>((resolve, reject) => {
    let input = "";
    process.stdin.on("data", (chunk: string) => {
      input += chunk;
    });
    process.stdin.on("end", () => {
      resolve(normalizeLineEndings(input));
    });
    process.stdin.on("error", (error) => {
      reject(error);
    });
  });
}

/** Documents the stdin token resolver payload exchanged by command, SDK, and package integrations. */
export interface StdinTokenResolver {
  /** Value that configures or reports resolve value for this contract. */
  resolveValue(
    value: string | undefined,
    optionName: string,
  ): Promise<string | undefined>;
  /** Value that configures or reports resolve list for this contract. */
  resolveList(
    values: string[] | undefined,
    optionName: string,
  ): Promise<string[] | undefined>;
}

/** Implements create stdin token resolver for the public runtime surface of this module. */
export function createStdinTokenResolver(): StdinTokenResolver {
  let stdinValuePromise: Promise<string> | undefined;
  let stdinConsumerOption: string | undefined;

  const consumeStdin = async (optionName: string): Promise<string> => {
    if (stdinConsumerOption && stdinConsumerOption !== optionName) {
      throw new PmCliError(
        `Only one option may use "${STDIN_TOKEN}" stdin token per command invocation. Already used by ${stdinConsumerOption}.`,
        EXIT_CODE.USAGE,
      );
    }
    stdinConsumerOption = optionName;
    if (!stdinValuePromise) {
      stdinValuePromise = readStdinText(optionName);
    }
    return await stdinValuePromise;
  };

  const resolveValue = async (
    value: string | undefined,
    optionName: string,
  ): Promise<string | undefined> => {
    if (value === undefined) {
      return undefined;
    }
    if (value.trim() !== STDIN_TOKEN) {
      return value;
    }
    return await consumeStdin(optionName);
  };

  const resolveList = async (
    values: string[] | undefined,
    optionName: string,
  ): Promise<string[] | undefined> => {
    if (!values) {
      return undefined;
    }
    const tokenIndexes = values
      .map((entry, index) => (entry.trim() === STDIN_TOKEN ? index : -1))
      .filter((index) => index >= 0);
    if (tokenIndexes.length === 0) {
      return values;
    }
    if (tokenIndexes.length > 1) {
      throw new PmCliError(
        `${optionName} accepts "${STDIN_TOKEN}" stdin token at most once per command invocation`,
        EXIT_CODE.USAGE,
      );
    }
    const stdinValue = await consumeStdin(optionName);
    const next = [...values];
    next[tokenIndexes[0]] = stdinValue;
    return next;
  };

  return {
    resolveValue,
    resolveList,
  };
}

/** Implements parse optional number for the public runtime surface of this module. */
export function parseOptionalNumber(raw: string, optionName: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new PmCliError(
      `Invalid ${optionName} value "${raw}"`,
      EXIT_CODE.USAGE,
    );
  }
  return value;
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  coerceJsonTagArray,
  stripCodeFenceEnvelope,
  parseMarkdownKeyValueLines,
};
