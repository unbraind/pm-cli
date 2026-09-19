import { describe, expect, it } from "vitest";
import { reconcileSettingsSnapshot } from "../../../../src/core/store/settings-concurrency.js";

describe("settings snapshot reconciliation", () => {
  it.each([
    [{ a: 1 }, { a: 1 }, { a: 2, b: 3 }, { a: 2, b: 3 }],
    [{ a: 1 }, { a: 2 }, { a: 1 }, { a: 2 }],
    [{ a: 1 }, { a: 2 }, { a: 2 }, { a: 2 }],
    [{}, { group: { a: 1 } }, { group: { b: 2 } }, { group: { a: 1, b: 2 } }],
    [{ a: 1, b: 2 }, { b: 2 }, { a: 1, b: 3 }, { b: 3 }],
    [{ a: null, b: 2 }, { a: "value", b: 2 }, { a: null, b: 3 }, { a: "value", b: 3 }],
    [{ a: 1, b: 2 }, { a: 1, b: 3 }, { a: null, b: 2 }, { a: null, b: 3 }],
  ])("preserves independent changes without mutating its inputs", (baseline, proposed, current, expected) => {
    const inputs = structuredClone([baseline, proposed, current]);
    expect(reconcileSettingsSnapshot(baseline, proposed, current)).toEqual(expected);
    expect([baseline, proposed, current]).toEqual(inputs);
  });

  it.each([
    ["old", "ours", "theirs"],
    [[1], [1, 2], [1, 3]],
    [{ a: 1 }, undefined, { a: 2 }],
    [null, { a: 1 }, { b: 2 }],
    [{ a: 1 }, { a: 2 }, null],
    [{ a: 1 }, { a: 1 }, null],
  ])("refuses conflicting replacements and deletions", (baseline, proposed, current) => {
    expect(() => reconcileSettingsSnapshot(baseline, proposed, current)).toThrow(/Settings changed concurrently/);
  });

  it("keeps prototype-like JSON keys as inert own properties", () => {
    const proposed: unknown = JSON.parse('{"__proto__":{"a":1},"constructor":"local"}');
    const current: unknown = JSON.parse('{"__proto__":{"b":2},"toString":"peer"}');
    const result = reconcileSettingsSnapshot({}, proposed, current);
    expect(result).toEqual(JSON.parse('{"__proto__":{"a":1,"b":2},"constructor":"local","toString":"peer"}'));
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty("a");
  });

  it("names the conflicting key without exposing any setting value", () => {
    expect(() => reconcileSettingsSnapshot(
      { provider: { credential: "initial-sensitive-value" } },
      { provider: { credential: "our-sensitive-value" } },
      { provider: { credential: "other-sensitive-value" } },
    )).toThrow("Settings changed concurrently at provider.credential;");
  });
});
