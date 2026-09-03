/**
 * @module sdk/agent-environment
 *
 * Declares reproducible, budgeted agent observations, total verdicts, and
 * isolated project-management episodes over adapter-provided recorded state.
 */
import { sha256Hex, stableStringify } from "../../core/shared/serialization.js";
import { runWithAgentSessionContext } from "../agent-session-context.js";
import {
  defineWorkspaceRecipe,
  type WorkspaceRecipe,
} from "../workspace-recipe.js";

/** Schema identifier for a portable observation contract. */
export const PM_OBSERVATION_SCHEMA = "pm.agent-observation/v1" as const;

/** Schema identifier for a deterministic verdict contract. */
export const PM_VERDICT_SCHEMA = "pm.agent-verdict/v1" as const;

/** Schema identifier for a bounded agent-environment episode. */
export const PM_EPISODE_SCHEMA = "pm.agent-episode/v1" as const;

/** A JSON-compatible object used as immutable recorded workspace state. */
export type RecordedStateObject = Readonly<Record<string, unknown>>;

/** One declared read and its guaranteed token ceiling. */
export interface ObservationReadDeclaration {
  /** Public SDK or CLI command name used to collect the read. */
  command: string;
  /** Maximum tokens this read may consume. */
  budget_tokens: number;
}

/** Emitted-byte calibration for a representative observation corpus. */
export interface ObservationCalibration {
  /** Stable measurement basis; serialized payload bytes are authoritative. */
  basis: "emitted_bytes";
  /** Historical emitted-byte measurements used to calibrate expectations. */
  samples: readonly number[];
  /** Expected serialized payload size before an observation is served. */
  expected_emitted_bytes: number;
  /** Accepted drift around the expected emitted-byte measurement. */
  tolerance_bytes: number;
}

/** Declares whether observation cost varies with corpus size. */
export type ObservationCorpusDependence =
  | { readonly kind: "independent" }
  | {
      readonly kind: "bounded";
      readonly dimension: string;
      readonly maximum: number;
    };

/** One ordered disclosure tier in an observation degradation ladder. */
export interface ObservationTier {
  /** Stable tier identity included in every observation receipt. */
  id: string;
  /** Maximum tokens this tier is permitted to emit. */
  max_tokens: number;
  /** Dot-separated recorded-state fields disclosed by the tier. */
  fields: readonly string[];
}

/** Portable declaration for a bounded, calibrated observation. */
export interface ObservationContract {
  /** Versioned schema identity. */
  schema: typeof PM_OBSERVATION_SCHEMA;
  /** Stable contract identity. */
  id: string;
  /** Positive contract revision. */
  version: number;
  /** Reads whose ceilings form the guaranteed collection cost. */
  reads: readonly ObservationReadDeclaration[];
  /** Emitted-byte calibration visible before collection starts. */
  calibration: ObservationCalibration;
  /** Explicit corpus-size dependence of the cost model. */
  corpus_dependence: ObservationCorpusDependence;
  /** Ordered richest-to-smallest degradation ladder. */
  tiers: readonly ObservationTier[];
}

/** Pre-call observation-cost description available to schedulers. */
export interface ObservationCostDescription {
  /** Stable observation identity. */
  contract_id: string;
  /** Observation revision. */
  contract_version: number;
  /** Sum of all declared collection ceilings. */
  guaranteed_ceiling_tokens: number;
  /** Calibrated expected serialized payload size. */
  expected_emitted_bytes: number;
  /** Conservative token estimate derived from emitted bytes. */
  expected_tokens: number;
  /** Accepted emitted-byte calibration drift. */
  tolerance_bytes: number;
  /** Stable calibration basis. */
  calibration_basis: "emitted_bytes";
  /** Declared corpus-size dependence. */
  corpus_dependence: ObservationCorpusDependence;
}

