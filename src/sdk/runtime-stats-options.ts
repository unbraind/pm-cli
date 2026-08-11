/**
 * @module sdk/runtime-stats-options
 *
 * Maps the flat SDK/MCP action transport into the typed stats command options
 * shared by the CLI and direct SDK surfaces.
 */
import type { StatsCommandOptions } from "./stats.js";
import { readRuntimeString, readRuntimeStringArray } from "./runtime-input.js";

/** Convert a flat runtime option bag into the canonical typed stats payload. */
export function statsCommandOptionsFromRuntime(
  options: Record<string, unknown>,
): StatsCommandOptions {
  return {
    includeEmpty: options.includeEmpty === true,
    storage: options.storage === true,
    metadataCoverage: options.metadataCoverage === true,
    fieldUtilization: options.fieldUtilization === true,
    byAssignee: options.byAssignee === true,
    byTag: options.byTag === true,
    byPriority: options.byPriority === true,
    tagPrefix:
      typeof options.tagPrefix === "string" ? options.tagPrefix : undefined,
    measurements: options.measurements === true,
    metric: readRuntimeString(options, "metric"),
    measurementLimit:
      typeof options.measurementLimit === "number"
        ? options.measurementLimit
        : undefined,
    observe: readRuntimeStringArray(options.observe),
    direction:
      typeof options.improvementDirection === "string"
        ? (options.improvementDirection as StatsCommandOptions["direction"])
        : undefined,
    measurementSource: readRuntimeString(options, "measurementSource"),
    measurementItem: readRuntimeString(options, "measurementItem"),
    measurementRevision: readRuntimeString(options, "measurementRevision"),
    author: readRuntimeString(options, "author"),
    message: readRuntimeString(options, "message"),
    provenanceCoverage: options.provenanceCoverage === true,
    fleetAttribution: options.fleetAttribution === true,
    since: readRuntimeString(options, "since"),
    eventLimit:
      typeof options.eventLimit === "number" ? options.eventLimit : undefined,
    minimumSample:
      typeof options.minimumSample === "number"
        ? options.minimumSample
        : undefined,
  };
}
