/**
 * Fix planning for `pm validate --auto-fix` / `--prune-missing` (pm-c3sz,
 * pm-8jss, pm-0v2m).
 *
 * Pure module: planners turn check findings into declarative
 * {@link ValidateFixRecord}s; the validate command decides whether to apply
 * them (apply mode), preview them (`--dry-run`), or withhold gated fixes
 * (lifecycle structural changes require an explicit `--fix-scope lifecycle`).
 *
 * Safety invariants:
 * - Every planned fix is deterministic and non-destructive: it only sets a
 *   derivable field value or removes a stale LINK (never a real file).
 * - No fix ever closes, deletes, or cancels an item.
 * - Lifecycle fixes (reparent / unset parent) are structural, so they are
 *   planned with `gate: "lifecycle"` and only applied when that scope was
 *   explicitly granted.
 */

import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { resolveEstimateDefaultMinutes } from "./estimate-defaults.js";

/** Restricts validate fix check values accepted by command, SDK, and storage contracts. */
export type ValidateFixCheck =
  | "metadata"
  | "resolution"
  | "lifecycle"
  | "files";

/** Restricts validate fix kind values accepted by command, SDK, and storage contracts. */
export type ValidateFixKind =
  | "set_resolution"
  | "set_close_reason"
  | "set_estimate"
  | "reparent"
  | "unset_parent"
  | "prune_file_link"
  | "prune_doc_link";

/** Restricts validate fix scope values accepted by command, SDK, and storage contracts. */
export type ValidateFixScope =
  | "metadata"
  | "resolution"
  | "estimates"
  | "lifecycle";

/** Scopes auto-applied without an explicit `--fix-scope` (safe field backfills). */
export const DEFAULT_GRANTED_FIX_SCOPES: readonly ValidateFixScope[] = [
  "metadata",
  "resolution",
];

/** Scopes accepted by `--fix-scope`. `estimates` and `lifecycle` are opt-in: estimate backfills are heuristic per-type guesses (not derived facts) and lifecycle changes are structural, so neither is granted by default. */
export const SUPPORTED_FIX_SCOPES: readonly ValidateFixScope[] = [
  "metadata",
  "resolution",
  "estimates",
  "lifecycle",
];

/** Documents the validate fix record payload exchanged by command, SDK, and package integrations. */
export interface ValidateFixRecord {
  /** Item the fix targets. */
  item_id: string;
  /** Validate check the finding came from. */
  check: ValidateFixCheck;
  /** Item-metadata field (or link list) the fix changes. */
  field: string;
  /** Declarative fix kind the applier dispatches on. */
  kind: ValidateFixKind;
  /** Equivalent standalone `pm` command for the fix. */
  command: string;
  /** New value for set-field fixes. */
  value?: string;
  /** Stale link path for prune fixes. */
  path?: string;
  /** Target parent id for reparent fixes. */
  parent_id?: string;
  /** Fix scope the `--fix-scope` allowlist must grant for the fix to be applied. Every `--auto-fix` record carries one (the granted default is metadata+resolution; lifecycle must be named explicitly). Absent only on `--prune-missing` records, which are governed by their own flag. */
  gate?: ValidateFixScope;
}

/** Default resolution backfilled onto closed items with no derivable source text. */
const DEFAULT_RESOLUTION_BACKFILL_VALUE = "completed";

