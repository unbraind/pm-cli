/**
 * @module sdk/governance/workflow-policy
 *
 * Public policy authoring, preview, and approval operations. Registry changes
 * use audited workspace transactions; approvals use locked item history.
 */
import path from "node:path";
import { assertInitializedTracker } from "../environment/tracker-preflight.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { resolveAuthor } from "../../core/shared/author.js";
import { PmCliError } from "../../core/shared/errors.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { mutateWorkspaceJsonWithHistory } from "../../core/history/workspace-history.js";
import { locateItem, readLocatedItem, mutateItemWithHistoryContextResolver } from "../../core/store/item-store.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import {
  decodeWorkflowPolicyDocument, readWorkflowPolicies, readWorkflowApprovals, evaluateWorkspacePolicies,
  MAX_WORKFLOW_POLICY_BYTES,
} from "../../core/policy/workflow-policy-store.js";
import {
  WORKFLOW_POLICY_ACTIONS, type WorkflowPolicyAction,
  parseWorkflowPolicy, parseWorkflowPolicyDocument, workflowPolicyFingerprint, workflowApprovalFingerprint,
  type WorkflowPolicy, type WorkflowPolicyDocument, type WorkflowPolicyEvaluation,
} from "../../core/policy/workflow-policy.js";

export * from "../../core/policy/workflow-policy.js";
export * from "../../core/policy/workflow-policy-schema.js";
export { buildWorkflowCompletenessCheck, type WorkflowCompletenessViolation } from "./workflow-completeness.js";
export { readWorkflowPolicies } from "../../core/policy/workflow-policy-store.js";

/** Options shared by SDK, CLI and MCP policy operations. */
export interface WorkflowPolicyActionOptions {
  /** One policy definition for put, or proposed field values for check. */
  definition?: unknown;
  /** Approval declaration id. */
  policy?: string;
  /** Preview without registry, item, or history writes. */
  dryRun?: boolean;
  /** Explicit actor override; normally detected automatically. */
  author?: string;
  /** Rationale recorded for registry and approval mutations. */
  message?: string;
}

/** Transport-neutral envelope with a discriminant for schema renderers. */
export interface WorkflowPolicyActionResult {
  /** Identifies this schema result without conflating type or status operations. */
  policy_result: true;
  /** Executed schema verb. */
  action: WorkflowPolicyAction;
  /** Whether durable state changed. */
  changed: boolean;
  /** Complete bounded result of the selected operation. */
  result: WorkflowPolicyDocument | WorkflowPolicyEvaluation | WorkflowApprovalReceipt;
}

/** Content-bound approval identity returned after its history event is durable. */
export interface WorkflowApprovalReceipt {
  /** Reviewed item id. */
  id: string;
  /** Approval declaration id. */
  policy_id: string;
  /** Exact policy revision. */
  policy_fingerprint: string;
  /** Hash of reviewed content. */
  content_fingerprint: string;
  /** Advisory mutation diagnostics. */
  warnings: string[];
}

/** Advisory defaults are opt-in data, never implicitly applied to existing projects. */
export function createLifecycleCompletenessPolicies(): WorkflowPolicyDocument {
  const requiredByType: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["Epic", ["goal", "objective", "body"]],
    ["Story", ["description", "value", "acceptance_criteria"]],
    ["Decision", ["body", "resolution"]],
    ["Feature", ["acceptance_criteria", "expected_result"]],
    ["Task", ["description"]],
    ["Issue", ["repro_steps", "expected_result"]],
    ["Chore", ["description"]],
  ];
  return { version: 1, enforcement: "advise", policies: [
    ...requiredByType.map(([type, fields]): WorkflowPolicy => ({
      id: `completeness-${type.toLowerCase()}`, effect: "advise",
      description: `Evidence expected when ${type} work reaches completion.`,
      subject: { types: [type], statuses: ["closed"] },
      rule: { kind: "require_fields", fields: [...fields] },
    })),
    { id: "completeness-resolution", effect: "advise", subject: { statuses: ["closed"] },
      rule: { kind: "require_fields", fields: ["resolution", "expected_result", "actual_result"] } },
  ] };
}

/** Parse transport JSON without accepting arrays or coercing invalid input. */
function policyInputObject(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); }
    catch { throw new PmCliError("Policy definition must be valid JSON.", EXIT_CODE.USAGE); }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new PmCliError("Policy definition must be an object.", EXIT_CODE.USAGE);
  return parsed as Record<string, unknown>;
}

/** Read an initialized workspace and resolve the actual mutation actor once. */
async function policyContext(global: Pick<GlobalOptions, "path">, author?: string) {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await assertInitializedTracker(pmRoot);
  const settings = await readSettings(pmRoot);
  return { pmRoot, settings, author: resolveAuthor(author, settings.author_default) };
}

/** Derive a complete registry update while its workspace-history lock is held. */
function changedPolicyDocument(action: WorkflowPolicyAction, name: string, before: WorkflowPolicyDocument, options: WorkflowPolicyActionOptions): WorkflowPolicyDocument {
  if (action === "policy-mode") return parseWorkflowPolicyDocument({ ...before, enforcement: name });
  const remaining = before.policies.filter((policy) => policy.id !== name);
  if (action === "policy-remove") return { ...before, policies: remaining };
  const policy = parseWorkflowPolicy(policyInputObject(options.definition));
  if (policy.id !== name) throw new PmCliError("Policy definition id must match its operand.", EXIT_CODE.USAGE);
  const next = parseWorkflowPolicyDocument({ ...before, policies: [...remaining, policy].sort((left, right) => left.id.localeCompare(right.id)) });
  if (Buffer.byteLength(`${JSON.stringify(next, null, 2)}\n`) > MAX_WORKFLOW_POLICY_BYTES)
    throw new PmCliError("Policy registry exceeds its byte ceiling.", EXIT_CODE.USAGE);
  return next;
}

