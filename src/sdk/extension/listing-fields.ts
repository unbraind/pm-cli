/**
 * @module sdk/extension/listing-fields
 *
 * One `--fields` contract for every package listing (pm-gh1777): `list`
 * (`inventory`), `explore`, `manage` and `catalog` each take a comma-separated
 * subset of their row keys, refuse an unknown key with the listing's whole
 * domain, and keep the requested order.
 */
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";

/** Split `--fields` into distinct keys; undefined when the option is absent. */
export function parseListingFields(raw: unknown, allowed: readonly string[], listing: string): string[] | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  const fields = [...new Set(String(raw).split(",").map((field) => field.trim()).filter((field) => field.length > 0))];
  if (fields.length === 0) {
    throw new PmCliError(`Package ${listing} --fields requires a comma-separated list of field names`, EXIT_CODE.USAGE);
  }
  const unknown = fields.filter((field) => !allowed.includes(field));
  if (unknown.length > 0) {
    // The "must be one of a|b|c" spelling is what recovery reads the legal domain from.
    throw new PmCliError(`Package ${listing} --fields must be one of ${allowed.join("|")}; unknown: ${unknown.join(", ")}`, EXIT_CODE.USAGE, {
      examples: [`pm package ${listing} --fields ${allowed.slice(0, 3).join(",")}`],
    });
  }
  return fields;
}

/** Keep only the requested keys of each row, in the requested order; a key a row lacks reads as null. */
export function projectListingRows(rows: ReadonlyArray<object>, fields: readonly string[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(fields.map((field) => [field, (row as Record<string, unknown>)[field] ?? null])));
}

/** Row keys an explore or manage row can carry, in their emitted order. */
export const EXPLORE_MANAGE_ROW_FIELDS = [
  "name", "directory", "version", "entry", "scope", "active", "enabled", "runtime_active", "activation_status",
  "managed", "source", "update_available", "last_update_check_at", "last_update_remote_version", "last_update_remote_commit",
  "update_error", "update_check_timeout_ms", "update_check_status", "update_check_reason", "command_paths", "action_paths",
  "contributions",
] as const;

/**
 * Shape explore and manage rows: `--fields` selects any subset; without it the
 * embedded `contributions` map stays out, because `pm package describe` maps
 * every registered surface and the map dominated each row (pm-gh1777).
 */
export function projectExploreManageRows(rows: ReadonlyArray<object>, rawFields: unknown, listing: string): object[] {
  const fields = parseListingFields(rawFields, EXPLORE_MANAGE_ROW_FIELDS, listing);
  if (fields !== undefined) return projectListingRows(rows, fields);
  return rows.map((row) => {
    const { contributions: _contributions, ...rest } = row as Record<string, unknown>;
    return rest;
  });
}
