/**
 * @module cli/commands/claim
 *
 * Implements the pm claim command surface and its agent-facing runtime behavior.
 */
import { assertInitializedTracker } from "../environment/tracker-preflight.js";
import {
  resolveRuntimeStatusRegistry,
  statusIsTerminal,
  EXIT_CODE,
  type GlobalOptions,
  PmCliError,
  toItemRecord,
  mutateItem,
  resolvePmRoot,
  readSettings,
  resolveAuthor,
  resolveClaimPrincipal,
  normalizeStatusForRegistry,
} from "../runtime-primitives.js";
import { wrapOwnershipConflict } from "../annotations.js";
import { resolveItemOwnershipConflict } from "../ownership-source.js";
import { applyReleaseHandoff, resolveReleaseHandoff } from "./release-handoff.js";
import { enforceTypeWorkflowTransition } from "./workflow-transition.js";
import { admitExplicitStartClaim, admitStartTransition, START_BLOCKED_REFUSAL_CODE } from "./start-blockers.js";
import { resolveTypeWorkflows } from "../../core/schema/type-workflows.js";
import { resolveStartTaskInProgressStatus } from "../start-task-status.js";
import type { ItemMetadata, PmSettings } from "../../types/index.js";
import type { RuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import {
  runNext,
  type NextRecommendation,
  type NextOptions,
} from "../query/next.js";
import {
  recordClaimSemanticAttribution,
  recordReleaseSemanticAttribution,
} from "../context/semantic-session-attribution.js";
import { redactIdentityCredentials, redactIdentityFields, redactOptionalIdentityCredentials } from "../../core/shared/url-credentials.js";

/** Stable warning/error code for an exhausted atomic next-work walk. */
export const NO_AVAILABLE_NEXT_ITEM_CODE = "no_available_next_item";

/** Documents the claim result payload exchanged by command, SDK, and package integrations. */
export interface ClaimResult {
  /** Value that configures or reports item for this contract. */
  item: Record<string, unknown>;
  /** Metadata fields changed by this claim; empty for an idempotent or skipped claim. */
  changed_fields?: string[];
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
  /** Lifecycle transition applied inside the claim's locked mutation when `start` was requested. */
  start?: ClaimStartReceipt;
  /** What a post-commit warning left unrecorded and how to clear its cause; the claim itself is saved. */
  suggestions?: string[];
}

/** Status transition recorded by a claim that also started its item. */
export interface ClaimStartReceipt {
  /** Lifecycle status observed under the item lock before the claim. */
  from_status: string;
  /** Configured in-progress status the claimed item now carries. */
  to_status: string;
}

/** Result of atomically selecting and claiming the next caller-available item. */
export interface ClaimNextAvailableResult extends ClaimResult {
  /** True when an actionable candidate was claimed. */
  available: true;
  /** Value that configures or reports recommendation for this contract. */
  recommendation: NextRecommendation;
  /** Value that configures or reports attempts for this contract. */
  attempts: number;
  /** Earlier candidates skipped because a declared blocker refused their start; nothing was written to them. */
  start_refused?: string[];
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
  /** Candidates skipped because a declared blocker refused their start; nothing was written to them. */
  start_refused?: string[];
  /** Stable machine-readable exhaustion warning. */
  warnings: [typeof NO_AVAILABLE_NEXT_ITEM_CODE];
}

/** Result of a successful or deliberately empty atomic next-work claim. */
export type ClaimNextResult =
  | ClaimNextAvailableResult
  | ClaimNextUnavailableResult;

/** The typed `code` of a pm refusal, matched by name so a refusal from another module copy still counts. */
function refusalCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== "PmCliError") {
    return undefined;
  }
  // Every PmCliError carries a context object (its constructor defaults it to {}).
  return (error as PmCliError).context.code;
}

/** Returns whether an error is a pm refusal carrying the typed `code`. */
function hasRefusalCode(error: unknown, code: string): boolean {
  return refusalCode(error) === code;
}

