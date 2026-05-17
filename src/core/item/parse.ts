import { PmCliError } from "../shared/errors.js";
import { EXIT_CODE } from "../shared/constants.js";

const STDIN_TOKEN = "-";
const CONTINUABLE_VALUE_KEYS = new Set([
  "actual_result",
  "body",
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
  if (!Array.isArray(parsed)) {
    return null;
  }
  return parsed
    .map((entry) =>
      typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"
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
  if (!lines[0].startsWith("```")) {
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
    if (char === "\"") {
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
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\"/g, "\"");
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

function buildOptionSpecificKvGuidance(raw: string, optionName: string): string {
  if (optionName === "--add" || optionName === "--add-glob") {
    const looksLikePath = /[./\\]/.test(raw) || /\.[a-z]{1,6}$/i.test(raw.trim());
    if (looksLikePath) {
      return 'For file/doc paths use: path=<file-path>[,scope=project|global]. The scope field is optional and defaults to project (example: path=src/api.ts or path=README.md,scope=project). ';
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
  const preview = condensed.length > 160 ? `${condensed.slice(0, 157)}...` : condensed;
  const optionSpecificGuidance = buildOptionSpecificKvGuidance(raw, optionName);
  return (
    `Invalid ${optionName} value "${preview}". Expected key=value entries separated by commas. ` +
    optionSpecificGuidance +
    'Also accepts markdown-style key/value lines (for example "- path: README.md"). ' +
    `Use ${optionName} ${STDIN_TOKEN} to read piped stdin input.`
  );
}

function parseMarkdownKeyValueLines(raw: string): Record<string, string> | null {
  const normalized = stripCodeFenceEnvelope(raw).trim();
  if (normalized.length === 0) {
    return null;
  }
  if (!normalized.includes("\n") && !normalized.startsWith("-") && !normalized.startsWith("*") && !normalized.startsWith("+")) {
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

  return Object.keys(result).length > 0 ? result : null;
}

export function parseCsvKv(raw: string, optionName: string): Record<string, string> {
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
      if (!key) {
        throw new PmCliError(buildInvalidKvMessage(raw, optionName), EXIT_CODE.USAGE);
      }
      const value = unquoteValue(segment.slice(delimiterIndex + 1).trim());
      result[key] = value;
      activeKey = key;
      continue;
    }
    if (activeKey && CONTINUABLE_VALUE_KEYS.has(activeKey.toLowerCase())) {
      result[activeKey] = `${result[activeKey]},${segment.trim()}`;
      continue;
    }
    throw new PmCliError(buildInvalidKvMessage(raw, optionName), EXIT_CODE.USAGE);
  }

  if (Object.keys(result).length === 0) {
    throw new PmCliError(buildInvalidKvMessage(raw, optionName), EXIT_CODE.USAGE);
  }

  return result;
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

export interface StdinTokenResolver {
  resolveValue(value: string | undefined, optionName: string): Promise<string | undefined>;
  resolveList(values: string[] | undefined, optionName: string): Promise<string[] | undefined>;
}

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

  const resolveValue = async (value: string | undefined, optionName: string): Promise<string | undefined> => {
    if (value === undefined) {
      return undefined;
    }
    if (value.trim() !== STDIN_TOKEN) {
      return value;
    }
    return await consumeStdin(optionName);
  };

  const resolveList = async (values: string[] | undefined, optionName: string): Promise<string[] | undefined> => {
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

export function parseOptionalNumber(raw: string, optionName: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new PmCliError(`Invalid ${optionName} value "${raw}"`, EXIT_CODE.USAGE);
  }
  return value;
}
