/**
 * @module core/policy/workflow-policy-store
 *
 * Reads bounded policy and approval evidence and refuses invalid mutations
 * before item persistence. Successful decisions join the caller's atomic
 * history append; refusals receive a separate no-state-change audit event.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isUtf8 } from "node:buffer";
import { isFileMissingError } from "../fs/fs-utils.js";
import { appendWorkspaceAuditEvent } from "../history/workspace-history.js";
import { verifyHistoryChain } from "../history/replay.js";
import { PmCliError } from "../shared/errors.js";
import { EXIT_CODE } from "../shared/constants.js";
import { getHistoryPath } from "../store/paths.js";
import type { HistoryEntry, ItemDocument, PmSettings } from "../../types/index.js";
import {
  evaluateWorkflowPolicies,
  parseWorkflowPolicyDocument,
  workflowPolicyApplies,
  type WorkflowPolicyApproval,
  type WorkflowPolicyDocument,
  type WorkflowPolicyEvaluation,
  type WorkflowPolicyInput,
} from "./workflow-policy.js";

/** Policy files are bounded independently from item or history corpus size. */
export const MAX_WORKFLOW_POLICY_BYTES = 1_048_576;
/** Maximum immutable evidence read for an approval-dependent transition. */
export const MAX_WORKFLOW_APPROVAL_HISTORY_BYTES = 4_194_304;

/** Read at most the declared byte ceiling plus one sentinel byte, always closing the handle. */
async function readBoundedPolicyFile(file: string, maxBytes: number): Promise<string | null> {
  // Validate ancestors explicitly: Windows may report ENOENT below a regular file.
  let ancestor = path.dirname(file);
  while (ancestor !== path.parse(file).root) {
    const stats = await fs.stat(ancestor).catch((error: unknown) => {
      if (isFileMissingError(error)) return null;
      throw error;
    });
    if (stats !== null) {
      if (!stats.isDirectory()) throw new PmCliError("Workflow policy storage ancestor must be a directory.", EXIT_CODE.CONFLICT, {
        code: "workflow_policy_input_unreadable",
        nextSteps: ["Restore the policy or approval history directory before retrying."],
      });
      break;
    }
    ancestor = path.dirname(ancestor);
  }
  const handle = await fs.open(file, "r").catch((error: unknown) => {
    if (isFileMissingError(error)) return null;
    throw error;
  });
  if (handle === null) return null;
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(maxBytes, size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset === buffer.length || !isUtf8(buffer.subarray(0, offset))) {
      throw new PmCliError("Workflow policy input exceeds its byte bound or is not valid UTF-8.", EXIT_CODE.CONFLICT, {
        code: "workflow_policy_input_unreadable",
        nextSteps: ["Inspect the policy and approval history; reduce the declaration or use verified history compaction before retrying."],
      });
    }
    return buffer.toString("utf8", 0, offset);
  } finally {
    await handle.close();
  }
}

/** Decode a complete policy file; only an absent file means no configured policy. */
export function decodeWorkflowPolicyDocument(raw: string | null): WorkflowPolicyDocument {
  if (raw === null) return { version: 1, enforcement: "advise", policies: [] };
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch {
    throw new PmCliError("schema/policies.json must contain valid JSON.", EXIT_CODE.CONFLICT, {
      code: "workflow_policy_registry_invalid", nextSteps: ["Restore valid policy JSON before retrying the mutation."],
    });
  }
  return parseWorkflowPolicyDocument(value);
}

/** Load the latest atomic registry snapshot; absent workspaces have no implicit enforcement. */
export async function readWorkflowPolicies(pmRoot: string): Promise<WorkflowPolicyDocument> {
  return decodeWorkflowPolicyDocument(await readBoundedPolicyFile(path.join(pmRoot, "schema", "policies.json"), MAX_WORKFLOW_POLICY_BYTES));
}

