/**
 * @module sdk/assurance
 *
 * Declares, persists, evaluates, and audits project assurance contracts. The
 * module deliberately owns semantics while hosts inject workspace data and
 * external measurement adapters, keeping CLI, MCP, CI, and embedded callers on
 * one deterministic SDK path.
 */
import path from "node:path";

import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import {
  appendWorkspaceAuditEvent,
  mutateWorkspaceJsonWithHistory,
  readFileIfExists,
  readHistoryEntries,
  resolveAuthor,
  stableStringify,
  WORKSPACE_HISTORY_ID,
  getWorkspaceHistoryPath,
} from "../runtime-primitives.js";

/** Current serialized assurance registry format. */
export const ASSURANCE_DOCUMENT_VERSION = 1 as const;

/** Supported lifecycle points that can evaluate a gate. */
export const ASSURANCE_GATE_TRIGGERS = [
  "pre-commit",
  "pre-push",
  "pre-merge",
  "ci",
  "pre-release",
  "post-release",
  "scheduled",
  "on-claim",
  "on-close",
] as const;

/** Gate lifecycle trigger. */
export type AssuranceGateTrigger = (typeof ASSURANCE_GATE_TRIGGERS)[number];

/** Assertion enforcement strength. */
export type AssuranceEnforcement = "block" | "warn" | "observe";

/** Assertion lifetime after its owning work item becomes terminal. */
export type AssuranceLifetime = "hold" | "retire";

/** Numeric or labelled-set value produced by a measurement. */
export type AssuranceValue = number | string[];

/** Minimal dependency row used by built-in relationship measurements. */
export interface AssuranceDependencyRecord {
  /** Target item id. */
  id: string;
  /** Typed relationship kind. */
  kind: string;
}

/** Minimal item projection consumed by built-in measurement sources. */
export interface AssuranceItemRecord {
  /** Stable item id. */
  id: string;
  /** Lifecycle status. */
  status: string;
  /** Item type. */
  type: string;
  /** Optional tags. */
  tags?: string[];
  /** Optional priority. */
  priority?: string | number;
  /** Typed relationships. */
  dependencies?: AssuranceDependencyRecord[];
  /** Linked files. */
  files?: Array<Record<string, unknown>>;
  /** Linked tests. */
  tests?: Array<Record<string, unknown>>;
  /** Linked docs. */
  docs?: Array<Record<string, unknown>>;
  /** Extension-owned metadata remains filterable. */
  [key: string]: unknown;
}

/** Minimal immutable-history row consumed by history measurements. */
export interface AssuranceHistoryRecord {
  /** Mutation operation. */
  op: string;
  /** Mutation author. */
  author: string;
  /** Optional detected harness. */
  agent_harness?: string;
  /** Optional detected model. */
  agent_model?: string;
  /** Extensible history metadata. */
  [key: string]: unknown;
}

/** Item-population measurement source. */
export interface AssuranceItemsSource {
  /** Source discriminant. */
  kind: "items";
  /** Allowed statuses. */
  statuses?: string[];
  /** Allowed item types. */
  types?: string[];
  /** Tags that must all be present. */
  tags?: string[];
  /** Optional metadata field. */
  field?: string;
  /** Required exact value for field. */
  equals?: string | number | boolean | null;
}

/** Typed relationship-count source. */
export interface AssuranceDependencyKindSource {
  /** Source discriminant. */
  kind: "dependency_kind";
  /** Relationship kind to count. */
  dependency_kind: string;
}

/** Graph-analytics source delegated to a host adapter. */
export interface AssuranceGraphSource {
  /** Source discriminant. */
  kind: "graph";
  /** Graph analytic to execute. */
  operation: string;
  /** Numeric or labelled-set field to select. */
  field: string;
  /** Optional analytic arguments. */
  parameters?: Record<string, string | number | boolean>;
}

/** Validator source delegated to a host adapter. */
export interface AssuranceValidateSource {
  /** Source discriminant. */
  kind: "validate";
  /** Stable validator check id. */
  check: string;
  /** Numeric field within the check result. */
  field: string;
}

/** Health-check source delegated to a host adapter. */
export interface AssuranceHealthSource {
  /** Source discriminant. */
  kind: "health";
  /** Stable health check id. */
  check: string;
  /** Numeric field within the check result. */
  field: string;
}

/** Immutable-history population source. */
export interface AssuranceHistorySource {
  /** Source discriminant. */
  kind: "history";
  /** Optional operation filter. */
  op?: string;
  /** Optional author filter. */
  author?: string;
  /** Optional harness filter. */
  harness?: string;
  /** Optional model filter. */
  model?: string;
}

/** Linked evidence population source. */
export interface AssuranceLinksSource {
  /** Source discriminant. */
  kind: "links";
  /** Evidence collection to inspect. */
  link: "files" | "tests" | "docs";
  /** Count items with or without at least one link. */
  state: "present" | "missing";
}

/** Extension- or host-contributed measurement source. */
export interface AssuranceProviderSource {
  /** Source discriminant. */
  kind: "provider";
  /** Stable provider id. */
  provider: string;
  /** Provider-owned measurement key. */
  key: string;
  /** Provider-owned JSON-compatible parameters. */
  parameters?: Record<string, string | number | boolean | null>;
}

/** Reference to another measurement inside a derived expression. */
export interface AssuranceMeasurementReference {
  /** Referenced measurement id. */
  measurement: string;
}

/** Literal numeric term inside a derived expression. */
export interface AssuranceLiteralExpression {
  /** Literal number. */
  literal: number;
}

/** Arithmetic expression over measurement references and literals. */
export interface AssuranceArithmeticExpression {
  /** Deterministic arithmetic operation. */
  operator: "add" | "subtract" | "multiply" | "divide" | "min" | "max";
  /** Ordered operands. */
  operands: AssuranceDerivedExpression[];
}

