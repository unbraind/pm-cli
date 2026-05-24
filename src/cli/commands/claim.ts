import { pathExists } from "../../core/fs/fs-utils.js";
import { resolveRuntimeStatusRegistry, statusIsTerminal } from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { mutateItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { resolveAuthor } from "../../core/shared/author.js";
import { wrapOwnershipConflict } from "./annotation-command.js";

export interface ClaimResult {
  item: Record<string, unknown>;
  claimed_by: string;
  previous_assignee: string | null;
  forced: boolean;
  skipped?: boolean;
  warnings?: string[];
}

export interface ReleaseResult {
  item: Record<string, unknown>;
  released_by: string;
  previous_assignee: string | null;
  audit_release: boolean;
  forced: boolean;
}

export interface ClaimMutationOptions {
  author?: string;
  message?: string;
  ifAvailable?: boolean;
}

export interface ReleaseMutationOptions extends ClaimMutationOptions {
  allowAuditRelease?: boolean;
}

export async function runClaim(
  id: string,
  force: boolean,
  global: GlobalOptions,
  options: ClaimMutationOptions = {},
): Promise<ClaimResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const author = resolveAuthor(options.author, settings.author_default);
  let previousAssignee: string | null = null;
  let skipped = false;
  const mutationWarnings: string[] = [];

  const result = await mutateItem({
    pmRoot,
    settings,
    id,
    op: "claim",
    author,
    message: options.message,
    force,
    mutate(document) {
      previousAssignee = document.metadata.assignee ?? null;
      if (statusIsTerminal(document.metadata.status, statusRegistry) && !force) {
        throw new PmCliError(`Cannot claim terminal item ${document.metadata.id} without --force`, EXIT_CODE.CONFLICT);
      }
      const heldByOther = previousAssignee !== null && previousAssignee !== author;
      if (heldByOther && options.ifAvailable === true) {
        skipped = true;
        mutationWarnings.push(`claim_skipped_held_by:${previousAssignee}`);
        return { changedFields: [] };
      }
      if (heldByOther) {
        mutationWarnings.push(`claim_takeover:${previousAssignee}->${author}`);
      }
      document.metadata.assignee = author;
      return { changedFields: ["assignee"], warnings: mutationWarnings };
    },
  });

  return {
    item: result.item as unknown as Record<string, unknown>,
    claimed_by: skipped && previousAssignee !== null ? previousAssignee : author,
    previous_assignee: previousAssignee,
    forced: force,
    ...(skipped ? { skipped: true } : {}),
    ...(mutationWarnings.length > 0 ? { warnings: mutationWarnings } : {}),
  };
}

export async function runRelease(
  id: string,
  force: boolean,
  global: GlobalOptions,
  options: ReleaseMutationOptions = {},
): Promise<ReleaseResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const author = resolveAuthor(options.author, settings.author_default);
  let previousAssignee: string | null = null;

  let result: Awaited<ReturnType<typeof mutateItem>>;
  try {
    result = await mutateItem({
      pmRoot,
      settings,
      id,
      op: "release",
      author,
      message: options.message,
      force,
      bypassAssigneeConflict: Boolean(options.allowAuditRelease),
      mutate(document) {
        previousAssignee = document.metadata.assignee ?? null;
        if (!previousAssignee) {
          return { changedFields: [] };
        }
        delete document.metadata.assignee;
        return { changedFields: ["assignee"] };
      },
    });
  } catch (error: unknown) {
    wrapOwnershipConflict(error, {
      required: "For audited non-owner handoffs, prefer --allow-audit-release before considering --force.",
      examples: ['pm release pm-a1b2 --author "reviewer" --allow-audit-release'],
      nextSteps: [
        "Use --allow-audit-release for append-only release handoffs that only clear assignee metadata.",
        "Use --force only when an explicit override is approved for broader ownership conflicts.",
      ],
    });
  }

  return {
    item: result.item as unknown as Record<string, unknown>,
    released_by: author,
    previous_assignee: previousAssignee,
    audit_release: options.allowAuditRelease === true,
    forced: force,
  };
}
