/**
 * @module cli/commands/claim
 *
 * Implements the pm claim command surface and its agent-facing runtime behavior.
 */
import { pathExists } from "../../core/fs/fs-utils.js";
import { resolveRuntimeStatusRegistry, statusIsTerminal } from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { toItemRecord } from "../../core/item/item-record.js";
import { mutateItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { resolveAuthor } from "../../core/shared/author.js";
import { wrapOwnershipConflict } from "./annotation-command.js";
import { runNext, type NextRecommendation, type NextOptions } from "./next.js";

/**
 * Documents the claim result payload exchanged by command, SDK, and package integrations.
 */
export interface ClaimResult {
  item: Record<string, unknown>;
  claimed_by: string;
  previous_assignee: string | null;
  forced: boolean;
  skipped?: boolean;
  warnings?: string[];
}

/** Result of atomically selecting and claiming the next caller-available item. */
export interface ClaimNextResult extends ClaimResult {
  recommendation: NextRecommendation;
  attempts: number;
}

/** Returns whether a failed claim lost the atomic test-and-set race. */
export function isAlreadyClaimedError(error: unknown): boolean {
  return error instanceof PmCliError && error.context?.code === "already_claimed_by";
}

type ClaimRunner = (
  id: string,
  force: boolean,
  global: GlobalOptions,
  options: ClaimMutationOptions,
) => Promise<ClaimResult>;

/**
 * Documents the release result payload exchanged by command, SDK, and package integrations.
 */
export interface ReleaseResult {
  item: Record<string, unknown>;
  released_by: string;
  previous_assignee: string | null;
  audit_release: boolean;
  forced: boolean;
}

/**
 * Documents the claim mutation options payload exchanged by command, SDK, and package integrations.
 */
export interface ClaimMutationOptions {
  author?: string;
  message?: string;
  ifAvailable?: boolean;
}

/**
 * Documents the release mutation options payload exchanged by command, SDK, and package integrations.
 */
export interface ReleaseMutationOptions extends ClaimMutationOptions {
  allowAuditRelease?: boolean;
}

/**
 * Implements run claim for the public runtime surface of this module.
 */
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
    skipNoop: true,
    mutate(document) {
      const currentAssignee = document.metadata.assignee;
      const currentAssigneeText = typeof currentAssignee === "string" ? currentAssignee : "";
      previousAssignee = currentAssigneeText.trim().length > 0 ? currentAssigneeText : null;
      if (statusIsTerminal(document.metadata.status, statusRegistry) && !force) {
        throw new PmCliError(`Cannot claim terminal item ${document.metadata.id} without --force`, EXIT_CODE.CONFLICT);
      }
      const heldByOther = previousAssignee !== null && previousAssignee !== author;
      if (heldByOther && options.ifAvailable === true) {
        skipped = true;
        mutationWarnings.push(`claim_skipped_held_by:${previousAssignee}`);
        return { changedFields: [] };
      }
      if (heldByOther && !force) {
        throw new PmCliError(
          `Item ${document.metadata.id} is already claimed by ${previousAssignee}. Use --force to take over, or --if-available to skip without failing.`,
          EXIT_CODE.CONFLICT,
          {
            code: "already_claimed_by",
            why: "Claim is an atomic test-and-set so parallel agents never proceed believing they own the same item.",
            nextSteps: [
              "Run pm next to pick a different unclaimed item.",
              "Re-run with --if-available to treat a held item as a no-op skip.",
              "Re-run with --force only when taking over the item is coordinated.",
            ],
          },
        );
      }
      if (heldByOther) {
        mutationWarnings.push(`claim_takeover:${previousAssignee}->${author}`);
      }
      document.metadata.assignee = author;
      return { changedFields: ["assignee"], warnings: mutationWarnings };
    },
  });

  return {
    item: toItemRecord(result.item),
    claimed_by: skipped && previousAssignee !== null ? previousAssignee : author,
    previous_assignee: previousAssignee,
    forced: force,
    ...(skipped ? { skipped: true } : {}),
    ...(mutationWarnings.length > 0 ? { warnings: mutationWarnings } : {}),
  };
}

/**
 * Selects ranked actionable work and claims the first candidate still available
 * under the item lock. Conflicts caused by parallel claimers advance to the next
 * candidate instead of returning a thundering-herd failure.
 */
export async function runClaimNext(
  force: boolean,
  global: GlobalOptions,
  options: ClaimMutationOptions = {},
  nextOptions: NextOptions = {},
): Promise<ClaimNextResult> {
  const next = await runNext({ ...nextOptions, limit: "10" }, global);
  const recommendations = [next.recommended, ...next.ready]
    .filter((entry): entry is NextRecommendation => entry !== null)
    .map((entry) => ({ ...entry, reasons: "reasons" in entry ? entry.reasons : ["ranked ready candidate"] }));
  return claimNextFromRecommendations(recommendations, force, global, options);
}

/** Claims the first still-available row from a pre-ranked recommendation set. */
export async function claimNextFromRecommendations(
  recommendations: NextRecommendation[],
  force: boolean,
  global: GlobalOptions,
  options: ClaimMutationOptions = {},
  claimRunner: ClaimRunner = runClaim,
): Promise<ClaimNextResult> {
  let attempts = 0;
  for (const recommendation of recommendations) {
    attempts += 1;
    try {
      const claimed = await claimRunner(recommendation.id, force, global, { ...options, ifAvailable: false });
      return { ...claimed, recommendation, attempts };
    } catch (error: unknown) {
      if (!isAlreadyClaimedError(error)) throw error;
    }
  }
  throw new PmCliError("No actionable item remained available to claim", EXIT_CODE.CONFLICT, {
    code: "no_available_next_item",
    why: "Every ranked candidate was claimed by another agent before this atomic selection completed.",
    nextSteps: ["Run pm claim --next again to refresh the ranked candidate set."],
  });
}

/**
 * Implements run release for the public runtime surface of this module.
 */
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
    item: toItemRecord(result.item),
    released_by: author,
    previous_assignee: previousAssignee,
    audit_release: options.allowAuditRelease === true,
    forced: force,
  };
}
