import { describe, expect, it } from "vitest";
import {
  extractTitlePrefix,
  inferTypesFromTitles,
  prefixToTypeName,
} from "../../../../src/core/schema/type-inference.js";

describe("extractTitlePrefix", () => {
  it("extracts a hyphen-delimited prefix", () => {
    expect(extractTitlePrefix("INFRA- provision the cluster")).toBe("infra");
  });

  it("extracts a colon-delimited prefix", () => {
    expect(extractTitlePrefix("BUG: crash on startup")).toBe("bug");
  });

  it("returns undefined when there is no delimiter or trailing content", () => {
    expect(extractTitlePrefix("just a normal title")).toBeUndefined();
    expect(extractTitlePrefix("INFRA-")).toBeUndefined();
  });

  it("rejects single-character (sequence/index) prefixes", () => {
    expect(extractTitlePrefix("S- something")).toBeUndefined();
    expect(extractTitlePrefix("E- another")).toBeUndefined();
  });

  it("rejects a numeric-led prefix (not letter-led)", () => {
    expect(extractTitlePrefix("123- numeric")).toBeUndefined();
  });

  it("accepts internal hyphens/underscores in the token", () => {
    expect(extractTitlePrefix("CODE-REVIEW: ship it")).toBe("code-review");
  });
});

describe("prefixToTypeName", () => {
  it("pascal-cases a simple prefix", () => {
    expect(prefixToTypeName("infra")).toBe("Infra");
  });

  it("pascal-cases multi-word hyphen/underscore prefixes", () => {
    expect(prefixToTypeName("code-review")).toBe("CodeReview");
    expect(prefixToTypeName("user_story")).toBe("UserStory");
  });
});

describe("inferTypesFromTitles", () => {
  const titles = [
    ...Array.from({ length: 12 }, (_, i) => `INFRA- task ${i}`),
    ...Array.from({ length: 11 }, (_, i) => `SECURITY: finding ${i}`),
    ...Array.from({ length: 3 }, (_, i) => `DOCS- note ${i}`),
    "no prefix here",
    "",
    42 as unknown as string,
  ];

  it("returns candidates above the default threshold sorted by count then name", () => {
    const candidates = inferTypesFromTitles(titles);
    expect(candidates.map((c) => c.name)).toEqual(["Infra", "Security"]);
    expect(candidates[0]).toMatchObject({ name: "Infra", prefix: "infra", count: 12, shadows_builtin: false });
    expect(candidates[0].examples.length).toBe(3);
  });

  it("respects a custom minCount", () => {
    const candidates = inferTypesFromTitles(titles, { minCount: 3 });
    expect(candidates.map((c) => c.name)).toEqual(["Infra", "Security", "Docs"]);
  });

  it("caps the example list per candidate", () => {
    const candidates = inferTypesFromTitles(titles, { minCount: 3, maxExamples: 1 });
    expect(candidates[0].examples.length).toBe(1);
  });

  it("flags candidates that shadow a built-in type", () => {
    const taskTitles = Array.from({ length: 10 }, (_, i) => `TASK- thing ${i}`);
    const candidates = inferTypesFromTitles(taskTitles, { minCount: 10 });
    expect(candidates[0]).toMatchObject({ name: "Task", shadows_builtin: true });
  });

  it("falls back to defaults for non-positive options", () => {
    const taskTitles = Array.from({ length: 10 }, (_, i) => `INFRA- thing ${i}`);
    const candidates = inferTypesFromTitles(taskTitles, { minCount: 0, maxExamples: 0 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].examples.length).toBe(3);
  });

  it("returns empty when nothing meets the threshold", () => {
    expect(inferTypesFromTitles(["INFRA- one", "INFRA- two"])).toEqual([]);
  });
});
