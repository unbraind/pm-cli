import { describe, expect, it } from "vitest";
import {
  normalizeTypePresetName,
  resolveTypePresetDefinitions,
  TYPE_PRESET_DEFINITIONS,
  TYPE_PRESET_NAMES,
} from "../../../../src/core/schema/type-presets.js";

describe("normalizeTypePresetName", () => {
  it("returns undefined for undefined input", () => {
    expect(normalizeTypePresetName(undefined)).toBeUndefined();
  });

  it("throws on empty input", () => {
    expect(() => normalizeTypePresetName("   ")).toThrow(/must not be empty/);
  });

  it("normalizes casing and hyphen/underscore for known presets", () => {
    expect(normalizeTypePresetName("Agile")).toBe("agile");
    expect(normalizeTypePresetName("OPS")).toBe("ops");
    expect(normalizeTypePresetName("research")).toBe("research");
  });

  it("throws on an unknown preset", () => {
    expect(() => normalizeTypePresetName("kanban")).toThrow(/Invalid type preset "kanban"/);
  });
});

describe("resolveTypePresetDefinitions", () => {
  it("returns normalized add-type inputs for every preset name", () => {
    for (const name of TYPE_PRESET_NAMES) {
      const resolved = resolveTypePresetDefinitions(name);
      expect(resolved.length).toBe(TYPE_PRESET_DEFINITIONS[name].length);
      for (const definition of resolved) {
        expect(definition.name.length).toBeGreaterThan(0);
        expect(Array.isArray(definition.aliases)).toBe(true);
      }
    }
  });

  it("normalizes the agile Story/Spike definitions with folders and aliases", () => {
    const resolved = resolveTypePresetDefinitions("agile");
    const story = resolved.find((d) => d.name === "Story");
    expect(story?.folder).toBe("stories");
    expect(story?.aliases).toContain("user-story");
    const spike = resolved.find((d) => d.name === "Spike");
    expect(spike?.defaultStatus).toBe("open");
  });
});