/** Recursive derived-measurement expression. */
export type AssuranceDerivedExpression =
  | AssuranceMeasurementReference
  | AssuranceLiteralExpression
  | AssuranceArithmeticExpression;

/** Derived arithmetic source. */
export interface AssuranceDerivedSource {
  /** Source discriminant. */
  kind: "derived";
  /** Arithmetic expression. */
  expression: AssuranceDerivedExpression;
}

/** Complete measurement source vocabulary. */
export type AssuranceMeasurementSource =
  | AssuranceItemsSource
  | AssuranceDependencyKindSource
  | AssuranceGraphSource
  | AssuranceValidateSource
  | AssuranceHealthSource
  | AssuranceHistorySource
  | AssuranceLinksSource
  | AssuranceProviderSource
  | AssuranceDerivedSource;

/** Persisted measurement declaration. */
export interface AssuranceMeasurementDefinition {
  /** Stable registry id. */
  id: string;
  /** Optional intent description. */
  description?: string;
  /** Measurement source. */
  source: AssuranceMeasurementSource;
  /** Maximum abstract compute units accepted for one evaluation. */
  max_cost?: number;
}

/** Explicit population scope asserted by a bound. */
export type AssuranceScope =
  | { /** Scope discriminant. */ kind: "all" }
  | { /** Scope discriminant. */ kind: "active" }
  | {
      /** Scope discriminant. */
      kind: "filter";
      /** Saved measurement whose population defines the scope. */
      measurement_id: string;
    };

/** One assertion negative-control case. */
export interface AssuranceNegativeControlCase {
  /** Synthetic observation. */
  observed: AssuranceValue;
  /** Expected comparator result. */
  expected: "pass" | "fail";
}

/** Required negative-control suite proving a bound can both pass and fail. */
export interface AssuranceNegativeControl {
  /** Synthetic comparator cases. */
  cases: AssuranceNegativeControlCase[];
}

/** Persisted assertion declaration. Exactly one polarity field is valid. */
export interface AssuranceAssertionDefinition {
  /** Stable registry id. */
  id: string;
  /** Registry key of the observation constrained by this guarantee. */
  measurement_id: string;
  /** pm item that owns this guarantee. */
  owner_item_id: string;
  /** Explicit asserted population scope. */
  scope: AssuranceScope;
  /** Maximum permitted value. */
  ceiling?: number;
  /** Minimum permitted value. */
  floor?: number;
  /** Exact permitted scalar or labelled set. */
  equals?: AssuranceValue;
  /** Require numeric zero. */
  zero?: true;
  /** Require no decrease from the numeric baseline. */
  monotone_nondecreasing?: number;
  /** Require no increase from the numeric baseline. */
  monotone_nonincreasing?: number;
  /** Require the observed labelled set to be a subset. */
  subset_of?: string[];
  /** Behavior after owner termination. */
  lifetime?: AssuranceLifetime;
  /** Required explanation when lifetime retires. */
  retire_reason?: string;
  /** Enforcement strength. */
  enforcement: AssuranceEnforcement;
  /** Required proof that the comparator distinguishes good and bad values. */
  negative_control: AssuranceNegativeControl;
  /** Decision item authorizing a loosening update. */
  authorization_decision?: string;
}

/** Persisted gate declaration. */
export interface AssuranceGateDefinition {
  /** Stable registry id. */
  id: string;
  /** Assertion ids evaluated by this gate. */
  assertion_ids: string[];
  /** Lifecycle triggers allowed to run it. */
  triggers: AssuranceGateTrigger[];
  /** Optional description. */
  description?: string;
}

/** Complete persisted assurance registry. */
export interface AssuranceDocument {
  /** Storage format version. */
  version: typeof ASSURANCE_DOCUMENT_VERSION;
  /** Measurement declarations. */
  measurements: AssuranceMeasurementDefinition[];
  /** Assertion declarations. */
  assertions: AssuranceAssertionDefinition[];
  /** Gate declarations. */
  gates: AssuranceGateDefinition[];
}

/** Host adapter result for graph, validate, health, or provider sources. */
export interface AssuranceExternalMeasurementResult {
  /** Observed value. */
  value: AssuranceValue;
  /** Population denominator. */
  population_size: number;
  /** Abstract compute units charged by the adapter. */
  cost: number;
  /** Optional contributors that moved the value. */
  contributors?: string[];
}

/** SDK evaluation inputs supplied by a host. */
export interface AssuranceEvaluationContext {
  /** Commit, tree, snapshot, or workspace identity being judged. */
  tree_id: string;
  /** Item rows for built-in sources. */
  items: AssuranceItemRecord[];
  /** Immutable history rows for built-in history sources. */
  history: AssuranceHistoryRecord[];
  /** Status ids that make an assertion owner terminal. */
  terminal_statuses?: string[];
  /** External source adapter. Implementations must enforce an appropriate timeout. */
  external: (
    source:
      | AssuranceGraphSource
      | AssuranceValidateSource
      | AssuranceHealthSource
      | AssuranceProviderSource,
  ) => Promise<AssuranceExternalMeasurementResult>;
}

/** Compute receipt for one measurement. */
export interface AssuranceMeasurementCost {
  /** Total abstract units. */
  units: number;
  /** Item rows scanned. */
  items_scanned: number;
  /** History rows scanned. */
  history_entries: number;
  /** External provider calls. */
  provider_calls: number;
  /** Wall-clock duration. */
  duration_ms: number;
}

/** Evaluated measurement receipt. */
export interface AssuranceMeasurementResult {
  /** Measurement id. */
  id: string;
  /** Observed value. */
  value: AssuranceValue;
  /** Population denominator. */
  population_size: number;
  /** Compute receipt. */
  cost: AssuranceMeasurementCost;
  /** Optional contributors. */
  contributors: string[];
}

