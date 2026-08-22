/**
 * @module sdk/assurance-action
 *
 * Normalizes the assurance action vocabulary once for CLI, SDK, and MCP hosts.
 */
import { createHash } from "node:crypto";

import type { GlobalOptions } from "../../core/shared/command-types.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { stableStringify } from "../../core/shared/serialization.js";
import {
  ASSURANCE_GATE_TRIGGERS,
  evaluateAssuranceGate,
  getAssuranceDeclaration,
  listAssuranceDeclarations,
  listAssuranceVerdicts,
  putAssuranceDeclaration,
  recordAssuranceVerdict,
  removeAssuranceDeclaration,
  type AssuranceAssertionDefinition,
  type AssuranceBundleMutationReceipt,
  type AssuranceDeclaration,
  type AssuranceDeclarationKind,
  type AssuranceDocument,
  type AssuranceGateDefinition,
  type AssuranceGateVerdict,
  type AssuranceGateTrigger,
  type AssuranceMeasurementDefinition,
  type AssuranceMutationReceipt,
  type AssuranceItemRecord,
} from "./assurance.js";
import {
  ASSURANCE_PRESET_IDS,
  acceptAssuranceProposals,
  applyAssurancePreset,
  createAssurancePreset,
  deriveAssuranceProposals,
  promoteAssuranceAssertion,
  type AssuranceDerivedProposal,
  type AssurancePreset,
  type AssurancePresetId,
} from "./assurance-presets.js";
import { MAX_ASSURANCE_VERDICT_LIMIT } from "./assurance-limits.js";
import {
  normalizeAssuranceEvaluation,
  normalizeAssuranceMutation,
} from "./assurance-mutation-error.js";
import {
  createAssuranceWorkspaceContext,
  type CreateAssuranceWorkspaceContextOptions,
} from "./assurance-runtime.js";
import { resolvePmRoot } from "../runtime-primitives.js";
import { parseRuntimeInteger, readRuntimeString } from "../runtime-input.js";
import {
  analyzeDefectChangeRisk,
  buildDefectRecurrenceIndex,
  parseDefectChangeRiskRequest,
  type DefectChangeRiskRequest,
  type DefectRecurrenceIndex,
  type DefectChangeRiskReport,
} from "./defect-recurrence.js";
import { defectRecurrenceItemSignals } from "./defect-recurrence-signals.js";
import { createUnknownSubcommandError } from "../agent/subcommand-recovery.js";

/**
 * One bounded process-local recurrence index and its invalidation evidence.
 *
 * The cache intentionally retains one tracker root. Alternating roots rebuilds
 * the evicted root on its next request; callers needing multi-root locality
 * should isolate runtimes by process.
 */
interface RiskIndexCacheEntry {
  /** Absolute tracker root owning this cache entry. */
  pm_root: string;
  /** Stable policy serialization used for exact invalidation. */
  policy_serialized: string;
  /** Recurrence-signal fingerprints used to derive sparse changes and deletions. */
  item_fingerprints: ReadonlyMap<string, string>;
  /** Previous immutable index eligible for sparse reuse. */
  index: DefectRecurrenceIndex;
}

let riskIndexCache: RiskIndexCacheEntry | undefined;

/** Assurance registry and evaluation verbs shared by every transport. */
export const ASSURANCE_ACTIONS = [
  "list",
  "show",
  "put",
  "remove",
  "run",
  "verdicts",
  "presets",
  "apply",
  "derive",
  "promote",
  "risk",
] as const;

/** Assurance declaration kinds shared by every transport. */
export const ASSURANCE_DECLARATION_KINDS = [
  "measurement",
  "assertion",
  "gate",
] as const;

/** Assurance action verb. */
export type AssuranceAction = (typeof ASSURANCE_ACTIONS)[number];