/** Preview or persist one declaration change with history rollback on failure. */
async function mutatePolicyRegistry(action: WorkflowPolicyAction, name: string, options: WorkflowPolicyActionOptions, context: Awaited<ReturnType<typeof policyContext>>): Promise<WorkflowPolicyActionResult> {
  if (options.dryRun) return { policy_result: true, action, changed: false,
    result: changedPolicyDocument(action, name, await readWorkflowPolicies(context.pmRoot), options) };
  const mutation = await mutateWorkspaceJsonWithHistory({
    pmRoot: context.pmRoot, filePath: path.join(context.pmRoot, "schema", "policies.json"),
    op: `schema:${action}`, author: context.author, message: options.message,
    lockTtlSeconds: context.settings.locks.ttl_seconds, lockWaitMs: context.settings.locks.wait_ms,
    mutate(beforeRaw) {
      const next = changedPolicyDocument(action, name, decodeWorkflowPolicyDocument(beforeRaw), options);
      const raw = `${JSON.stringify(next, null, 2)}\n`;
      return { raw, result: next };
    },
  });
  return { policy_result: true, action, changed: mutation.changed, result: mutation.result };
}

/** Record an independent actor's approval of exactly the fields declared by a policy. */
async function approvePolicy(name: string, options: WorkflowPolicyActionOptions, context: Awaited<ReturnType<typeof policyContext>>): Promise<WorkflowPolicyActionResult> {
  let evidence: Omit<WorkflowApprovalReceipt, "id" | "warnings"> | undefined;
  const mutation = await mutateItemWithHistoryContextResolver({
    ...context, id: name, op: "policy_approve", message: options.message,
    resolveHistoryContext: () => ({ workflow_approval: evidence }),
    async mutate(document) {
      const registry = await readWorkflowPolicies(context.pmRoot);
      const policy = registry.policies.find((candidate) => candidate.id === options.policy);
      if (!policy || policy.rule.kind !== "approval") throw new PmCliError("--policy must name an approval rule.", EXIT_CODE.USAGE);
      if (!policy.rule.authors.includes(context.author)) throw new PmCliError("This actor is not a declared approver.", EXIT_CODE.CONFLICT);
      await readWorkflowApprovals(context.pmRoot, document.metadata.id);
      evidence = { policy_id: policy.id, policy_fingerprint: workflowPolicyFingerprint(policy),
        content_fingerprint: workflowApprovalFingerprint(policy, { ...document.metadata, body: document.body }) };
      return { changedFields: [] };
    },
  });
  return { policy_result: true, action: "policy-approve", changed: true, result: { id: mutation.item.id, ...evidence!, warnings: mutation.warnings } };
}

/** Execute policy operations through the same SDK semantics on every transport. */
export async function runWorkflowPolicyAction(action: WorkflowPolicyAction, name: string | undefined, options: WorkflowPolicyActionOptions = {}, global: Pick<GlobalOptions, "path"> = {}): Promise<WorkflowPolicyActionResult> {
  if (!WORKFLOW_POLICY_ACTIONS.includes(action)) throw new PmCliError("Unknown workflow policy action.", EXIT_CODE.USAGE);
  if (action === "policy-presets") return { policy_result: true, action, changed: false, result: createLifecycleCompletenessPolicies() };
  const context = await policyContext(global, options.author);
  if (action === "policies") return { policy_result: true, action, changed: false, result: await readWorkflowPolicies(context.pmRoot) };
  if (!name?.trim()) throw new PmCliError(`schema ${action} requires an operand.`, EXIT_CODE.USAGE);
  if (["policy-put", "policy-remove", "policy-mode"].includes(action)) return mutatePolicyRegistry(action, name, options, context);
  if (action === "policy-approve") {
    if (options.dryRun) throw new PmCliError("Use policy-check to preview; policy-approve records an approval.", EXIT_CODE.USAGE);
    return approvePolicy(name, options, context);
  }
  const types = resolveItemTypeRegistry(context.settings, getActiveExtensionRegistrations());
  const located = await locateItem(context.pmRoot, name, context.settings.id_prefix, context.settings.item_format, types.type_to_folder);
  if (!located) throw new PmCliError(`Item ${name} not found.`, EXIT_CODE.NOT_FOUND);
  const { document } = await readLocatedItem(located, { schema: context.settings.schema });
  const before = { ...document.metadata, body: document.body };
  const after = options.definition === undefined ? before : { ...before, ...policyInputObject(options.definition) };
  if (after.id !== before.id) throw new PmCliError("Policy preview cannot change the item id.", EXIT_CODE.USAGE);
  return { policy_result: true, action, changed: false, result: await evaluateWorkspacePolicies(context.pmRoot, await readWorkflowPolicies(context.pmRoot), {
    operation: "update", author: context.author, before, after,
    completeness_only: options.definition === undefined,
  }) };
}