/** Audit receipt emitted for every served or refused observation. */
export interface ObservationReceipt {
  /** Stable observation identity. */
  contract_id: string;
  /** Observation revision. */
  contract_version: number;
  /** Tier whose payload was returned, or null after truthful refusal. */
  served_tier: string | null;
  /** Whether a smaller tier was attempted or served. */
  degraded: boolean;
  /** Tier identities evaluated in deterministic order. */
  attempted_tiers: readonly string[];
  /** Exact serialized payload bytes, or null when nothing was served. */
  emitted_bytes: number | null;
  /** Conservative token estimate, or null when nothing was served. */
  estimated_tokens: number | null;
  /** Stable measurement basis. */
  calibration_basis: "emitted_bytes";
}

/** Successful bounded observation with its explicit receipt. */
export interface ServedObservation<T> {
  /** Discriminator for a payload-bearing response. */
  status: "served";
  /** Payload produced by the declared tier. */
  payload: T;
  /** Cost and degradation evidence. */
  receipt: ObservationReceipt;
}

/** Refusal returned when no declared tier can fit the caller's ceiling. */
export interface RefusedObservation {
  /** Discriminator for a payload-free refusal. */
  status: "refused";
  /** Stable reason callers can route without parsing prose. */
  reason: "no_declared_tier_fits_budget";
  /** Cost and degradation evidence. */
  receipt: ObservationReceipt;
}

/** Complete outcome of attempting one declared observation. */
export type ObservationResult<T> = ServedObservation<T> | RefusedObservation;

/** Caller-imposed ceiling for one observation response. */
export interface ObservationRequest {
  /** Maximum response tokens accepted by the caller. */
  budget_tokens: number;
}

/** Predicate supported by the versioned total-verdict interpreter. */
export type VerdictPredicate =
  | {
      readonly id: string;
      readonly kind: "field_equals";
      readonly path: string;
      readonly expected: unknown;
    }
  | {
      readonly id: string;
      readonly kind: "field_present";
      readonly path: string;
    }
  | {
      readonly id: string;
      readonly kind: "field_absent";
      readonly path: string;
    };

/** Declarative composition applied to predicate outcomes. */
export interface VerdictComposition {
  /** Whether every or at least one referenced predicate must satisfy. */
  operator: "all" | "any";
  /** Ordered predicate identities evaluated by the total verdict. */
  predicate_ids: readonly string[];
}

/** Portable named and versioned total-verdict declaration. */
export interface VerdictContract {
  /** Versioned schema identity. */
  schema: typeof PM_VERDICT_SCHEMA;
  /** Stable contract identity. */
  id: string;
  /** Positive contract revision. */
  version: number;
  /** Predicates evaluated exclusively over recorded state. */
  predicates: readonly VerdictPredicate[];
  /** Explicit deterministic predicate composition. */
  composition: VerdictComposition;
}

/** Recorded state and stable snapshot identity supplied by an adapter. */
export interface WorkspaceRecordedState {
  /** Stable identity of the exact state being evaluated. */
  snapshot_id: string;
  /** Recorded, JSON-compatible project state. */
  state: RecordedStateObject;
}

/** Per-predicate evidence in a deterministic total verdict. */
export interface PredicateVerdict {
  /** Declared predicate identity. */
  id: string;
  /** Whether the predicate is satisfied by recorded state. */
  outcome: "satisfied" | "violated";
  /** Snapshot-qualified JSON pointer to the inspected field. */
  evidence_pointer: string;
  /** Hash of the observed value without duplicating potentially private data. */
  evidence_digest: string;
}

/** Total, reproducible result produced by a verdict contract. */
export interface VerdictResult {
  /** Stable verdict identity. */
  contract_id: string;
  /** Verdict revision. */
  contract_version: number;
  /** Exact recorded-state snapshot evaluated. */
  snapshot_id: string;
  /** Total outcome, including an explicit empty-contract state. */
  outcome: "satisfied" | "violated" | "not_applicable";
  /** Satisfied fraction, or null when no predicates are declared. */
  score: number | null;
  /** Explicitly separates evaluation from reward or learning signals. */
  policy: "verdict_only_no_reward";
  /** Stable explanation for a not-applicable verdict. */
  reason?: "no_predicates_declared";
  /** Ordered predicate evidence. */
  predicates: readonly PredicateVerdict[];
}

