import { describe, expect, it } from "vitest";

import {
  activateExtensions,
  createDefaultExtensionGovernancePolicy,
  type AssuranceMeasurementProviderDefinition,
  type ExtensionLoadResult,
} from "../../../src/core/extensions/loader.js";
import { describeExtensionActivation } from "../../../src/core/extensions/activation-summary.js";
import { collectUsedExtensionCapabilities } from "../../../src/core/extensions/capability-usage.js";
import {
  getActiveExtensionRegistrations,
  setActiveExtensionRegistrations,
} from "../../../src/core/extensions/index.js";
import { resolveRegisteredAssuranceMeasurementProvider } from "../../../src/core/extensions/runtime-registrations.js";
import { createAssuranceWorkspaceContext } from "../../../src/sdk/governance/assurance-runtime.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

function provider(
  overrides: Partial<AssuranceMeasurementProviderDefinition> = {},
): AssuranceMeasurementProviderDefinition {
  return {
    id: "quality",
    keys: {
      coverage: {
        value_type: "number",
        description: "Line coverage percentage.",
        parameters: {
          target: { type: "string", required: true, description: "Target." },
        },
      },
      labels: { value_type: "string_set" },
    },
    cost_class: "low",
    network: false,
    timeout_ms: 100,
    resolve: ({ key }) => ({
      value: key === "labels" ? ["lines", "branches"] : 100,
      population_size: 1,
      cost: 1,
    }),
    ...overrides,
  };
}

function loadResult(
  definition: unknown,
  options: {
    permissions?: { network?: boolean };
    policy?: ReturnType<typeof createDefaultExtensionGovernancePolicy>;
  } = {},
): ExtensionLoadResult {
  return {
    disabled_by_flag: false,
    roots: { global: "", project: "" },
    configured_enabled: [],
    configured_disabled: [],
    discovered: [],
    effective: [],
    warnings: [],
    policy: options.policy ?? createDefaultExtensionGovernancePolicy(),
    failed: [],
    loaded: [
      {
        layer: "project",
        directory: "",
        manifest_path: "",
        name: "quality-extension",
        version: "1.0.0",
        entry: "index.ts",
        priority: 0,
        entry_path: "",
        capabilities: ["services"],
        permissions: options.permissions,
        module: {
          activate(api) {
            api.registerAssuranceMeasurementProvider(
              definition as AssuranceMeasurementProviderDefinition,
            );
          },
        },
      },
    ],
  };
}

