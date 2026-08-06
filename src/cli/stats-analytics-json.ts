/**
 * @module cli/stats-analytics-json
 *
 * Validates the compact JSON adapter used to keep the agent-facing stats CLI
 * contract bounded while preserving the fully typed SDK and MCP primitives.
 */
import type { StatsCommandOptions } from "./commands/stats.js";
import { EXIT_CODE, PmCliError } from "../sdk/runtime-primitives.js";

const STATS_ANALYTICS_JSON_FIELDS = new Map<
  string,
  "boolean" | "direction" | "number" | "string" | "string_array"
>([
  ["measurements", "boolean"],
  ["metric", "string"],
  ["measurementLimit", "number"],
  ["observe", "string_array"],
  ["direction", "direction"],
  ["measurementSource", "string"],
  ["measurementItem", "string"],
  ["measurementRevision", "string"],
  ["author", "string"],
  ["message", "string"],
  ["provenanceCoverage", "boolean"],
  ["fleetAttribution", "boolean"],
  ["since", "string"],
  ["eventLimit", "number"],
  ["minimumSample", "number"],
]);
const IMPROVEMENT_DIRECTIONS: ReadonlySet<unknown> = new Set([
  "higher",
  "lower",
  "target",
]);
const ACCEPTED_STATS_ANALYTICS_JSON_FIELDS = [
  ...STATS_ANALYTICS_JSON_FIELDS.keys(),
]
  .sort((left, right) => left.localeCompare(right))
  .join(", ");

/** Validate one field against the compact analytics JSON type contract. */
function isStatsAnalyticsValue(
  expected:
    | (typeof STATS_ANALYTICS_JSON_FIELDS extends Map<string, infer Value>
        ? Value
        : never)
    | undefined,
  value: unknown,
): boolean {
  if (expected === "boolean") return typeof value === "boolean";
  if (expected === "string") return typeof value === "string";
  if (expected === "number") return typeof value === "number";
  if (expected === "string_array") {
    return (
      Array.isArray(value) && value.every((entry) => typeof entry === "string")
    );
  }
  return expected === "direction" && IMPROVEMENT_DIRECTIONS.has(value);
}

/** Parse and strictly validate the compact CLI improvement-analytics payload. */
export function parseStatsAnalyticsJson(
  input: string | undefined,
): StatsCommandOptions {
  if (input === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch (error) {
    throw new PmCliError(
      `--analytics must be valid JSON: ${String(error)}`,
      EXIT_CODE.USAGE,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PmCliError("--analytics must be a JSON object.", EXIT_CODE.USAGE);
  }
  for (const [key, value] of Object.entries(parsed)) {
    const expected = STATS_ANALYTICS_JSON_FIELDS.get(key);
    if (!isStatsAnalyticsValue(expected, value)) {
      throw new PmCliError(
        expected === undefined
          ? `Unknown --analytics field "${key}". Accepted fields: ${ACCEPTED_STATS_ANALYTICS_JSON_FIELDS}.`
          : `--analytics field "${key}" must be ${expected.replace("_", " ")}.`,
        EXIT_CODE.USAGE,
      );
    }
  }
  return parsed as StatsCommandOptions;
}