/** Hard limits enforced within one isolated episode. */
export interface EpisodeLimits {
  /** Maximum ordinary project-management actions. */
  max_actions: number;
  /** Maximum observations, including the close-time grading read. */
  max_observations: number;
  /** Per-observation response ceiling. */
  max_tokens_per_observation: number;
}

/** Portable specification shared by evaluation and training harnesses. */
export interface EpisodeSpecification {
  /** Versioned schema identity. */
  schema: typeof PM_EPISODE_SCHEMA;
  /** Stable episode identity and session provenance key. */
  id: string;
  /** Positive episode revision. */
  version: number;
  /** Consumer intent without coupling the runtime to a training framework. */
  mode: "benchmark" | "evaluation" | "training" | "scale_transfer";
  /** Deterministic workspace construction recipe. */
  recipe: WorkspaceRecipe;
  /** Canonical pm items that define the task set. */
  task_item_ids: readonly string[];
  /** State fields that observations may disclose. */
  observable_fields: readonly string[];
  /** Grading-only fields that must never enter observations. */
  withheld_fields: readonly string[];
  /** Bounded observation declaration. */
  observation: ObservationContract;
  /** Recorded-state verdict declaration. */
  verdict: VerdictContract;
  /** Hard action and observation limits. */
  limits: EpisodeLimits;
}

/** Reset receipt returned by an episode adapter. */
export interface EpisodeResetReceipt {
  /** Adapter-defined isolated workspace identity. */
  workspace_id: string;
  /** Stable state identity after reset. */
  state_id: string;
}

/** Action receipt returned by an episode adapter. */
export interface EpisodeActionReceipt<TOutput> {
  /** Stable state identity after the action. */
  state_id: string;
  /** Adapter-defined ordinary command result. */
  output: TOutput;
}

/** Host boundary for ordinary pm SDK actions and recorded-state reads. */
export interface EpisodeRuntimeAdapter<TAction, TOutput = unknown> {
  /** Construct a fresh isolated workspace using the declared recipe. */
  reset(recipe: WorkspaceRecipe): Promise<EpisodeResetReceipt>;
  /** Execute one ordinary action, normally by calling `PmClient.run`. */
  execute(action: TAction): Promise<EpisodeActionReceipt<TOutput>>;
  /** Read immutable grading state from the workspace system of record. */
  readRecordedState(): Promise<WorkspaceRecordedState>;
}

/** One deterministic entry in a portable episode trajectory. */
export interface EpisodeTrajectoryEntry {
  /** Monotonic event number within the isolated episode. */
  sequence: number;
  /** Stable event classification. */
  kind: "reset" | "observation" | "action" | "verdict" | "close";
  /** Snapshot, state, or observation tier associated with the event. */
  state_id: string;
}

/** Closed episode evidence without reward or framework-specific shaping. */
export interface ClosedEpisode {
  /** Deterministic total verdict. */
  verdict: VerdictResult;
  /** Complete bounded trajectory. */
  trajectory: readonly EpisodeTrajectoryEntry[];
  /** Explicitly absent to prevent verdicts from becoming reward signals. */
  reward?: never;
}