/** Structured assertion bound. */
export interface AssuranceBound {
  /** Comparator applied to the observed value and declared bound. */
  polarity:
    | "ceiling"
    | "floor"
    | "equals"
    | "zero"
    | "monotone_nondecreasing"
    | "monotone_nonincreasing"
    | "subset_of";
  /** Declared bound value. */
  value: AssuranceValue;
}

/** One assertion row inside a gate verdict. */
export interface AssuranceAssertionVerdict {
  /** Stable guarantee key that produced this evaluation row. */
  assertion_id: string;
  /** Stable observation key used to obtain the evaluated value. */
  measurement_id: string;
  /** Explicit scope. */
  scope: AssuranceScope;
  /** Population denominator. */
  population_size: number;
  /** Numeric or labelled-set value captured for the judged population. */
  observed: AssuranceValue;
  /** Structured bound. */
  bound: AssuranceBound;
  /** Signed numeric distance when applicable. */
  distance: number | null;
  /** Assertion result. */
  verdict: "pass" | "fail" | "retired";
  /** Enforcement strength. */
  enforcement: AssuranceEnforcement;
  /** Whether negative controls proved the comparator. */
  negative_control_proven: boolean;
  /** Compute receipt. */
  cost: AssuranceMeasurementCost;
  /** Optional contributors. */
  contributors: string[];
}

/** Complete gate verdict shared by every presentation and execution surface. */
export interface AssuranceGateVerdict {
  /** Stable lifecycle-policy key that produced this verdict. */
  gate_id: string;
  /** Judged tree identity. */
  tree_id: string;
  /** Evaluation trigger. */
  trigger: AssuranceGateTrigger;
  /** Whether history persistence was intentionally skipped. */
  dry_run: boolean;
  /** ISO timestamp. */
  evaluated_at: string;
  /** Overall result. */
  verdict: "pass" | "warn" | "block";
  /** Stable process exit code. */
  exit_code: 0 | 1;
  /** Per-assertion receipts. */
  assertions: AssuranceAssertionVerdict[];
  /** Aggregate compute receipt. */
  cost: AssuranceMeasurementCost;
}

/** Mutation attribution accepted by registry and verdict writes. */
export interface AssuranceMutationOptions {
  /** Explicit author override; normal callers omit it for harness detection. */
  author?: string;
  /** Optional audited rationale. */
  message?: string;
  /** Decision item ids the caller has verified as authorization. */
  authorized_decision_ids?: string[];
}

/** Declaration collection kind. */
export type AssuranceDeclarationKind = "measurement" | "assertion" | "gate";

/** Declaration union accepted by persistence helpers. */
export type AssuranceDeclaration =
  | AssuranceMeasurementDefinition
  | AssuranceAssertionDefinition
  | AssuranceGateDefinition;

/** Registry mutation receipt. */
export interface AssuranceMutationReceipt {
  /** Whether serialized state changed. */
  changed: boolean;
  /** Mutation outcome. */
  action: "created" | "updated" | "removed";
  /** Declaration kind. */
  kind: AssuranceDeclarationKind;
  /** Declaration id. */
  id: string;
}

const POLARITY_KEYS = [
  "ceiling",
  "floor",
  "equals",
  "zero",
  "monotone_nondecreasing",
  "monotone_nonincreasing",
  "subset_of",
] as const;
const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const LOCK_TTL_SECONDS = 30;
const LOCK_WAIT_MS = 5_000;
const EVALUATION_CONCURRENCY = 4;
const DEFAULT_VERDICT_LIMIT = 50;
const MAX_VERDICT_LIMIT = 1_000;

function requireStableId(value: string, field: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a stable lowercase id`);
  }
}

function requireFiniteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite non-negative number`);
  }
}

function boundFor(assertion: AssuranceAssertionDefinition): AssuranceBound {
  const present = POLARITY_KEYS.filter((key) => assertion[key] !== undefined);
  if (present.length !== 1) {
    throw new TypeError(
      `assertion ${assertion.id} must declare exactly one polarity`,
    );
  }
  const polarity = present[0];
  const raw = assertion[polarity];
  return {
    polarity,
    value: polarity === "zero" ? 0 : (raw as AssuranceValue),
  };
}

function valuesEqual(left: AssuranceValue, right: AssuranceValue): boolean {
  return stableStringify(left) === stableStringify(right);
}

function compareBound(observed: AssuranceValue, bound: AssuranceBound): boolean {
  if (bound.polarity === "equals") return valuesEqual(observed, bound.value);
  if (bound.polarity === "subset_of") {
    if (!Array.isArray(observed) || !Array.isArray(bound.value)) return false;
    const allowed = bound.value;
    return observed.every((entry) => allowed.includes(entry));
  }
  if (typeof observed !== "number") {
    return false;
  }
  const numericBound = bound.value as number;
  if (bound.polarity === "ceiling" || bound.polarity === "monotone_nonincreasing") {
    return observed <= numericBound;
  }
  if (bound.polarity === "floor" || bound.polarity === "monotone_nondecreasing") {
    return observed >= numericBound;
  }
  return observed === 0;
}

function proveNegativeControl(assertion: AssuranceAssertionDefinition): boolean {
  const bound = boundFor(assertion);
  const cases = assertion.negative_control.cases;
  return (
    cases.some((entry) => entry.expected === "pass") &&
    cases.some((entry) => entry.expected === "fail") &&
    cases.every(
      (entry) =>
        compareBound(entry.observed, bound) === (entry.expected === "pass"),
    )
  );
}

