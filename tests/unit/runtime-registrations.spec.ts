import { describe, expect, it } from "vitest";
import { createEmptyExtensionRegistrationRegistry } from "../../src/core/extensions/loader.js";
import {
  evaluateExtensionPolicyForCapability,
  evaluateExtensionPolicyForExtension,
  evaluateExtensionPolicyForRegistration,
  hydrateExtensionPolicy,
  normalizeExtensionPolicy,
  normalizePmMaxVersionExceededMode,
  normalizePolicySandboxProfile,
  serializeExtensionPolicy,
} from "../../src/core/extensions/extension-policy.js";
import {
  collectRegisteredItemFields,
  getMigrationRuntimeDefinition,
  resolveRegisteredSearchProvider,
  resolveRegisteredVectorStoreAdapter,
} from "../../src/core/extensions/runtime-registrations.js";
import {
  canonicalizeCommandOptionKey,
  commandOptionFlagLabel,
  resolveCommandOptionPolicyState,
  resolveItemTypeRegistry,
  resolveTypeDefinition,
  resolveTypeName,
  validateTypeOptions,
} from "../../src/core/item/type-registry.js";
import { SETTINGS_DEFAULTS } from "../../src/core/shared/constants.js";

describe("extensions runtime registration resolution", () => {
  it("collects registered item fields across registrations", () => {
    const registrations = createEmptyExtensionRegistrationRegistry();
    registrations.item_fields.push(
      {
        layer: "global",
        name: "global-fields",
        fields: [{ name: "team" }],
      },
      {
        layer: "project",
        name: "project-fields",
        fields: [{ name: "severity" }],
      },
    );

    expect(collectRegisteredItemFields(registrations)).toEqual([{ name: "team" }, { name: "severity" }]);
    expect(collectRegisteredItemFields(null)).toEqual([]);
  });

  it("resolves search providers by configured name with reverse-precedence matching", () => {
    const registrations = createEmptyExtensionRegistrationRegistry();
    registrations.search_providers.push(
      {
        layer: "global",
        name: "global-provider",
        definition: { name: "elastic", query: () => [{ id: "pm-1", score: 0.5 }] },
        runtime_definition: { name: "elastic", query: () => [{ id: "pm-1", score: 0.5 }] },
      },
      {
        layer: "project",
        name: "project-provider",
        definition: { name: "Elastic", query: () => [{ id: "pm-2", score: 0.8 }] },
        runtime_definition: { query: () => [{ id: "pm-2", score: 0.8 }] },
      },
    );

    const resolved = resolveRegisteredSearchProvider(registrations, "  ELASTIC ");
    expect(resolved?.name).toBe("project-provider");
    expect(resolveRegisteredSearchProvider(registrations, "missing")).toBeNull();
    expect(resolveRegisteredSearchProvider(registrations, undefined)).toBeNull();
  });

  it("resolves vector store adapters by configured name with reverse precedence", () => {
    const registrations = createEmptyExtensionRegistrationRegistry();
    registrations.vector_store_adapters.push(
      {
        layer: "global",
        name: "global-vector",
        definition: { name: "pinecone", query: () => [] },
        runtime_definition: { name: "pinecone", query: () => [] },
      },
      {
        layer: "project",
        name: "project-vector",
        definition: { name: "PINECONE", query: () => [] },
        runtime_definition: { query: () => [] },
      },
    );

    const resolved = resolveRegisteredVectorStoreAdapter(registrations, "pinecone");
    expect(resolved?.name).toBe("project-vector");
    expect(resolveRegisteredVectorStoreAdapter(registrations, "")).toBeNull();
    expect(resolveRegisteredVectorStoreAdapter(null, "pinecone")).toBeNull();
  });

  it("returns migration runtime definitions when available", () => {
    const runtime = getMigrationRuntimeDefinition({
      layer: "project",
      name: "runtime-migration",
      definition: { id: "m1", status: "pending" },
      runtime_definition: { id: "m1", status: "applied", run: () => true },
    });
    expect(runtime).toEqual({ id: "m1", status: "applied", run: expect.any(Function) });

    const fallback = getMigrationRuntimeDefinition({
      layer: "project",
      name: "fallback-migration",
      definition: { id: "m2", status: "pending" },
      runtime_definition: undefined as unknown as Record<string, unknown>,
    });
    expect(fallback).toEqual({ id: "m2", status: "pending" });
  });
});

