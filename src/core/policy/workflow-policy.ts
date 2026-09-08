/**
 * @module core/policy/workflow-policy
 *
 * Evaluates portable workflow declarations without IO. Policies describe
 * correctness constraints over proposed records; actor names are unverified
 * provenance and do not establish an authorization boundary.
 */
import { createHash } from "node:crypto";
import { stableStringify, stableValueEquals } from "../shared/serialization.js";
import { PmCliError } from "../shared/errors.js";
import { EXIT_CODE } from "../shared/constants.js";

/** Policy verbs carried under the existing schema command family. */
export const WORKFLOW_POLICY_ACTIONS = ["policies", "policy-put", "policy-remove", "policy-mode", "policy-check", "policy-approve", "policy-presets"] as const;
/** Portable schema-policy action vocabulary. */
export type WorkflowPolicyAction = (typeof WORKFLOW_POLICY_ACTIONS)[number];

/** Maximum declarations evaluated for one mutation, independent of corpus size. */
export const MAX_WORKFLOW_POLICIES = 256;
/** Maximum selectors or fields within one declaration. */
export const MAX_WORKFLOW_POLICY_TERMS = 64;

/** Policy response, with refusal requiring a separate workspace opt-in. */
export type WorkflowPolicyEffect = "advise" | "warn" | "refuse";

/** All supplied selectors must match; values within a selector are alternatives. */
export interface WorkflowPolicySubject {
  /** Case-insensitive item type names. */
  types?: string[];
  /** At least one of these exact tags must be present. */
  tags?: string[];
  /** Canonical target lifecycle statuses; deletion uses the previous status. */
  statuses?: string[];
  /** Exact mutation operation names, as recorded in history. */
  operations?: string[];
  /** Direct parent ids for scoping policies to a domain or programme. */
  parents?: string[];
  /** Outgoing edge requirement evaluated on the selected record. */
  dependency?: { kind: string; id?: string };
}

/** Data-only requirements; no expressions, regexes, or executable code. */
export type WorkflowPolicyRule =
  | { kind: "require_fields"; fields: string[] }
  | { kind: "transition"; allowed: [string, string][] }
  | { kind: "authors"; authors: string[] }
  | { kind: "field_writers"; fields: string[]; authors: string[] }
  | { kind: "approval"; fields: string[]; authors: string[] };

/** One stable, explainable workflow requirement. */
export interface WorkflowPolicy {
  /** Stable declaration id retained in mutation evidence. */
  id: string;
  /** Human explanation of the invariant, at most 500 characters. */
  description?: string;
  /** Optional intersection of item and operation selectors. */
  subject?: WorkflowPolicySubject;
  /** Defaults to advise; refuse also requires document.enforcement=refuse. */
  effect?: WorkflowPolicyEffect;
  /** The requirement evaluated for matching mutations. */
  rule: WorkflowPolicyRule;
}

/** Versioned workspace data stored in schema/policies.json. */
export interface WorkflowPolicyDocument {
  /** Version of the declaration semantics. */
  version: 1;
  /** Explicit workspace permission for policies to refuse mutations. */
  enforcement: "advise" | "refuse";
  /** Ordered, uniquely identified declarations. */
  policies: WorkflowPolicy[];
}

/** Approval evidence resolved from a verified immutable item history. */
export interface WorkflowPolicyApproval {
  /** Exact policy declaration hash, including its selectors and effect. */
  policy_fingerprint: string;
  /** Hash of the declared approval fields and item id. */
  content_fingerprint: string;
  /** Recorded author of the approval event. */
  author: string;
}

/** Presentation-independent mutation snapshot. Body is a normal selectable field. */
export interface WorkflowPolicyInput {
  /** History operation being evaluated. */
  operation: string;
  /** Effective mutation actor; never taken from mutable item.author. */
  author: string;
  /** Previous record or null for creation. */
  before: Readonly<Record<string, unknown>> | null;
  /** Proposed record or null for deletion. */
  after: Readonly<Record<string, unknown>> | null;
  /** Verified approval events, omitted when no approval rule is applicable. */
  approvals?: readonly WorkflowPolicyApproval[];
  /** Inspect present field completeness without interpreting a transition. */
  completeness_only?: boolean;
}