function boundUpdateIsLoosening(
  beforeBound: AssuranceBound,
  afterBound: AssuranceBound,
): boolean {
  if (beforeBound.polarity !== afterBound.polarity) return true;
  if (typeof beforeBound.value === "number" && typeof afterBound.value === "number") {
    return (
      beforeBound.polarity === "ceiling" || beforeBound.polarity === "monotone_nonincreasing"
        ? afterBound.value > beforeBound.value
        : beforeBound.polarity === "floor" || beforeBound.polarity === "monotone_nondecreasing"
          ? afterBound.value < beforeBound.value
          : afterBound.value !== beforeBound.value
    );
  }
  if (beforeBound.polarity === "subset_of") {
    const beforeValues = beforeBound.value;
    const afterValues = afterBound.value;
    return (
      !Array.isArray(beforeValues) ||
      !Array.isArray(afterValues) ||
      afterValues.some((entry) => !beforeValues.includes(entry))
    );
  }
  return !valuesEqual(beforeBound.value, afterBound.value);
}

/** Return true when an assertion update weakens scope, bound, lifetime, or enforcement. */
export function assuranceAssertionUpdateIsLoosening(
  before: AssuranceAssertionDefinition,
  after: AssuranceAssertionDefinition,
): boolean {
  if (
    before.measurement_id !== after.measurement_id ||
    before.owner_item_id !== after.owner_item_id ||
    stableStringify(before.scope) !== stableStringify(after.scope)
  ) {
    return true;
  }
  const enforcementRank: Record<AssuranceEnforcement, number> = {
    observe: 0,
    warn: 1,
    block: 2,
  };
  const lifetimeLoosened =
    (before.lifetime ?? "hold") === "hold" && (after.lifetime ?? "hold") === "retire";
  return (
    boundUpdateIsLoosening(boundFor(before), boundFor(after)) ||
    enforcementRank[after.enforcement] < enforcementRank[before.enforcement] ||
    lifetimeLoosened
  );
}

/** Validate and return one measurement declaration. */
export function validateMeasurementDefinition(
  definition: AssuranceMeasurementDefinition,
): AssuranceMeasurementDefinition {
  requireStableId(definition.id, "measurement.id");
  if (definition.max_cost !== undefined) {
    requireFiniteNonNegative(definition.max_cost, "measurement.max_cost");
  }
  const source = definition.source;
  if (source.kind === "items" && source.field !== undefined && source.equals === undefined) {
    throw new TypeError("items source with field requires equals");
  }
  if (source.kind === "dependency_kind" && source.dependency_kind.trim().length === 0) {
    throw new TypeError("dependency_kind source requires dependency_kind");
  }
  if ((source.kind === "graph" || source.kind === "validate" || source.kind === "health") && source.field.trim().length === 0) {
    throw new TypeError(`${source.kind} source requires field`);
  }
  if (source.kind === "provider") {
    requireStableId(source.provider, "provider source provider");
    requireStableId(source.key, "provider source key");
  }
  return definition;
}

/** Validate and return one assertion declaration. */
export function validateAssertionDefinition(
  definition: AssuranceAssertionDefinition,
): AssuranceAssertionDefinition {
  requireStableId(definition.id, "assertion.id");
  requireStableId(definition.measurement_id, "assertion.measurement_id");
  if (definition.owner_item_id.trim().length === 0) {
    throw new TypeError("assertion.owner_item_id is required");
  }
  const bound = boundFor(definition);
  if (typeof bound.value === "number" && !Number.isFinite(bound.value)) {
    throw new TypeError(`assertion.${bound.polarity} must be a finite number`);
  }
  if (definition.lifetime === "retire" && !definition.retire_reason?.trim()) {
    throw new TypeError("retired assertion requires retire_reason");
  }
  if (definition.scope.kind === "filter") {
    requireStableId(definition.scope.measurement_id, "assertion.scope.measurement_id");
  }
  const cases = definition.negative_control?.cases;
  if (!Array.isArray(cases) || !cases.some((entry) => entry.expected === "pass") || !cases.some((entry) => entry.expected === "fail")) {
    throw new TypeError("assertion negative control requires pass and fail cases");
  }
  if (!proveNegativeControl(definition)) {
    throw new TypeError(`assertion ${definition.id} negative control does not prove its bound`);
  }
  return definition;
}

/** Validate and return one gate declaration. */
export function validateGateDefinition(
  definition: AssuranceGateDefinition,
): AssuranceGateDefinition {
  requireStableId(definition.id, "gate.id");
  if (definition.assertion_ids.length === 0) {
    throw new TypeError("gate requires at least one assertion");
  }
  for (const id of definition.assertion_ids) requireStableId(id, "gate.assertion_id");
  if (definition.triggers.length === 0) {
    throw new TypeError("gate requires at least one trigger");
  }
  return definition;
}

/** Validate registry references, uniqueness, and declaration-local contracts. */
export function validateAssuranceDocument(
  document: AssuranceDocument,
): AssuranceDocument {
  if (document.version !== ASSURANCE_DOCUMENT_VERSION) {
    throw new TypeError(`unsupported assurance document version ${String(document.version)}`);
  }
  const ids = new Set<string>();
  for (const definition of document.measurements) {
    validateMeasurementDefinition(definition);
    if (ids.has(`measurement:${definition.id}`)) throw new TypeError(`duplicate measurement ${definition.id}`);
    ids.add(`measurement:${definition.id}`);
  }
  for (const definition of document.assertions) {
    validateAssertionDefinition(definition);
    if (ids.has(`assertion:${definition.id}`)) throw new TypeError(`duplicate assertion ${definition.id}`);
    ids.add(`assertion:${definition.id}`);
  }
  for (const definition of document.gates) {
    validateGateDefinition(definition);
    const missing = definition.assertion_ids.filter(
      (id) => !document.assertions.some((assertionDefinition) => assertionDefinition.id === id),
    );
    if (missing.length > 0) throw new TypeError(`gate ${definition.id} references missing assertions: ${missing.join(", ")}`);
    if (ids.has(`gate:${definition.id}`)) throw new TypeError(`duplicate gate ${definition.id}`);
    ids.add(`gate:${definition.id}`);
  }
  const measurementIds = new Set(document.measurements.map((entry) => entry.id));
  for (const [measurementId, consumers] of collectMeasurementReferences(document)) {
    if (!measurementIds.has(measurementId)) {
      throw new TypeError(
        `${consumers.join(", ")} references missing measurement ${measurementId}`,
      );
    }
  }
  return document;
}