describe("extension policy runtime resolution", () => {
  it("normalizes max-version modes and sandbox profiles with safe fallbacks", () => {
    expect(normalizePmMaxVersionExceededMode("warn")).toEqual({ global: "warn", project: "warn" });
    expect(normalizePmMaxVersionExceededMode({ global: "warn", project: "bogus" as never })).toEqual({
      global: "warn",
      project: "block",
    });
    expect(normalizePmMaxVersionExceededMode(["warn"] as never)).toEqual({ global: "block", project: "block" });
    expect(normalizePolicySandboxProfile(" Strict ")).toBe("strict");
    expect(normalizePolicySandboxProfile("container" as never)).toBe("none");
  });

  it("normalizes, warns, serializes, and hydrates extension policy settings", () => {
    const settings = structuredClone(SETTINGS_DEFAULTS);
    settings.extensions.policy = {
      mode: "WARN" as never,
      trust_mode: "enforce",
      pm_max_version_exceeded_mode: { global: "warn", project: "nope" as never },
      require_provenance: true,
      trusted_extensions: [" Core ", "core"],
      default_sandbox_profile: "restricted",
      allowed_extensions: ["alpha"],
      blocked_extensions: [" beta "],
      allowed_capabilities: ["hooks", "bogus-cap"],
      blocked_capabilities: ["services", "bogus-cap"],
      allowed_surfaces: ["Hooks: On Write", "bad/surface"],
      blocked_surfaces: ["services.override"],
      allowed_commands: [" status "],
      blocked_commands: [" delete "],
      allowed_actions: ["export-data"],
      blocked_actions: ["wipe-data"],
      allowed_services: ["output_format"],
      blocked_services: ["history_append"],
      extension_overrides: [
        { name: " ", allowed_capabilities: ["hooks"] },
        {
          name: " Alpha ",
          disabled: true,
          require_trusted: true,
          require_provenance: true,
          sandbox_profile: "strict",
          allowed_capabilities: ["commands", "unknown-override"],
          blocked_surfaces: ["schema.flags", "missing.surface"],
          allowed_commands: [" create "],
          blocked_actions: ["drop-all"],
          allowed_services: ["item_store_write"],
        },
      ],
    };

    const policy = normalizeExtensionPolicy(settings);
    expect(policy.mode).toBe("warn");
    expect(policy.trustMode).toBe("enforce");
    expect(policy.pmMaxVersionExceededMode).toEqual({ global: "warn", project: "block" });
    expect(policy.trustedExtensions).toEqual(new Set(["core"]));
    expect(policy.allowedSurfaces).toEqual(new Set(["hooks.onwrite", "bad.surface"]));
    expect(policy.overridesByName.get("alpha")?.disabled).toBe(true);
    expect(policy.warnings).toEqual([
      "extension_policy_unknown_capability:alpha:unknown-override",
      "extension_policy_unknown_capability:bogus-cap",
      "extension_policy_unknown_surface:alpha:missing.surface",
      "extension_policy_unknown_surface:bad.surface",
    ]);

    const serialized = serializeExtensionPolicy(policy);
    expect(serialized.pm_max_version_exceeded_mode).toEqual({ global: "warn", project: "block" });
    expect(serialized.extension_overrides).toEqual([
      expect.objectContaining({
        name: "alpha",
        disabled: true,
        require_trusted: true,
        require_provenance: true,
        sandbox_profile: "strict",
        allowed_capabilities: ["commands", "unknown-override"],
        blocked_actions: ["drop-all"],
      }),
    ]);
    expect(hydrateExtensionPolicy(serialized).warnings).toEqual([]);
  });

  it("evaluates extension, capability, and registration policy decisions", () => {
    const settings = structuredClone(SETTINGS_DEFAULTS);
    settings.extensions.policy = {
      ...settings.extensions.policy,
      mode: "enforce",
      trust_mode: "warn",
      require_provenance: true,
      trusted_extensions: ["alpha"],
      default_sandbox_profile: "restricted",
      allowed_extensions: ["alpha"],
      blocked_capabilities: ["services"],
      allowed_surfaces: ["commands.handler"],
      blocked_commands: ["delete"],
      blocked_actions: ["wipe-data"],
      blocked_services: ["history_append"],
      extension_overrides: [
        {
          name: "alpha",
          sandbox_profile: "strict",
          allowed_capabilities: ["commands"],
          blocked_surfaces: ["schema.flags"],
          allowed_commands: ["create"],
          allowed_actions: ["export-data"],
          allowed_services: ["item_store_write"],
        },
      ],
    };
    const policy = normalizeExtensionPolicy(settings);
    const alpha = {
      layer: "project" as const,
      name: "alpha",
      trusted: true,
      provenanceVerified: true,
      permissions: { network: false, fs_write: false, process_spawn: false, env_write: false },
    };

    expect(evaluateExtensionPolicyForExtension(policy, alpha)).toEqual({ allowed: true, warning: null });
    expect(evaluateExtensionPolicyForExtension(policy, { ...alpha, name: "beta" })).toEqual({
      allowed: false,
      warning: "extension_policy_blocked_extension:project:beta:reason=extension_not_allowlisted",
    });
    expect(evaluateExtensionPolicyForExtension(policy, { ...alpha, trusted: false })).toEqual({
      allowed: true,
      warning: "extension_policy_violation_trust:project:alpha:reason=extension_untrusted",
    });
    expect(
      evaluateExtensionPolicyForExtension(policy, {
        ...alpha,
        permissions: { ...alpha.permissions, network: true },
      }),
    ).toEqual({
      allowed: false,
      warning: "extension_policy_blocked_extension:project:alpha:reason=sandbox_strict_disallows_network",
    });

    expect(evaluateExtensionPolicyForCapability(policy, alpha, "services")).toEqual({
      allowed: false,
      warning: "extension_policy_blocked_capability:project:alpha:reason=capability_blocked:capability=services",
    });
    expect(evaluateExtensionPolicyForCapability(policy, alpha, "hooks")).toEqual({
      allowed: false,
      warning: "extension_policy_blocked_capability:project:alpha:reason=capability_not_allowlisted:capability=hooks",
    });
    expect(
      evaluateExtensionPolicyForRegistration(policy, alpha, "commands.handler", " Register Handler ", "commands", {
        command: "pm delete",
      }),
    ).toEqual({
      allowed: false,
      warning:
        "extension_policy_blocked_registration:project:alpha:reason=command_not_allowlisted:capability=commands:command=pm delete:method=register_handler:surface=commands.handler",
    });
    expect(
      evaluateExtensionPolicyForRegistration(policy, alpha, "commands.handler", "Register Handler", "commands", {
        command: "create",
        action: "wipe data",
      }),
    ).toEqual({
      allowed: false,
      warning:
        "extension_policy_blocked_registration:project:alpha:reason=action_blocked:action=wipe-data:capability=commands:command=create:method=register_handler:surface=commands.handler",
    });
    expect(
      evaluateExtensionPolicyForRegistration(policy, alpha, "commands.handler", "Register Handler", "commands", {
        command: "create",
        action: "export-data",
        service: "history_append",
      }),
    ).toEqual({
      allowed: false,
      warning:
        "extension_policy_blocked_registration:project:alpha:reason=service_blocked:action=export-data:capability=commands:command=create:method=register_handler:service=history_append:surface=commands.handler",
    });
  });
});

