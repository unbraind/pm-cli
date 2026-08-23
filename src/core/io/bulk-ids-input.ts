/**
 * @module core/io/bulk-ids-input
 *
 * Normalizes bulk item-id selectors supplied inline, through stdin, or from an
 * argv-referenced file. Presentation layers can share the parser while MCP and
 * embedded SDK callers keep passing transport-native arrays.
 */
import { readFile } from "node:fs/promises";

import { createStdinTokenResolver } from "../item/parse.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";

/** File reader injected by tests or host runtimes that virtualize argv files. */
export type BulkIdsFileReader = (path: string) => Promise<string>;

/** Stdin reader injected by tests or hosts that do not use process stdin. */
export type BulkIdsStdinReader = (optionName: string) => Promise<string>;

/** Dependencies used to resolve CLI-only external ID sources. */
export interface BulkIdsInputReaders {
  /** Read a UTF-8 `@path` payload. */
  readFile?: BulkIdsFileReader;
  /** Read the complete stdin payload for `-`. */
  readStdin?: BulkIdsStdinReader;
}

const defaultFileReader: BulkIdsFileReader = (path) => readFile(path, "utf8");

const defaultStdinReader: BulkIdsStdinReader = async (optionName) =>
  (await createStdinTokenResolver().resolveValue("-", optionName)) as string;

/** Parse comma- or line-delimited item IDs with stable first-seen deduplication. */
export function parseBulkIdsText(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,\r\n]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
}

/** Normalize SDK/MCP scalar-or-array ID input into the list query's CSV form. */
export function normalizeBulkIdsValue(
  value: string | readonly string[] | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const ids = Array.isArray(value)
    ? parseBulkIdsText(value.join("\n"))
    : parseBulkIdsText(value as string);
  return ids.length > 0 ? ids.join(",") : "";
}

/**
 * Resolve one CLI `--ids` value. `-` reads newline/comma-delimited stdin and
 * `@path` reads the same grammar from a UTF-8 file; ordinary argv text accepts
 * the grammar inline. The return value is canonical CSV for existing list
 * filtering and unmatched-id accounting.
 */
export async function resolveCliBulkIdsInput(
  value: string | undefined,
  optionName = "--ids",
  readers: BulkIdsInputReaders = {},
): Promise<string | undefined> {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  let raw = value;
  try {
    if (trimmed === "-") {
      raw = await (readers.readStdin ?? defaultStdinReader)(optionName);
    } else if (trimmed.startsWith("@")) {
      const path = trimmed.slice(1).trim();
      if (path.length === 0) {
        throw new PmCliError(
          `${optionName} @path requires a non-empty file path.`,
          EXIT_CODE.USAGE,
          {
            code: "bulk_ids_input_missing_path",
            required: `Pass ${optionName} @<path>, ${optionName} -, or inline IDs.`,
          },
        );
      }
      raw = await (readers.readFile ?? defaultFileReader)(path);
    }
  } catch (error: unknown) {
    if (error instanceof PmCliError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new PmCliError(
      `${optionName} could not read ${trimmed === "-" ? "stdin" : `"${trimmed.slice(1).trim()}"`}: ${detail}`,
      EXIT_CODE.NOT_FOUND,
      {
        code: "bulk_ids_input_unreadable",
        required: `Provide readable newline/comma-delimited IDs via ${optionName} -, ${optionName} @<path>, or inline argv text.`,
        nextSteps: [
          `Retry with inline IDs: ${optionName} pm-a1b2,pm-c3d4`,
          `Or pipe IDs: pm list --id-only | <selector> | pm update-many ${optionName} - --dry-run`,
        ],
      },
    );
  }
  const normalized = normalizeBulkIdsValue(raw);
  if (normalized !== "") {
    return normalized;
  }
  throw new PmCliError(
    `${optionName} requires at least one non-empty item ID.`,
    EXIT_CODE.USAGE,
    {
      code: "bulk_ids_input_empty",
      required: `Provide one or more comma- or newline-delimited IDs through argv, stdin, or @path.`,
    },
  );
}
