import { describe, expect, it } from "vitest";
import {
  evaluateExtensionPolicyForExtension,
  evaluateExtensionPolicyForRegistration,
  hydrateExtensionPolicy,
  normalizeExtensionPolicy,
  normalizePmMaxVersionExceededMode,
  serializeExtensionPolicy,
  type NormalizedExtensionPolicy,
  type PolicyExtensionRef,
} from "../../../../src/core/extensions/extension-policy.js";
import type { ExtensionGovernancePolicy } from "../../../../src/core/extensions/extension-types.js";
import type { PmSettings } from "../../../../src/types/index.js";

function settingsWithPolicy(policy: Partial<ExtensionGovernancePolicy>): PmSettings {
  return {
    extensions: { policy },
  } as unknown as PmSettings;
}

describe("extension-policy normalization edge cases", () => {
  it("normalizes a non-string override name to empty and drops it", () => {
    const policy = normalizeExtensionPolicy(
      settingsWithPolicy({
        mode: "warn",
        extension_overrides: [
          // Non-string name → normalizePolicyName returns "" → override dropped.
          { name: 123 as unknown as string, disabled: true },
          { name: "valid-ext", disabled: true },
        ],
      }),
    );
    expect([...policy.overridesByName.keys()]).toEqual(["valid-ext"]);
  });

  it("normalizes empty and single-segment policy surfaces", () => {
    const policy = normalizeExtensionPolicy(
      settingsWithPolicy({
        mode: "warn",
        // "   " → token "" (dropped); "commands" → single segment kept as-is;
        // "commands.override" → multi-segment.
        allowed_surfaces: ["   ", "commands", "commands.override"],
      }),
    );
    expect([...policy.allowedSurfaces].sort()).toEqual(["commands", "commands.override"]);
  });

  it("defaults an unknown pm_max_version_exceeded_mode string to block", () => {
    expect(normalizePmMaxVersionExceededMode("nonsense")).toEqual({ global: "block", project: "block" });
    expect(normalizePmMaxVersionExceededMode({ global: "warn" })).toEqual({ global: "warn", project: "block" });
    expect(normalizePmMaxVersionExceededMode(undefined)).toEqual({ global: "block", project: "block" });
  });

  it("collects overrides when extension_overrides is undefined", () => {
    const policy = normalizeExtensionPolicy(settingsWithPolicy({ mode: "warn" }));
    expect(policy.overridesByName.size).toBe(0);
  });
});

describe("extension-policy serialization with populated override sets", () => {
  it("serializes every populated override set branch", () => {
    const policy = normalizeExtensionPolicy(
      settingsWithPolicy({
        mode: "enforce",
        extension_overrides: [
          {
            name: "rich-ext",
            disabled: true,
            require_trusted: true,
            require_provenance: true,
            sandbox_profile: "restricted",
            allowed_capabilities: ["fs.read"],
            blocked_capabilities: ["network"],
            allowed_surfaces: ["commands.override"],
            blocked_surfaces: ["services.override"],
            allowed_commands: ["list"],
            blocked_commands: ["delete"],
            allowed_actions: ["create"],
            blocked_actions: ["close"],
            allowed_services: ["item_store_read"],
            blocked_services: ["output_format"],
          },
        ],
      }),
    );
    const serialized = serializeExtensionPolicy(policy);
    expect(serialized.extension_overrides).toEqual([
      {
        name: "rich-ext",
        disabled: true,
        require_trusted: true,
        require_provenance: true,
        sandbox_profile: "restricted",
        allowed_capabilities: ["fs.read"],
        blocked_capabilities: ["network"],
        allowed_surfaces: ["commands.override"],
        blocked_surfaces: ["services.override"],
        allowed_commands: ["list"],
        blocked_commands: ["delete"],
        allowed_actions: ["create"],
        blocked_actions: ["close"],
        allowed_services: ["item_store_read"],
        blocked_services: ["output_format"],
      },
    ]);
  });
});

describe("extension-policy evaluation fall-through and override-scoped surfaces", () => {
  function basePolicy(overrides: Partial<ExtensionGovernancePolicy>): NormalizedExtensionPolicy {
    return hydrateExtensionPolicy({
      mode: "off",
      trust_mode: "off",
      require_provenance: false,
      trusted_extensions: [],
      default_sandbox_profile: "none",
      allowed_extensions: [],
      blocked_extensions: [],
      allowed_capabilities: [],
      blocked_capabilities: [],
      allowed_surfaces: [],
      blocked_surfaces: [],
      allowed_commands: [],
      blocked_commands: [],
      allowed_actions: [],
      blocked_actions: [],
      allowed_services: [],
      blocked_services: [],
      extension_overrides: [],
      ...overrides,
    } as ExtensionGovernancePolicy);
  }

  it("returns allowed/no-warning when a reason exists but neither layer warns or enforces", () => {
    // mode "off" still computes the extension reason (blocked), but mode "off"
    // never enforces/warns. trust_mode "warn" with a trusted ext yields no trust
    // reason. sandbox reason is suppressed by mode "off". → final fall-through.
    const policy = basePolicy({
      mode: "off",
      trust_mode: "warn",
      blocked_extensions: ["blocked-ext"],
    });
    const extension: PolicyExtensionRef = {
      layer: "project",
      name: "blocked-ext",
      trusted: true,
      provenanceVerified: true,
    };
    expect(evaluateExtensionPolicyForExtension(policy, extension)).toEqual({
      allowed: true,
      warning: null,
    });
  });

  it("uses override-scoped allowed surfaces during registration evaluation", () => {
    const policy = basePolicy({
      mode: "enforce",
      extension_overrides: [
        {
          name: "scoped-ext",
          allowed_surfaces: ["commands.override"],
        },
      ],
    });
    const extension: PolicyExtensionRef = { layer: "project", name: "scoped-ext" };
    // Surface not in the override's allowlist → blocked.
    const blocked = evaluateExtensionPolicyForRegistration(
      policy,
      extension,
      "services.override",
      "registerServiceOverride",
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.warning).toContain("reason=surface_not_allowlisted");

    // Surface in the override's allowlist → allowed.
    const allowed = evaluateExtensionPolicyForRegistration(
      policy,
      extension,
      "commands.override",
      "registerCommandOverride",
    );
    expect(allowed.allowed).toBe(true);
    expect(allowed.warning).toBeNull();
  });
});