/** Bounded explanation recorded alongside a mutation or returned by a preview. */
export interface WorkflowPolicyDecision {
  /** Stable id of the declaration evaluated. */
  policy_id: string;
  /** Fingerprint needed to identify the precise rule revision. */
  policy_fingerprint: string;
  /** Requirement vocabulary entry. */
  rule: WorkflowPolicyRule["kind"];
  /** Effective response after applying workspace consent. */
  effect: WorkflowPolicyEffect;
  /** Whether the proposed record meets this requirement. */
  satisfied: boolean;
  /** Missing field paths, never their values. */
  missing_fields: string[];
  /** Corrective action without item content or credential values. */
  remediation: string;
}

/** Complete decision set; callers may project it without weakening enforcement. */
export interface WorkflowPolicyEvaluation {
  /** False when at least one effective refusal is unsatisfied. */
  allowed: boolean;
  /** One result for every matched declaration. */
  decisions: WorkflowPolicyDecision[];
  /** Safe compact warnings for unsatisfied advisory requirements. */
  warnings: string[];
}

/** Refuse malformed policy data with a stable correction path. */
function invalidPolicy(detail: string): never {
  throw new PmCliError(`Invalid workflow policy: ${detail}`, EXIT_CODE.USAGE, {
    code: "workflow_policy_invalid",
    nextSteps: ["Inspect pm schema policies and correct the declaration using pm schema policy-put."],
  });
}

/** Validate object shape and reject misspelled keys rather than ignoring rules. */
function policyObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalidPolicy(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key)))
    return invalidPolicy(`${label} contains an unknown key`);
  return record;
}

/** Validate bounded nonempty text used as exact-match policy vocabulary. */
function policyText(value: unknown, label: string, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    return invalidPolicy(`${label} must be nonempty text of at most ${max} characters`);
  return value.trim();
}

/** Validate selector arrays and safe dotted field paths. */
function policyTerms(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_WORKFLOW_POLICY_TERMS)
    return invalidPolicy(`${label} requires 1-${MAX_WORKFLOW_POLICY_TERMS} terms`);
  const terms = value.map((entry) => policyText(entry, label));
  if (label === "fields" && terms.some((term) =>
    !/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*){0,7}$/.test(term) ||
    term.split(".").some((part) => ["__proto__", "constructor", "prototype"].includes(part))))
    return invalidPolicy("fields must be safe metadata paths of at most eight segments");
  return [...new Set(terms)];
}

/** Parse the discriminated requirement vocabulary. */
function parsePolicyRule(value: unknown): WorkflowPolicyRule {
  const common = policyObject(value, ["kind", "fields", "authors", "allowed"], "rule");
  if (common.kind === "transition") {
    policyObject(common, ["kind", "allowed"], "transition rule");
    if (!Array.isArray(common.allowed) || common.allowed.length > MAX_WORKFLOW_POLICY_TERMS)
      return invalidPolicy("transition.allowed must be a bounded array");
    return { kind: "transition", allowed: common.allowed.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) return invalidPolicy("transition pairs need two statuses");
      return [policyText(pair[0], "from"), policyText(pair[1], "to")];
    }) };
  }
  if (common.kind === "authors") {
    policyObject(common, ["kind", "authors"], "authors rule");
    return { kind: "authors", authors: policyTerms(common.authors, "authors") };
  }
  if (common.kind === "require_fields") {
    policyObject(common, ["kind", "fields"], "require_fields rule");
    return { kind: "require_fields", fields: policyTerms(common.fields, "fields") };
  }
  if (common.kind === "field_writers" || common.kind === "approval") {
    policyObject(common, ["kind", "fields", "authors"], "field rule");
    return { kind: common.kind, fields: policyTerms(common.fields, "fields"), authors: policyTerms(common.authors, "authors") };
  }
  return invalidPolicy("unknown rule kind");
}

