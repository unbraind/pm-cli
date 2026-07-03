import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROFILES,
  listProfiles,
  normalizeProfileName,
  PROFILE_NAMES,
  resolveProfile,
  resolveProfileCatalog,
  resolveProfileEntry,
  type ExtensionProfileContribution,
  type ProjectProfileDefinition,
} from "../../../../src/core/profile/profile-presets.js";
import { normalizeAddTypeInput } from "../../../../src/core/schema/item-types-file.js";
import { BUILTIN_STATUS_IDS, normalizeAddStatusInput } from "../../../../src/core/schema/status-defs-file.js";
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
      const typeNames = new Set<string>();
      for (const type of profile.types) {
        const normalizedType = normalizeAddTypeInput(type);
        expect(normalizedType.name.length).toBeGreaterThan(0);
        expect(typeNames.has(normalizedType.name.toLowerCase())).toBe(false);
        typeNames.add(normalizedType.name.toLowerCase());
      }
      const statusIds = new Set<string>();
      for (const status of profile.statuses) {
        const normalizedStatus = normalizeAddStatusInput(status);
        expect(normalizedStatus.id.length).toBeGreaterThan(0);
        expect(statusIds.has(normalizedStatus.id)).toBe(false);
        statusIds.add(normalizedStatus.id);
      }
      // Every workflow transition endpoint must resolve to a built-in status or
      // a status this profile itself registers, so applying the profile never
      // declares a transition to a nonexistent status.
      for (const workflow of profile.workflows) {
        for (const [from, to] of workflow.allowed_transitions) {
          expect(statusIds.has(from) || BUILTIN_STATUS_IDS.has(from)).toBe(true);
          expect(statusIds.has(to) || BUILTIN_STATUS_IDS.has(to)).toBe(true);
        }
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

/** Build a minimal extension-contributed profile definition for the merge resolver. */
function extensionProfile(name: string, overrides: Partial<ProjectProfileDefinition> = {}): ProjectProfileDefinition {
  return {
    name,
    title: `${name} archetype`,
    summary: `${name} summary`,
    types: [],
    statuses: [],
    fields: [],
    workflows: [],
    config: [],
    templates: [],
    packages: [],
    ...overrides,
  };
}

/** Wrap a profile definition as a contribution from the named package. */
function contribution(pkg: string, profile: ProjectProfileDefinition): ExtensionProfileContribution {
  return { name: pkg, profile };
}

describe("resolveProfileCatalog", () => {
  it("returns the built-in profiles (no extensions) labeled as builtin, in canonical order", () => {
    const { profiles, warnings } = resolveProfileCatalog();
    expect(profiles.map((entry) => entry.definition.name)).toEqual([...PROFILE_NAMES]);
    expect(profiles.every((entry) => entry.source === "builtin")).toBe(true);
    expect(profiles.every((entry) => entry.package === undefined)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("appends extension profiles after the builtins with their owning package as source", () => {
    const { profiles, warnings } = resolveProfileCatalog([contribution("pm-kanban", extensionProfile("kanban"))]);
    expect(profiles).toHaveLength(PROFILE_NAMES.length + 1);
    const kanban = profiles.at(-1)!;
    expect(kanban.definition.name).toBe("kanban");
    expect(kanban.source).toBe("extension");
    expect(kanban.package).toBe("pm-kanban");
    expect(warnings).toEqual([]);
  });

  it("reserves built-in names: an extension profile colliding with a builtin is ignored with a warning", () => {
    const { profiles, warnings } = resolveProfileCatalog([
      contribution("rogue-pkg", extensionProfile("Agile", { title: "Hijacked" })),
    ]);
    expect(profiles).toHaveLength(PROFILE_NAMES.length);
    expect(profiles.find((entry) => entry.definition.name === "agile")?.source).toBe("builtin");
    expect(warnings).toEqual([
      'Extension "rogue-pkg" profile "Agile" uses a name reserved by a built-in archetype and was ignored.',
    ]);
  });

  it("keeps the first contribution when two extension profiles share a normalized name", () => {
    const { profiles, warnings } = resolveProfileCatalog([
      contribution("pkg-a", extensionProfile("flow", { title: "First" })),
      contribution("pkg-b", extensionProfile("FLOW", { title: "Second" })),
    ]);
    const flowEntries = profiles.filter((entry) => entry.definition.name.toLowerCase() === "flow");
    expect(flowEntries).toHaveLength(1);
    expect(flowEntries[0].definition.title).toBe("First");
    expect(flowEntries[0].package).toBe("pkg-a");
    expect(warnings).toEqual([
      'Profile "FLOW" from extension "pkg-b" duplicates an already-registered profile and was ignored.',
    ]);
  });

  it("folds hyphens to underscores for collision detection so kebab/snake variants dedupe", () => {
    const { profiles, warnings } = resolveProfileCatalog([
      contribution("pkg-a", extensionProfile("my-flow")),
      contribution("pkg-b", extensionProfile("my_flow")),
    ]);
    expect(profiles.filter((entry) => entry.source === "extension")).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

});

describe("resolveProfileEntry", () => {
  it("resolves a built-in profile by name (case/format-insensitive)", () => {
    const { resolved, warnings } = resolveProfileEntry("AGILE");
    expect(resolved.definition.name).toBe("agile");
    expect(resolved.source).toBe("builtin");
    expect(warnings).toEqual([]);
  });

  it("resolves an extension-contributed profile by name", () => {
    const { resolved } = resolveProfileEntry("kanban", [contribution("pm-kanban", extensionProfile("kanban"))]);
    expect(resolved.definition.name).toBe("kanban");
    expect(resolved.source).toBe("extension");
    expect(resolved.package).toBe("pm-kanban");
  });

  it("resolves an extension profile by mixed-case and kebab/snake equivalents", () => {
    const contributions = [contribution("pkg", extensionProfile("my-flow"))];
    expect(resolveProfileEntry("MY-FLOW", contributions).resolved.definition.name).toBe("my-flow");
    expect(resolveProfileEntry("my_flow", contributions).resolved.definition.name).toBe("my-flow");
    expect(resolveProfileEntry("  My_Flow ", contributions).resolved.definition.name).toBe("my-flow");
  });

  it("surfaces the catalog's merge warnings alongside the resolved profile", () => {
    const { resolved, warnings } = resolveProfileEntry("agile", [
      contribution("rogue", extensionProfile("agile", { title: "X" })),
    ]);
    // The built-in is resolved, and the shadowing attempt is reported (not swallowed).
    expect(resolved.source).toBe("builtin");
    expect(warnings).toEqual([
      'Extension "rogue" profile "agile" uses a name reserved by a built-in archetype and was ignored.',
    ]);
  });

  it("throws a name-listing error when the profile name is required but missing", () => {
    expect(() => resolveProfileEntry(undefined)).toThrow(/Profile name is required\. Allowed: agile, ops, research\./);
    expect(() => resolveProfileEntry("   ")).toThrow(/Profile name is required\./);
  });

  it("throws a name-listing error for an unknown profile, including extension names", () => {
    expect(() => resolveProfileEntry("nope", [contribution("pm-kanban", extensionProfile("kanban"))])).toThrow(
      /Invalid profile "nope"\. Allowed: agile, ops, research, kanban\./,
    );
  });

  it("never resolves a built-in-colliding extension profile (the builtin wins)", () => {
    const { resolved } = resolveProfileEntry("agile", [contribution("rogue", extensionProfile("agile", { title: "X" }))]);
    expect(resolved.source).toBe("builtin");
    expect(resolved.definition.title).not.toBe("X");
  });
});
