import { describe, expect, it } from "vitest";
import { TYPE_SYNONYMS, resolveTypeSynonym } from "../../src/core/item/type-synonyms.js";

describe("resolveTypeSynonym", () => {
  it("maps common bug synonyms to Issue case-insensitively", () => {
    expect(resolveTypeSynonym("Bug")).toBe("Issue");
    expect(resolveTypeSynonym("bug")).toBe("Issue");
    expect(resolveTypeSynonym("DEFECT")).toBe("Issue");
    expect(resolveTypeSynonym("incident")).toBe("Issue");
  });

  it("maps enhancement/story synonyms to Feature", () => {
    expect(resolveTypeSynonym("enhancement")).toBe("Feature");
    expect(resolveTypeSynonym("story")).toBe("Feature");
    expect(resolveTypeSynonym("user-story")).toBe("Feature");
  });

  it("maps change to Chore and ticket/todo to Task", () => {
    expect(resolveTypeSynonym("change")).toBe("Chore");
    expect(resolveTypeSynonym("ticket")).toBe("Task");
    expect(resolveTypeSynonym("todo")).toBe("Task");
  });

  it("trims surrounding whitespace before lookup", () => {
    expect(resolveTypeSynonym("  Bug  ")).toBe("Issue");
  });

  it("returns undefined for unknown tokens and undefined input", () => {
    expect(resolveTypeSynonym("Issue")).toBeUndefined();
    expect(resolveTypeSynonym("totally-made-up")).toBeUndefined();
    expect(resolveTypeSynonym(undefined)).toBeUndefined();
    expect(resolveTypeSynonym("")).toBeUndefined();
  });

  it("only maps to canonical built-in type names", () => {
    const builtins = new Set(["Issue", "Feature", "Chore", "Task", "Epic", "Decision"]);
    for (const target of Object.values(TYPE_SYNONYMS)) {
      expect(builtins.has(target)).toBe(true);
    }
  });
});