/** Normalize exact-match selectors and optional direct graph scope. */
function parsePolicySubject(value: unknown): WorkflowPolicySubject {
  const subject: WorkflowPolicySubject = {};
  const source = policyObject(value, ["types", "tags", "statuses", "operations", "parents", "dependency"], "subject");
  for (const key of ["types", "tags", "statuses", "operations", "parents"] as const) {
    if (source[key] !== undefined) subject[key] = policyTerms(source[key], key);
  }
  if (source.dependency !== undefined) {
    const edge = policyObject(source.dependency, ["kind", "id"], "dependency");
    subject.dependency = { kind: policyText(edge.kind, "dependency kind"),
      ...(edge.id === undefined ? {} : { id: policyText(edge.id, "dependency id") }) };
  }
  return subject;
}

/** Parse and normalize a declaration, rejecting unsupported selectors. */
export function parseWorkflowPolicy(value: unknown): WorkflowPolicy {
  const raw = policyObject(value, ["id", "description", "subject", "effect", "rule"], "policy");
  const id = policyText(raw.id, "id");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) return invalidPolicy("id must be a stable token");
  if (raw.effect !== undefined && !["advise", "warn", "refuse"].includes(String(raw.effect)))
    return invalidPolicy("effect must be advise, warn, or refuse");
  return { id, rule: parsePolicyRule(raw.rule),
    ...(raw.subject === undefined ? {} : { subject: parsePolicySubject(raw.subject) }),
    ...(raw.description === undefined ? {} : { description: policyText(raw.description, "description", 500) }),
    ...(raw.effect === undefined ? {} : { effect: raw.effect as WorkflowPolicyEffect }) };
}

/** Validate a complete registry; absence is handled by the IO layer, never malformed data. */
export function parseWorkflowPolicyDocument(value: unknown): WorkflowPolicyDocument {
  const raw = policyObject(value, ["version", "enforcement", "policies"], "document");
  if (raw.version !== 1) return invalidPolicy("unsupported version");
  if (raw.enforcement !== undefined && raw.enforcement !== "advise" && raw.enforcement !== "refuse")
    return invalidPolicy("enforcement must be advise or refuse");
  if (!Array.isArray(raw.policies) || raw.policies.length > MAX_WORKFLOW_POLICIES)
    return invalidPolicy(`policies must contain at most ${MAX_WORKFLOW_POLICIES} declarations`);
  const policies = raw.policies.map(parseWorkflowPolicy);
  if (new Set(policies.map((policy) => policy.id)).size !== policies.length)
    return invalidPolicy("duplicate policy id");
  return { version: 1, enforcement: raw.enforcement ?? "advise", policies };
}