/** Returns whether a failed claim lost the atomic test-and-set race. */
export function isAlreadyClaimedError(error: unknown): boolean {
  return hasRefusalCode(error, "already_claimed_by");
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
  /** Ownership fields actually removed, or an empty list for an unclaimed item. */
  changed_fields?: string[];
  /** Value that configures or reports released by for this contract. */
  released_by: string;
  /** Value that configures or reports previous assignee for this contract. */
  previous_assignee: string | null;
  /** Value that configures or reports forced for this contract. */
  forced: boolean;
  /** Stable handoff diagnostics shared by CLI and MCP consumers. */
  warnings?: string[];
  /** Concrete recovery commands when releasing ownership leaves work in progress. */
  suggestions?: string[];
  /** Evidence and queue transition recorded with the ownership release. */
  handoff?: {
    /** Lifecycle status observed under the item lock. */
    from_status: string;
    /** Project-defined queue receiving the unclaimed work. */
    to_status: string;
    /** Author-supplied evidence retained in the release history event. */
    message: string;
  };
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
  maxAttempts?: string | number;
  /**
   * Move the claimed item to the configured in-progress status in the same locked
   * mutation and history event. `runClaimNext` uses this for `claim --next --start`.
   * The explicit-item `claim <id> --start` and `runStartTask` keep their documented
   * claim-then-update composition and do not pass it.
   */
  start?: boolean;
}

/** Documents the release mutation options payload exchanged by command, SDK, and package integrations. */
export interface ReleaseMutationOptions extends ClaimMutationOptions {
  /** Configured non-terminal queue to enter atomically with release. */
  handoff?: string;
  /** Pause composition, mutually exclusive with a handoff queue. */
  pause?: boolean;
}

/** Implements run claim for the public runtime surface of this module. */
export async function runClaim(
  id: string,
  force: boolean,
  global: GlobalOptions,
  options: ClaimMutationOptions = {},
): Promise<ClaimResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await assertInitializedTracker(pmRoot);
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const author = resolveAuthor(options.author, settings.author_default);
  const claimPrincipal = resolveClaimPrincipal(author);
  let previousAssignee: string | null = null;
  let skipped = false;
  let startEvidence: Pick<ClaimResult, "start"> = {};
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
    async mutate(document) {
      const currentAssignee = document.metadata.assignee;
      const currentAssigneeText = currentAssignee ?? "";
      // Compared exactly so distinct legacy holders stay distinct; echoed redacted (GH-1707).
      const currentClaimPrincipal =
        document.metadata.claim_principal?.trim() || currentAssigneeText;
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
        previousAssignee !== null && currentClaimPrincipal !== claimPrincipal;
      if (heldByOther) {
        if (options.ifAvailable === true) {
          skipped = true;
          mutationWarnings.push(`claim_skipped_held_by:${redactOptionalIdentityCredentials(previousAssignee)}`);
          return { changedFields: [] };
        }
        if (!force) {
          const ownership = await resolveItemOwnershipConflict(
            pmRoot,
            document.metadata.id,
            currentAssigneeText,
          );
          throw new PmCliError(
            `Item ${document.metadata.id} is already ${ownership.phrase}. Use --force to take over, or --if-available to skip without failing.`,
            EXIT_CODE.CONFLICT,
            {
              code: "already_claimed_by",
              item_id: document.metadata.id,
              claimed_by: ownership.holder,
              claimed_at: ownership.since,
              claim_source: ownership.source,
              why: "Claim is an atomic test-and-set so parallel agents never proceed believing they own the same item.",
              nextSteps: [
                "Run pm next to pick a different unclaimed item.",
                "Re-run with --if-available to treat a held item as a no-op skip.",
                "Re-run with --force only when taking over the item is coordinated.",
              ],
            },
          );
        }
        mutationWarnings.push(`claim_takeover:${redactOptionalIdentityCredentials(previousAssignee)}->${author}`);
      }
      const ownership = { assignee: author, claim_principal: claimPrincipal };
      const changedFields = (["assignee", "claim_principal"] as const).filter(
        (field) => document.metadata[field] !== ownership[field],
      );
      Object.assign(document.metadata, ownership);
      const fromStatus = document.metadata.status;
      const { changedFields: startedFields, warnings: startWarnings, ...started } =
        applyClaimStart(document.metadata, options.start === true, settings, statusRegistry);
      startWarnings.push(...await claimStartWarnings({ pmRoot, settings, metadata: document.metadata, fromStatus, registry: statusRegistry, force, start: options.start === true }));
      startEvidence = started;
      mutationWarnings.push(...startWarnings);
      return {
        changedFields: [...changedFields, ...startedFields],
        warnings: mutationWarnings,
      };
    },
  });

  const attribution = skipped
    ? undefined
    : await recordAttributionAfterCommit("claim", result.item.id, () =>
        recordClaimSemanticAttribution({
          pmRoot,
          settings,
          principal: claimPrincipal,
          itemId: result.item.id,
        }),
      );
  if (attribution) mutationWarnings.push(attribution.warning);

  return {
    // Echo identities an older version stored only in redacted form (GH-1707).
    item: redactIdentityFields(toItemRecord(result.item)),
    changed_fields: result.changedFields,
    claimed_by:
      skipped && previousAssignee !== null ? redactIdentityCredentials(previousAssignee) : author,
    previous_assignee: previousAssignee === null ? null : redactIdentityCredentials(previousAssignee),
    forced: force,
    ...(skipped ? { skipped: true } : {}),
    ...(mutationWarnings.length > 0 ? { warnings: mutationWarnings } : {}),
    ...(attribution ? { suggestions: [attribution.suggestion] } : {}),
    ...startEvidence,
  };
}

