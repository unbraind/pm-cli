import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROFILES,
  listProfiles,
  normalizeProfileName,
  PROFILE_NAMES,
  resolveProfile,
} from "../../../../src/core/profile/profile-presets.js";
import { normalizeAddTypeInput } from "../../../../src/core/schema/item-types-file.js";
import { normalizeAddStatusInput } from "../../../../src/core/schema/status-defs-file.js";
import { normalizeAddFieldInput, BUILTIN_FIELD_KEYS } from "../../../../src/core/schema/fields-file.js";
import { resolveNestedSettingDescriptor, parseNestedSettingValue } from "../../../../src/core/config/nested-settings.js";

describe("normalizeProfileName", () => {
  it("returns undefined for undefined input", () => {
    expect(normalizeProfileName(undefined)).toBeUndefined();
  });

  it("throws on empty input", () => {
    expect(() => normalizeProfileName("   ")).toThrow(/must not be empty/);
  });

  it("normalizes casing and hyphen/underscore for known profiles", () => {
    expect(normalizeProfileName("Agile")).toBe("agile");
    expect(normalizeProfileName("OPS")).toBe("ops");
    expect(normalizeProfileName("Research")).toBe("research");
  });

  it("throws on an unknown profile", () => {
    expect(() => normalizeProfileName("kanban")).toThrow(/Invalid profile "kanban"/);
  });
});

describe("resolveProfile", () => {
  it("returns the matching built-in definition", () => {
    expect(resolveProfile("agile")).toBe(BUILTIN_PROFILES.agile);
    expect(resolveProfile("ops").name).toBe("ops");
  });

  it("throws when the name is omitted", () => {
    expect(() => resolveProfile(undefined)).toThrow(/Profile name is required/);
  });

  it("throws when the name is unknown", () => {
    expect(() => resolveProfile("waterfall")).toThrow(/Invalid profile/);
  });
});

describe("listProfiles", () => {
  it("returns every built-in profile in canonical order", () => {
    expect(listProfiles().map((profile) => profile.name)).toEqual([...PROFILE_NAMES]);
  });
});

describe("BUILTIN_PROFILES definitions", () => {
  it("normalizes every type/status/field without throwing and never shadows a built-in field", () => {
    for (const name of PROFILE_NAMES) {
      const profile = BUILTIN_PROFILES[name];
      expect(profile.name).toBe(name);
      expect(profile.title.length).toBeGreaterThan(0);
      expect(profile.summary.length).toBeGreaterThan(0);
      for (const type of profile.types) {
        expect(() => normalizeAddTypeInput(type)).not.toThrow();
      }
      for (const status of profile.statuses) {
        expect(() => normalizeAddStatusInput(status)).not.toThrow();
      }
      for (const field of profile.fields) {
        expect(BUILTIN_FIELD_KEYS.has(normalizeAddFieldInput(field).key)).toBe(false);
        expect(() => normalizeAddFieldInput(field)).not.toThrow();
      }
    }
  });

  it("references only resolvable, valid config knobs", () => {
    for (const name of PROFILE_NAMES) {
      for (const entry of BUILTIN_PROFILES[name].config) {
        const descriptor = resolveNestedSettingDescriptor(entry.key);
        expect(descriptor).toBeDefined();
        expect(parseNestedSettingValue(descriptor!, entry.value).ok).toBe(true);
      }
    }
  });

  it("declares workflows whose type matches a registered type and lists transitions", () => {
    for (const name of PROFILE_NAMES) {
      const profile = BUILTIN_PROFILES[name];
      const typeNames = new Set(profile.types.map((type) => normalizeAddTypeInput(type).name));
      for (const workflow of profile.workflows) {
        expect(typeNames.has(workflow.type)).toBe(true);
        expect(workflow.allowed_transitions.length).toBeGreaterThan(0);
      }
    }
  });

  it("stages at least one template and one package recommendation per profile", () => {
    for (const name of PROFILE_NAMES) {
      const profile = BUILTIN_PROFILES[name];
      expect(profile.templates.length).toBeGreaterThan(0);
      expect(profile.packages.length).toBeGreaterThan(0);
      for (const template of profile.templates) {
        expect(template.name.length).toBeGreaterThan(0);
        expect(Object.keys(template.options).length).toBeGreaterThan(0);
      }
    }
  });
});
