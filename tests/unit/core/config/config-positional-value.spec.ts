import { describe, expect, it } from "vitest";
import { resolveConfigPositionalValue } from "../../../../src/core/config/positional-value.js";

describe("resolveConfigPositionalValue", () => {
  it("routes the item-format key to the --format flag (verbatim value)", () => {
    expect(resolveConfigPositionalValue("item-format", "toon")).toEqual({
      routable: true,
      flag: "format",
      value: "toon",
    });
  });

  it("accepts the snake_case form of a key", () => {
    expect(resolveConfigPositionalValue("item_format", "toon")).toEqual({
      routable: true,
      flag: "format",
      value: "toon",
    });
  });

  it("routes plain policy keys to --policy and passes the value through unchanged", () => {
    expect(resolveConfigPositionalValue("history-missing-stream-policy", "strict_error")).toEqual({
      routable: true,
      flag: "policy",
      value: "strict_error",
    });
    expect(resolveConfigPositionalValue("governance-preset", "strict")).toEqual({
      routable: true,
      flag: "policy",
      value: "strict",
    });
    // Bad values are passed through so the downstream validator reports the allowed set.
    expect(resolveConfigPositionalValue("governance-preset", "bogus")).toEqual({
      routable: true,
      flag: "policy",
      value: "bogus",
    });
  });

  it("maps enabled/disabled synonyms for boolean-style policy keys", () => {
    const cases: [string, string][] = [
      ["off", "disabled"],
      ["OFF", "disabled"],
      ["on", "enabled"],
      ["On", "enabled"],
      ["true", "enabled"],
      ["false", "disabled"],
      ["enabled", "enabled"],
      ["disabled", "disabled"],
    ];
    for (const [input, expected] of cases) {
      expect(resolveConfigPositionalValue("telemetry-tracking", input)).toEqual({
        routable: true,
        flag: "policy",
        value: expected,
      });
    }
    expect(resolveConfigPositionalValue("test-result-tracking", "off")).toEqual({
      routable: true,
      flag: "policy",
      value: "disabled",
    });
    expect(resolveConfigPositionalValue("governance-force-required-for-stale-lock", "on")).toEqual({
      routable: true,
      flag: "policy",
      value: "enabled",
    });
    expect(resolveConfigPositionalValue("governance-require-close-reason", "off")).toEqual({
      routable: true,
      flag: "policy",
      value: "disabled",
    });
  });

  it("passes non-synonym values through unchanged for boolean-style policy keys", () => {
    expect(resolveConfigPositionalValue("telemetry-tracking", "yep")).toEqual({
      routable: true,
      flag: "policy",
      value: "yep",
    });
  });

  it("routes criteria-list keys to --criterion as a single-value array", () => {
    expect(resolveConfigPositionalValue("definition-of-done", "Tests pass")).toEqual({
      routable: true,
      flag: "criterion",
      values: ["Tests pass"],
    });
    expect(resolveConfigPositionalValue("metadata-required-fields", "author")).toEqual({
      routable: true,
      flag: "criterion",
      values: ["author"],
    });
    expect(resolveConfigPositionalValue("lifecycle-stale-blocker-reason-patterns", "waiting")).toEqual({
      routable: true,
      flag: "criterion",
      values: ["waiting"],
    });
  });

  it("reports context as not routable with a flag hint", () => {
    const result = resolveConfigPositionalValue("context", "deep");
    expect(result.routable).toBe(false);
    if (!result.routable) {
      expect(result.reason).toContain("--default-depth");
      expect(result.reason).toContain("--section-");
    }
  });

  it("reports unknown keys as not routable", () => {
    const result = resolveConfigPositionalValue("bogus-key", "x");
    expect(result.routable).toBe(false);
    if (!result.routable) {
      expect(result.reason).toContain("bogus-key");
    }
  });
});
