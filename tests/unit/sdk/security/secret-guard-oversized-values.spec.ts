/**
 * Codex review round 34 on PR 1746 (pm-hw00c2): a rule whose pattern exhausts
 * the regex stack on one oversized value reports that value for review, so the
 * value fails closed for itself instead of the whole scan failing open. Any
 * other error still propagates to the guard's fail-open advisory.
 */
import { describe, expect, it, vi } from "vitest";

const OVERFLOW = "overflow-sentinel";
const BROKEN = "broken-sentinel";
// Raised only by the member judge, so the member pass's own handling is what the test observes.
const MEMBER_OVERFLOW = "judge-only-range";
const MEMBER_BROKEN = "judge-only-type";

vi.mock("../../../../src/core/shared/secret-rules.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../../src/core/shared/secret-rules.js")>();
  const raise = (value: string): void => {
    if (value.includes(OVERFLOW)) throw new RangeError("Maximum call stack size exceeded");
    if (value.includes(BROKEN)) throw new TypeError("unexpected");
  };
  return {
    ...original,
    findSecretRuleMatches: (rule: Parameters<typeof original.findSecretRuleMatches>[0], value: string) => {
      raise(value);
      return original.findSecretRuleMatches(rule, value);
    },
    acceptsStructuredValue: (rule: Parameters<typeof original.acceptsStructuredValue>[0], value: string, compact: boolean) => {
      raise(value);
      if (value === MEMBER_OVERFLOW) throw new RangeError("Maximum call stack size exceeded");
      if (value === MEMBER_BROKEN) throw new TypeError("unexpected");
      return original.acceptsStructuredValue(rule, value, compact);
    },
  };
});

const { evaluateMutationGuard, scanMutationSecrets } = await import("../../../../src/sdk/mutation-guard.js");
const blockSettings = { require_attributed_author: false, secret_guard: "block", stale_in_progress_hours: 72 } as const;
const githubToken = ["ghp_", "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56"].join("");

describe("an oversized value fails closed for itself (Codex round 34)", () => {
  it("reports the value for review under every rule that cannot judge it, and keeps other findings", () => {
    const findings = scanMutationSecrets({ description: OVERFLOW, notes: githubToken });
    expect(findings).toContainEqual({ rule: "github_token", path: "$.notes" });
    expect(findings).toContainEqual({ rule: "credential_key_assignment", path: "$.description", normalization_incomplete: true });
    // A credential-named member is judged by the member pass, which fails closed the same way on its own.
    // Both key-named rules that read `api_key` judge the member, and each fails closed for it.
    expect(scanMutationSecrets({ api_key: MEMBER_OVERFLOW })).toEqual([
      { rule: "high_entropy_assignment", path: "$.api_key", normalization_incomplete: true },
      { rule: "credential_key_assignment", path: "$.api_key", normalization_incomplete: true },
    ]);
  });

  it("blocks instead of failing open", () => {
    // Only the oversized value: the block must come from its own fail-closed finding.
    expect(() => evaluateMutationGuard({ author: "agent", payload: { description: OVERFLOW }, settings: blockSettings }))
      .toThrow(/Mutation blocked by secret guard/);
  });

  it("still lets any other error reach the guard's fail-open advisory", () => {
    expect(() => scanMutationSecrets({ description: BROKEN })).toThrow(TypeError);
    expect(() => scanMutationSecrets({ api_key: MEMBER_BROKEN })).toThrow(TypeError);
    expect(evaluateMutationGuard({ author: "agent", payload: { description: BROKEN }, settings: blockSettings }).warnings)
      .toEqual(["secret_guard_scan_failed_open"]);
  });
});
