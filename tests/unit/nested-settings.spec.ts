import { describe, expect, it } from "vitest";
import {
  NESTED_SETTING_DESCRIPTORS,
  parseNestedSettingValue,
  readNestedSettingValue,
  resolveNestedSettingDescriptor,
  writeNestedSettingValue,
} from "../../src/core/config/nested-settings.js";

const STRING_DESCRIPTOR = NESTED_SETTING_DESCRIPTORS.find((d) => d.key === "search_provider")!;
const INTEGER_DESCRIPTOR = NESTED_SETTING_DESCRIPTORS.find((d) => d.key === "search_embedding_batch_size")!;
const NUMBER_DESCRIPTOR = NESTED_SETTING_DESCRIPTORS.find((d) => d.key === "search_score_threshold")!;
const RATIO_DESCRIPTOR = NESTED_SETTING_DESCRIPTORS.find((d) => d.key === "search_hybrid_semantic_weight")!;
const NESTED_PATH_DESCRIPTOR = NESTED_SETTING_DESCRIPTORS.find((d) => d.key === "qdrant_url")!;

describe("nested-settings helpers (pm-7ilo)", () => {
  describe("resolveNestedSettingDescriptor", () => {
    it("returns undefined for non-string inputs", () => {
      expect(resolveNestedSettingDescriptor(undefined)).toBeUndefined();
      expect(resolveNestedSettingDescriptor(null as unknown as string)).toBeUndefined();
      expect(resolveNestedSettingDescriptor(42 as unknown as string)).toBeUndefined();
    });

    it("returns undefined for empty / whitespace-only keys", () => {
      expect(resolveNestedSettingDescriptor("")).toBeUndefined();
      expect(resolveNestedSettingDescriptor("   ")).toBeUndefined();
    });

    it("normalizes case and kebab/snake separators", () => {
      expect(resolveNestedSettingDescriptor("Search-Provider")?.key).toBe("search_provider");
      expect(resolveNestedSettingDescriptor("SEARCH_PROVIDER")?.key).toBe("search_provider");
    });
  });

  describe("parseNestedSettingValue", () => {
    it("trims whitespace for string kinds and returns the trimmed value", () => {
      const result = parseNestedSettingValue(STRING_DESCRIPTOR, "  ollama  ");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.parsed.value).toBe("ollama");
    });

    it("rejects non-string inputs", () => {
      const result = parseNestedSettingValue(STRING_DESCRIPTOR, 7 as unknown as string);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("requires a string value");
    });

    it("rejects non-finite numbers", () => {
      const result = parseNestedSettingValue(INTEGER_DESCRIPTOR, "not-a-number");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("finite number");
    });

    it("rejects non-integers / negative integers for integer kind", () => {
      const fractional = parseNestedSettingValue(INTEGER_DESCRIPTOR, "1.5");
      expect(fractional.ok).toBe(false);
      const negative = parseNestedSettingValue(INTEGER_DESCRIPTOR, "-3");
      expect(negative.ok).toBe(false);
    });

    it("accepts zero and positive integers", () => {
      const zero = parseNestedSettingValue(INTEGER_DESCRIPTOR, "0");
      expect(zero.ok).toBe(true);
      if (zero.ok) expect(zero.parsed.value).toBe(0);
      const positive = parseNestedSettingValue(INTEGER_DESCRIPTOR, "32");
      expect(positive.ok).toBe(true);
      if (positive.ok) expect(positive.parsed.value).toBe(32);
    });

    it("accepts any finite number for number kind (including negatives)", () => {
      const negative = parseNestedSettingValue(NUMBER_DESCRIPTOR, "-0.25");
      expect(negative.ok).toBe(true);
      if (negative.ok) expect(negative.parsed.value).toBe(-0.25);
    });

    it("rejects ratios outside [0, 1] on both ends", () => {
      const tooLow = parseNestedSettingValue(RATIO_DESCRIPTOR, "-0.1");
      expect(tooLow.ok).toBe(false);
      const tooHigh = parseNestedSettingValue(RATIO_DESCRIPTOR, "1.5");
      expect(tooHigh.ok).toBe(false);
    });

    it("accepts boundary ratios 0 and 1", () => {
      expect(parseNestedSettingValue(RATIO_DESCRIPTOR, "0").ok).toBe(true);
      expect(parseNestedSettingValue(RATIO_DESCRIPTOR, "1").ok).toBe(true);
    });
  });

  describe("readNestedSettingValue", () => {
    it("returns null when the path traverses through a non-object", () => {
      expect(readNestedSettingValue(null, STRING_DESCRIPTOR)).toBeNull();
      expect(readNestedSettingValue("not-an-object", STRING_DESCRIPTOR)).toBeNull();
      expect(readNestedSettingValue({ search: "scalar" }, STRING_DESCRIPTOR)).toBeNull();
    });

    it("returns null when the leaf is missing or non-scalar", () => {
      expect(readNestedSettingValue({}, STRING_DESCRIPTOR)).toBeNull();
      expect(readNestedSettingValue({ search: { provider: { nested: true } } }, STRING_DESCRIPTOR)).toBeNull();
    });

    it("returns the string / number leaf when present", () => {
      expect(
        readNestedSettingValue({ search: { provider: "ollama" } }, STRING_DESCRIPTOR),
      ).toBe("ollama");
      expect(
        readNestedSettingValue({ search: { embedding_batch_size: 16 } }, INTEGER_DESCRIPTOR),
      ).toBe(16);
    });
  });

  describe("writeNestedSettingValue", () => {
    it("creates missing intermediate objects when setting a deep leaf", () => {
      const settings: Record<string, unknown> = {};
      const changed = writeNestedSettingValue(settings, NESTED_PATH_DESCRIPTOR, "http://localhost:6333");
      expect(changed).toBe(true);
      expect(readNestedSettingValue(settings, NESTED_PATH_DESCRIPTOR)).toBe("http://localhost:6333");
    });

    it("replaces non-object intermediates (string / array) with a fresh object before writing", () => {
      const stringIntermediate: Record<string, unknown> = { vector_store: "lancedb" };
      expect(
        writeNestedSettingValue(stringIntermediate, NESTED_PATH_DESCRIPTOR, "http://h:6333"),
      ).toBe(true);
      expect(readNestedSettingValue(stringIntermediate, NESTED_PATH_DESCRIPTOR)).toBe("http://h:6333");

      const arrayIntermediate: Record<string, unknown> = { vector_store: { qdrant: [1, 2, 3] } };
      expect(
        writeNestedSettingValue(arrayIntermediate, NESTED_PATH_DESCRIPTOR, "http://h:6333"),
      ).toBe(true);
      expect(readNestedSettingValue(arrayIntermediate, NESTED_PATH_DESCRIPTOR)).toBe("http://h:6333");

      const nullIntermediate: Record<string, unknown> = { vector_store: { qdrant: null } };
      expect(
        writeNestedSettingValue(nullIntermediate, NESTED_PATH_DESCRIPTOR, "http://h:6333"),
      ).toBe(true);
      expect(readNestedSettingValue(nullIntermediate, NESTED_PATH_DESCRIPTOR)).toBe("http://h:6333");
    });

    it("returns false (no change) when leaf already holds the same value", () => {
      const settings: Record<string, unknown> = { search: { provider: "ollama" } };
      expect(writeNestedSettingValue(settings, STRING_DESCRIPTOR, "ollama")).toBe(false);
    });
  });
});
