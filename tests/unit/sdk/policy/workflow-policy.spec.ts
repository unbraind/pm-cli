import { describe, expect, it } from "vitest";
import {
  evaluateWorkflowPolicies, parseWorkflowPolicy, parseWorkflowPolicyDocument,
  readWorkflowPolicyField, workflowPolicyApplies, workflowPolicyFingerprint,
  workflowApprovalFingerprint, type WorkflowPolicy, type WorkflowPolicyInput,
} from "../../../../src/core/policy/workflow-policy.js";

const input: WorkflowPolicyInput = { operation: "update", author: "writer",
  before: { id: "pm-one", type: "Feature", status: "open" }, after: { id: "pm-one", type: "Feature", status: "closed" } };
const requirement: WorkflowPolicy = { id: "completion", subject: { types: ["Feature"], statuses: ["closed"] },
  rule: { kind: "require_fields", fields: ["resolution"] }, effect: "refuse" };

/** Evaluate a specific rule with explicit workspace enforcement. */
function evaluate(policy: WorkflowPolicy, change: WorkflowPolicyInput = input) {
  return evaluateWorkflowPolicies({ version: 1, enforcement: "refuse", policies: [policy] }, change);
}

describe("declarative workflow policies", () => {
  it("requires both workspace and policy consent and never lets an advisory override a refusal", () => {
    const document = parseWorkflowPolicyDocument({ version: 1, policies: [requirement] });
    expect(evaluateWorkflowPolicies(document, input)).toMatchObject({ allowed: true, decisions: [{ satisfied: false, effect: "warn" }] });
    expect(evaluate(requirement)).toMatchObject({ allowed: false, decisions: [{ missing_fields: ["resolution"] }] });
    expect(evaluate(requirement, { ...input, after: { ...input.after, resolution: "Verified delivery" } })).toMatchObject({ allowed: true, decisions: [{ satisfied: true }] });
    expect(evaluateWorkflowPolicies({ ...document, enforcement: "refuse", policies: [requirement, { ...requirement, id: "advice", effect: "advise" }] }, input).allowed).toBe(false);
    expect(evaluate({ ...requirement, effect: undefined }).decisions[0].effect).toBe("advise");
    expect(evaluate({ ...requirement, effect: "warn" }).allowed).toBe(true);
  });

  it("normalizes selectors, supports all rule forms, and fails closed on malformed vocabulary", () => {
    const valid: WorkflowPolicy[] = [requirement,
      { id: "transition", rule: { kind: "transition", allowed: [["open", "closed"]] } },
      { id: "actors", rule: { kind: "authors", authors: ["writer"] } },
      { id: "writers", rule: { kind: "field_writers", authors: ["writer"], fields: ["body"] } },
      { id: "approval", rule: { kind: "approval", authors: ["reviewer"], fields: ["body"] } },
    ];
    expect(parseWorkflowPolicyDocument({ version: 1, enforcement: "refuse", policies: valid }).policies).toEqual(valid);
    expect(parseWorkflowPolicy({ ...requirement, id: " completion ", description: " Useful rule ", subject: {
      types: ["Feature", "Feature"], tags: ["finance"], statuses: ["closed"], operations: ["update"], parents: ["pm-parent"], dependency: { kind: "verifies", id: "pm-parent" },
    } })).toMatchObject({ id: "completion", description: "Useful rule", subject: { types: ["Feature"], dependency: { id: "pm-parent" } } });
    expect(parseWorkflowPolicy({ ...requirement, subject: { dependency: { kind: "verifies" } } }).subject?.dependency).toEqual({ kind: "verifies" });
    for (const value of [null, [], "bad", { ...requirement, typo: true }, { ...requirement, id: "bad/id" }, { ...requirement, id: " " }, { ...requirement, id: "x".repeat(129) }, { ...requirement, effect: "deny" }, { ...requirement, effect: ["refuse"] }, { ...requirement, effect: null }, { ...requirement, subject: { typo: true } }, { ...requirement, description: "x".repeat(501) }]) expect(() => parseWorkflowPolicy(value)).toThrow();
    for (const rule of [
      { kind: "typo" }, { kind: "require_fields", fields: [] }, { kind: "authors", authors: [""] },
      { kind: "require_fields", fields: ["__proto__.x"] }, { kind: "require_fields", fields: ["x.constructor"] },
      { kind: "require_fields", fields: ["x[0]"] }, { kind: "require_fields", fields: Array(65).fill("body") },
      { kind: "transition", allowed: "open" }, { kind: "transition", allowed: Array(65).fill(["open", "closed"]) },
      { kind: "transition", allowed: [["open"]] }, { kind: "transition", allowed: ["open"] },
      { kind: "authors", authors: "writer" }, { kind: "authors", authors: ["writer"], fields: ["body"] },
    ]) expect(() => parseWorkflowPolicy({ id: "bad", rule })).toThrow();
    for (const document of [{ version: 2, policies: [] }, { version: 1, enforcement: "deny", policies: [] }, { version: 1 }, { version: 1, policies: Array(257).fill(requirement) }, { version: 1, policies: [requirement, requirement] }]) expect(() => parseWorkflowPolicyDocument(document)).toThrow();
  });

  it("intersects selectors, checks both scopes, and skips non-completeness rules during inspections", () => {
    const policy: WorkflowPolicy = { ...requirement, subject: { types: ["feature"], statuses: ["closed"], operations: ["update"], parents: ["pm-parent"], tags: ["finance"], dependency: { kind: "verifies", id: "pm-parent" } } };
    const record = { ...input.after, parent: "pm-parent", tags: ["finance"], dependencies: [{ kind: "verifies", id: "pm-parent" }] };
    expect(evaluate(policy, { ...input, before: record, after: { ...record, tags: [], resolution: "" } }).allowed).toBe(false);
    for (const override of [{ type: "Task" }, { status: "open" }, { parent: "pm-other" }, { tags: ["other"] }, { tags: null }, { dependencies: [] }, { dependencies: null }, { dependencies: [null, {}, { kind: "verifies" }, { kind: "verifies", id: "pm-other" }] }]) {
      const candidate = { ...record, ...override };
      expect(workflowPolicyApplies(policy, { ...input, before: candidate, after: candidate })).toBe(false);
    }
    expect(workflowPolicyApplies(policy, { ...input, before: record, after: record, operation: "delete" })).toBe(false);
    expect(workflowPolicyApplies(policy, { ...input, before: null, after: null })).toBe(false);
    expect(workflowPolicyApplies({ ...policy, subject: { dependency: { kind: "verifies" } } }, { ...input, before: null, after: record })).toBe(true);
    expect(workflowPolicyApplies({ id: "authors", rule: { kind: "authors", authors: ["writer"] } }, { ...input, completeness_only: true })).toBe(false);
  });

  it("recognizes meaningful zero and false, own nested fields, and scope-entry changes", () => {
    const policy: WorkflowPolicy = { id: "nested", effect: "refuse", rule: { kind: "require_fields", fields: ["custom.value"] } };
    for (const value of [0, false, ["evidence"], { evidence: true }, "present"]) expect(evaluate(policy, { ...input, after: { ...input.after, custom: { value } } }).allowed).toBe(true);
    for (const value of [undefined, null, NaN, " ", [], {}]) expect(evaluate(policy, { ...input, after: { ...input.after, custom: { value } } }).allowed).toBe(false);
    expect(readWorkflowPolicyField({ custom: Object.create({ value: "inherited" }) }, "custom.value")).toBeUndefined();
    expect(readWorkflowPolicyField({ custom: "scalar" }, "custom.value")).toBeUndefined();
    expect(evaluate(requirement, { ...input, before: input.after, after: { ...input.after, title: "Unrelated correction" } }).allowed).toBe(true);
    expect(evaluate(requirement, { ...input, before: input.after, after: input.after, completeness_only: true }).allowed).toBe(false);
    expect(evaluate({ ...policy, subject: { tags: ["finance"] } }, { ...input, before: { ...input.before, tags: [] }, after: { ...input.before, tags: ["finance"] } }).allowed).toBe(false);
    expect(evaluate(policy, { ...input, after: null }).allowed).toBe(true);
  });

  it("checks transitions including creation/deletion and restricts protected writers only when fields change", () => {
    const policy: WorkflowPolicy = { id: "transition", effect: "refuse", rule: { kind: "transition", allowed: [["$create", "open"], ["open", "closed"], ["closed", "$delete"]] } };
    for (const change of [input, { ...input, before: null, after: input.before }, { ...input, before: input.after, after: null }, { ...input, before: input.after }]) expect(evaluate(policy, change).allowed).toBe(true);
    expect(evaluate(policy, { ...input, after: { status: "canceled" } }).allowed).toBe(false);
    const writers: WorkflowPolicy = { id: "writers", effect: "refuse", rule: { kind: "field_writers", authors: ["reviewer"], fields: ["body"] } };
    expect(evaluate(writers).allowed).toBe(true);
    expect(evaluate(writers, { ...input, after: { ...input.after, body: "edit" } }).allowed).toBe(false);
    expect(evaluate(writers, { ...input, author: "reviewer", after: { ...input.after, body: "edit" } }).allowed).toBe(true);
    const actors: WorkflowPolicy = { id: "actors", effect: "refuse", rule: { kind: "authors", authors: ["writer"] } };
    expect(evaluate(actors).allowed).toBe(true);
    expect(evaluate(actors, { ...input, author: "other" }).allowed).toBe(false);
  });

  it("requires independent approval of the same item, rule, and field values", () => {
    const policy: WorkflowPolicy = { id: "review", effect: "refuse", rule: { kind: "approval", authors: ["reviewer"], fields: ["body"] } };
    const approval = { author: "reviewer", policy_fingerprint: workflowPolicyFingerprint(policy), content_fingerprint: workflowApprovalFingerprint(policy, input.after!) };
    expect(evaluate(policy).allowed).toBe(false);
    expect(evaluate(policy, { ...input, approvals: [approval] }).allowed).toBe(true);
    for (const mismatch of [{ author: "writer" }, { author: "other" }, { policy_fingerprint: "old" }, { content_fingerprint: "old" }]) expect(evaluate(policy, { ...input, approvals: [{ ...approval, ...mismatch }] }).allowed).toBe(false);
    expect(evaluate(policy, { ...input, before: input.after }).allowed).toBe(true);
    expect(evaluate(policy, { ...input, before: null }).decisions).toEqual([]);
    expect(evaluate(policy, { ...input, after: null, approvals: [approval] }).allowed).toBe(true);
    expect(evaluate(policy, { ...input, after: null }).allowed).toBe(false);
    expect(evaluate(policy, { ...input, before: { ...input.before, body: "changed" }, after: null, approvals: [approval] }).allowed).toBe(false);
    expect(workflowApprovalFingerprint(policy, { ...input.after, id: "pm-other" })).not.toBe(approval.content_fingerprint);
    expect(workflowApprovalFingerprint(requirement, input.after!)).toHaveLength(64);
  });
});