describe("extension assurance measurement providers", () => {
  it("registers, inventories, summarizes, and resolves a local provider", async () => {
    const defaultTimeoutProvider = provider();
    delete defaultTimeoutProvider.timeout_ms;
    const activation = await activateExtensions(
      loadResult(defaultTimeoutProvider),
    );
    expect(activation.failed).toEqual([]);
    expect(activation.registration_counts).toMatchObject({
      assurance_providers: 1,
    });
    expect(describeExtensionActivation(activation)).toMatchObject({
      assurance_providers: ["quality"],
    });
    expect(collectUsedExtensionCapabilities(activation)).toContain("services");

    const legacyRegistrations = {
      ...activation.registrations,
    } as Partial<typeof activation.registrations>;
    delete legacyRegistrations.assurance_providers;
    const legacyActivation = {
      ...activation,
      registrations: legacyRegistrations as typeof activation.registrations,
    };
    expect(describeExtensionActivation(legacyActivation)).not.toHaveProperty(
      "assurance_providers",
    );
    expect(collectUsedExtensionCapabilities(legacyActivation)).not.toContain(
      "services",
    );
    expect(
      resolveRegisteredAssuranceMeasurementProvider(
        legacyRegistrations as typeof activation.registrations,
        "quality",
      ),
    ).toBeNull();

    const previous = getActiveExtensionRegistrations();
    setActiveExtensionRegistrations(activation.registrations);
    try {
      await withTempPmPath(async ({ pmPath }) => {
        const context = await createAssuranceWorkspaceContext(pmPath, {
          resolve_tree: false,
          trigger: "ci",
        });
        expect(context.provider_capabilities).toEqual({
          quality: { cost_class: "low", network: false },
        });
        await expect(
          context.external({
            kind: "provider",
            provider: "quality",
            key: "coverage",
            parameters: { target: "src" },
          }),
        ).resolves.toMatchObject({ value: 100, population_size: 1, cost: 1 });
        await expect(
          context.external({
            kind: "provider",
            provider: "quality",
            key: "labels",
          }),
        ).resolves.toMatchObject({ value: ["lines", "branches"] });
      });
    } finally {
      setActiveExtensionRegistrations(previous);
    }
  });

  it.each([
    [{ id: " " }, "non-empty string"],
    [{ id: "Bad Id" }, "stable lowercase id"],
    [{ cost_class: "huge" }, "cost_class"],
    [{ network: "yes" }, "network must be boolean"],
    [{ keys: {} }, "at least one key"],
    [{ keys: { "Bad Key": { value_type: "number" } } }, "stable lowercase id"],
    [{ keys: { metric: { value_type: "object" } } }, "value_type"],
    [
      { keys: { metric: { value_type: "number", description: 1 } } },
      "description",
    ],
    [
      { keys: { metric: { value_type: "number", parameters: [] } } },
      "requires an object",
    ],
    [
      {
        keys: {
          metric: {
            value_type: "number",
            parameters: { p: { type: "array" } },
          },
        },
      },
      "must be string",
    ],
    [
      {
        keys: {
          metric: {
            value_type: "number",
            parameters: { p: { type: "string", required: "yes" } },
          },
        },
      },
      "required",
    ],
    [
      {
        keys: {
          metric: {
            value_type: "number",
            parameters: { p: { type: "string", description: 1 } },
          },
        },
      },
      "description",
    ],
    [{ timeout_ms: 0 }, "timeout_ms"],
    [{ timeout_ms: 300_001 }, "timeout_ms"],
    [{ resolve: true }, "requires a function"],
  ])("rejects malformed provider definition %j", async (overrides, message) => {
    const activation = await activateExtensions(
      loadResult(
        provider(overrides as Partial<AssuranceMeasurementProviderDefinition>),
      ),
    );
    expect(activation.failed[0]?.error).toContain(message);
    expect(activation.registrations.assurance_providers).toEqual([]);
  });

  it("bounds parameter schemas and requires manifest network permission", async () => {
    const tooManyParameters = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [
        `p${index}`,
        { type: "string" as const },
      ]),
    );
    const oversized = await activateExtensions(
      loadResult(
        provider({
          keys: {
            metric: { value_type: "number", parameters: tooManyParameters },
          },
        }),
      ),
    );
    expect(oversized.failed[0]?.error).toContain("exceeds 50 parameters");

    const denied = await activateExtensions(
      loadResult(provider({ network: true })),
    );
    expect(denied.failed[0]?.error).toContain("permissions.network=true");
    const allowed = await activateExtensions(
      loadResult(provider({ network: true }), {
        permissions: { network: true },
      }),
    );
    expect(allowed.failed).toEqual([]);
    expect(
      allowed.registrations.assurance_providers[0]?.network_permission,
    ).toBe(true);
  });

  it("honors extension surface policy before registering", async () => {
    const policy = createDefaultExtensionGovernancePolicy();
    policy.mode = "enforce";
    policy.blocked_surfaces = ["services.assuranceprovider"];
    const activation = await activateExtensions(
      loadResult(provider(), { policy }),
    );
    expect(activation.registrations.assurance_providers).toEqual([]);
  });

  it("fails closed for provider key, parameter, result, and timeout violations", async () => {
    const cases: Array<{
      definition: AssuranceMeasurementProviderDefinition;
      source: {
        key: string;
        parameters?: Record<string, string | number | boolean | null>;
      };
      message: string;
    }> = [
      {
        definition: provider(),
        source: { key: "missing" },
        message: "does not declare key",
      },
      {
        definition: provider(),
        source: { key: "coverage" },
        message: "requires parameter target",
      },
      {
        definition: provider(),
        source: { key: "coverage", parameters: { extra: true, target: "src" } },
        message: "does not declare parameter extra",
      },
      {
        definition: provider(),
        source: { key: "coverage", parameters: { target: 1 } },
        message: "must be string",
      },
      {
        definition: provider({
          resolve: () => ({ value: ["wrong"], population_size: 1, cost: 1 }),
        }),
        source: { key: "coverage", parameters: { target: "src" } },
        message: "wrong value type",
      },
      {
        definition: provider({
          resolve: () => ({ value: 1, population_size: -1, cost: 1 }),
        }),
        source: { key: "coverage", parameters: { target: "src" } },
        message: "invalid population",
      },
      {
        definition: provider({
          resolve: () => ({ value: 1, population_size: 1.5, cost: 1 }),
        }),
        source: { key: "coverage", parameters: { target: "src" } },
        message: "invalid population",
      },
      {
        definition: provider({
          resolve: () => ({ value: 1, population_size: 1, cost: -1 }),
        }),
        source: { key: "coverage", parameters: { target: "src" } },
        message: "invalid population",
      },
      {
        definition: provider({
          timeout_ms: 1,
          resolve: () => new Promise(() => undefined),
        }),
        source: { key: "coverage", parameters: { target: "src" } },
        message: "timed out",
      },
    ];
    for (const testCase of cases) {
      const activation = await activateExtensions(
        loadResult(testCase.definition),
      );
      const previous = getActiveExtensionRegistrations();
      setActiveExtensionRegistrations(activation.registrations);
      try {
        await withTempPmPath(async ({ pmPath }) => {
          const context = await createAssuranceWorkspaceContext(pmPath, {
            resolve_tree: false,
          });
          await expect(
            context.external({
              kind: "provider",
              provider: "quality",
              ...testCase.source,
            }),
          ).rejects.toThrow(testCase.message);
        });
      } finally {
        setActiveExtensionRegistrations(previous);
      }
    }
  });

  it("absorbs a provider rejection that arrives after the host timeout", async () => {
    const activation = await activateExtensions(
      loadResult(
        provider({
          timeout_ms: 1,
          resolve: () =>
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error("late provider failure")), 5);
            }),
        }),
      ),
    );
    const previous = getActiveExtensionRegistrations();
    setActiveExtensionRegistrations(activation.registrations);
    try {
      await withTempPmPath(async ({ pmPath }) => {
        const context = await createAssuranceWorkspaceContext(pmPath, {
          resolve_tree: false,
        });
        await expect(
          context.external({
            kind: "provider",
            provider: "quality",
            key: "coverage",
            parameters: { target: "src" },
          }),
        ).rejects.toThrow("timed out");
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    } finally {
      setActiveExtensionRegistrations(previous);
    }
  });
});
