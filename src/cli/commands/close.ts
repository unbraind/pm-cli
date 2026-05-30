import { pathExists } from "../../core/fs/fs-utils.js";
import { toItemRecord } from "../../core/item/item-record.js";
import { isTerminalStatus } from "../../core/item/status.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { resolveRuntimeStatusRegistry, type RuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { listAllFrontMatterLight, mutateItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemFrontMatter } from "../../types/index.js";

export interface CloseCommandOptions {
  author?: string;
  message?: string;
  validateClose?: string;
  force?: boolean;
  // pm-fl0c #11 (2026-05-28): allow setting the three closure validation
  // fields inline on `pm close` so agents do not have to issue a prior
  // `pm update` just to satisfy --validate-close warn|strict. These map 1:1
  // to ItemFrontMatter.{resolution,expected_result,actual_result}.
  resolution?: string;
  expectedResult?: string;
  actualResult?: string;
}

export interface CloseResult {
  item: Record<string, unknown>;
  changed_fields: string[];
  warnings: string[];
}

function toAuthor(candidate: string | undefined, defaultAuthor: string): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? defaultAuthor;
  const trimmed = resolved.trim();
  return trimmed || "unknown";
}

function ensureCloseReason(reasonText: string): string {
  const reason = reasonText.trim();
  if (reason.length === 0) {
    throw new PmCliError("Close reason text must not be empty", EXIT_CODE.USAGE);
  }
  return reason;
}

type ValidateCloseMode = "off" | "warn" | "strict";

const CLOSE_VALIDATION_FIELDS: Array<{ key: keyof Pick<ItemFrontMatter, "resolution" | "expected_result" | "actual_result">; label: string }> = [
  { key: "resolution", label: "resolution" },
  { key: "expected_result", label: "expected_result" },
  { key: "actual_result", label: "actual_result" },
];

function parseValidateCloseMode(raw: string | undefined): ValidateCloseMode | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0 || normalized === "warn") {
    return "warn";
  }
  if (normalized === "off" || normalized === "none" || normalized === "disabled") {
    return "off";
  }
  if (normalized === "strict") {
    return "strict";
  }
  throw new PmCliError(`Invalid --validate-close mode "${raw}" (expected "off", "warn", or "strict")`, EXIT_CODE.USAGE);
}

function findMissingCloseValidationFields(frontMatter: ItemFrontMatter): string[] {
  const missing: string[] = [];
  for (const field of CLOSE_VALIDATION_FIELDS) {
    const rawValue = frontMatter[field.key];
    if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
      missing.push(field.label);
    }
  }
  return missing;
}

async function findActiveChildIds(
  pmRoot: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  parentId: string,
  statusRegistry: RuntimeStatusRegistry,
): Promise<string[]> {
  const typeRegistry = resolveItemTypeRegistry(settings);
  const items = await listAllFrontMatterLight(
    pmRoot,
    settings.item_format,
    typeRegistry.type_to_folder,
    undefined,
    settings.schema,
  );
  return items
    .filter((item) => item.parent === parentId && !isTerminalStatus(item.status, statusRegistry))
    .map((item) => item.id)
    .sort((left, right) => left.localeCompare(right));
}