/** Transport-neutral assurance action request. */
export interface AssuranceActionInput {
  /** CRUD, evaluation, or verdict-history action. */
  action: string;
  /** Declaration kind for registry actions. */
  kind?: string;
  /** Declaration id, gate id, or verdict gate filter. */
  id?: string;
  /** JSON object or serialized JSON declaration for put. */
  definition?: unknown;
  /** Lifecycle trigger for gate evaluation. */
  trigger?: string;
  /** Explicit commit, tree, or snapshot identity. */
  tree?: string;
  /** Verdict-history gate filter when id is used by another host field. */
  gate?: string;
  /** Maximum newest durable verdicts returned. */
  limit?: number | string;
  /** Evaluate without appending an immutable verdict. */
  dry_run?: boolean;
  /** Retain the complete mutation receipt; assurance receipts are complete by default. */
  fullChangedFields?: boolean;
  /** Project declaration mutations to their stable id. */
  idOnly?: boolean;
  /** Explicit author override. */
  author?: string;
  /** Audited mutation rationale. */
  message?: string;
  /** Built-in preset selected for preview or application. */
  preset?: string;
  /** pm item that owns preset or derived assertions. */
  owner?: string;
  /** Explicitly accept derived proposals. */
  apply?: boolean;
  /** Explicit next assertion enforcement level. */
  enforcement?: string;
}

/** Embedding-host capabilities used only while evaluating assurance actions. */
export interface AssuranceActionRuntimeOptions {
  /** Workspace adapters and provider capabilities supplied by an SDK host. */
  workspace?: Omit<
    CreateAssuranceWorkspaceContextOptions,
    "tree_id" | "trigger"
  >;
}

/** Result union returned by transport-neutral assurance execution. */
export type AssuranceActionResult =
  | AssuranceDeclaration
  | AssuranceMutationReceipt
  | AssuranceGateVerdict
  | AssuranceBundleMutationReceipt
  | AssurancePreset
  | DefectChangeRiskReport
  | {
      items: AssuranceDerivedProposal[];
      count: number;
      applied?: AssuranceBundleMutationReceipt;
    }
  | {
      items: Array<{
        id: AssurancePresetId;
        title: string;
        description: string;
      }>;
      count: number;
      row_contract: { row_keys: ["items"]; jq_selector: ".items[]" };
    }
  | { /** Mutated declaration id. */ id: string }
  | {
      /** Registry declarations. */
      items: AssuranceDeclaration[];
      /** Number of declarations. */
      count: number;
      /** Stable row-selection contract. */
      row_contract: { row_keys: ["items"]; jq_selector: ".items[]" };
    }
  | {
      /** Durable gate verdicts. */
      items: AssuranceGateVerdict[];
      /** Number of verdicts. */
      count: number;
      /** Stable row-selection contract. */
      row_contract: { row_keys: ["items"]; jq_selector: ".items[]" };
    };

function parseAction(value: string): AssuranceAction {
  if (ASSURANCE_ACTIONS.includes(value as AssuranceAction)) {
    return value as AssuranceAction;
  }
  throw createUnknownSubcommandError({
    command_path: "assurance",
    token: value,
    allowed: ASSURANCE_ACTIONS,
    display_name: "assurance action",
  });
}

/** Throw the shared structured usage refusal for a missing assurance operand. */
function missingAssuranceArgument(detail: string, example: string): never {
  throw new PmCliError(detail, EXIT_CODE.USAGE, {
    code: "missing_required_argument",
    examples: [example],
  });
}

function parseKind(value: string | undefined): AssuranceDeclarationKind {
  if (!value) {
    return missingAssuranceArgument(
      `Assurance declaration kind is required. Expected: ${ASSURANCE_DECLARATION_KINDS.join(", ")}`,
      "pm assurance list measurement",
    );
  }
  if (ASSURANCE_DECLARATION_KINDS.includes(value as AssuranceDeclarationKind)) {
    return value as AssuranceDeclarationKind;
  }
  throw new PmCliError(
    `Assurance declaration kind is required. Expected: ${ASSURANCE_DECLARATION_KINDS.join(", ")}`,
    EXIT_CODE.USAGE,
  );
}