/** Stable warning when session attribution could not be recorded for a claim that already committed. */
export const CLAIM_ATTRIBUTION_UNRECORDED_WARNING = "claim_semantic_attribution_unrecorded";

/** Stable warning when session attribution could not be updated for a release that already committed (GH-1706). */
export const RELEASE_ATTRIBUTION_UNRECORDED_WARNING = "release_semantic_attribution_unrecorded";

/**
 * Update session attribution after an ownership write committed. Claim and
 * release share this policy (GH-1706): the item write stands, so a failure
 * here is a warning with a suggestion naming what went unrecorded, never a
 * non-zero exit after the tracker already changed. The suggestion carries
 * the refusal code only, so no host path from an error message leaks.
 */
async function recordAttributionAfterCommit(
  operation: "claim" | "release",
  itemId: string,
  record: () => Promise<void>,
): Promise<{ warning: string; suggestion: string } | undefined> {
  try {
    await record();
    return undefined;
  } catch (error: unknown) {
    const cause = refusalCode(error) ?? "unexpected_error";
    return {
      warning: operation === "claim" ? CLAIM_ATTRIBUTION_UNRECORDED_WARNING : RELEASE_ATTRIBUTION_UNRECORDED_WARNING,
      suggestion: `The ${operation} of ${itemId} is saved, but the session attribution that names this agent's active work was not updated (${cause}); nothing needs a retry. If pm health reports a stale lock, remove it with pm gc --scope locks.`,
    };
  }
}

/** Enforce the claim target XOR selection contract; refusals never ask for a flag the caller already passed. */
export function requireClaimTarget(
  id: string | undefined,
  next: boolean,
  start = false,
): void {
  const startSuffix = start ? " --start" : "";
  if (!next && !id) {
    throw new PmCliError(
      start
        ? "pm claim --start needs an item id, or --next to start the next available item"
        : "Specify an item id or pass --next",
      EXIT_CODE.USAGE,
      {
        code: "missing_required_argument",
        field: "id",
        required: "Pass an item id, or --next to select the next available item.",
        nextSteps: [`Retry as pm claim <id>${startSuffix}, or pm claim --next${startSuffix}.`],
      },
    );
  }
  if (next && id) {
    throw new PmCliError(
      "Specify either an item id or --next, not both",
      EXIT_CODE.USAGE,
      {
        code: "ambiguous_option_combination",
        required: "Pass either an item id or --next.",
        nextSteps: [`Retry as pm claim ${id}${startSuffix} to claim that item, or drop the id to select with --next.`],
      },
    );
  }
}

/** Judge the start a claim makes itself (`--next --start`) or an enclosing explicit start composition will make. */
async function claimStartWarnings(params: Parameters<typeof admitExplicitStartClaim>[0] & { fromStatus: string | undefined; start: boolean }): Promise<string[]> {
  return params.start ? admitStartTransition(params) : admitExplicitStartClaim(params);
}