/** Read only verified approval entries and bind their actor to the actual history envelope. */
export async function readWorkflowApprovals(pmRoot: string, id: string): Promise<WorkflowPolicyApproval[]> {
  const raw = await readBoundedPolicyFile(getHistoryPath(pmRoot, id), MAX_WORKFLOW_APPROVAL_HISTORY_BYTES);
  if (raw === null) return [];
  let entries: HistoryEntry[];
  try {
    entries = raw.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as HistoryEntry);
    if (!verifyHistoryChain(entries).ok) throw new Error("invalid chain");
  } catch {
    throw new PmCliError("Approval evidence requires a valid item history chain.", EXIT_CODE.CONFLICT, {
      code: "workflow_policy_approval_history_invalid",
      nextSteps: [`Run pm history ${id} --verify before recording or using an approval.`],
    });
  }
  return entries.flatMap((entry) => {
    const approval = entry.context?.workflow_approval;
    if (entry.op !== "policy_approve" || entry.record_hash_version !== 1 || typeof entry.record_hash !== "string" || typeof approval !== "object" || approval === null) return [];
    const record = approval as Record<string, unknown>;
    if (typeof record.policy_fingerprint !== "string" || typeof record.content_fingerprint !== "string") return [];
    return [{ policy_fingerprint: record.policy_fingerprint, content_fingerprint: record.content_fingerprint, author: entry.author }];
  });
}

/** Evaluate a workspace snapshot, reading history only for applicable status-changing approvals. */
export async function evaluateWorkspacePolicies(pmRoot: string, document: WorkflowPolicyDocument, input: WorkflowPolicyInput): Promise<WorkflowPolicyEvaluation> {
  const needsApproval = input.before?.status !== input.after?.status && document.policies.some((policy) =>
    policy.rule.kind === "approval" && workflowPolicyApplies(policy, input));
  const id = input.before?.id ?? input.after?.id;
  const approvals = needsApproval && typeof id === "string" ? await readWorkflowApprovals(pmRoot, id) : [];
  return evaluateWorkflowPolicies(document, { ...input, approvals });
}

/** Enforce policy under the caller's item lock, returning evidence for the same history transaction. */
export async function enforceWorkflowMutation(params: {
  pmRoot: string;
  settings: PmSettings;
  operation: string;
  author: string;
  before: ItemDocument | null;
  after: ItemDocument | null;
  dryRun?: boolean;
}): Promise<WorkflowPolicyEvaluation> {
  const document = await readWorkflowPolicies(params.pmRoot);
  const result = await evaluateWorkspacePolicies(params.pmRoot, document, {
    operation: params.operation, author: params.author,
    before: params.before ? { ...params.before.metadata, body: params.before.body } : null,
    after: params.after ? { ...params.after.metadata, body: params.after.body } : null,
  });
  if (result.allowed) return result;
  const refused = result.decisions.filter((decision) => !decision.satisfied && decision.effect === "refuse");
  if (!params.dryRun) {
    try {
      await appendWorkspaceAuditEvent({
        pmRoot: params.pmRoot, op: "policy_refused", author: params.author,
        context: { item_id: params.after?.metadata.id ?? params.before?.metadata.id, operation: params.operation, workflow_policies: result.decisions },
        message: "Workflow policy refused a proposed item mutation.",
        lockTtlSeconds: params.settings.locks.ttl_seconds, lockWaitMs: params.settings.locks.wait_ms,
      });
    } catch (cause: unknown) {
      const error = new PmCliError("Workflow policy refusal could not be recorded in workspace history.", EXIT_CODE.CONFLICT, {
        code: "workflow_policy_audit_failed",
        nextSteps: ["Resolve workspace-history lock or storage failures, then retry the refused mutation; no item changes were written."],
      });
      error.cause = cause;
      throw error;
    }
  }
  const summary = refused.slice(0, 3).map((decision) => `${decision.policy_id} (${decision.rule})`).join(", ");
  const remaining = refused.length > 3 ? ` and ${refused.length - 3} more` : "";
  throw new PmCliError(`Workflow policy refused ${params.operation}: ${summary}${remaining}.`, EXIT_CODE.CONFLICT, {
    code: "workflow_policy_refused",
    reason: refused.slice(0, 3).map((decision) => decision.policy_id).join(","),
    nextSteps: [...new Set(refused.map((decision) => decision.remediation))].slice(0, 3),
  });
}
