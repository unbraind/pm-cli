import { describe, expect, it } from "vitest";

import {
  evaluateAssuranceGate,
  getAssuranceDeclaration,
  listAssuranceDeclarations,
  putAssuranceDeclarationBundle,
  type AssuranceDocument,
  type AssuranceEvaluationContext,
} from "../../../src/sdk/governance/assurance.js";
import {
  ASSURANCE_PRESET_IDS,
  acceptAssuranceProposals,
  applyAssurancePreset,
  createAssurancePreset,
  deriveAssuranceProposals,
  promoteAssuranceAssertion,
} from "../../../src/sdk/governance/assurance-presets.js";
import { runAssuranceAction } from "../../../src/sdk/governance/assurance-action.js";
import { createAssuranceWorkspaceContext } from "../../../src/sdk/governance/assurance-runtime.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("assurance presets and self-derivation", () => {
  it("ships four readable ordinary declaration bundles", () => {
    expect(ASSURANCE_PRESET_IDS).toEqual([
      "software-delivery",
      "research",
      "agent-evaluation",
      "operations",
    ]);
    for (const id of ASSURANCE_PRESET_IDS) {
      const preset = createAssurancePreset(id, "pm-owner");
      expect(preset.id).toBe(id);
      expect(preset.declarations.measurements).toHaveLength(2);
      expect(preset.declarations.assertions).toHaveLength(2);
      expect(preset.declarations.gates).toHaveLength(1);
      expect(preset.declarations.assertions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            owner_item_id: "pm-owner",
            scope: { kind: "active" },
            enforcement: "warn",
          }),
        ]),
      );
    }
  });

  it("applies presets atomically, idempotently, and refuses divergent ids", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const first = await applyAssurancePreset(
        pmPath,
        "software-delivery",
        "pm-owner",
      );
      expect(first.changed).toBe(true);
      expect(first.created_ids).toHaveLength(5);
      const second = await applyAssurancePreset(
        pmPath,
        "software-delivery",
        "pm-owner",
      );
      expect(second).toMatchObject({ changed: false });
      expect(second.unchanged_ids).toHaveLength(5);
      await expect(
        applyAssurancePreset(pmPath, "software-delivery", "pm-other"),
      ).rejects.toThrow("refuses to replace divergent assertion");
      expect(
        (await listAssuranceDeclarations(pmPath, "measurement")).count,
      ).toBe(2);
    });
  });

  it("derives active-scope observe ceilings, persists only explicitly, and promotes one step", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const fixture = await createAssuranceWorkspaceContext(pmPath, {
        resolve_tree: false,
      });
      const proposals = await deriveAssuranceProposals(fixture, "pm-owner");
      expect(proposals).toHaveLength(3);
      expect(proposals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            population_size: 0,
            scope: { kind: "active" },
            observed: 0,
          }),
        ]),
      );
      expect(
        (await listAssuranceDeclarations(pmPath, "measurement")).count,
      ).toBe(0);

      const accepted = await acceptAssuranceProposals(pmPath, proposals);
      expect(accepted.created_ids).toHaveLength(9);
      const definition = await getAssuranceDeclaration(
        pmPath,
        "assertion",
        "derived-active-missing-tests-ceiling",
      );
      const warned = await promoteAssuranceAssertion(
        pmPath,
        definition as never,
        "warn",
      );
      expect(warned.changed).toBe(true);
      const warningDefinition = await getAssuranceDeclaration(
        pmPath,
        "assertion",
        definition.id,
      );
      await expect(
        promoteAssuranceAssertion(pmPath, warningDefinition as never, "warn"),
      ).rejects.toThrow("warn -> block");
      await expect(
        promoteAssuranceAssertion(pmPath, definition as never, "block"),
      ).rejects.toThrow("observe -> warn");
      await promoteAssuranceAssertion(
        pmPath,
        warningDefinition as never,
        "block",
      );
      const blockingDefinition = await getAssuranceDeclaration(
        pmPath,
        "assertion",
        definition.id,
      );
      await expect(
        promoteAssuranceAssertion(pmPath, blockingDefinition as never, "block"),
      ).rejects.toThrow("block -> block");
    });
  });

  it("derives against active items and excludes default terminal statuses", async () => {
    const proposals = await deriveAssuranceProposals(
      {
        tree_id: "tree",
        items: [
          {
            id: "pm-active",
            status: "open",
            type: "Task",
            tags: [],
            links: { files: [], tests: [], docs: [] },
          },
          {
            id: "pm-closed",
            status: "closed",
            type: "Task",
            tags: [],
            links: { files: [], tests: [], docs: [] },
          },
        ],
        history: [],
        external: async () => ({ value: 0, population_size: 0, cost: 0 }),
      },
      "pm-owner",
    );
    expect(proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ population_size: 1, observed: 1 }),
      ]),
    );
  });

  it("exposes preset, derive/apply, and promotion through one action transport", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      const list = await runAssuranceAction({ action: "presets" }, global);
      expect(list).toMatchObject({ count: 4 });
      await expect(
        runAssuranceAction(
          { action: "presets", preset: "software-delivery" },
          global,
        ),
      ).rejects.toThrow("require --owner");
      await expect(
        runAssuranceAction(
          { action: "apply", preset: "unknown", owner: "pm-owner" },
          global,
        ),
      ).rejects.toThrow("preset is required");
      expect(
        await runAssuranceAction(
          {
            action: "presets",
            preset: "research",
            owner: "pm-owner",
          },
          global,
        ),
      ).toMatchObject({ id: "research" });
      expect(
        await runAssuranceAction(
          {
            action: "presets",
            id: "agent-evaluation",
            owner: "pm-owner",
          },
          global,
        ),
      ).toMatchObject({ id: "agent-evaluation" });
      expect(
        await runAssuranceAction(
          {
            action: "apply",
            preset: "operations",
            owner: "pm-owner",
          },
          global,
        ),
      ).toMatchObject({ changed: true });
      expect(
        await runAssuranceAction(
          {
            action: "apply",
            id: "software-delivery",
            owner: "pm-owner",
          },
          global,
        ),
      ).toMatchObject({ changed: true });
      await expect(
        runAssuranceAction({ action: "derive" }, global),
      ).rejects.toThrow("require --owner");
      const derived = await runAssuranceAction(
        { action: "derive", owner: "pm-owner", apply: true },
        global,
      );
      expect(derived).toMatchObject({ count: 3, applied: { changed: true } });
      expect(
        await runAssuranceAction(
          { action: "derive", owner: "pm-owner" },
          global,
        ),
      ).not.toHaveProperty("applied");
      await expect(
        runAssuranceAction({ action: "promote" }, global),
      ).rejects.toThrow("assertion id");
      await expect(
        runAssuranceAction(
          {
            action: "promote",
            id: "derived-active-missing-files-ceiling",
            enforcement: "observe",
          },
          global,
        ),
      ).rejects.toThrow("warn|block");
      expect(
        await runAssuranceAction(
          {
            action: "promote",
            id: "derived-active-missing-files-ceiling",
            enforcement: "warn",
          },
          global,
        ),
      ).toMatchObject({ changed: true });
    });
  });

  it("enforces provider allow, trigger, cost, network, and capability policies", async () => {
    const measurement = {
      id: "metric",
      source: { kind: "provider" as const, provider: "quality", key: "score" },
    };
    const assertion = {
      id: "metric-floor",
      measurement_id: measurement.id,
      owner_item_id: "pm-owner",
      scope: { kind: "all" as const },
      floor: 90,
      enforcement: "block" as const,
      negative_control: {
        cases: [
          { observed: 90, expected: "pass" as const },
          { observed: 89, expected: "fail" as const },
        ],
      },
    };
    const gate = {
      id: "quality",
      assertion_ids: [assertion.id],
      triggers: ["ci" as const],
      provider_policy: {
        allowed_providers: ["quality"],
        triggers: {
          ci: { max_cost_class: "low" as const, allow_network: false },
        },
      },
    };
    const document: AssuranceDocument = {
      version: 1,
      measurements: [measurement],
      assertions: [assertion],
      gates: [gate],
    };
    const context: AssuranceEvaluationContext = {
      tree_id: "tree",
      items: [],
      history: [],
      provider_capabilities: { quality: { cost_class: "low", network: false } },
      external: async () => ({ value: 95, population_size: 1, cost: 1 }),
    };
    await expect(
      evaluateAssuranceGate("quality", document, context, {
        trigger: "ci",
        dry_run: true,
      }),
    ).resolves.toMatchObject({ verdict: "pass" });

    const failureCases: Array<
      [AssuranceDocument, AssuranceEvaluationContext, string]
    > = [
      [
        { ...document, gates: [{ ...gate, provider_policy: undefined }] },
        context,
        "without an explicit provider policy",
      ],
      [
        {
          ...document,
          gates: [
            {
              ...gate,
              provider_policy: { ...gate.provider_policy, triggers: {} },
            },
          ],
        },
        context,
        "without an explicit provider policy",
      ],
      [
        {
          ...document,
          gates: [
            {
              ...gate,
              provider_policy: {
                ...gate.provider_policy,
                allowed_providers: [],
              },
            },
          ],
        },
        context,
        "refuses provider quality",
      ],
      [
        document,
        { ...context, provider_capabilities: {} },
        "no declared capabilities",
      ],
      [
        document,
        {
          ...context,
          provider_capabilities: {
            quality: { cost_class: "high", network: false },
          },
        },
        "high-cost provider",
      ],
      [
        document,
        {
          ...context,
          provider_capabilities: {
            quality: { cost_class: "low", network: true },
          },
        },
        "network provider",
      ],
    ];
    for (const [candidate, candidateContext, message] of failureCases) {
      await expect(
        evaluateAssuranceGate("quality", candidate, candidateContext, {
          trigger: "ci",
          dry_run: true,
        }),
      ).rejects.toThrow(message);
    }

    const unrelated: AssuranceDocument = {
      ...document,
      measurements: [{ id: "items", source: { kind: "items" } }, measurement],
      assertions: [
        {
          ...assertion,
          id: "items-floor",
          measurement_id: "items",
          floor: 0,
          negative_control: {
            cases: [
              { observed: 0, expected: "pass" },
              { observed: -1, expected: "fail" },
            ],
          },
        },
      ],
      gates: [
        {
          id: "items",
          assertion_ids: ["items-floor"],
          triggers: ["ci"],
        },
      ],
    };
    await expect(
      evaluateAssuranceGate("items", unrelated, context, {
        trigger: "ci",
        dry_run: true,
      }),
    ).resolves.toMatchObject({ verdict: "pass" });
  });

  it("validates gate provider policy and atomic bundle references", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const invalidPolicy = createAssurancePreset(
        "operations",
        "pm-owner",
      ).declarations;
      invalidPolicy.gates[0] = {
        ...invalidPolicy.gates[0],
        provider_policy: {
          allowed_providers: ["Bad Id"],
          triggers: {},
        },
      };
      await expect(
        putAssuranceDeclarationBundle(pmPath, invalidPolicy),
      ).rejects.toThrow("stable lowercase id");
      const validGate = createAssurancePreset("operations", "pm-owner")
        .declarations.gates[0];
      const invalidProviderPolicies: Array<[unknown, string]> = [
        [
          { allowed_providers: null, triggers: {} },
          "allowed_providers must be an array",
        ],
        [{ allowed_providers: [], triggers: [] }, "triggers must be an object"],
        [
          {
            allowed_providers: [],
            triggers: {
              manual: { max_cost_class: "low", allow_network: false },
            },
          },
          "unknown trigger manual",
        ],
        [
          { allowed_providers: [], triggers: { ci: null } },
          "trigger ci is invalid",
        ],
      ];
      for (const [providerPolicy, message] of invalidProviderPolicies) {
        await expect(
          putAssuranceDeclarationBundle(pmPath, {
            measurements: [],
            assertions: [],
            gates: [
              {
                ...validGate,
                assertion_ids: ["missing"],
                provider_policy: providerPolicy as never,
              },
            ],
          }),
        ).rejects.toThrow(message);
      }
      await expect(
        putAssuranceDeclarationBundle(pmPath, {
          measurements: [],
          assertions: [],
          gates: [
            { id: "orphan", assertion_ids: ["missing"], triggers: ["ci"] },
          ],
        }),
      ).rejects.toThrow("missing assertions");
    });
  });

  it("discovers providers referenced through derived measurements", async () => {
    const document: AssuranceDocument = {
      version: 1,
      measurements: [
        {
          id: "raw-score",
          source: { kind: "provider", provider: "quality", key: "score" },
        },
        {
          id: "derived-score",
          source: {
            kind: "derived",
            expression: {
              operator: "add",
              operands: [
                { measurement: "raw-score" },
                { measurement: "raw-score" },
              ],
            },
          },
        },
      ],
      assertions: [
        {
          id: "score-floor",
          measurement_id: "derived-score",
          owner_item_id: "pm-owner",
          scope: { kind: "all" },
          floor: 90,
          enforcement: "block",
          negative_control: {
            cases: [
              { observed: 90, expected: "pass" },
              { observed: 89, expected: "fail" },
            ],
          },
        },
      ],
      gates: [
        {
          id: "derived-quality",
          assertion_ids: ["score-floor"],
          triggers: ["ci"],
          provider_policy: {
            allowed_providers: ["quality"],
            triggers: {
              ci: { max_cost_class: "low", allow_network: false },
            },
          },
        },
      ],
    };
    await expect(
      evaluateAssuranceGate(
        "derived-quality",
        document,
        {
          tree_id: "tree",
          items: [],
          history: [],
          provider_capabilities: {
            quality: { cost_class: "low", network: false },
          },
          external: async () => ({
            value: 95,
            population_size: 1,
            cost: 1,
          }),
        },
        { trigger: "ci", dry_run: true },
      ),
    ).resolves.toMatchObject({ verdict: "pass" });
  });
});