/** Isolated runtime returned for one declared agent episode. */
export interface PmEpisodeSession<TAction, TOutput> {
  /** Observe recorded state through the declared disclosure ladder. */
  observe(): Promise<ObservationResult<RecordedStateObject>>;
  /** Execute one bounded ordinary project-management action. */
  step(action: TAction): Promise<EpisodeActionReceipt<TOutput>>;
  /** Evaluate the current recorded state without closing the session. */
  score(): Promise<VerdictResult>;
  /** Evaluate and close the episode, returning immutable evidence. */
  close(): Promise<ClosedEpisode>;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

/** Reject blank user-facing identifiers at the declaration boundary. */
function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty.`);
}

/** Recursively freeze a structured clone without mutating caller input. */
function frozenCopy<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) frozenCopy(nested);
    Object.freeze(value);
  }
  return value;
}

/** Validate bounded read declarations and reject arithmetic overflow. */
function validateObservationReads(
  reads: readonly ObservationReadDeclaration[],
): void {
  if (reads.length === 0) {
    throw new Error(
      "observation.reads must declare at least one bounded read.",
    );
  }
  let readCeiling = 0;
  for (const read of reads) {
    assertNonEmpty(read.command, "observation.reads.command");
    assertPositiveInteger(
      read.budget_tokens,
      "observation.reads.budget_tokens",
    );
    readCeiling += read.budget_tokens;
    if (!Number.isSafeInteger(readCeiling)) {
      throw new Error("observation read ceilings exceed safe integer range.");
    }
  }
}

/** Validate that emitted-byte expectations are supported by bounded samples. */
function validateObservationCalibration(
  calibration: ObservationCalibration,
): void {
  if (calibration.basis !== "emitted_bytes") {
    throw new Error("observation calibration must use emitted_bytes.");
  }
  for (const sample of calibration.samples) {
    if (!Number.isSafeInteger(sample) || sample < 0) {
      throw new Error(
        "observation calibration samples must be non-negative safe integers.",
      );
    }
  }
  if (calibration.samples.length === 0) {
    throw new Error(
      "observation calibration must include at least one sample.",
    );
  }
  assertPositiveInteger(
    calibration.expected_emitted_bytes,
    "observation.calibration.expected_emitted_bytes",
  );
  if (
    !Number.isSafeInteger(calibration.tolerance_bytes) ||
    calibration.tolerance_bytes < 0
  ) {
    throw new Error(
      "observation.calibration.tolerance_bytes must be a non-negative safe integer.",
    );
  }
  const sampleMean =
    calibration.samples.reduce((total, sample) => total + sample, 0) /
    calibration.samples.length;
  if (
    Math.abs(sampleMean - calibration.expected_emitted_bytes) >
    calibration.tolerance_bytes
  ) {
    throw new Error(
      "observation expected_emitted_bytes is outside the calibrated sample tolerance.",
    );
  }
}

/** Validate the ordered disclosure ladder and every projected field path. */
function validateObservationTiers(tiers: readonly ObservationTier[]): void {
  if (tiers.length === 0) {
    throw new Error("observation.tiers must declare a degradation ladder.");
  }
  const tierIds = new Set<string>();
  let previousTierBudget = Number.POSITIVE_INFINITY;
  for (const tier of tiers) {
    assertNonEmpty(tier.id, "observation.tiers.id");
    assertPositiveInteger(tier.max_tokens, "observation.tiers.max_tokens");
    if (tierIds.has(tier.id))
      throw new Error(`Duplicate observation tier: ${tier.id}.`);
    tierIds.add(tier.id);
    if (tier.max_tokens > previousTierBudget) {
      throw new Error(
        "observation tiers must be ordered from largest to smallest max_tokens.",
      );
    }
    previousTierBudget = tier.max_tokens;
    const fields = new Set<string>();
    for (const field of tier.fields) {
      parseFieldPath(field, "observation.tiers.fields");
      if (fields.has(field)) {
        throw new Error(`Duplicate observation tier field: ${field}.`);
      }
      fields.add(field);
    }
  }
}

/** Validate, clone, and freeze a portable observation declaration. */
export function defineObservationContract(
  declaration: ObservationContract,
): ObservationContract {
  if (declaration.schema !== PM_OBSERVATION_SCHEMA) {
    throw new Error(`observation.schema must be ${PM_OBSERVATION_SCHEMA}.`);
  }
  assertNonEmpty(declaration.id, "observation.id");
  assertPositiveInteger(declaration.version, "observation.version");
  validateObservationReads(declaration.reads);
  validateObservationCalibration(declaration.calibration);
  if (declaration.corpus_dependence.kind === "bounded") {
    assertNonEmpty(
      declaration.corpus_dependence.dimension,
      "observation.corpus_dependence.dimension",
    );
    assertPositiveInteger(
      declaration.corpus_dependence.maximum,
      "observation.corpus_dependence.maximum",
    );
  }
  validateObservationTiers(declaration.tiers);
  return frozenCopy(structuredClone(declaration));
}

/** Describe guaranteed and calibrated observation cost before collection. */
export function describeObservationCost(
  contract: ObservationContract,
): ObservationCostDescription {
  return {
    contract_id: contract.id,
    contract_version: contract.version,
    guaranteed_ceiling_tokens: contract.reads.reduce(
      (total, read) => total + read.budget_tokens,
      0,
    ),
    expected_emitted_bytes: contract.calibration.expected_emitted_bytes,
    expected_tokens: Math.ceil(contract.calibration.expected_emitted_bytes / 4),
    tolerance_bytes: contract.calibration.tolerance_bytes,
    calibration_basis: "emitted_bytes",
    corpus_dependence: contract.corpus_dependence,
  };
}

/** Serve the richest declared tier that fits both caller and tier ceilings. */
export async function serveDeclaredObservation<T>(
  contract: ObservationContract,
  collect: (tier: ObservationTier) => Promise<T>,
  request: ObservationRequest,
): Promise<ObservationResult<T>> {
  assertPositiveInteger(
    request.budget_tokens,
    "observation request budget_tokens",
  );
  const attempted: string[] = [];
  for (const [index, tier] of contract.tiers.entries()) {
    attempted.push(tier.id);
    const payload = await collect(tier);
    const emittedBytes = Buffer.byteLength(stableStringify(payload), "utf8");
    const estimatedTokens = Math.ceil(emittedBytes / 4);
    if (estimatedTokens <= Math.min(request.budget_tokens, tier.max_tokens)) {
      return {
        status: "served",
        payload,
        receipt: {
          contract_id: contract.id,
          contract_version: contract.version,
          served_tier: tier.id,
          degraded: index > 0,
          attempted_tiers: attempted,
          emitted_bytes: emittedBytes,
          estimated_tokens: estimatedTokens,
          calibration_basis: "emitted_bytes",
        },
      };
    }
  }
  return {
    status: "refused",
    reason: "no_declared_tier_fits_budget",
    receipt: {
      contract_id: contract.id,
      contract_version: contract.version,
      served_tier: null,
      degraded: contract.tiers.length > 1,
      attempted_tiers: attempted,
      emitted_bytes: null,
      estimated_tokens: null,
      calibration_basis: "emitted_bytes",
    },
  };
}

/** Parse a safe dot path and reject prototype-mutating or ambiguous segments. */
function parseFieldPath(path: string, label: string): string[] {
  const segments = path.split(".");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "__proto__" ||
        segment === "prototype" ||
        segment === "constructor",
    )
  ) {
    throw new Error(`${label} must be a safe, non-empty dot-separated path.`);
  }
  return segments;
}

/** Read a declared field without interpreting inherited properties. */
function valueAtPath(root: RecordedStateObject, path: string): unknown {
  let value: unknown = root;
  for (const segment of parseFieldPath(path, "recorded field path")) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, segment)
    ) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

/** Convert a safe dot path into an RFC 6901 evidence pointer. */
function jsonPointer(path: string): string {
  return `/${parseFieldPath(path, "verdict predicate path")
    .map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/")}`;
}

/** Validate, clone, and freeze a portable total-verdict declaration. */
export function defineVerdictContract(
  declaration: VerdictContract,
): VerdictContract {
  if (declaration.schema !== PM_VERDICT_SCHEMA) {
    throw new Error(`verdict.schema must be ${PM_VERDICT_SCHEMA}.`);
  }
  assertNonEmpty(declaration.id, "verdict.id");
  assertPositiveInteger(declaration.version, "verdict.version");
  const predicateIds = new Set<string>();
  for (const predicate of declaration.predicates) {
    assertNonEmpty(predicate.id, "verdict.predicates.id");
    parseFieldPath(predicate.path, "verdict.predicates.path");
    const runtimeKind = (predicate as { kind: unknown }).kind;
    if (
      runtimeKind !== "field_equals" &&
      runtimeKind !== "field_present" &&
      runtimeKind !== "field_absent"
    ) {
      throw new Error(
        `Unsupported verdict predicate kind for ${predicate.id}.`,
      );
    }
    if (predicateIds.has(predicate.id))
      throw new Error(`Duplicate verdict predicate: ${predicate.id}.`);
    predicateIds.add(predicate.id);
  }
  if (
    declaration.composition.operator !== "all" &&
    declaration.composition.operator !== "any"
  ) {
    throw new Error("verdict composition operator must be all or any.");
  }
  if (
    declaration.composition.predicate_ids.length !==
    declaration.predicates.length
  ) {
    throw new Error(
      "verdict composition must reference every predicate exactly once.",
    );
  }
  const compositionIds = new Set(declaration.composition.predicate_ids);
  if (
    compositionIds.size !== declaration.composition.predicate_ids.length ||
    [...compositionIds].some((id) => !predicateIds.has(id))
  ) {
    throw new Error(
      "verdict composition contains duplicate or unknown predicate ids.",
    );
  }
  return frozenCopy(structuredClone(declaration));
}

/** Evaluate a total verdict exclusively from one immutable recorded snapshot. */
export function evaluateVerdictContract(
  contract: VerdictContract,
  recorded: WorkspaceRecordedState,
): VerdictResult {
  if (contract.predicates.length === 0) {
    return {
      contract_id: contract.id,
      contract_version: contract.version,
      snapshot_id: recorded.snapshot_id,
      outcome: "not_applicable",
      score: null,
      policy: "verdict_only_no_reward",
      reason: "no_predicates_declared",
      predicates: [],
    };
  }
  const byId = new Map(
    contract.predicates.map((predicate) => [predicate.id, predicate]),
  );
  const predicates = contract.composition.predicate_ids.map((id) => {
    const predicate = byId.get(id) as VerdictPredicate;
    const observed = valueAtPath(recorded.state, predicate.path);
    const satisfied =
      predicate.kind === "field_present"
        ? observed !== undefined
        : predicate.kind === "field_absent"
          ? observed === undefined
          : stableStringify(observed) === stableStringify(predicate.expected);
    return {
      id,
      outcome: satisfied ? "satisfied" : "violated",
      evidence_pointer: `${recorded.snapshot_id}#${jsonPointer(predicate.path)}`,
      evidence_digest: sha256Hex(stableStringify(observed)),
    } satisfies PredicateVerdict;
  });
  const satisfiedCount = predicates.filter(
    (predicate) => predicate.outcome === "satisfied",
  ).length;
  const satisfied =
    contract.composition.operator === "all"
      ? satisfiedCount === predicates.length
      : satisfiedCount > 0;
  return {
    contract_id: contract.id,
    contract_version: contract.version,
    snapshot_id: recorded.snapshot_id,
    outcome: satisfied ? "satisfied" : "violated",
    score: satisfiedCount / predicates.length,
    policy: "verdict_only_no_reward",
    predicates,
  };
}

/** Validate, clone, and freeze a portable episode specification. */
export function defineEpisodeSpecification(
  declaration: EpisodeSpecification,
): EpisodeSpecification {
  if (declaration.schema !== PM_EPISODE_SCHEMA) {
    throw new Error(`episode.schema must be ${PM_EPISODE_SCHEMA}.`);
  }
  assertNonEmpty(declaration.id, "episode.id");
  assertPositiveInteger(declaration.version, "episode.version");
  if (
    !["benchmark", "evaluation", "training", "scale_transfer"].includes(
      declaration.mode,
    )
  ) {
    throw new Error("episode.mode is not supported.");
  }
  if (declaration.task_item_ids.length === 0) {
    throw new Error("episode.task_item_ids must declare at least one pm item.");
  }
  for (const itemId of declaration.task_item_ids) {
    assertNonEmpty(itemId, "episode.task_item_ids");
  }
  assertPositiveInteger(
    declaration.limits.max_actions,
    "episode.limits.max_actions",
  );
  assertPositiveInteger(
    declaration.limits.max_observations,
    "episode.limits.max_observations",
  );
  assertPositiveInteger(
    declaration.limits.max_tokens_per_observation,
    "episode.limits.max_tokens_per_observation",
  );
  const withheld = new Set(declaration.withheld_fields);
  for (const field of declaration.observable_fields) {
    parseFieldPath(field, "episode.observable_fields");
    if (withheld.has(field)) {
      throw new Error(`Observable field ${field} is also a withheld field.`);
    }
  }
  for (const field of declaration.withheld_fields) {
    parseFieldPath(field, "episode.withheld_fields");
  }
  for (const tier of declaration.observation.tiers) {
    for (const field of tier.fields) {
      if (!declaration.observable_fields.includes(field)) {
        throw new Error(
          `Observation tier field ${field} is not declared observable.`,
        );
      }
    }
  }
  defineObservationContract(declaration.observation);
  defineVerdictContract(declaration.verdict);
  defineWorkspaceRecipe(declaration.recipe);
  return frozenCopy(structuredClone(declaration));
}

/** Copy one selected field into a null-prototype-safe projected object. */
function assignProjectedPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const segments = parseFieldPath(path, "observation projection field");
  let cursor = target;
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      if (value !== undefined) cursor[segment] = structuredClone(value);
      return;
    }
    const nested = cursor[segment];
    if (
      nested === null ||
      typeof nested !== "object" ||
      Array.isArray(nested)
    ) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
}

