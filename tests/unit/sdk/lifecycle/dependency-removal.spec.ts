import { describe, expect, it } from "vitest";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import {
  assertDependencyRemovalSelectorsMatch,
  describeRemovedDependencies,
  matchesDependencySelector,
  storedDependencyIdentityKey,
} from "../../../../src/sdk/lifecycle/dependency-removal.js";
import { scalarClearRemovesDependency } from "../../../../src/sdk/lifecycle/start-blockers.js";
import type { Dependency } from "../../../../src/types/index.js";

/** pm-4yxzvd: lossless dependency-row removal and the scalar clear's row scope. */
describe("dependency removal primitives", () => {
  const row: Dependency = { id: "pm-a", kind: "blocked_by", author: "Agent", source_kind: "cli:update:dep", created_at: "2026-01-01T00:00:00Z" };

  it("keys stored rows by normalized identity, keeping an unparseable timestamp verbatim", () => {
    expect(storedDependencyIdentityKey(row)).toBe(["pm-a", "blocked_by", "cli:update:dep", "agent", "2026-01-01T00:00:00.000Z"].join("\u0000"));
    expect(storedDependencyIdentityKey({ id: " PM-A ", kind: "related" })).toBe(["pm-a", "related", "", "", ""].join("\u0000"));
    expect(storedDependencyIdentityKey({ id: "pm-a", kind: "related", created_at: "not-a-date" }).endsWith("not-a-date")).toBe(true);
  });

  it("matches only the coordinates a selector names, including the kind-wide form", () => {
    expect(matchesDependencySelector(row, { kind: "blocked_by" })).toBe(true);
    expect(matchesDependencySelector(row, { id: "PM-A", author: "agent", source_kind: "CLI:UPDATE:DEP", created_at: "2026-01-01T00:00:00.000Z" })).toBe(true);
    expect(matchesDependencySelector(row, { id: "pm-b" })).toBe(false);
    expect(matchesDependencySelector(row, { kind: "related" })).toBe(false);
    expect(matchesDependencySelector(row, { id: "pm-a", author: "someone-else" })).toBe(false);
    expect(matchesDependencySelector(row, { id: "pm-a", source_kind: "cli:create:dep" })).toBe(false);
    expect(matchesDependencySelector({ ...row, created_at: undefined }, { id: "pm-a", created_at: "2026-01-01T00:00:00.000Z" })).toBe(false);
  });

  it("refuses unmatched selectors, naming a kind-wide selector's id as *", () => {
    expect(() => assertDependencyRemovalSelectorsMatch([row], [{ kind: "blocked_by" }], "pm-x")).not.toThrow();
    let refusal: unknown;
    try {
      assertDependencyRemovalSelectorsMatch([row], [{ kind: "related" }, { id: "pm-b" }], "pm-x");
    } catch (error: unknown) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(PmCliError);
    expect((refusal as PmCliError).exitCode).toBe(EXIT_CODE.NOT_FOUND);
    expect((refusal as PmCliError).message).toBe("Dependency removal did not match stored edges.");
    expect((refusal as PmCliError).context).toMatchObject({
      code: "dependency_remove_no_match",
      unmatched_selectors: [{ id: "*", kind: "related" }, { id: "pm-b" }],
    });
  });

  it("names removed rows once per stored row", () => {
    expect(describeRemovedDependencies([row, { ...row, id: "pm-b" }], [row])).toBe("pm-b/blocked_by");
  });

  it("scopes the scalar clear to rows naming its own target", () => {
    const derived = { id: "pm-a", kind: "blocked_by", source_kind: "cli:update:blocked_by" };
    expect(scalarClearRemovesDependency(derived, "a", "pm-")).toBe(true);
    expect(scalarClearRemovesDependency({ ...derived, source_kind: "CLI:CREATE:BLOCKED_BY" }, "a", "pm-")).toBe(true);
    expect(scalarClearRemovesDependency({ id: "pm-a", kind: "blocked_by" }, "a", "pm-")).toBe(false);
    expect(scalarClearRemovesDependency({ id: "a", kind: "blocked_by" }, " A ", "pm-")).toBe(true);
    expect(scalarClearRemovesDependency({ ...derived, kind: "related" }, "pm-a", "pm-")).toBe(false);
    expect(scalarClearRemovesDependency(derived, "pm-b", "pm-")).toBe(false);
    for (const scalar of [undefined, 7, "", "   "]) {
      expect(scalarClearRemovesDependency(derived, scalar, "pm-")).toBe(false);
    }
  });
});
