import { describe, expect, it } from "vitest";
import { createEmptyExtensionRegistrationRegistry } from "../../../src/core/extensions/loader.js";
import {
  evaluateExtensionPolicyForCapability,
  evaluateExtensionPolicyForExtension,
  evaluateExtensionPolicyForRegistration,
  hydrateExtensionPolicy,
  normalizeExtensionPolicy,
  normalizePmMaxVersionExceededMode,
  normalizePolicySandboxProfile,
  serializeExtensionPolicy,
} from "../../../src/core/extensions/extension-policy.js";
import {
  collectUnknownExtensionCapabilities,
  formatLegacyExtensionCapabilityAliasWarning,
  formatUnknownExtensionCapabilityWarning,
  normalizeManifestCapabilities,
  normalizeNames,
  parseLegacyExtensionCapabilityAliasWarning,
  parseUnknownExtensionCapabilityWarning,
  resolveLegacyExtensionCapabilityAlias,
  suggestKnownExtensionCapability,
} from "../../../src/core/extensions/extension-capability-aliases.js";
import {
  collectRegisteredItemFields,
  getMigrationRuntimeDefinition,
  resolveRegisteredSearchProvider,
  resolveRegisteredVectorStoreAdapter,
} from "../../../src/core/extensions/runtime-registrations.js";
import {
  applyRegisteredItemFieldDefaultsAndValidation,
  collectRegisteredItemFieldNames,
  parseRegisteredItemFieldAssignments,
} from "../../../src/core/extensions/item-fields.js";
import {
  canonicalizeCommandOptionKey,
  commandOptionFlagLabel,
  DEFAULT_REQUIRED_CREATE_FIELDS,
  DEFAULT_REQUIRED_CREATE_REPEATABLES,
  resolveCommandOptionPolicyState,
  resolveItemTypeRegistry,
  resolveTypeDefinition,
  resolveTypeName,
  validateTypeOptions,
} from "../../../src/core/item/type-registry.js";
import { SETTINGS_DEFAULTS } from "../../../src/core/shared/constants.js";