describe("item type registry runtime resolution", () => {
  it("canonicalizes command options and derives fallback flag labels", () => {
    expect(canonicalizeCommandOptionKey("create", "--acceptance-criteria")).toBe("acceptanceCriteria");
    expect(canonicalizeCommandOptionKey("update", "allow_audit_update")).toBe("allowAuditUpdate");
    expect(canonicalizeCommandOptionKey("update", "  ")).toBeUndefined();
    expect(commandOptionFlagLabel("create", "unknownCamelCase")).toBe("--unknown-camel-case");
  });

  it("merges settings and extension item types with aliases, options, and policies", () => {
    const settings = structuredClone(SETTINGS_DEFAULTS);
    settings.item_types.definitions = [
      {
        name: "Asset",
        description: "Tracked asset",
        aliases: [" asset ", "Thing"],
        default_status: "open",
        required_create_fields: ["title", "title", "description"],
        required_create_repeatables: ["file", "doc"],
        options: [{ key: "tier", values: ["gold", "silver"], required: true, aliases: ["level"] }],
        command_option_policies: [
          { command: "create", option: "description", required: false },
          { command: "update", option: "blocked-by", visible: false, enabled: false },
        ],
      },
    ];
    const registrations = createEmptyExtensionRegistrationRegistry();
    registrations.item_types.push({
      layer: "project",
      name: "item-type-ext",
      types: [
        "bad" as never,
        { name: " ", folder: "ignored" } as never,
        { name: "Asset", aliases: ["Hardware"], options: [{ key: "region", values: [], required: false }] },
        {
          name: "Review Board",
          options: [{ key: "cadence", values: ["weekly"], aliases: ["freq"], required: true }],
          command_option_policies: [
            { command: "create", option: "estimate", required: true },
            { command: "delete" as never, option: "ignored", required: true },
          ],
        },
      ],
    });

    const registry = resolveItemTypeRegistry(settings, registrations);
    expect(resolveTypeName("hardware", registry)).toBe("Asset");
    expect(resolveTypeName(undefined, registry)).toBeUndefined();
    expect(resolveTypeDefinition("review board", registry)).toMatchObject({
      name: "Review Board",
      folder: "review-boards",
      required_create_fields: [],
      required_create_repeatables: [],
    });
    expect(registry.by_type.Asset.aliases).toEqual(["asset", "Hardware", "Thing"]);
    expect(registry.by_type.Asset.options).toEqual([
      expect.objectContaining({ key: "region", values: [] }),
    ]);

    expect(
      resolveCommandOptionPolicyState(registry.by_type.Asset, "update", ["status", "bogus"]),
    ).toEqual({
      required: ["status"],
      hidden: ["blockedBy"],
      disabled: ["blockedBy"],
      errors: ['Unsupported base required option "bogus" for command "update" on type "Asset"'],
    });
    expect(
      resolveCommandOptionPolicyState(
        {
          ...registry.by_type.Asset,
          command_option_policies: [{ command: "create", option: "title", required: true, enabled: false }],
        },
        "create",
        [],
      ).errors,
    ).toEqual(['Option "title" cannot be both required and disabled for command "create" on type "Asset"']);
  });

  it("validates type options, aliases, required values, and sorted normalized output", () => {
    const settings = structuredClone(SETTINGS_DEFAULTS);
    settings.item_types.definitions = [
      {
        name: "Asset",
        options: [
          { key: "tier", values: ["Gold", "Silver"], aliases: ["level"], required: true },
          { key: "region", values: [], aliases: ["area"] },
        ],
      },
      { name: "Plain" },
    ];
    const registry = resolveItemTypeRegistry(settings);

    expect(validateTypeOptions("Missing", { tier: "Gold" }, registry)).toEqual({
      normalized: undefined,
      errors: ['Unknown type "Missing"'],
    });
    expect(validateTypeOptions("Plain", { any: "value" }, registry)).toEqual({
      normalized: undefined,
      errors: ['Type "Plain" does not define any configurable type options'],
    });
    expect(validateTypeOptions("Asset", { " ": "Gold", tier: " ", unknown: "x" }, registry)).toEqual({
      normalized: undefined,
      errors: [
        "type option keys must not be empty",
        'type option "tier" must not be empty',
        'Unknown type option "unknown" for type "Asset". Allowed: region, tier',
        'Missing required type option "tier" for type "Asset"',
      ],
    });
    expect(validateTypeOptions("Asset", { level: "silver", area: "emea" }, registry)).toEqual({
      normalized: { region: "emea", tier: "Silver" },
      errors: [],
    });
    expect(validateTypeOptions("Asset", { tier: "bronze" }, registry)).toEqual({
      normalized: undefined,
      errors: [
        'Invalid value "bronze" for type option "tier". Allowed: Gold, Silver',
        'Missing required type option "tier" for type "Asset"',
      ],
    });
  });
});