function quoteForCommand(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function toMeaningfulValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** Documents the resolution backfill row payload exchanged by command, SDK, and package integrations. */
export interface ResolutionBackfillRow {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Resolution-check missing field keys for this closed item. */
  missing_fields: readonly string[];
  /** The item's close_reason, when present (preferred derivation source). */
  close_reason?: string;
}

/** Plan resolution backfills for closed items flagged by the resolution check. Only the `resolution` field is mechanical enough to auto-fix: it derives from the item's own `close_reason` when present and falls back to the `"completed"` default. `expected_result` / `actual_result` stay hint-only — no deterministic source text exists for them. */
export function planResolutionBackfillFixes(
  rows: readonly ResolutionBackfillRow[],
): ValidateFixRecord[] {
  const fixes: ValidateFixRecord[] = [];
  for (const row of rows) {
    if (!row.missing_fields.includes("resolution")) {
      continue;
    }
    const value =
      toMeaningfulValue(row.close_reason) ?? DEFAULT_RESOLUTION_BACKFILL_VALUE;
    fixes.push({
      item_id: row.id,
      check: "resolution",
      field: "resolution",
      kind: "set_resolution",
      value,
      command: `pm update ${row.id} --resolution ${quoteForCommand(value)}`,
      gate: "resolution",
    });
  }
  return fixes;
}

/** Documents the close reason backfill row payload exchanged by command, SDK, and package integrations. */
export interface CloseReasonBackfillRow {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** The item's resolution, when present (the only derivation source). */
  resolution?: string;
}

/** Plan close_reason backfills for closed items flagged by the metadata check. Only derivable when the item already carries a resolution; items missing both stay hint-only (any synthesized reason would be fabricated, not derived). */
export function planCloseReasonBackfillFixes(
  rows: readonly CloseReasonBackfillRow[],
): ValidateFixRecord[] {
  const fixes: ValidateFixRecord[] = [];
  for (const row of rows) {
    const value = toMeaningfulValue(row.resolution);
    if (value === undefined) {
      continue;
    }
    fixes.push({
      item_id: row.id,
      check: "metadata",
      field: "close_reason",
      kind: "set_close_reason",
      value,
      command: `pm update ${row.id} --close-reason ${quoteForCommand(value)}`,
      gate: "metadata",
    });
  }
  return fixes;
}

/** Documents the estimate backfill row payload exchanged by command, SDK, and package integrations. */
export interface EstimateBackfillRow {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Item type, used to resolve the per-type default estimate. */
  type?: string;
}

/** Plan estimate backfills for items flagged by the metadata check as missing `estimated_minutes` (GH-212). The value is a config-driven per-type default (overrides > built-in map > fallback), never a derived fact — so these fixes carry `gate: "estimates"`, an opt-in scope that is NOT granted by default. `overrides` is the already-normalized `validation.estimate_defaults_by_type` map; pass `undefined`/`{}` to use the built-in defaults. */
export function planEstimateBackfillFixes(
  rows: readonly EstimateBackfillRow[],
  overrides?: Readonly<Record<string, number>>,
): ValidateFixRecord[] {
  return rows.map((row) => {
    const minutes = resolveEstimateDefaultMinutes(row.type, overrides);
    return {
      item_id: row.id,
      check: "metadata" as const,
      field: "estimated_minutes",
      kind: "set_estimate" as const,
      value: String(minutes),
      command: `pm update ${row.id} --estimate ${minutes}`,
      gate: "estimates" as const,
    };
  });
}

/** Documents the terminal parent fix row payload exchanged by command, SDK, and package integrations. */
export interface TerminalParentFixRow {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports parent id for this contract. */
  parent_id: string;
  /** The terminal parent's own parent, when one exists. */
  grandparent_id?: string;
  /** True when the grandparent exists and is NOT terminal (safe reparent target). */
  grandparent_active?: boolean;
}

/** Plan lifecycle fixes for active items whose parent is terminal (pm-8jss / GH-168). When the terminal parent has an active grandparent, the child is reparented one level up (it stays inside the same hierarchy); otherwise the parent link is cleared so the item surfaces as unparented active work. Either way the item itself is never closed or mutated beyond `parent` — and every fix carries `gate: "lifecycle"` so it is only applied under an explicit `--fix-scope lifecycle`. */
export function planTerminalParentFixes(
  rows: readonly TerminalParentFixRow[],
): ValidateFixRecord[] {
  return rows.map((row) => {
    if (row.grandparent_id !== undefined && row.grandparent_active === true) {
      return {
        item_id: row.id,
        check: "lifecycle" as const,
        field: "parent",
        kind: "reparent" as const,
        parent_id: row.grandparent_id,
        command: `pm update ${row.id} --parent ${row.grandparent_id}`,
        gate: "lifecycle" as const,
      };
    }
    return {
      item_id: row.id,
      check: "lifecycle" as const,
      field: "parent",
      kind: "unset_parent" as const,
      command: `pm update ${row.id} --unset parent`,
      gate: "lifecycle" as const,
    };
  });
}

/** Documents the stale link prune row payload exchanged by command, SDK, and package integrations. */
export interface StaleLinkPruneRow {
  /** Value that configures or reports item id for this contract. */
  item_id: string;
  /** Filesystem path used for path resolution. */
  path: string;
  /** Value that configures or reports link kind for this contract. */
  link_kind: "files" | "docs";
  /** Value that configures or reports classification for this contract. */
  classification: "moved" | "deleted";
}

/** Plan link prunes for `--prune-missing` (pm-0v2m / GH-184). Only links whose stale path classified as `deleted` are pruned; `moved` links keep their relink candidates in the files-check details instead of being dropped, so recoverable link information is never destroyed. Link removal only — real files are never touched. */
export function planStaleLinkPruneFixes(
  rows: readonly StaleLinkPruneRow[],
): ValidateFixRecord[] {
  const fixes: ValidateFixRecord[] = [];
  for (const row of rows) {
    if (row.classification !== "deleted") {
      continue;
    }
    const noun = row.link_kind === "files" ? "files" : "docs";
    fixes.push({
      item_id: row.item_id,
      check: "files",
      field: row.link_kind,
      kind: row.link_kind === "files" ? "prune_file_link" : "prune_doc_link",
      path: row.path,
      command: `pm ${noun} ${row.item_id} --remove ${quoteForCommand(row.path)}`,
    });
  }
  return fixes;
}

/** Resolve the granted `--fix-scope` set (repeatable and/or comma-separated). With no explicit scopes the safe field-backfill scopes (metadata, resolution) are granted; lifecycle must always be named explicitly. Unknown values fail fast with the supported list. */
export function resolveGrantedFixScopes(
  rawScopes: readonly string[] | undefined,
): Set<ValidateFixScope> {
  const tokens = (rawScopes ?? [])
    .flatMap((raw) => raw.split(","))
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0);
  if (tokens.length === 0) {
    if (rawScopes !== undefined && rawScopes.length > 0) {
      throw new PmCliError(
        `--fix-scope values must not be empty. Supported values: ${SUPPORTED_FIX_SCOPES.join(", ")}.`,
        EXIT_CODE.USAGE,
      );
    }
    return new Set(DEFAULT_GRANTED_FIX_SCOPES);
  }
  const granted = new Set<ValidateFixScope>();
  for (const raw of tokens) {
    const normalized = raw.toLowerCase().replaceAll("-", "_");
    if ((SUPPORTED_FIX_SCOPES as readonly string[]).includes(normalized)) {
      granted.add(normalized as ValidateFixScope);
      continue;
    }
    throw new PmCliError(
      `Unknown --fix-scope value "${raw}". Supported values: ${SUPPORTED_FIX_SCOPES.join(", ")}.`,
      EXIT_CODE.USAGE,
    );
  }
  return granted;
}

/** Split a fix plan into the records that may be applied under the granted scopes and the gated records that were withheld. `--fix-scope` is an exact allowlist: every `--auto-fix` record requires its gate scope in `granted`. Ungated records (`--prune-missing` link prunes, governed by their own flag) are always applicable. */
export function partitionFixesByGrant(
  fixes: readonly ValidateFixRecord[],
  granted: ReadonlySet<ValidateFixScope>,
): { applicable: ValidateFixRecord[]; gated: ValidateFixRecord[] } {
  const applicable: ValidateFixRecord[] = [];
  const gated: ValidateFixRecord[] = [];
  for (const fix of fixes) {
    if (fix.gate !== undefined && !granted.has(fix.gate)) {
      gated.push(fix);
    } else {
      applicable.push(fix);
    }
  }
  return { applicable, gated };
}

/** Compact serialization of a fix for planned/applied output rows. */
export function toFixOutputRow(
  fix: ValidateFixRecord,
): Record<string, unknown> {
  return {
    item_id: fix.item_id,
    check: fix.check,
    field: fix.field,
    command: fix.command,
    ...(fix.gate !== undefined ? { gate: fix.gate } : {}),
  };
}
