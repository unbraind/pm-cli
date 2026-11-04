import { describe, expect, it } from "vitest";
import {
  emptyMutationOptionMessage,
  markCliMutationInput,
  mutationInputAudience,
  mutationOptionLabel,
  preserveLiteralMutationInput,
  sdkClearRemedy,
} from "../../../../src/core/item/literal-mutation-input.js";
import {
  assertParentReferenceIsNotSelf,
  normalizeParentReferenceValue,
  validateMissingParentReference,
} from "../../../../src/core/item/parent-reference-policy.js";
import { validateSprintOrReleaseValue } from "../../../../src/core/item/sprint-release-format.js";
import { foldNullClearsIntoUnset, literalSentinelAdvisories } from "../../../../src/sdk/lifecycle/shared-unset-fields.js";

describe("mutation input audience wording (pm-gh1655)", () => {
  it("treats only literal-marked input as a typed SDK caller", () => {
    expect(mutationInputAudience(preserveLiteralMutationInput({}))).toBe("sdk");
    expect(mutationInputAudience(markCliMutationInput({}))).toBe("cli");
    expect(mutationInputAudience({})).toBe("cli");
  });

  it("names options and clear remedies in the caller's vocabulary", () => {
    expect(mutationOptionLabel("cli", "close-reason")).toBe("--close-reason");
    expect(mutationOptionLabel("sdk", "close-reason")).toBe("closeReason");
    expect(sdkClearRemedy("parent")).toBe('Pass unset: ["parent"] to clear it');
    expect(emptyMutationOptionMessage("cli", "close-reason")).toBe("--close-reason must not be empty");
    expect(emptyMutationOptionMessage("cli", "assignee", ". Use --unset assignee to clear it.")).toBe("--assignee must not be empty. Use --unset assignee to clear it.");
    expect(emptyMutationOptionMessage("sdk", "blocked-by", ". ignored")).toBe('blockedBy must not be empty. Pass unset: ["blocked-by"] to clear it, or omit blockedBy.');
  });

  it("keeps CLI wording by default on the public validators and SDK wording on request", () => {
    expect(() => normalizeParentReferenceValue(42)).toThrow("--parent must be a string. Use --unset parent to clear this field.");
    expect(() => normalizeParentReferenceValue(42, "sdk")).toThrow('parent must be a string. Pass unset: ["parent"] to clear it.');
    expect(() => normalizeParentReferenceValue("none")).toThrow('--parent must not use placeholder token "none". Use --unset parent to clear this field.');
    expect(() => validateMissingParentReference("pm-x", "strict_error")).toThrow("Create it first or use --parent none.");
    expect(() => assertParentReferenceIsNotSelf("pm-a", "pm-a", "pm")).toThrow("Use --unset parent to clear this field.");
    expect(() => validateSprintOrReleaseValue("sprint", "", "warn")).toThrow("--sprint must not be empty. Use --sprint none to unset.");
    expect(() => validateSprintOrReleaseValue("release", "a b", "strict_error")).toThrow('Invalid --release value "a b".');
    expect(() => validateSprintOrReleaseValue("release", "a b", "strict_error", "sdk")).toThrow('Invalid release value "a b".');
  });
});

describe("typed null clears (pm-gh1655)", () => {
  it("folds null on clearable options into unset and leaves every other value alone", () => {
    const fresh: Record<string, unknown> = { parent: null, title: null, author: null, goal: "kept" };
    foldNullClearsIntoUnset("create", fresh);
    expect(fresh).toEqual({ title: null, author: null, goal: "kept", unset: ["parent"] });
    const appended: Record<string, unknown> = { closeReason: null, unset: ["tags"] };
    foldNullClearsIntoUnset("update", appended);
    expect(appended).toEqual({ unset: ["tags", "close-reason"] });
    const scalar: Record<string, unknown> = { estimatedMinutes: null, unset: "goal" };
    foldNullClearsIntoUnset("update", scalar);
    expect(scalar).toEqual({ unset: ["goal", "estimate"] });
    const untouched: Record<string, unknown> = { goal: "x", unset: ["tags"] };
    foldNullClearsIntoUnset("update", untouched);
    expect(untouched).toEqual({ goal: "x", unset: ["tags"] });
    const malformed: Record<string, unknown> = { parent: null, unset: 5 };
    foldNullClearsIntoUnset("update", malformed);
    expect(malformed).toEqual({ parent: null, unset: 5 });
  });

  it("advises only literal input whose stored item still holds a former sentinel in a clearable string field", () => {
    expect(literalSentinelAdvisories("create", { assignee: "none" }, false, { assignee: "none" })).toEqual([]);
    expect(literalSentinelAdvisories("create", { assignee: " None ", goal: "ship", tags: ["none"], order: 3 }, true, { assignee: "None", goal: "ship" })).toEqual(["literal_sentinel_stored:assignee:None"]);
    expect(literalSentinelAdvisories("update", { closeReason: "-" }, true, { close_reason: "-" })).toEqual(["literal_sentinel_stored:close-reason:-"]);
    // A CSV option stored as an array is advised when an element still holds the sentinel.
    expect(literalSentinelAdvisories("create", { tags: "none" }, true, { tags: ["none"] })).toEqual(["literal_sentinel_stored:tags:none"]);
    expect(literalSentinelAdvisories("create", { tags: "none" }, true, { tags: ["shipped"] })).toEqual([]);
    // A lifecycle transition that removed the value leaves nothing to advise.
    expect(literalSentinelAdvisories("update", { assignee: "none" }, true, {})).toEqual([]);
  });
});