/** Advance a just-claimed item to the in-progress status under the claim's lock, enforcing configured type workflows. */
export function applyClaimStart(
  metadata: ItemMetadata,
  start: boolean,
  settings: PmSettings,
  registry: RuntimeStatusRegistry,
): Pick<ClaimResult, "start"> & { changedFields: string[]; warnings: string[] } {
  if (!start) return { changedFields: [], warnings: [] };
  if (statusIsTerminal(metadata.status, registry)) {
    throw new PmCliError(
      `Cannot start terminal item ${metadata.id}; reopen it with pm item reopen before starting it`,
      EXIT_CODE.CONFLICT,
      {
        code: "terminal_state_conflict",
        item_id: metadata.id,
        why: "Starting work moves an active item into progress; a terminal item must be reopened so its recurrence evidence is recorded.",
        nextSteps: [`Run pm item reopen ${metadata.id} "<reason>", then pm claim ${metadata.id} --start.`],
      },
    );
  }
  const startStatus = resolveStartTaskInProgressStatus(registry);
  const enforcement = settings.governance.workflow_enforcement ?? "off";
  const warning = enforceTypeWorkflowTransition({
    enforcement,
    typeWorkflows: enforcement === "off" ? [] : resolveTypeWorkflows(settings.schema),
    statusRegistry: registry,
    typeName: metadata.type,
    fromStatus: metadata.status,
    toStatus: startStatus,
  });
  const receipt = { from_status: metadata.status, to_status: startStatus };
  const changedFields = metadata.status === startStatus ? [] : ["status"];
  metadata.status = startStatus;
  return { start: receipt, changedFields, warnings: warning ? [warning] : [] };
}