function collectExpressionMeasurementReferences(
  expression: AssuranceDerivedExpression,
  references: string[],
): void {
  if ("measurement" in expression) {
    references.push(expression.measurement);
    return;
  }
  if ("operator" in expression) {
    for (const operand of expression.operands) {
      collectExpressionMeasurementReferences(operand, references);
    }
  }
}

function collectMeasurementReferences(
  document: AssuranceDocument,
): Map<string, string[]> {
  const references = new Map<string, string[]>();
  const add = (measurementId: string, consumer: string): void => {
    const consumers = references.get(measurementId) ?? [];
    consumers.push(consumer);
    references.set(measurementId, consumers);
  };
  for (const assertionDefinition of document.assertions) {
    add(assertionDefinition.measurement_id, `assertion ${assertionDefinition.id}`);
    if (assertionDefinition.scope.kind === "filter") {
      add(
        assertionDefinition.scope.measurement_id,
        `assertion ${assertionDefinition.id} scope`,
      );
    }
  }
  for (const measurementDefinition of document.measurements) {
    if (measurementDefinition.source.kind !== "derived") continue;
    const derivedReferences: string[] = [];
    collectExpressionMeasurementReferences(
      measurementDefinition.source.expression,
      derivedReferences,
    );
    for (const measurementId of derivedReferences) {
      add(measurementId, `derived measurement ${measurementDefinition.id}`);
    }
  }
  return references;
}

/** Create an empty, valid assurance registry. */
export function createEmptyAssuranceDocument(): AssuranceDocument {
  return { version: ASSURANCE_DOCUMENT_VERSION, measurements: [], assertions: [], gates: [] };
}

function itemsSourceResult(
  source: AssuranceItemsSource,
  context: AssuranceEvaluationContext,
): AssuranceExternalMeasurementResult {
  const matches = context.items.filter(
    (item) =>
      (source.statuses === undefined || source.statuses.includes(item.status)) &&
      (source.types === undefined || source.types.includes(item.type)) &&
      (source.tags === undefined ||
        source.tags.every((tag) => item.tags?.includes(tag))) &&
      (source.field === undefined ||
        valuesEqual(
          item[source.field] as AssuranceValue,
          source.equals as AssuranceValue,
        )),
  );
  return {
    value: matches.length,
    population_size: context.items.length,
    cost: context.items.length,
    contributors: matches.map((item) => item.id),
  };
}

function dependencyKindSourceResult(
  source: AssuranceDependencyKindSource,
  context: AssuranceEvaluationContext,
): AssuranceExternalMeasurementResult {
  const contributors: string[] = [];
  for (const item of context.items) {
    for (const dependency of item.dependencies ?? []) {
      if (dependency.kind === source.dependency_kind) {
        contributors.push(`${item.id}->${dependency.id}`);
      }
    }
  }
  return {
    value: contributors.length,
    population_size: context.items.length,
    cost: context.items.length,
    contributors,
  };
}

function historySourceResult(
  source: AssuranceHistorySource,
  context: AssuranceEvaluationContext,
): AssuranceExternalMeasurementResult {
  const matches = context.history.filter(
    (entry) =>
      (source.op === undefined || entry.op === source.op) &&
      (source.author === undefined || entry.author === source.author) &&
      (source.harness === undefined ||
        entry.agent_harness === source.harness) &&
      (source.model === undefined || entry.agent_model === source.model),
  );
  return {
    value: matches.length,
    population_size: context.history.length,
    cost: context.history.length,
  };
}

function linksSourceResult(
  source: AssuranceLinksSource,
  context: AssuranceEvaluationContext,
): AssuranceExternalMeasurementResult {
  const matches = context.items.filter((item) => {
    const links = item[source.link];
    const present = Array.isArray(links) && links.length > 0;
    return source.state === "present" ? present : !present;
  });
  return {
    value: matches.length,
    population_size: context.items.length,
    cost: context.items.length,
    contributors: matches.map((item) => item.id),
  };
}

function sourceResult(
  definition: AssuranceMeasurementDefinition,
  context: AssuranceEvaluationContext,
): AssuranceExternalMeasurementResult | null {
  const source = definition.source;
  if (source.kind === "items") return itemsSourceResult(source, context);
  if (source.kind === "dependency_kind") {
    return dependencyKindSourceResult(source, context);
  }
  if (source.kind === "history") return historySourceResult(source, context);
  if (source.kind === "links") return linksSourceResult(source, context);
  return null;
}

function sumCosts(costs: AssuranceMeasurementCost[], durationMs: number): AssuranceMeasurementCost {
  return costs.reduce<AssuranceMeasurementCost>(
    (total, cost) => ({
      units: total.units + cost.units,
      items_scanned: total.items_scanned + cost.items_scanned,
      history_entries: total.history_entries + cost.history_entries,
      provider_calls: total.provider_calls + cost.provider_calls,
      duration_ms: durationMs,
    }),
    { units: 0, items_scanned: 0, history_entries: 0, provider_calls: 0, duration_ms: durationMs },
  );
}

function arithmeticValue(operator: AssuranceArithmeticExpression["operator"], values: number[]): number {
  if (values.length === 0) throw new TypeError(`derived ${operator} requires operands`);
  if (operator === "add") return values.reduce((sum, value) => sum + value, 0);
  if (operator === "subtract") return values.slice(1).reduce((result, value) => result - value, values[0]);
  if (operator === "multiply") return values.reduce((result, value) => result * value, 1);
  if (operator === "divide") {
    if (values.slice(1).includes(0)) throw new TypeError("derived divide cannot divide by zero");
    return values.slice(1).reduce((result, value) => result / value, values[0]);
  }
  return operator === "min" ? Math.min(...values) : Math.max(...values);
}

