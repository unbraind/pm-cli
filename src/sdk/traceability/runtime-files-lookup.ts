/**
 * @module sdk/traceability/runtime-files-lookup
 *
 * Projects transport-neutral action values into reverse source lookup options.
 */
import type { FilesLookupOptions } from "../files.js";
import { parseSourceLineRange } from "./source-traceability.js";

/** Convert bounded MCP/action values into the public files lookup contract. */
export function runtimeFilesLookupOptions(
  options: Readonly<Record<string, unknown>>,
  paths: string[],
  parseInteger: (value: unknown, label: string) => number | undefined,
): FilesLookupOptions {
  let lineRange: FilesLookupOptions["lineRange"];
  if (typeof options.lines === "string") {
    lineRange = parseSourceLineRange(options.lines);
  } else if (options.lineRange !== undefined) {
    if (
      options.lineRange === null ||
      typeof options.lineRange !== "object" ||
      Array.isArray(options.lineRange)
    ) {
      throw new RangeError(
        "Source line range must be an object with numeric start and end values.",
      );
    }
    lineRange = parseSourceLineRange(
      `${String(Reflect.get(options.lineRange, "start"))}:${String(Reflect.get(options.lineRange, "end"))}`,
    );
  }
  return {
    paths,
    scope:
      options.scope === "project" || options.scope === "global"
        ? options.scope
        : undefined,
    limit: parseInteger(options.limit, "files lookup limit"),
    offset: parseInteger(options.offset, "files lookup offset"),
    noTruncate: options.noTruncate === true,
    strictRead: options.strictRead === true,
    explain: options.explain === true,
    lineRange,
    decisionDepth: parseInteger(
      options.decisionDepth,
      "files lookup decision depth",
    ),
  };
}