/** Project only declared tier fields from recorded workspace state. */
function projectedState(
  state: RecordedStateObject,
  fields: readonly string[],
): RecordedStateObject {
  const result: Record<string, unknown> = {};
  for (const field of fields)
    assignProjectedPath(result, field, valueAtPath(state, field));
  return result;
}

/** Open one isolated, deterministic episode around an adapter's ordinary actions. */
export async function openPmEpisode<TAction, TOutput = unknown>(
  specification: EpisodeSpecification,
  adapter: EpisodeRuntimeAdapter<TAction, TOutput>,
): Promise<PmEpisodeSession<TAction, TOutput>> {
  const trajectory: EpisodeTrajectoryEntry[] = [];
  let actions = 0;
  let observations = 0;
  let closed = false;
  const context = {
    episode: {
      id: specification.id,
      label: `pm agent environment v${specification.version}`,
    },
    provenance: { role: specification.mode, topic: "agent-environment" },
  };
  const reset = await runWithAgentSessionContext(context, () =>
    adapter.reset(specification.recipe),
  );
  trajectory.push({ sequence: 1, kind: "reset", state_id: reset.state_id });

  const readObservation = async (): Promise<
    ObservationResult<RecordedStateObject>
  > => {
    if (closed) throw new Error("episode is already closed.");
    if (observations >= specification.limits.max_observations) {
      throw new Error("episode exceeded limits.max_observations.");
    }
    observations += 1;
    const recorded = await adapter.readRecordedState();
    const result = await serveDeclaredObservation(
      specification.observation,
      async (tier) => projectedState(recorded.state, tier.fields),
      { budget_tokens: specification.limits.max_tokens_per_observation },
    );
    trajectory.push({
      sequence: trajectory.length + 1,
      kind: "observation",
      state_id: result.receipt.served_tier ?? recorded.snapshot_id,
    });
    return result;
  };

  const evaluate = async (): Promise<VerdictResult> => {
    if (closed) throw new Error("episode is already closed.");
    const recorded = await adapter.readRecordedState();
    const result = evaluateVerdictContract(specification.verdict, recorded);
    trajectory.push({
      sequence: trajectory.length + 1,
      kind: "verdict",
      state_id: recorded.snapshot_id,
    });
    return result;
  };

  return {
    observe: () => runWithAgentSessionContext(context, readObservation),
    step: async (action) => {
      if (closed) throw new Error("episode is already closed.");
      if (actions >= specification.limits.max_actions) {
        throw new Error("episode exceeded limits.max_actions.");
      }
      actions += 1;
      const result = await runWithAgentSessionContext(context, () =>
        adapter.execute(action),
      );
      trajectory.push({
        sequence: trajectory.length + 1,
        kind: "action",
        state_id: result.state_id,
      });
      return result;
    },
    score: () => runWithAgentSessionContext(context, evaluate),
    close: async () => {
      const verdict = await runWithAgentSessionContext(context, evaluate);
      closed = true;
      trajectory.push({
        sequence: trajectory.length + 1,
        kind: "close",
        state_id: verdict.snapshot_id,
      });
      return { verdict, trajectory: frozenCopy(structuredClone(trajectory)) };
    },
  };
}