interface AssuranceEvaluationState {
  cache: Map<string, Promise<AssuranceMeasurementResult>>;
  charged: Set<string>;
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  limit: number,
  transform: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await transform(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function evaluateExpression(
  expression: AssuranceDerivedExpression,
  context: AssuranceEvaluationContext,
  definitions: AssuranceMeasurementDefinition[],
  stack: string[],
  state: AssuranceEvaluationState,
): Promise<{ value: number; costs: AssuranceMeasurementCost[]; population_size: number; contributors: string[] }> {
  if ("literal" in expression) return { value: expression.literal, costs: [], population_size: 0, contributors: [] };
  if ("measurement" in expression) {
    const definition = definitions.find((entry) => entry.id === expression.measurement);
    if (!definition) throw new TypeError(`derived measurement references missing ${expression.measurement}`);
    const result = await evaluateMeasurementCached(
      definition,
      context,
      definitions,
      stack,
      state,
    );
    if (typeof result.value !== "number") throw new TypeError(`derived measurement ${definition.id} is not numeric`);
    const costs = state.charged.has(definition.id) ? [] : [result.cost];
    state.charged.add(definition.id);
    return { value: result.value, costs, population_size: result.population_size, contributors: result.contributors };
  }
  const operands = await mapWithConcurrency(
    expression.operands,
    EVALUATION_CONCURRENCY,
    (operand) => evaluateExpression(operand, context, definitions, stack, state),
  );
  return {
    value: arithmeticValue(expression.operator, operands.map((entry) => entry.value)),
    costs: operands.flatMap((entry) => entry.costs),
    population_size: Math.max(0, ...operands.map((entry) => entry.population_size)),
    contributors: [...new Set(operands.flatMap((entry) => entry.contributors))],
  };
}

async function evaluateMeasurementInternal(
  definition: AssuranceMeasurementDefinition,
  context: AssuranceEvaluationContext,
  definitions: AssuranceMeasurementDefinition[],
  stack: string[],
  state: AssuranceEvaluationState,
): Promise<AssuranceMeasurementResult> {
  validateMeasurementDefinition(definition);
  const startedAt = Date.now();
  let result: AssuranceExternalMeasurementResult;
  let nestedCosts: AssuranceMeasurementCost[] = [];
  let providerCalls = 0;
  if (definition.source.kind === "derived") {
    const derived = await evaluateExpression(
      definition.source.expression,
      context,
      definitions,
      [...stack, definition.id],
      state,
    );
    result = { value: derived.value, population_size: derived.population_size, cost: 0, contributors: derived.contributors };
    nestedCosts = derived.costs;
  } else {
    const builtin = sourceResult(definition, context);
    if (builtin !== null) {
      result = builtin;
    } else if (
      definition.source.kind === "graph" ||
      definition.source.kind === "validate" ||
      definition.source.kind === "health" ||
      definition.source.kind === "provider"
    ) {
      result = await context.external(definition.source);
      providerCalls = 1;
    } else {
      throw new TypeError(`unsupported assurance source ${definition.source.kind}`);
    }
  }
  const ownCost: AssuranceMeasurementCost = {
    units: result.cost,
    items_scanned: definition.source.kind === "items" || definition.source.kind === "dependency_kind" || definition.source.kind === "links" ? context.items.length : 0,
    history_entries: definition.source.kind === "history" ? context.history.length : 0,
    provider_calls: providerCalls,
    duration_ms: Date.now() - startedAt,
  };
  const cost = sumCosts([...nestedCosts, ownCost], Date.now() - startedAt);
  if (definition.max_cost !== undefined && cost.units > definition.max_cost) {
    throw new TypeError(`measurement ${definition.id} exceeded cost ceiling ${definition.max_cost} with ${cost.units}`);
  }
  return { id: definition.id, value: result.value, population_size: result.population_size, cost, contributors: result.contributors ?? [] };
}

function evaluateMeasurementCached(
  definition: AssuranceMeasurementDefinition,
  context: AssuranceEvaluationContext,
  definitions: AssuranceMeasurementDefinition[],
  stack: string[],
  state: AssuranceEvaluationState,
): Promise<AssuranceMeasurementResult> {
  if (stack.includes(definition.id)) {
    throw new TypeError(
      `derived measurement cycle: ${[...stack, definition.id].join(" -> ")}`,
    );
  }
  const cached = state.cache.get(definition.id);
  if (cached) return cached;
  const evaluation = evaluateMeasurementInternal(
    definition,
    context,
    definitions,
    stack,
    state,
  );
  state.cache.set(definition.id, evaluation);
  return evaluation;
}

/** Evaluate one measurement with cycle detection and a complete cost receipt. */
export async function evaluateMeasurement(
  definition: AssuranceMeasurementDefinition,
  context: AssuranceEvaluationContext,
  definitions: AssuranceMeasurementDefinition[] = [definition],
): Promise<AssuranceMeasurementResult> {
  return evaluateMeasurementCached(definition, context, definitions, [], {
    cache: new Map(),
    charged: new Set(),
  });
}

function assertionDistance(observed: AssuranceValue, bound: AssuranceBound): number | null {
  if (typeof observed !== "number" || typeof bound.value !== "number") return null;
  if (bound.polarity === "ceiling" || bound.polarity === "monotone_nonincreasing") return bound.value - observed;
  if (bound.polarity === "floor" || bound.polarity === "monotone_nondecreasing") return observed - bound.value;
  return observed - bound.value;
}

/** Evaluate one assertion against a precomputed measurement receipt. */
export function evaluateAssuranceAssertion(
  definition: AssuranceAssertionDefinition,
  measurement: AssuranceMeasurementResult,
  options: { /** Whether the owning item is terminal. */ owner_terminal?: boolean } = {},
): AssuranceAssertionVerdict {
  validateAssertionDefinition(definition);
  const bound = boundFor(definition);
  const retired = definition.lifetime === "retire" && options.owner_terminal === true;
  return {
    assertion_id: definition.id,
    measurement_id: definition.measurement_id,
    scope: definition.scope,
    population_size: measurement.population_size,
    observed: measurement.value,
    bound,
    distance: assertionDistance(measurement.value, bound),
    verdict: retired ? "retired" : compareBound(measurement.value, bound) ? "pass" : "fail",
    enforcement: definition.enforcement,
    negative_control_proven: proveNegativeControl(definition),
    cost: measurement.cost,
    contributors: measurement.contributors,
  };
}

/** Evaluate a named gate into one presentation-independent verdict document. */
export async function evaluateAssuranceGate(
  gateId: string,
  document: AssuranceDocument,
  context: AssuranceEvaluationContext,
  options: { /** Trigger being evaluated. */ trigger: AssuranceGateTrigger; /** Skip persistence in the caller. */ dry_run?: boolean },
): Promise<AssuranceGateVerdict> {
  validateAssuranceDocument(document);
  const gateDefinition = document.gates.find((entry) => entry.id === gateId);
  if (!gateDefinition) throw new TypeError(`assurance gate ${gateId} not found`);
  if (!gateDefinition.triggers.includes(options.trigger)) {
    throw new TypeError(`assurance gate ${gateId} does not declare trigger ${options.trigger}`);
  }
  const assertions = await mapWithConcurrency(
    gateDefinition.assertion_ids,
    EVALUATION_CONCURRENCY,
    async (id) => {
      const assertionDefinition = document.assertions.find((entry) => entry.id === id)!;
      const measurementDefinition = document.measurements.find((entry) => entry.id === assertionDefinition.measurement_id)!;
      let scopedContext = context;
      if (assertionDefinition.scope.kind === "active") {
        const terminalStatuses = new Set(context.terminal_statuses ?? ["closed", "canceled"]);
        scopedContext = {
          ...context,
          items: context.items.filter((item) => !terminalStatuses.has(item.status)),
        };
      } else if (assertionDefinition.scope.kind === "filter") {
        const scopeMeasurementId = assertionDefinition.scope.measurement_id;
        const scopeDefinition = document.measurements.find(
          (entry) => entry.id === scopeMeasurementId,
        )!;
        const scope = await evaluateMeasurement(scopeDefinition, context, document.measurements);
        const contributorIds = new Set(scope.contributors);
        scopedContext = {
          ...context,
          items: context.items.filter((item) => contributorIds.has(item.id)),
        };
      }
      const owner = context.items.find((item) => item.id === assertionDefinition.owner_item_id);
      const ownerTerminal =
        owner !== undefined &&
        new Set(context.terminal_statuses ?? ["closed", "canceled"]).has(owner.status);
      return evaluateAssuranceAssertion(
        assertionDefinition,
        await evaluateMeasurement(measurementDefinition, scopedContext, document.measurements),
        { owner_terminal: ownerTerminal },
      );
    },
  );
  const blocking = assertions.some((entry) => entry.verdict === "fail" && entry.enforcement === "block");
  const warning = assertions.some((entry) => entry.verdict === "fail" && entry.enforcement === "warn");
  return {
    gate_id: gateDefinition.id,
    tree_id: context.tree_id,
    trigger: options.trigger,
    dry_run: options.dry_run === true,
    evaluated_at: new Date().toISOString(),
    verdict: blocking ? "block" : warning ? "warn" : "pass",
    exit_code: blocking ? 1 : 0,
    assertions,
    cost: sumCosts(assertions.map((entry) => entry.cost), Math.max(0, ...assertions.map((entry) => entry.cost.duration_ms))),
  };
}

function assurancePath(pmRoot: string): string {
  return path.join(pmRoot, "assurance.json");
}

async function readDocument(pmRoot: string): Promise<AssuranceDocument> {
  const raw = await readFileIfExists(assurancePath(pmRoot));
  if (raw === null) return createEmptyAssuranceDocument();
  return parseAssuranceDocument(raw);
}

function parseAssuranceDocument(raw: string): AssuranceDocument {
  try {
    return validateAssuranceDocument(JSON.parse(raw) as AssuranceDocument);
  } catch (error: unknown) {
    throw new PmCliError(
      "The assurance registry is invalid. Repair or restore .agents/pm/assurance.json and retry.",
      EXIT_CODE.GENERIC_FAILURE,
      {
        code: "assurance_registry_invalid",
        reason: String(error),
        nextSteps: [
          "Restore a valid assurance.json from version control or repair its declaration references.",
          "Run pm assurance list measurement after the repair.",
        ],
      },
    );
  }
}

function collectionFor(
  document: AssuranceDocument,
  kind: AssuranceDeclarationKind,
): AssuranceDeclaration[] {
  if (kind === "measurement") return document.measurements;
  if (kind === "assertion") return document.assertions;
  return document.gates;
}

function validateForKind(kind: AssuranceDeclarationKind, definition: AssuranceDeclaration): void {
  if (kind === "measurement") validateMeasurementDefinition(definition as AssuranceMeasurementDefinition);
  else if (kind === "assertion") validateAssertionDefinition(definition as AssuranceAssertionDefinition);
  else validateGateDefinition(definition as AssuranceGateDefinition);
}

/** Read all declarations of one kind with a stable row selector receipt. */
export async function listAssuranceDeclarations(
  pmRoot: string,
  kind: AssuranceDeclarationKind,
): Promise<{ items: AssuranceDeclaration[]; count: number; row_contract: { row_keys: ["items"]; jq_selector: ".items[]" } }> {
  const items = structuredClone(collectionFor(await readDocument(pmRoot), kind));
  return { items, count: items.length, row_contract: { row_keys: ["items"], jq_selector: ".items[]" } };
}

/** Read one named declaration or fail loudly. */
export async function getAssuranceDeclaration(
  pmRoot: string,
  kind: AssuranceDeclarationKind,
  id: string,
): Promise<AssuranceDeclaration> {
  const found = collectionFor(await readDocument(pmRoot), kind).find((entry) => entry.id === id);
  if (!found) throw new TypeError(`assurance ${kind} ${id} not found`);
  return structuredClone(found);
}

/** Create or update one declaration through audited singleton persistence. */
export async function putAssuranceDeclaration(
  pmRoot: string,
  kind: AssuranceDeclarationKind,
  definition: AssuranceDeclaration,
  options: AssuranceMutationOptions = {},
): Promise<AssuranceMutationReceipt> {
  validateForKind(kind, definition);
  const author = resolveAuthor(options.author, "unknown");
  const mutation = await mutateWorkspaceJsonWithHistory<AssuranceMutationReceipt>({
    pmRoot,
    filePath: assurancePath(pmRoot),
    op: `assurance:${kind}:put`,
    author,
    message: options.message,
    lockTtlSeconds: LOCK_TTL_SECONDS,
    lockWaitMs: LOCK_WAIT_MS,
    mutate: (beforeRaw) => {
      const document = beforeRaw === null ? createEmptyAssuranceDocument() : parseAssuranceDocument(beforeRaw);
      const collection = collectionFor(document, kind);
      const index = collection.findIndex((entry) => entry.id === definition.id);
      const action = index < 0 ? "created" : "updated";
      if (
        kind === "assertion" &&
        index >= 0 &&
        assuranceAssertionUpdateIsLoosening(
          collection[index] as AssuranceAssertionDefinition,
          definition as AssuranceAssertionDefinition,
        )
      ) {
        const decision = (definition as AssuranceAssertionDefinition).authorization_decision;
        if (!decision || !options.authorized_decision_ids?.includes(decision)) {
          throw new TypeError(
            `loosening assertion ${definition.id} requires a verified authorization_decision`,
          );
        }
      }
      if (index < 0) collection.push(structuredClone(definition));
      else collection[index] = structuredClone(definition);
      validateAssuranceDocument(document);
      return {
        raw: `${JSON.stringify(document, null, 2)}\n`,
        result: { changed: true, action, kind, id: definition.id },
      };
    },
  });
  return { ...mutation.result, changed: mutation.changed };
}

/** Remove an unreferenced declaration through audited singleton persistence. */
export async function removeAssuranceDeclaration(
  pmRoot: string,
  kind: AssuranceDeclarationKind,
  id: string,
  options: AssuranceMutationOptions = {},
): Promise<AssuranceMutationReceipt> {
  const author = resolveAuthor(options.author, "unknown");
  const mutation = await mutateWorkspaceJsonWithHistory<AssuranceMutationReceipt>({
    pmRoot,
    filePath: assurancePath(pmRoot),
    op: `assurance:${kind}:remove`,
    author,
    message: options.message,
    lockTtlSeconds: LOCK_TTL_SECONDS,
    lockWaitMs: LOCK_WAIT_MS,
    mutate: (beforeRaw) => {
      const document = beforeRaw === null ? createEmptyAssuranceDocument() : parseAssuranceDocument(beforeRaw);
      if (kind === "measurement") {
        const consumers = collectMeasurementReferences(document).get(id);
        if (consumers && consumers.length > 0) {
          throw new TypeError(
            `assurance measurement ${id} is referenced by ${consumers.join(", ")}`,
          );
        }
      }
      if (kind === "assertion" && document.gates.some((entry) => entry.assertion_ids.includes(id))) {
        throw new TypeError(`assurance assertion ${id} is referenced by gate`);
      }
      const collection = collectionFor(document, kind);
      const index = collection.findIndex((entry) => entry.id === id);
      if (index < 0) throw new TypeError(`assurance ${kind} ${id} not found`);
      collection.splice(index, 1);
      validateAssuranceDocument(document);
      return {
        raw: `${JSON.stringify(document, null, 2)}\n`,
        result: { changed: true, action: "removed", kind, id },
      };
    },
  });
  return { ...mutation.result, changed: mutation.changed };
}

/** Append one immutable gate verdict without changing registry state. */
export async function recordAssuranceVerdict(
  pmRoot: string,
  verdict: AssuranceGateVerdict,
  options: AssuranceMutationOptions = {},
): Promise<void> {
  if (verdict.dry_run) throw new TypeError("dry-run assurance verdicts are not persisted");
  await appendWorkspaceAuditEvent({
    pmRoot,
    op: "assurance:gate:verdict",
    author: resolveAuthor(options.author, "unknown"),
    context: { assurance_verdict: verdict },
    message: options.message ?? `Assurance gate ${verdict.gate_id} returned ${verdict.verdict}`,
    lockTtlSeconds: LOCK_TTL_SECONDS,
    lockWaitMs: LOCK_WAIT_MS,
  });
}

/** Query durable assurance verdicts from the verified workspace stream. */
export async function listAssuranceVerdicts(
  pmRoot: string,
  options: {
    /** Optional gate filter. */ gate_id?: string;
    /** Maximum newest matching verdicts returned. */ limit?: number;
  } = {},
): Promise<AssuranceGateVerdict[]> {
  const limit = options.limit ?? DEFAULT_VERDICT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_VERDICT_LIMIT) {
    throw new TypeError(
      `assurance verdict limit must be an integer from 1 through ${MAX_VERDICT_LIMIT}`,
    );
  }
  const entries = await readHistoryEntries(getWorkspaceHistoryPath(pmRoot), WORKSPACE_HISTORY_ID);
  return entries
    .reverse()
    .filter((entry) => entry.op === "assurance:gate:verdict")
    .map((entry) => entry.context?.assurance_verdict)
    .filter((value): value is AssuranceGateVerdict => typeof value === "object" && value !== null && "gate_id" in value)
    .filter((verdict) => options.gate_id === undefined || verdict.gate_id === options.gate_id)
    .slice(0, limit);
}
