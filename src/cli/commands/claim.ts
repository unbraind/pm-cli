/**
 * @module cli/commands/claim
 *
 * Implements the pm claim command surface and its agent-facing runtime behavior.
 */
import { pathExists } from "../../core/fs/fs-utils.js";
import {
  resolveRuntimeStatusRegistry,
  statusIsTerminal,
} from "../../core/schema/runtime-schema.js";
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

/** Documents the claim result payload exchanged by command, SDK, and package integrations. */
export interface ClaimResult {
  /** Value that configures or reports item for this contract. */
  item: Record<string, unknown>;
  /** Value that configures or reports claimed by for this contract. */
  claimed_by: string;
  /** Value that configures or reports previous assignee for this contract. */
  previous_assignee: string | null;
  /** Value that configures or reports forced for this contract. */
  forced: boolean;
  /** Value that configures or reports skipped for this contract. */
  skipped?: boolean;
  /** Value that configures or reports warnings for this contract. */
  warnings?: string[];
}

/** Result of atomically selecting and claiming the next caller-available item. */
export interface ClaimNextAvailableResult extends ClaimResult {
  /** True when an actionable candidate was claimed. */
  available: true;
  /** Value that configures or reports recommendation for this contract. */
  recommendation: NextRecommendation;
  /** Value that configures or reports attempts for this contract. */
  attempts: number;
}

/** Non-error empty result returned when an if-available candidate walk is exhausted. */
export interface ClaimNextUnavailableResult {
  /** Indicates that no candidate remained claimable. */
  available: false;
  /** Empty item projection for a deliberately unavailable selection. */
  item: null;
  /** Caller identity that attempted the selection. */
  claimed_by: string;
  /** No previous owner exists for an empty selection. */
  previous_assignee: null;
  /** Whether forced selection was requested. */
  forced: boolean;
  /** Signals a deliberate non-error skip. */
  skipped: true;
  /** No recommendation survived the bounded walk. */
  recommendation: null;
  /** Number of ranked candidates attempted. */
  attempts: number;
  /** Stable machine-readable exhaustion warning. */
  warnings: ["no_available_next_item"];
}

/** Result of a successful or deliberately empty atomic next-work claim. */
export type ClaimNextResult =
  | ClaimNextAvailableResult
  | ClaimNextUnavailableResult;

/** Returns whether a failed claim lost the atomic test-and-set race. */
export function isAlreadyClaimedError(error: unknown): boolean {
  return (
    error instanceof PmCliError && error.context?.code === "already_claimed_by"
  );
}

type ClaimRunner = (
  id: string,
  force: boolean,
  global: GlobalOptions,
  options: ClaimMutationOptions,
) => Promise<ClaimResult>;

/** Documents the release result payload exchanged by command, SDK, and package integrations. */
export interface ReleaseResult {
  /** Value that configures or reports item for this contract. */
  item: Record<string, unknown>;
  /** Value that configures or reports released by for this contract. */
  released_by: string;
  /** Value that configures or reports previous assignee for this contract. */
  previous_assignee: string | null;
  /** Value that configures or reports audit release for this contract. */
  audit_release: boolean;
  /** Value that configures or reports forced for this contract. */
  forced: boolean;
}

/** Documents the claim mutation options payload exchanged by command, SDK, and package integrations. */
export interface ClaimMutationOptions {
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports if available for this contract. */
  ifAvailable?: boolean;
  /** Maximum ranked candidates attempted by `claim --next`. */
  maxAttempts?: string;
}

/** Documents the release mutation options payload exchanged by command, SDK, and package integrations. */
export interface ReleaseMutationOptions extends ClaimMutationOptions {
  /** Value that configures or reports allow audit release for this contract. */
  allowAuditRelease?: boolean;
}

/** Implements run claim for the public runtime surface of this module. */
export async function runClaim(
  id: string,
  force: boolean,
  global: GlobalOptions,
  options: ClaimMutationOptions = {},
): Promise<ClaimResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
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
      const currentAssigneeText =
        typeof currentAssignee === "string" ? currentAssignee : "";
      previousAssignee =
        currentAssigneeText.trim().length > 0 ? currentAssigneeText : null;
      if (
        statusIsTerminal(document.metadata.status, statusRegistry) &&
        !force
      ) {
        throw new PmCliError(
          `Cannot claim terminal item ${document.metadata.id} without --force`,
          EXIT_CODE.CONFLICT,
        );
      }
      const heldByOther =
        previousAssignee !== null && previousAssignee !== author;
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
    claimed_by:
      skipped && previousAssignee !== null ? previousAssignee : author,
    previous_assignee: previousAssignee,
    forced: force,
    ...(skipped ? { skipped: true } : {}),
    ...(mutationWarnings.length > 0 ? { warnings: mutationWarnings } : {}),
  };
}

/** Selects ranked actionable work and claims the first candidate still available under the item lock. Conflicts caused by parallel claimers advance to the next candidate instead of returning a thundering-herd failure. */
export async function runClaimNext(
  force: boolean,
  global: GlobalOptions,
  options: ClaimMutationOptions = {},
  nextOptions: NextOptions = {},
): Promise<ClaimNextResult> {
  const maxAttempts = parseClaimNextAttempts(options.maxAttempts);
  const next = await runNext(
    {
      ...nextOptions,
      callerAuthor: options.author,
      limit: String(maxAttempts),
    },
    global,
  );
  const recommendations = [next.recommended, ...next.ready]
    .filter((entry): entry is NextRecommendation => entry !== null)
    .map((entry) => ({
      ...entry,
      reasons: "reasons" in entry ? entry.reasons : ["ranked ready candidate"],
    }));
  return claimNextFromRecommendations(
    recommendations.slice(0, maxAttempts),
    force,
    global,
    options,
  );
}

/** Parses the bounded candidate walk used by `claim --next`. */
export function parseClaimNextAttempts(raw: string | undefined): number {
  if (raw === undefined) return 10;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new PmCliError(
      "--max-attempts must be an integer from 1 to 100",
      EXIT_CODE.USAGE,
    );
  }
  return parsed;
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
      const claimed = await claimRunner(
        recommendation.id,
        force,
        global,
        options,
      );
      const result = { ...claimed, recommendation, attempts, available: true as const };
      if (!claimed.skipped) return result;
    } catch (error: unknown) {
      if (!isAlreadyClaimedError(error)) throw error;
    }
  }
  if (options.ifAvailable === true) {
    return {
      available: false,
      item: null,
      claimed_by: options.author ?? process.env.PM_AUTHOR ?? "unknown",
      previous_assignee: null,
      forced: force,
      skipped: true,
      recommendation: null,
      attempts,
      warnings: ["no_available_next_item"],
    };
  }
  throw new PmCliError(
    "No actionable item remained available to claim",
    EXIT_CODE.CONFLICT,
    {
      code: "no_available_next_item",
      why: "Every ranked candidate was claimed by another agent before this atomic selection completed.",
      nextSteps: [
        "Run pm claim --next again to refresh the ranked candidate set.",
      ],
    },
  );
}

/** Implements run release for the public runtime surface of this module. */
export async function runRelease(
  id: string,
  force: boolean,
  global: GlobalOptions,
  options: ReleaseMutationOptions = {},
): Promise<ReleaseResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
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
      required:
        "For audited non-owner handoffs, prefer --allow-audit-release before considering --force.",
      examples: [
        'pm release pm-a1b2 --author "reviewer" --allow-audit-release',
      ],
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