/** Read only own properties so prototype values cannot satisfy a declared field. */
export function readWorkflowPolicyField(record: Readonly<Record<string, unknown>> | null, field: string): unknown {
  let value: unknown = record;
  for (const key of field.split(".")) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Distinguish absent/empty evidence from meaningful false or zero values. */
function hasPolicyValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** Fingerprint exactly the declaration semantics used by a decision. */
export function workflowPolicyFingerprint(policy: WorkflowPolicy): string {
  return createHash("sha256").update(stableStringify(policy)).digest("hex");
}

/** Bind an approval to its item and declared fields, excluding unrelated metadata. */
export function workflowApprovalFingerprint(policy: WorkflowPolicy, record: Readonly<Record<string, unknown>>): string {
  const fields = policy.rule.kind === "approval" ? policy.rule.fields : [];
  return createHash("sha256").update(stableStringify({ id: record.id,
    fields: fields.map((field) => [field, readWorkflowPolicyField(record, field)]) })).digest("hex");
}

/** Match against a snapshot without graph traversal or corpus enumeration. */
function matchesPolicySubject(subject: WorkflowPolicySubject, record: Readonly<Record<string, unknown>>, operation: string): boolean {
  if (subject.types && !subject.types.some((type) => type.toLowerCase() === String(record.type).toLowerCase())) return false;
  if (subject.statuses && !subject.statuses.includes(String(record.status))) return false;
  if (subject.operations && !subject.operations.includes(operation)) return false;
  if (subject.parents && !subject.parents.includes(String(record.parent))) return false;
  if (subject.tags && (!Array.isArray(record.tags) || !subject.tags.some((tag) => (record.tags as unknown[]).includes(tag)))) return false;
  if (subject.dependency) {
    const expected = subject.dependency;
    if (!Array.isArray(record.dependencies) || !record.dependencies.some((edge: unknown) =>
      typeof edge === "object" && edge !== null && "kind" in edge && edge.kind === expected.kind &&
      (expected.id === undefined || ("id" in edge && edge.id === expected.id)))) return false;
  }
  return true;
}

/** Match both sides so removing a tag or changing type cannot evade a rule. */
export function workflowPolicyApplies(policy: WorkflowPolicy, input: WorkflowPolicyInput): boolean {
  if (input.completeness_only && policy.rule.kind !== "require_fields") return false;
  const subject = policy.subject ?? {};
  // Status selectors describe the destination; other scope changes check both sides.
  const status = input.after?.status ?? input.before?.status;
  return [input.before, input.after].some((record) => record !== null &&
    matchesPolicySubject(subject, { ...record, status }, input.operation));
}

/** Check required fields when status, scope, or protected content changes. */
function missingRequiredPolicyFields(fields: string[], input: WorkflowPolicyInput, changedStatus: boolean, fieldsChanged: boolean): string[] {
  const scopeChanged = ["type", "tags", "parent", "dependencies"].some((field) =>
    !stableValueEquals(input.before?.[field], input.after?.[field]));
  const missing = input.after && (input.completeness_only || changedStatus || fieldsChanged || scopeChanged)
    ? fields.filter((field) => !hasPolicyValue(readWorkflowPolicyField(input.after, field))) : [];
  return missing;
}

/** Evaluate one bounded requirement against the actual before/after values. */
function evaluatePolicyRule(policy: WorkflowPolicy, input: WorkflowPolicyInput): { satisfied: boolean; missing_fields: string[]; remediation: string } {
  const rule = policy.rule;
  const changedStatus = input.before?.status !== input.after?.status;
  const fieldsChanged = "fields" in rule && rule.fields.some((field) =>
    !stableValueEquals(readWorkflowPolicyField(input.before, field), readWorkflowPolicyField(input.after, field)));
  switch (rule.kind) {
    case "require_fields": {
      const missing = missingRequiredPolicyFields(rule.fields, input, changedStatus, fieldsChanged);
      return { satisfied: missing.length === 0, missing_fields: missing, remediation: "Supply the declared required fields before this lifecycle transition." };
    }
    case "transition":
      return { satisfied: !changedStatus || rule.allowed.some(([from, to]) => from === String(input.before?.status ?? "$create") && to === String(input.after?.status ?? "$delete")),
        missing_fields: [], remediation: "Choose a declared allowed transition; inspect pm schema policies." };
    case "authors":
      return { satisfied: rule.authors.includes(input.author), missing_fields: [], remediation: "Have a declared workflow actor perform this operation." };
    case "field_writers":
      return { satisfied: !fieldsChanged || rule.authors.includes(input.author), missing_fields: [], remediation: "Have a declared field writer change the protected fields." };
    case "approval":
      return { satisfied: !changedStatus || Boolean(input.after && input.approvals?.some((approval) =>
        approval.policy_fingerprint === workflowPolicyFingerprint(policy) &&
        approval.content_fingerprint === workflowApprovalFingerprint(policy, input.after!) &&
        approval.author !== input.author && rule.authors.includes(approval.author))),
        missing_fields: [], remediation: `Record an independent approval with pm schema policy-approve <item-id> --policy ${policy.id} after preparing the reviewed fields.` };
  }
}

/** Evaluate every matching rule; a later advisory can never override a refusal. */
export function evaluateWorkflowPolicies(document: WorkflowPolicyDocument, input: WorkflowPolicyInput): WorkflowPolicyEvaluation {
  const decisions = document.policies.filter((policy) => workflowPolicyApplies(policy, input)).map((policy): WorkflowPolicyDecision => {
    const requested = policy.effect ?? "advise";
    return { policy_id: policy.id, policy_fingerprint: workflowPolicyFingerprint(policy), rule: policy.rule.kind,
      effect: requested === "refuse" && document.enforcement !== "refuse" ? "warn" : requested,
      ...evaluatePolicyRule(policy, input) };
  });
  return { allowed: !decisions.some((decision) => !decision.satisfied && decision.effect === "refuse"), decisions,
    warnings: decisions.filter((decision) => !decision.satisfied).map((decision) => `workflow_policy:${decision.effect}:${decision.policy_id}:${decision.rule}`) };
}