export async function runClose(
  id: string,
  closeReasonText: string,
  options: CloseCommandOptions,
  global: GlobalOptions,
): Promise<CloseResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const author = toAuthor(options.author, settings.author_default);
  const closeReason = ensureCloseReason(closeReasonText);
  const validateCloseMode = parseValidateCloseMode(options.validateClose) ?? settings.governance.close_validation_default;
  // C3 (pm-fu5d): scan for active children even under minimal governance so
  // closing a parent is never silently orphaning — off mode emits an
  // informational note instead of the warn/strict validation warning.
  const activeChildIds = await findActiveChildIds(pmRoot, settings, id, statusRegistry);

  const result = await mutateItem({
    pmRoot,
    settings,
    id,
    op: "close",
    author,
    message: options.message,
    force: options.force,
    mutate(document) {
      if (isTerminalStatus(document.metadata.status, statusRegistry) && !options.force) {
        throw new PmCliError(`Item ${document.metadata.id} is already terminal; use --force to close again.`, EXIT_CODE.CONFLICT);
      }
      const mutationWarnings: string[] = [];
      // pm-fl0c #11: apply inline closure fields BEFORE the validation pass so
      // a single `pm close <id> "reason" --resolution "..."` call satisfies
      // strict validation without a prior pm update. Only meaningful trimmed
      // text writes; an empty/whitespace value is a no-op rather than a clear.
      const inlineCloseFields: Array<{ option: string | undefined; key: "resolution" | "expected_result" | "actual_result" }> = [
        { option: options.resolution, key: "resolution" },
        { option: options.expectedResult, key: "expected_result" },
        { option: options.actualResult, key: "actual_result" },
      ];
      for (const { option, key } of inlineCloseFields) {
        if (typeof option !== "string") continue;
        const trimmed = option.trim();
        if (trimmed.length === 0) continue;
        document.metadata[key] = trimmed;
      }
      if (validateCloseMode !== "off") {
        const missingFields = findMissingCloseValidationFields(document.metadata);
        if (missingFields.length > 0) {
          if (validateCloseMode === "strict") {
            throw new PmCliError(
              `Cannot close item ${document.metadata.id}: missing ${missingFields.join(", ")}. Populate fields or use --validate-close warn.`,
              EXIT_CODE.USAGE,
            );
          }
          mutationWarnings.push(`close_validation_missing_fields:${document.metadata.id}:${missingFields.join(",")}`);
        }
        if (activeChildIds.length > 0) {
          if (validateCloseMode === "strict") {
            throw new PmCliError(
              `Cannot close item ${document.metadata.id}: active child items remain open (${activeChildIds.join(", ")}). Close, cancel, or re-parent them first, or use --validate-close warn.`,
              EXIT_CODE.USAGE,
            );
          }
          mutationWarnings.push(`close_validation_active_children:${document.metadata.id}:${activeChildIds.join(",")}`);
        }
      } else if (activeChildIds.length > 0) {
        // C3: minimal governance (validate-close off) should still tell the
        // agent it just closed a parent with open children, without blocking.
        mutationWarnings.push(`closed_with_active_children:${document.metadata.id}:${activeChildIds.join(",")}`);
      }

      document.metadata.status = statusRegistry.close_status;
      document.metadata.close_reason = closeReason;

      const changedFields = ["status", "close_reason"];
      for (const { option, key } of inlineCloseFields) {
        if (typeof option === "string" && option.trim().length > 0) {
          changedFields.push(key);
        }
      }
      if (document.metadata.assignee !== undefined) {
        delete document.metadata.assignee;
        changedFields.push("assignee");
      }

      // C4 (pm-fu5d): a terminal item is no longer blocked. Clear every active
      // blocker signal independently — scalar blocked_by, blocked_reason, and the
      // blocked_by dependency edges (kept consistent with the kyd6 invariant) —
      // even if only some are present (e.g. an orphaned edge or a stale
      // blocked_reason left by manual edits), so closed work stops surfacing in
      // blockers views, and annotate the cleanup.
      const previousBlockedBy =
        typeof document.metadata.blocked_by === "string" ? document.metadata.blocked_by.trim() : "";
      const existingDeps = document.metadata.dependencies ?? [];
      const blockedByEdge = existingDeps.find((dep) => dep.kind === "blocked_by");
      const hadBlockedReason = document.metadata.blocked_reason !== undefined;
      if (previousBlockedBy.length > 0 || blockedByEdge !== undefined || hadBlockedReason) {
        if (previousBlockedBy.length > 0) {
          delete document.metadata.blocked_by;
          changedFields.push("blocked_by");
        }
        if (hadBlockedReason) {
          delete document.metadata.blocked_reason;
          changedFields.push("blocked_reason");
        }
        if (blockedByEdge !== undefined) {
          const remainingDeps = existingDeps.filter((dep) => dep.kind !== "blocked_by");
          if (remainingDeps.length > 0) {
            document.metadata.dependencies = remainingDeps;
          } else {
            delete document.metadata.dependencies;
          }
          changedFields.push("dependencies");
        }
        const reportedBlocker = previousBlockedBy || blockedByEdge?.id || "unknown";
        mutationWarnings.push(`closed_cleared_blocked_by:${document.metadata.id}:${reportedBlocker}`);
      }

      return {
        changedFields,
        ...(mutationWarnings.length > 0 ? { warnings: mutationWarnings } : {}),
      };
    },
  });

  return {
    item: toItemRecord(result.item),
    changed_fields: result.changedFields,
    warnings: result.warnings,
  };
}
