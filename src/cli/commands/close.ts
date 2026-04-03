import { pathExists } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { mutateItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemFrontMatter, ItemStatus } from "../../types/index.js";

export interface CloseCommandOptions {
  author?: string;
  message?: string;
  validateClose?: string;
  force?: boolean;
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

function isTerminal(status: ItemStatus): boolean {
  return status === "closed" || status === "canceled";
}

type ValidateCloseMode = "warn" | "strict";

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
  if (normalized === "strict") {
    return "strict";
  }
  throw new PmCliError(`Invalid --validate-close mode "${raw}" (expected "warn" or "strict")`, EXIT_CODE.USAGE);
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
  const author = toAuthor(options.author, settings.author_default);
  const closeReason = ensureCloseReason(closeReasonText);
  const validateCloseMode = parseValidateCloseMode(options.validateClose);

  const result = await mutateItem({
    pmRoot,
    settings,
    id,
    op: "close",
    author,
    message: options.message,
    force: options.force,
    mutate(document) {
      if (isTerminal(document.front_matter.status) && !options.force) {
        throw new PmCliError(`Item ${document.front_matter.id} is already terminal; use --force to close again.`, EXIT_CODE.CONFLICT);
      }
      const mutationWarnings: string[] = [];
      if (validateCloseMode) {
        const missingFields = findMissingCloseValidationFields(document.front_matter);
        if (missingFields.length > 0) {
          if (validateCloseMode === "strict") {
            throw new PmCliError(
              `Cannot close item ${document.front_matter.id}: missing ${missingFields.join(", ")}. Populate fields or use --validate-close warn.`,
              EXIT_CODE.USAGE,
            );
          }
          mutationWarnings.push(
            `close_validation_missing_fields:${document.front_matter.id}:${missingFields.join(",")}`,
          );
        }
      }

      document.front_matter.status = "closed";
      document.front_matter.close_reason = closeReason;

      const changedFields = ["status", "close_reason"];
      if (document.front_matter.assignee !== undefined) {
        delete document.front_matter.assignee;
        changedFields.push("assignee");
      }

      return {
        changedFields,
        ...(mutationWarnings.length > 0 ? { warnings: mutationWarnings } : {}),
      };
    },
  });

  return {
    item: result.item as unknown as Record<string, unknown>,
    changed_fields: result.changedFields,
    warnings: result.warnings,
  };
}