/** Selects ranked actionable work and claims the first candidate still available under the item lock. Conflicts caused by parallel claimers advance to the next candidate instead of returning a thundering-herd failure. */
export async function runClaimNext(
  force: boolean,
  global: GlobalOptions,
  options: ClaimMutationOptions = {},
  nextOptions: NextOptions = {},
): Promise<ClaimNextResult> {
  const maxAttempts = parseClaimNextAttempts(options.maxAttempts);
  const settings = await readSettings(
    resolvePmRoot(process.cwd(), global.path),
  );
  const claimOptions = {
    ...options,
    author: resolveAuthor(options.author, settings.author_default),
  };
  const next = await runNext(
    {
      ...nextOptions,
      callerAuthor: claimOptions.author,
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
    claimOptions,
  );
}

/** Parses the bounded candidate walk used by `claim --next`. */
export function parseClaimNextAttempts(
  raw: string | number | undefined,
): number {
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
  // A candidate whose blocker opened after ranking refuses its start before any write, so the walk moves on.
  const startRefused: string[] = [];
  const refusals = () => (startRefused.length > 0 ? { start_refused: [...startRefused] } : {});
  for (const recommendation of recommendations) {
    attempts += 1;
    try {
      const claimed = await claimRunner(
        recommendation.id,
        force,
        global,
        options,
      );
      const result = {
        ...claimed,
        recommendation,
        attempts,
        available: true as const,
        ...refusals(),
      };
      if (!claimed.skipped) return result;
    } catch (error: unknown) {
      if (hasRefusalCode(error, START_BLOCKED_REFUSAL_CODE)) {
        startRefused.push(recommendation.id);
        continue;
      }
      if (!isAlreadyClaimedError(error)) throw error;
    }
  }
  if (options.ifAvailable === true) {
    return {
      available: false,
      item: null,
      claimed_by: resolveAuthor(options.author, ""),
      previous_assignee: null,
      forced: force,
      skipped: true,
      recommendation: null,
      attempts,
      ...refusals(),
      warnings: [NO_AVAILABLE_NEXT_ITEM_CODE],
    };
  }
  throw noAvailableNextItemError(attempts, startRefused, options.start === true);
}

/** Explain an exhausted walk, naming candidates whose start a declared blocker refused. */
function noAvailableNextItemError(attempts: number, startRefused: readonly string[], start: boolean): PmCliError {
  const noCandidatesMatched = attempts === 0;
  let why = "Every ranked candidate was claimed by another agent before this atomic selection completed.";
  if (noCandidatesMatched) why = "No ready items matched the specified filters or selection criteria.";
  else if (startRefused.length > 0) {
    why = `${startRefused.length} of ${attempts} attempted candidates refused their start because a declared blocker is open (${startRefused.join(", ")}), and nothing was written to them; ${startRefused.length === attempts ? "no other candidate was attempted" : "every other attempted candidate was claimed by another agent"}.`;
  }
  return new PmCliError(
    noCandidatesMatched
      ? "No actionable items matched the selection filters"
      : "No actionable item remained available to claim",
    noCandidatesMatched ? EXIT_CODE.NOT_FOUND : EXIT_CODE.CONFLICT,
    {
      code: NO_AVAILABLE_NEXT_ITEM_CODE,
      why,
      nextSteps: [
        noCandidatesMatched
          ? "Verify the filters or run pm next to inspect all ready work."
          : `Run pm claim --next${start ? " --start" : ""} again, with the same filters, to refresh the ranked candidate set.`,
      ],
      ...(startRefused.length > 0 ? { details: { start_refused: [...startRefused] } } : {}),
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
  await assertInitializedTracker(pmRoot);
  const settings = await readSettings(pmRoot);
  const author = resolveAuthor(options.author, settings.author_default);
  const claimPrincipal = resolveClaimPrincipal(author);
  const ownershipReleaseBypass =
    (
      options as ReleaseMutationOptions & {
        ownershipReleaseBypass?: boolean;
      }
    ).ownershipReleaseBypass === true;
  let previousAssignee: string | null = null;
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const handoffStatus = resolveReleaseHandoff(options, statusRegistry);
  if (handoffStatus !== undefined && ownershipReleaseBypass) {
    throw new PmCliError("Ownership-release bypass only clears ownership; it cannot change a handoff status.", EXIT_CODE.USAGE);
  }
  let handoff: ReleaseResult["handoff"];

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
      bypassAssigneeConflict: ownershipReleaseBypass,
      mutate(document) {
        previousAssignee = document.metadata.assignee ?? null;
        const transition = handoffStatus === undefined ? undefined : applyReleaseHandoff(document.metadata, handoffStatus, settings, statusRegistry, options.message!);
        handoff = transition?.receipt;
        if (!previousAssignee && !document.metadata.claim_principal) {
          return { changedFields: [] };
        }
        delete document.metadata.assignee;
        delete document.metadata.claim_principal;
        return { changedFields: ["assignee", "claim_principal", ...(transition?.changedFields ?? [])], warnings: transition?.warnings };
      },
    });
  } catch (error: unknown) {
    wrapOwnershipConflict(error, {
      required:
        "For approved non-owner handoffs, prefer the ownership-release bypass before considering --force.",
      examples: ['pm release pm-a1b2 --author "reviewer" --force'],
      nextSteps: [
        "Use the package-provided ownership-release bypass for handoffs that only clear assignee metadata.",
        "Use --force only when an explicit override is approved for broader ownership conflicts.",
      ],
    });
  }

  const attribution = await recordAttributionAfterCommit("release", result.item.id, () =>
    recordReleaseSemanticAttribution({
      pmRoot,
      principal: claimPrincipal,
      itemId: result.item.id,
    }),
  );

  const stillInProgress = normalizeStatusForRegistry(result.item.status, statusRegistry) === normalizeStatusForRegistry(statusRegistry.in_progress_status, statusRegistry);
  const warnings = [
    ...result.warnings,
    ...(stillInProgress ? ["released_unclaimed_in_progress"] : []),
    ...(attribution ? [attribution.warning] : []),
  ];
  const suggestions = [
    ...(stillInProgress ? [`${result.item.id} remains ${result.item.status} and unclaimed. If work is paused, run pm release ${result.item.id} --pause to move it to ${statusRegistry.open_status}.`] : []),
    ...(attribution ? [attribution.suggestion] : []),
  ];

  return {
    item: redactIdentityFields(toItemRecord(result.item)),
    released_by: author,
    changed_fields: result.changedFields,
    previous_assignee: previousAssignee === null ? null : redactIdentityCredentials(previousAssignee),
    forced: force,
    ...(handoff === undefined ? {} : { handoff }),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(suggestions.length > 0 ? { suggestions } : {}),
  };
}