describe("extensions runtime registration resolution", () => {
  it("normalizes capability names and parses capability warning payloads", () => {
    expect(normalizeNames([" services ", "", "hooks", "services"])).toEqual(["hooks", "services"]);
    expect(collectUnknownExtensionCapabilities(["hooks", "not-real"])).toEqual(["not-real"]);
    expect(resolveLegacyExtensionCapabilityAlias(" migration ")).toBe("schema");
    expect(resolveLegacyExtensionCapabilityAlias(" ")).toBeNull();
    expect(suggestKnownExtensionCapability("comands")).toBe("commands");
    expect(suggestKnownExtensionCapability(" ")).toBeNull();

    expect(normalizeManifestCapabilities(["Migration", "hooks", "validation"])).toEqual({
      capabilities: ["hooks", "schema"],
      legacy_aliases: [
        { alias: "migration", target: "schema" },
        { alias: "validation", target: "schema" },
      ],
    });

    const unknownWarning = formatUnknownExtensionCapabilityWarning("project", "demo", "comands");
    expect(parseUnknownExtensionCapabilityWarning(unknownWarning)).toMatchObject({
      layer: "project",
      name: "demo",
      capability: "comands",
      suggested_capability: "commands",
      suggestion_source: "nearest_match",
    });
    expect(parseUnknownExtensionCapabilityWarning("not a warning")).toBeNull();

    const legacyUnknownWarning = formatUnknownExtensionCapabilityWarning("global", "demo", "migration");
    expect(parseUnknownExtensionCapabilityWarning(legacyUnknownWarning)).toMatchObject({
      layer: "global",
      capability: "migration",
      suggested_capability: "schema",
      suggestion_source: "legacy_alias",
      legacy_alias_target: "schema",
    });

    const legacyWarning = formatLegacyExtensionCapabilityAliasWarning("project", "demo", [
      { alias: "migration", target: "schema" },
      { alias: "broken", target: "missing" as never },
      { alias: "", target: "commands" },
    ]);
    expect(parseLegacyExtensionCapabilityAliasWarning(legacyWarning)).toEqual([
      expect.objectContaining({
        layer: "project",
        name: "demo",
        capability: "migration",
        suggested_capability: "schema",
        suggestion_source: "legacy_alias",
      }),
    ]);
    expect(parseLegacyExtensionCapabilityAliasWarning("not a legacy warning")).toEqual([]);
  });

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
    // Registry present but no adapter matches the requested name → coalesces to null.
    expect(resolveRegisteredVectorStoreAdapter(registrations, "does-not-exist")).toBeNull();
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

  it("parses registered item-field assignments and reports unknown or invalid values", () => {
    const registrations = createEmptyExtensionRegistrationRegistry();
    registrations.item_fields.push(
      {
        layer: "global",
        name: "invalid-fields",
        fields: [
          { name: " ", type: "string" },
          { name: "ignored", type: "unknown" as never },
        ],
      },
      {
        layer: "project",
        name: "typed-fields",
        fields: [
          { name: "x_severity", type: "string" },
          { name: "x_impact", type: "number" },
          { name: "x_flagged", type: "boolean" },
          { name: "x_labels", type: "array" },
          { name: "x_meta", type: "object" },
        ],
      },
    );

    expect(collectRegisteredItemFieldNames(registrations)).toEqual(["x_flagged", "x_impact", "x_labels", "x_meta", "x_severity"]);
    expect(parseRegisteredItemFieldAssignments(undefined, registrations)).toEqual({});
    expect(
      parseRegisteredItemFieldAssignments(
        ["x_severity=high", "x_impact=2.5", "x_flagged=yes", 'x_labels=["coverage","sdk"]', 'x_meta={"owner":"extensions"}'],
        registrations,
      ),
    ).toEqual({
      x_severity: "high",
      x_impact: 2.5,
      x_flagged: true,
      x_labels: ["coverage", "sdk"],
      x_meta: { owner: "extensions" },
    });

    expect(() => parseRegisteredItemFieldAssignments(["broken"], registrations)).toThrow(/name=value syntax/);
    expect(() => parseRegisteredItemFieldAssignments([" =value"], registrations)).toThrow(/name=value syntax/);
    expect(() => parseRegisteredItemFieldAssignments(["missing=value"], registrations)).toThrow(/is not declared/);
    expect(() => parseRegisteredItemFieldAssignments(["x_impact= "], registrations)).toThrow(/must be a number/);
    expect(() => parseRegisteredItemFieldAssignments(["x_impact=NaN"], registrations)).toThrow(/must be a number/);
    expect(() => parseRegisteredItemFieldAssignments(["x_flagged=maybe"], registrations)).toThrow(/true\|false/);
    expect(() => parseRegisteredItemFieldAssignments(["x_labels={}", "x_meta=[]"], registrations)).toThrow(/valid JSON array/);
    expect(
      parseRegisteredItemFieldAssignments(["x_flagged=no", "x_meta={\"ok\":true}"], registrations),
    ).toMatchObject({
      x_flagged: false,
      x_meta: { ok: true },
    });
  });

  it("applies registered item-field defaults, skip lists, type checks, and conflicts", () => {
    const registrations = createEmptyExtensionRegistrationRegistry();
    const defaultObject = { nested: true };
    registrations.item_fields.push(
      {
        layer: "global",
        name: "defaults",
        fields: [
          { name: "x_severity", type: "string", default: "medium", values: ["low", "medium", "high"] },
          { name: "x_impact", type: "number", default: 1 },
          { name: "x_flagged", type: "boolean", default: false },
          { name: "x_labels", type: "array", default: ["coverage"] },
          { name: "x_meta", type: "object", default: defaultObject },
        ],
      },
      {
        layer: "project",
        name: "invalid",
        fields: [{ name: " ", type: "string" }],
      },
    );

    const frontMatter: Record<string, unknown> = { x_impact: 2 };
    applyRegisteredItemFieldDefaultsAndValidation(frontMatter, registrations, { skipDefaultFields: new Set(["x_flagged"]) });
    expect(frontMatter).toEqual({
      x_severity: "medium",
      x_impact: 2,
      x_labels: ["coverage"],
      x_meta: { nested: true },
    });
    expect(frontMatter.x_meta).not.toBe(defaultObject);

    expect(() => applyRegisteredItemFieldDefaultsAndValidation({ x_severity: "urgent" }, registrations)).toThrow(
      /configured allowed values/,
    );
    expect(() => applyRegisteredItemFieldDefaultsAndValidation({ x_labels: "coverage" }, registrations)).toThrow(
      /must be of type array/,
    );
    const functionDefault: Record<string, unknown> = {};
    applyRegisteredItemFieldDefaultsAndValidation(functionDefault, {
      ...createEmptyExtensionRegistrationRegistry(),
      item_fields: [
        {
          layer: "project",
          name: "function-default",
          fields: [{ name: "x_function", type: "object", default: { fn: () => "not cloneable" } }],
        },
      ],
    });
    expect(typeof (functionDefault.x_function as { fn?: unknown }).fn).toBe("function");
    expect(() =>
      applyRegisteredItemFieldDefaultsAndValidation(
        {},
        {
          ...createEmptyExtensionRegistrationRegistry(),
          item_fields: [{ layer: "project", name: "reserved", fields: [{ name: "title", type: "string" }] }],
        },
      ),
    ).toThrow(/collides with reserved item metadata/);
    expect(() =>
      collectRegisteredItemFieldNames({
        ...createEmptyExtensionRegistrationRegistry(),
        item_fields: [
          { layer: "global", name: "global", fields: [{ name: "score", type: "number" }] },
          { layer: "project", name: "project", fields: [{ name: "score", type: "string" }] },
        ],
      }),
    ).toThrow(/conflicting types/);
    expect(() => applyRegisteredItemFieldDefaultsAndValidation({}, null)).not.toThrow();
    expect(collectRegisteredItemFieldNames(null)).toEqual([]);
    expect(
      collectRegisteredItemFieldNames({
        ...createEmptyExtensionRegistrationRegistry(),
        item_fields: [{ layer: "project", name: "non-string", fields: [{ name: 1 as never, type: 2 as never }] }],
      }),
    ).toEqual([]);
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

  it("evaluates policy sandbox and permissive fallback branches", () => {
    const settings = structuredClone(SETTINGS_DEFAULTS);
    settings.extensions.policy = {
      ...settings.extensions.policy,
      mode: "warn",
      trust_mode: "off",
      default_sandbox_profile: "restricted",
    };
    const policy = normalizeExtensionPolicy(settings);
    const extension = { layer: "project" as const, name: "sandboxed" };

    expect(evaluateExtensionPolicyForExtension(policy, extension)).toEqual({
      allowed: true,
      warning: "extension_policy_violation_extension:project:sandboxed:reason=sandbox_permissions_missing",
    });
    expect(
      evaluateExtensionPolicyForExtension(policy, {
        ...extension,
        permissions: { env_write: true },
      }),
    ).toEqual({
      allowed: true,
      warning: "extension_policy_violation_extension:project:sandboxed:reason=sandbox_restricted_disallows_env_write",
    });

    const strictSettings = structuredClone(SETTINGS_DEFAULTS);
    strictSettings.extensions.policy = {
      ...strictSettings.extensions.policy,
      mode: "warn",
      trust_mode: "off",
      default_sandbox_profile: "strict",
    };
    const strictPolicy = normalizeExtensionPolicy(strictSettings);
    expect(
      evaluateExtensionPolicyForExtension(strictPolicy, {
        ...extension,
        permissions: { fs_write: true },
      }),
    ).toEqual({
      allowed: true,
      warning: "extension_policy_violation_extension:project:sandboxed:reason=sandbox_strict_disallows_fs_write",
    });
    expect(
      evaluateExtensionPolicyForExtension(strictPolicy, {
        ...extension,
        permissions: { env_write: true },
      }),
    ).toEqual({
      allowed: true,
      warning: "extension_policy_violation_extension:project:sandboxed:reason=sandbox_strict_disallows_env_write",
    });

    const permissiveSettings = structuredClone(SETTINGS_DEFAULTS);
    permissiveSettings.extensions.policy = {
      ...permissiveSettings.extensions.policy,
      mode: "off",
      trust_mode: "warn",
      trusted_extensions: ["other"],
    };
    expect(evaluateExtensionPolicyForExtension(normalizeExtensionPolicy(permissiveSettings), extension)).toEqual({
      allowed: true,
      warning: "extension_policy_violation_trust:project:sandboxed:reason=extension_not_trusted",
    });
  });

  it("evaluates disabled overrides and empty policy registration names", () => {
    const settings = structuredClone(SETTINGS_DEFAULTS);
    settings.extensions.policy = {
      ...settings.extensions.policy,
      mode: "enforce",
      trust_mode: "off",
      allowed_actions: ["deploy"],
      allowed_services: ["output_format"],
      extension_overrides: [
        {
          name: "sandboxed",
          disabled: true,
          allowed_actions: ["sync-data"],
          blocked_services: ["item_store_read"],
        },
      ],
    };
    const policy = normalizeExtensionPolicy(settings);
    const extension = { layer: "project" as const, name: "sandboxed" };

    expect(evaluateExtensionPolicyForExtension(policy, extension)).toEqual({
      allowed: false,
      warning: "extension_policy_blocked_extension:project:sandboxed:reason=extension_override_disabled",
    });
    expect(evaluateExtensionPolicyForRegistration(policy, extension, "actions.register", " ", "commands", { action: " " })).toEqual({
      allowed: true,
      warning: null,
    });
    expect(
      evaluateExtensionPolicyForRegistration(policy, extension, "actions.register", "registerAction", "commands", {
        action: "sync data",
      }),
    ).toEqual({
      allowed: true,
      warning: null,
    });
    expect(
      evaluateExtensionPolicyForRegistration(policy, extension, "services.register", "registerService", undefined, {
        service: "item_store_read",
      }),
    ).toEqual({
      allowed: false,
      warning:
        "extension_policy_blocked_registration:project:sandboxed:reason=service_blocked:method=registerservice:service=item_store_read:surface=services.register",
    });
    expect(
      evaluateExtensionPolicyForRegistration(policy, extension, "services.register", "registerService", undefined, {
        service: " ",
      }),
    ).toEqual({
      allowed: true,
      warning: null,
    });
  });

  it("serializes minimal policy overrides and ignores blank command names", () => {
    const settings = structuredClone(SETTINGS_DEFAULTS);
    settings.extensions.policy = {
      ...settings.extensions.policy,
      mode: "warn",
      trust_mode: "off",
      extension_overrides: [
        {
          name: "alpha",
          allowed_commands: ["deploy"],
          blocked_commands: ["sync"],
        },
        {
          name: " ",
          allowed_commands: ["ignored"],
        },
      ],
    };
    const policy = normalizeExtensionPolicy(settings);
    expect(serializeExtensionPolicy(policy).extension_overrides).toEqual([
      {
        name: "alpha",
        allowed_commands: ["deploy"],
        blocked_commands: ["sync"],
      },
    ]);
    expect(
      evaluateExtensionPolicyForRegistration(policy, { layer: "project", name: "alpha" }, "commands.handler", "registerCommand", "commands", {
        command: " ",
      }),
    ).toEqual({ allowed: true, warning: null });
    expect(
      evaluateExtensionPolicyForRegistration(policy, { layer: "project", name: "alpha" }, "commands.handler", "registerCommand", "commands", {
        command: "sync",
      }),
    ).toEqual({
      allowed: true,
      warning:
        "extension_policy_violation_registration:project:alpha:reason=command_blocked:capability=commands:command=sync:method=registercommand:surface=commands.handler",
    });
  });
});

describe("item type registry runtime resolution", () => {
  it("canonicalizes command options and derives fallback flag labels", () => {
    expect(canonicalizeCommandOptionKey("create", "--acceptance-criteria")).toBe("acceptanceCriteria");
    expect(canonicalizeCommandOptionKey("update", "allow_audit_update")).toBe("allowAuditUpdate");
    expect(canonicalizeCommandOptionKey("update", "  ")).toBeUndefined();
    expect(canonicalizeCommandOptionKey("create", "--type-option")).toBe("typeOption");
    expect(canonicalizeCommandOptionKey("update", "--add-type-option")).toBeUndefined();
    expect(commandOptionFlagLabel("create", "unknownCamelCase")).toBe("--unknown-camel-case");
    expect(commandOptionFlagLabel("update", "unknownCamelCase")).toBe("--unknown-camel-case");
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
          folder: " ",
          aliases: ["Review-Board", 7] as never,
          required_create_fields: ["title", 1] as never,
          required_create_repeatables: ["file", false] as never,
          options: [{ key: "cadence", values: ["weekly"], aliases: ["freq"], required: true }],
          command_option_policies: [
            { command: "create", option: "estimate", required: true },
            { command: "delete" as never, option: "ignored", required: true },
            "bad-policy" as never,
            { command: "update", option: 1 } as never,
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
      required_create_fields: ["title"],
      required_create_repeatables: ["file"],
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
    expect(
      resolveCommandOptionPolicyState(
        {
          ...registry.by_type.Asset,
          command_option_policies: [
            { command: "create", option: "title", required: true, visible: false, enabled: false },
            { command: "create", option: "title", required: false, visible: true, enabled: true },
          ],
        },
        "create",
        ["description"],
      ),
    ).toEqual({
      required: ["description"],
      hidden: [],
      disabled: [],
      errors: [],
    });
    expect(
      resolveCommandOptionPolicyState(
        {
          ...registry.by_type.Asset,
          command_option_policies: [
            { command: "create", option: "acceptance-criteria", visible: false, enabled: false },
            { command: "create", option: "acceptance-criteria", visible: true, enabled: true },
          ],
        },
        "create",
        [],
      ),
    ).toEqual({
      required: [],
      hidden: [],
      disabled: [],
      errors: [],
    });
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

  it("covers invalid type-definition coercion and command-policy sorting branches", () => {
    const settings = structuredClone(SETTINGS_DEFAULTS);
    settings.item_types.definitions = [
      { name: " " } as never,
      {
        name: "!!!",
        command_option_policies: [
          { command: "create", option: "status", visible: false, enabled: false },
          { command: "create", option: "acceptanceCriteria", visible: false, enabled: false },
        ],
      },
      { name: "Goals" },
    ];
    const registrations = createEmptyExtensionRegistrationRegistry();
    registrations.item_types.push({
      layer: "project",
      name: "coerce-invalid-options",
      types: [
        { name: 42 } as never,
        {
          name: "Coerced",
          required_create_fields: ["title"],
          required_create_repeatables: ["file"],
          default_status: "in_progress",
          description: "coerced extension type",
          options: [
            null,
            { values: ["missing-key"] },
            { key: "tier", description: "Tier option" },
            { key: "region", values: ["us-east-1"] },
          ] as never,
          command_option_policies: [
            { command: "create", option: "title", required: true, visible: true, enabled: false },
            { command: "update", option: "status", required: false, visible: false, enabled: true },
            { command: "update", option: "allow-audit-update" },
          ],
        } as never,
      ],
    });
    registrations.item_types.push({
      layer: "project",
      name: "non-array-types",
      types: "invalid" as never,
    });

    const registry = resolveItemTypeRegistry(settings, registrations);
    const symbolType = resolveTypeDefinition("!!!", registry);
    expect(symbolType?.folder).toBe("items");
    expect(resolveTypeDefinition("Goals", registry)?.folder).toBe("goals");

    const coercionType = resolveTypeDefinition("Coerced", registry);
    expect(coercionType?.options.map((option) => option.key)).toEqual(["region", "tier"]);

    const policyState = resolveCommandOptionPolicyState(symbolType!, "create", []);
    expect(policyState.hidden).toEqual(["acceptanceCriteria", "status"]);
    expect(policyState.disabled).toEqual(["acceptanceCriteria", "status"]);

    const invalidPolicyState = resolveCommandOptionPolicyState(
      {
        ...symbolType!,
        command_option_policies: [{ command: "create", option: "invalid-option", required: true }],
      },
      "create",
      [],
    );
    expect(invalidPolicyState.errors).toContain(
      'Unsupported command_option_policies option "invalid-option" for command "create" on type "!!!"',
    );
  });

  it("covers nullish registry/type-option fallbacks and policy enabled toggles", () => {
    const settingsWithoutTypes = {
      ...structuredClone(SETTINGS_DEFAULTS),
      item_types: undefined,
    } as unknown as typeof SETTINGS_DEFAULTS;
    const registry = resolveItemTypeRegistry(settingsWithoutTypes);
    expect(resolveTypeDefinition("Task", registry)?.name).toBe("Task");

    const toggledPolicy = resolveCommandOptionPolicyState(
      {
        name: "Task",
        folder: "tasks",
        aliases: [],
        required_create_fields: [],
        required_create_repeatables: [],
        options: [{ key: "tier", values: ["gold"], required: false }],
        command_option_policies: [
          { command: "create", option: "typeOption", enabled: undefined },
          { command: "create", option: "typeOption", enabled: true },
          { command: "create", option: "typeOption", enabled: false },
        ],
      },
      "create",
      [],
    );
    expect(toggledPolicy.disabled).toEqual(["typeOption"]);

    expect(
      validateTypeOptions(
        "Task",
        undefined,
        {
          ...registry,
          by_type: {
            ...registry.by_type,
            Task: {
              ...registry.by_type.Task,
              options: [{ key: "priority", values: [] }],
            },
          },
        },
      ),
    ).toEqual({ normalized: undefined, errors: [] });

    const builtinOverrideSettings = structuredClone(SETTINGS_DEFAULTS);
    builtinOverrideSettings.item_types.definitions = [{ name: "Task", aliases: ["task-alias"] }];
    const overridden = resolveItemTypeRegistry(builtinOverrideSettings);
    expect(overridden.by_type.Task.required_create_fields).toEqual(DEFAULT_REQUIRED_CREATE_FIELDS);
    expect(overridden.by_type.Task.required_create_repeatables).toEqual(DEFAULT_REQUIRED_CREATE_REPEATABLES);
  });
});