function parsePreset(value: string | undefined): AssurancePresetId {
  if (!value) {
    return missingAssuranceArgument(
      `Assurance preset is required. Expected: ${ASSURANCE_PRESET_IDS.join(", ")}`,
      "pm assurance apply software-delivery --owner <pm-item-id>",
    );
  }
  if (value && ASSURANCE_PRESET_IDS.includes(value as AssurancePresetId)) {
    return value as AssurancePresetId;
  }
  throw new PmCliError(
    `Assurance preset is required. Expected: ${ASSURANCE_PRESET_IDS.join(", ")}`,
    EXIT_CODE.USAGE,
  );
}

function requireOwner(input: AssuranceActionInput): string {
  if (input.owner?.trim()) return input.owner.trim();
  throw new PmCliError(
    "assurance preset and derivation actions require --owner <pm-item-id>",
    EXIT_CODE.USAGE,
  );
}

function parseDefinition(
  kind: AssuranceDeclarationKind,
  value: unknown,
): AssuranceDeclaration {
  let parsed = value;
  if (typeof value === "string") {
    if (!value.trim()) parsed = undefined;
    else {
      try {
        parsed = JSON.parse(value);
      } catch (error: unknown) {
        throw new PmCliError(
          "assurance definition must be valid JSON",
          EXIT_CODE.USAGE,
          { reason: error instanceof Error ? error.message : "invalid_json" },
        );
      }
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PmCliError(
      "assurance put requires a JSON object definition",
      EXIT_CODE.USAGE,
    );
  }
  if (kind === "measurement") return parsed as AssuranceMeasurementDefinition;
  if (kind === "assertion") return parsed as AssuranceAssertionDefinition;
  return parsed as AssuranceGateDefinition;
}

async function readDocument(pmRoot: string): Promise<AssuranceDocument> {
  const [measurements, assertions, gates] = await Promise.all([
    listAssuranceDeclarations(pmRoot, "measurement"),
    listAssuranceDeclarations(pmRoot, "assertion"),
    listAssuranceDeclarations(pmRoot, "gate"),
  ]);
  return {
    version: 1,
    measurements: measurements.items as AssuranceMeasurementDefinition[],
    assertions: assertions.items as AssuranceAssertionDefinition[],
    gates: gates.items as AssuranceGateDefinition[],
  };
}

/** Apply the common id-only projection without weakening the full audit receipt. */
function projectMutationReceipt(
  receipt: AssuranceMutationReceipt,
  idOnly: boolean | undefined,
): AssuranceMutationReceipt | { id: string } {
  return idOnly === true ? { id: receipt.id } : receipt;
}

async function authorizedDecisionIds(
  pmRoot: string,
  definition: AssuranceAssertionDefinition,
): Promise<string[]> {
  const decisionId = definition.authorization_decision;
  if (!decisionId) return [];
  const context = await createAssuranceWorkspaceContext(pmRoot, {
    include_history: false,
    resolve_tree: false,
  });
  const decision = context.items.find((item) => item.id === decisionId);
  const terminalStatuses = new Set(context.terminal_statuses!);
  if (
    !decision ||
    decision.type.toLowerCase() !== "decision" ||
    !terminalStatuses.has(decision.status)
  ) {
    throw new PmCliError(
      `Assurance authorization ${decisionId} must name a terminal Decision item`,
      EXIT_CODE.USAGE,
    );
  }
  return [decision.id];
}

/** Validate and execute the bounded durable-verdict listing transport. */
async function runVerdictsAction(
  input: AssuranceActionInput,
  pmRoot: string,
): Promise<Extract<AssuranceActionResult, { items: AssuranceGateVerdict[] }>> {
  const limit = parseRuntimeInteger(input.limit, "assurance verdict limit");
  if (
    limit !== undefined &&
    (limit < 1 || limit > MAX_ASSURANCE_VERDICT_LIMIT)
  ) {
    throw new PmCliError(
      `assurance verdict limit must be an integer from 1 through ${MAX_ASSURANCE_VERDICT_LIMIT}`,
      EXIT_CODE.USAGE,
    );
  }
  const items = await listAssuranceVerdicts(pmRoot, {
    gate_id: input.id ?? input.gate,
    limit,
  });
  return {
    items,
    count: items.length,
    row_contract: { row_keys: ["items"] as const, jq_selector: ".items[]" },
  };
}

async function runAdoptionAction(
  action: Extract<AssuranceAction, "presets" | "apply" | "derive" | "promote">,
  input: AssuranceActionInput,
  pmRoot: string,
): Promise<AssuranceActionResult> {
  if (action === "presets") {
    if (input.preset ?? input.id) {
      return createAssurancePreset(
        parsePreset(input.preset ?? input.id),
        requireOwner(input),
      );
    }
    const items = ASSURANCE_PRESET_IDS.map((id) => {
      const preset = createAssurancePreset(id, "pm-owner");
      return { id, title: preset.title, description: preset.description };
    });
    return {
      items,
      count: items.length,
      row_contract: { row_keys: ["items"], jq_selector: ".items[]" },
    };
  }
  if (action === "apply") {
    return normalizeAssuranceMutation(() =>
      applyAssurancePreset(
        pmRoot,
        parsePreset(input.preset ?? input.id),
        requireOwner(input),
        { author: input.author, message: input.message },
      ),
    );
  }
  if (action === "derive") {
    const proposals = await deriveAssuranceProposals(
      await createAssuranceWorkspaceContext(pmRoot, {
        resolve_tree: false,
        trigger: "derive",
      }),
      requireOwner(input),
    );
    const applied = input.apply
      ? await normalizeAssuranceMutation(() =>
          acceptAssuranceProposals(pmRoot, proposals, {
            author: input.author,
            message:
              input.message ?? "Accept observation-derived assurance proposals",
          }),
        )
      : undefined;
    return {
      items: proposals,
      count: proposals.length,
      ...(applied ? { applied } : {}),
    };
  }
  if (!input.id) {
    return missingAssuranceArgument(
      "assurance promote requires an assertion id",
      "pm assurance promote <assertion-id> --enforcement warn",
    );
  }
  if (input.enforcement !== "warn" && input.enforcement !== "block") {
    throw new PmCliError(
      "assurance promote requires --enforcement warn|block",
      EXIT_CODE.USAGE,
    );
  }
  const definition = (await getAssuranceDeclaration(
    pmRoot,
    "assertion",
    input.id,
  )) as AssuranceAssertionDefinition;
  return normalizeAssuranceMutation(() =>
    promoteAssuranceAssertion(
      pmRoot,
      definition,
      input.enforcement as "warn" | "block",
      {
        author: input.author,
        message: input.message,
      },
    ),
  );
}

async function runGateAction(
  input: AssuranceActionInput,
  pmRoot: string,
  runtime: AssuranceActionRuntimeOptions,
): Promise<AssuranceGateVerdict> {
  if (!input.id) {
    return missingAssuranceArgument(
      "assurance run requires a gate id",
      "pm assurance run <gate-id> --trigger ci --dry-run",
    );
  }
  const gateId = input.id;
  if (!input.trigger) {
    throw new PmCliError("assurance run requires a trigger", EXIT_CODE.USAGE);
  }
  if (
    !ASSURANCE_GATE_TRIGGERS.includes(input.trigger as AssuranceGateTrigger)
  ) {
    throw new PmCliError(
      `Unknown assurance trigger ${input.trigger}. Expected: ${ASSURANCE_GATE_TRIGGERS.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  const trigger = input.trigger as AssuranceGateTrigger;
  const [document, workspaceContext] = await Promise.all([
    readDocument(pmRoot),
    createAssuranceWorkspaceContext(pmRoot, {
      ...runtime.workspace,
      tree_id: input.tree,
      trigger,
    }),
  ]);
  const verdict = await normalizeAssuranceEvaluation(() =>
    evaluateAssuranceGate(gateId, document, workspaceContext, {
      trigger,
      dry_run: input.dry_run === true,
    }),
  );
  if (!verdict.dry_run) {
    await recordAssuranceVerdict(pmRoot, verdict, {
      author: input.author,
      message: input.message,
    });
  }
  return verdict;
}

/** Normalize a request-validation failure into the shared usage-error contract. */
function throwRiskUsageError(error: unknown): never {
  if (error instanceof PmCliError) throw error;
  throw new PmCliError(
    error instanceof Error
      ? error.message
      : "assurance risk request is invalid",
    EXIT_CODE.USAGE,
  );
}

/** Parse JSON or object risk definitions without wrapping workspace failures. */
function parseRiskActionRequest(
  input: AssuranceActionInput,
): DefectChangeRiskRequest {
  if (input.limit !== undefined) {
    throw new PmCliError(
      "assurance risk does not accept --limit; set limit inside the risk definition",
      EXIT_CODE.USAGE,
    );
  }
  let definition = input.definition;
  if (typeof definition === "string") {
    try {
      definition = JSON.parse(definition);
    } catch (error: unknown) {
      throw new PmCliError(
        "assurance risk definition must be valid JSON",
        EXIT_CODE.USAGE,
        { reason: error instanceof Error ? error.message : "invalid_json" },
      );
    }
  }
  try {
    return parseDefectChangeRiskRequest(definition);
  } catch (error: unknown) {
    return throwRiskUsageError(error);
  }
}

/** Derive the exact sparse replacement and deletion set for a cached index. */
function changedRiskItemIds(
  cached: RiskIndexCacheEntry,
  current: ReadonlyMap<string, string>,
): Set<string> {
  const changed = new Set<string>();
  for (const [itemId, itemFingerprint] of current) {
    if (cached.item_fingerprints.get(itemId) !== itemFingerprint)
      changed.add(itemId);
  }
  for (const itemId of cached.item_fingerprints.keys()) {
    if (!current.has(itemId)) changed.add(itemId);
  }
  return changed;
}

/** Build and retain a safely invalidated bounded process-local recurrence index. */
function buildCachedRiskIndex(
  pmRoot: string,
  request: DefectChangeRiskRequest,
  items: readonly AssuranceItemRecord[],
): DefectRecurrenceIndex {
  const policySerialized = stableStringify(request.policy);
  const cached =
    riskIndexCache?.pm_root === pmRoot ? riskIndexCache : undefined;
  const itemFingerprints = new Map(
    items.map((item) => [
      item.id,
      createHash("sha256")
        .update(stableStringify(defectRecurrenceItemSignals(item)))
        .digest("hex"),
    ]),
  );
  const reusable =
    cached?.policy_serialized === policySerialized ? cached : undefined;
  const changed = reusable
    ? changedRiskItemIds(reusable, itemFingerprints)
    : new Set<string>();
  const index = buildDefectRecurrenceIndex(
    request.policy,
    reusable ? items.filter((item) => changed.has(item.id)) : items,
    reusable
      ? { previous_index: reusable.index, changed_item_ids: [...changed] }
      : {},
  );
  riskIndexCache = {
    pm_root: pmRoot,
    policy_serialized: policySerialized,
    item_fingerprints: itemFingerprints,
    index,
  };
  return index;
}

/** Evaluate one serialized change-risk request against authoritative PM metadata. */
async function runRiskAction(
  input: AssuranceActionInput,
  pmRoot: string,
): Promise<DefectChangeRiskReport> {
  const request = parseRiskActionRequest(input);
  const context = await createAssuranceWorkspaceContext(pmRoot, {
    include_history: false,
    resolve_tree: false,
  });
  try {
    return analyzeDefectChangeRisk(
      buildCachedRiskIndex(pmRoot, request, context.items),
      request.change,
      { cursor: request.cursor, limit: request.limit },
    );
  } catch (error: unknown) {
    return throwRiskUsageError(error);
  }
}

/** Execute one assurance request through the public assurance SDK primitives. */
export async function runAssuranceAction(
  input: AssuranceActionInput,
  global: Pick<GlobalOptions, "path"> = {},
  runtime: AssuranceActionRuntimeOptions = {},
): Promise<AssuranceActionResult> {
  const action = parseAction(input.action);
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (
    action === "presets" ||
    action === "apply" ||
    action === "derive" ||
    action === "promote"
  ) {
    return runAdoptionAction(action, input, pmRoot);
  }
  if (action === "verdicts") {
    return runVerdictsAction(input, pmRoot);
  }
  if (action === "run") {
    return runGateAction(input, pmRoot, runtime);
  }
  if (action === "risk") {
    return runRiskAction(input, pmRoot);
  }
  const kind = parseKind(input.kind);
  if (action === "list") return listAssuranceDeclarations(pmRoot, kind);
  if (!input.id) {
    return missingAssuranceArgument(
      `assurance ${action} requires an id`,
      `pm assurance ${action} ${kind} <id>`,
    );
  }
  const id = input.id;
  if (action === "show") {
    return getAssuranceDeclaration(pmRoot, kind, id);
  }
  if (action === "remove") {
    const receipt = await normalizeAssuranceMutation(() =>
      removeAssuranceDeclaration(pmRoot, kind, id, {
        author: input.author,
        message: input.message,
      }),
    );
    return projectMutationReceipt(receipt, input.idOnly);
  }
  const definition = parseDefinition(kind, input.definition);
  if (definition.id !== id) {
    throw new PmCliError(
      `Assurance definition id ${definition.id} does not match requested id ${id}`,
      EXIT_CODE.USAGE,
    );
  }
  const mutationOptions = {
    author: input.author,
    message: input.message,
    ...(kind === "assertion"
      ? {
          authorized_decision_ids: await authorizedDecisionIds(
            pmRoot,
            definition as AssuranceAssertionDefinition,
          ),
        }
      : {}),
  };
  const receipt = await normalizeAssuranceMutation(() =>
    putAssuranceDeclaration(pmRoot, kind, definition, mutationOptions),
  );
  return projectMutationReceipt(receipt, input.idOnly);
}

/** Normalize a generic SDK or MCP argument envelope into one assurance request. */
export function runAssuranceDispatch(
  args: Record<string, unknown>,
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<AssuranceActionResult> {
  const merged = { ...args, ...options };
  return runAssuranceAction(
    {
      action:
        readRuntimeString(merged, "subcommand") ??
        readRuntimeString(merged, "assuranceAction") ??
        readRuntimeString(merged, "operation") ??
        "",
      kind: readRuntimeString(merged, "kind"),
      id: readRuntimeString(merged, "id"),
      definition: merged.definition,
      trigger: readRuntimeString(merged, "trigger"),
      tree:
        readRuntimeString(merged, "treeId") ??
        readRuntimeString(merged, "tree"),
      gate: readRuntimeString(merged, "gate"),
      limit: parseRuntimeInteger(merged.limit, "assurance verdict limit"),
      dry_run: merged.dryRun === true || merged.dry_run === true,
      fullChangedFields: merged.fullChangedFields === true,
      idOnly: merged.idOnly === true,
      author: readRuntimeString(merged, "author"),
      message: readRuntimeString(merged, "message"),
      preset: readRuntimeString(merged, "preset"),
      owner: readRuntimeString(merged, "owner"),
      apply: merged.apply === true,
      enforcement: readRuntimeString(merged, "enforcement"),
    },
    global,
  );
}
