import { writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import {
  runAssuranceAction,
  runAssuranceDispatch,
} from "../../../src/sdk/governance/assurance-action.js";
import {
  AssuranceEvaluationRefusalError,
  normalizeAssuranceEvaluation,
  normalizeAssuranceMutation,
} from "../../../src/sdk/governance/assurance-mutation-error.js";
import { runClose } from "../../../src/sdk/lifecycle/close.js";
import { runCreate } from "../../../src/sdk/lifecycle/create.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const measurement = {
  id: "all-items",
  source: { kind: "items", statuses: ["open"] },
};
const assertion = {
  id: "all-items-floor",
  measurement_id: measurement.id,
  owner_item_id: "pm-owner",
  scope: { kind: "all" },
  floor: 0,
  enforcement: "block",
  negative_control: {
    cases: [
      { observed: 0, expected: "pass" },
      { observed: -1, expected: "fail" },
    ],
  },
};
const gate = {
  id: "delivery",
  assertion_ids: [assertion.id],
  triggers: ["ci"],
};

async function seedRegistry(pmPath: string): Promise<void> {
  const global = { path: pmPath };
  await runAssuranceAction(
    {
      action: "put",
      kind: "measurement",
      id: measurement.id,
      definition: measurement,
    },
    global,
  );
  await runAssuranceAction(
    {
      action: "put",
      kind: "assertion",
      id: assertion.id,
      definition: assertion,
    },
    global,
  );
  await runAssuranceAction(
    { action: "put", kind: "gate", id: gate.id, definition: gate },
    global,
  );
}

describe("assurance action transport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes validation errors for every host", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      await expect(
        runAssuranceAction({ action: "unknown" }, global),
      ).rejects.toThrow("Unknown assurance action");
      await expect(
        runAssuranceAction({ action: "list" }, global),
      ).rejects.toThrow("kind is required");
      await expect(
        runAssuranceAction(
          { action: "put", kind: "unknown", id: "x", definition: {} },
          global,
        ),
      ).rejects.toThrow("kind is required");
      await expect(
        runAssuranceAction(
          { action: "put", kind: "measurement", id: "x", definition: "{" },
          global,
        ),
      ).rejects.toThrow("valid JSON");
      vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
        throw "invalid";
      });
      await expect(
        runAssuranceAction(
          { action: "put", kind: "measurement", id: "x", definition: "{}" },
          global,
        ),
      ).rejects.toThrow("valid JSON");
      for (const definition of [undefined, [], "  "]) {
        await expect(
          runAssuranceAction(
            { action: "put", kind: "measurement", id: "x", definition },
            global,
          ),
        ).rejects.toThrow("JSON object");
      }
      await expect(
        runAssuranceAction(
          {
            action: "put",
            kind: "measurement",
            id: "different",
            definition: measurement,
          },
          global,
        ),
      ).rejects.toThrow("does not match requested id");
      await expect(runAssuranceDispatch({}, {}, global)).rejects.toThrow(
        "Unknown assurance action",
      );
      await expect(
        runAssuranceAction({ action: "show", kind: "gate" }, global),
      ).rejects.toThrow("requires an id");
      await expect(
        runAssuranceAction({ action: "run" }, global),
      ).rejects.toThrow("gate id");
      await expect(
        runAssuranceAction({ action: "run", id: gate.id }, global),
      ).rejects.toThrow("requires a trigger");
      await expect(
        runAssuranceAction(
          { action: "run", id: gate.id, trigger: "continuous" },
          global,
        ),
      ).rejects.toThrow("Unknown assurance trigger continuous");
      await expect(
        runAssuranceAction(
          { action: "verdicts", limit: "not-a-number" },
          global,
        ),
      ).rejects.toThrow("finite integer");
      await expect(
        runAssuranceAction({ action: "verdicts", limit: 0 }, global),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runAssuranceAction({ action: "verdicts", limit: 1001 }, global),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("types malformed, referenced, and unauthorized mutations as usage refusals", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      await seedRegistry(pmPath);
      await expect(
        runAssuranceAction(
          {
            action: "put",
            kind: "assertion",
            id: "malformed-floor",
            definition: {
              ...assertion,
              id: "malformed-floor",
              owner_item_id: undefined,
            },
          },
          global,
        ),
      ).rejects.toThrow("assertion.owner_item_id is required");
      const refusals = [
        () => runAssuranceAction(
          {
            action: "put",
            kind: "assertion",
            id: "malformed-floor",
            definition: {
              ...assertion,
              id: "malformed-floor",
              owner_item_id: undefined,
            },
          },
          global,
        ),
        () => runAssuranceAction(
          {
            action: "put",
            kind: "assertion",
            id: "numeric-retire-reason",
            definition: {
              ...assertion,
              id: "numeric-retire-reason",
              lifetime: "retire",
              retire_reason: 42,
            },
          },
          global,
        ),
        () => runAssuranceAction(
          { action: "remove", kind: "assertion", id: assertion.id },
          global,
        ),
        () => runAssuranceAction(
          {
            action: "put",
            kind: "assertion",
            id: assertion.id,
            definition: {
              ...assertion,
              floor: -1,
              negative_control: {
                cases: [
                  { observed: -1, expected: "pass" },
                  { observed: -2, expected: "fail" },
                ],
              },
            },
          },
          global,
        ),
      ];

      for (const refusal of refusals) {
        await expect(refusal()).rejects.toMatchObject({
          name: "PmCliError",
          exitCode: EXIT_CODE.USAGE,
          context: {
            code: "invalid_argument_value",
            reason: "assurance_mutation_refused",
          },
        });
      }
    });
  });

  it("preserves non-validation mutation failures without reclassification", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeFile(path.join(pmPath, "assurance.json"), "{");

      await expect(
        runAssuranceAction(
          { action: "remove", kind: "measurement", id: measurement.id },
          { path: pmPath },
        ),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
        context: { code: "assurance_registry_invalid" },
      });
    });
  });

  it("preserves unexpected TypeErrors outside the typed refusal boundary", async () => {
    const unexpected = new TypeError("unexpected internal fault");

    await expect(
      normalizeAssuranceMutation(() => Promise.reject(unexpected)),
    ).rejects.toBe(unexpected);
    await expect(
      normalizeAssuranceEvaluation(() => Promise.reject(unexpected)),
    ).rejects.toBe(unexpected);
  });

  it("types provider-policy evaluation refusals without hiding runtime faults", async () => {
    const refusal = new AssuranceEvaluationRefusalError(
      "assurance provider quality has no declared capabilities",
    );

    await expect(
      normalizeAssuranceEvaluation(() => Promise.reject(refusal)),
    ).rejects.toMatchObject({
      name: "PmCliError",
      exitCode: EXIT_CODE.USAGE,
      context: {
        code: "invalid_argument_value",
        reason: "assurance_evaluation_refused",
      },
    });

    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      await runAssuranceAction(
        {
          action: "put",
          kind: "measurement",
          id: "provider-score",
          definition: {
            id: "provider-score",
            source: { kind: "provider", provider: "quality", key: "score" },
          },
        },
        global,
      );
      await runAssuranceAction(
        {
          action: "put",
          kind: "assertion",
          id: "provider-score-floor",
          definition: {
            ...assertion,
            id: "provider-score-floor",
            measurement_id: "provider-score",
          },
        },
        global,
      );
      await runAssuranceAction(
        {
          action: "put",
          kind: "gate",
          id: "provider-quality",
          definition: {
            id: "provider-quality",
            assertion_ids: ["provider-score-floor"],
            triggers: ["ci"],
            provider_policy: {
              allowed_providers: ["quality"],
              triggers: {
                ci: { max_cost_class: "low", allow_network: false },
              },
            },
          },
        },
        global,
      );

      await expect(
        runAssuranceAction(
          {
            action: "run",
            id: "provider-quality",
            trigger: "pre-commit",
            dry_run: true,
          },
          global,
        ),
      ).rejects.toMatchObject({
        name: "PmCliError",
        exitCode: EXIT_CODE.USAGE,
        context: {
          code: "invalid_argument_value",
          reason: "assurance_evaluation_refused",
        },
      });

      await expect(
        runAssuranceAction(
          {
            action: "run",
            id: "provider-quality",
            trigger: "ci",
            dry_run: true,
          },
          global,
        ),
      ).rejects.toMatchObject({
        name: "PmCliError",
        exitCode: EXIT_CODE.USAGE,
        context: {
          code: "invalid_argument_value",
          reason: "assurance_evaluation_refused",
        },
      });
    });
  });

  it("runs host-provided measurements through the public action transport", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      await runAssuranceAction(
        {
          action: "put",
          kind: "measurement",
          id: "repository-quality",
          definition: {
            id: "repository-quality",
            source: {
              kind: "provider",
              provider: "quality-host",
              key: "static",
            },
          },
        },
        global,
      );
      await runAssuranceAction(
        {
          action: "put",
          kind: "assertion",
          id: "repository-quality-required",
          definition: {
            ...assertion,
            id: "repository-quality-required",
            measurement_id: "repository-quality",
            equals: 1,
            floor: undefined,
            negative_control: {
              cases: [
                { observed: 1, expected: "pass" },
                { observed: 0, expected: "fail" },
              ],
            },
          },
        },
        global,
      );
      await runAssuranceAction(
        {
          action: "put",
          kind: "gate",
          id: "repository-quality-gate",
          definition: {
            id: "repository-quality-gate",
            assertion_ids: ["repository-quality-required"],
            triggers: ["ci"],
            provider_policy: {
              allowed_providers: ["quality-host"],
              triggers: {
                ci: { max_cost_class: "high", allow_network: false },
              },
            },
          },
        },
        global,
      );
      const provider = vi.fn().mockResolvedValue({
        value: 1,
        population_size: 1,
        cost: 1,
        contributors: [],
      });

      await expect(
        runAssuranceAction(
          {
            action: "run",
            id: "repository-quality-gate",
            trigger: "ci",
            dry_run: true,
          },
          global,
          {
            workspace: {
              include_history: false,
              providers: { "quality-host": provider },
              provider_capabilities: {
                "quality-host": { cost_class: "high", network: false },
              },
            },
          },
        ),
      ).resolves.toMatchObject({ verdict: "pass" });
      expect(provider).toHaveBeenCalledWith({
        kind: "provider",
        provider: "quality-host",
        key: "static",
      });
    });
  });

  it("names the complete gate location when a declared source field cannot resolve", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      await runAssuranceAction(
        {
          action: "put",
          kind: "measurement",
          id: "missing-metadata-count",
          definition: {
            id: "missing-metadata-count",
            source: {
              kind: "validate",
              check: "metadata",
              field: "counts.not_declared",
            },
          },
        },
        global,
      );
      await runAssuranceAction(
        {
          action: "put",
          kind: "assertion",
          id: "missing-metadata-count-ceiling",
          definition: {
            id: "missing-metadata-count-ceiling",
            measurement_id: "missing-metadata-count",
            owner_item_id: "pm-owner",
            scope: { kind: "all" },
            ceiling: 0,
            enforcement: "block",
            negative_control: {
              cases: [
                { observed: 0, expected: "pass" },
                { observed: 1, expected: "fail" },
              ],
            },
          },
        },
        global,
      );
      await runAssuranceAction(
        {
          action: "put",
          kind: "gate",
          id: "metadata-completeness",
          definition: {
            id: "metadata-completeness",
            assertion_ids: ["missing-metadata-count-ceiling"],
            triggers: ["ci"],
          },
        },
        global,
      );

      await expect(
        runAssuranceAction(
          {
            action: "run",
            id: "metadata-completeness",
            trigger: "ci",
            dry_run: true,
          },
          global,
        ),
      ).rejects.toMatchObject({
        name: "PmCliError",
        exitCode: EXIT_CODE.USAGE,
        context: {
          code: "invalid_argument_value",
          reason: "assurance_evaluation_refused",
          gate_id: "metadata-completeness",
          assertion_id: "missing-metadata-count-ceiling",
          measurement_id: "missing-metadata-count",
          source_kind: "validate",
          check: "metadata",
          field: "counts.not_declared",
        },
      });
    });
  });

  it("keeps a zero close-reason population measurable through a blocking gate", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      await runAssuranceAction(
        {
          action: "put",
          kind: "measurement",
          id: "missing-close-reasons",
          definition: {
            id: "missing-close-reasons",
            source: {
              kind: "validate",
              check: "metadata",
              field: "counts.closed_missing_close_reason",
            },
          },
        },
        global,
      );
      await runAssuranceAction(
        {
          action: "put",
          kind: "assertion",
          id: "missing-close-reasons-ceiling",
          definition: {
            id: "missing-close-reasons-ceiling",
            measurement_id: "missing-close-reasons",
            owner_item_id: "pm-owner",
            scope: { kind: "all" },
            ceiling: 0,
            enforcement: "block",
            negative_control: {
              cases: [
                { observed: 0, expected: "pass" },
                { observed: 1, expected: "fail" },
              ],
            },
          },
        },
        global,
      );
      await runAssuranceAction(
        {
          action: "put",
          kind: "gate",
          id: "close-reason-completeness",
          definition: {
            id: "close-reason-completeness",
            assertion_ids: ["missing-close-reasons-ceiling"],
            triggers: ["ci"],
          },
        },
        global,
      );

      await expect(
        runAssuranceAction(
          {
            action: "run",
            id: "close-reason-completeness",
            trigger: "ci",
            dry_run: true,
          },
          global,
        ),
      ).resolves.toMatchObject({
        verdict: "pass",
        assertions: [
          expect.objectContaining({
            assertion_id: "missing-close-reasons-ceiling",
            observed: 0,
          }),
        ],
      });
    });
  });

  it("keeps CRUD and generic dispatch projections aligned", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      await expect(
        runAssuranceAction(
          {
            action: "put",
            kind: "measurement",
            id: measurement.id,
            definition: JSON.stringify(measurement),
            author: "transport-test",
            message: "Create measurement",
          },
          global,
        ),
      ).resolves.toMatchObject({ action: "created" });
      await expect(
        runAssuranceDispatch(
          { subcommand: "put", idOnly: true },
          {
            kind: "measurement",
            id: measurement.id,
            definition: measurement,
            fullChangedFields: true,
          },
          global,
        ),
      ).resolves.toEqual({ id: measurement.id });
      await expect(
        runAssuranceAction({ action: "list", kind: "measurement" }, global),
      ).resolves.toMatchObject({ count: 1, items: [measurement] });
      await expect(
        runAssuranceDispatch(
          { assuranceAction: "list", kind: "measurement" },
          {},
          global,
        ),
      ).resolves.toMatchObject({ count: 1 });
      await expect(
        runAssuranceDispatch(
          {},
          { operation: "list", kind: "measurement" },
          global,
        ),
      ).resolves.toMatchObject({ count: 1 });
      await expect(
        runAssuranceAction(
          { action: "show", kind: "measurement", id: measurement.id },
          global,
        ),
      ).resolves.toEqual(measurement);
    });
  });

  it("runs change-risk analysis through the shared action and generic transports", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const request = {
        policy: {
          version: 1,
          evidence_epoch: "2026-08-16T00:00:00.000Z",
          families: [
            {
              id: "assurance-transport",
              version: 1,
              title: "Assurance transport drift",
              owner_item_id: "pm-owner",
              escape_class: "review_caught_late",
              triggers: { file_patterns: ["src/sdk/governance/**"] },
              checks: {
                local: ["pnpm test -- assurance"],
                hosted: ["CI / test-shard"],
              },
              negative_control: {
                files: ["src/sdk/governance/assurance-action.ts"],
              },
              historical_item_ids: ["pm-owner"],
              budget: {
                max_escape_rate: 0,
                max_false_positive_rate: 0.05,
              },
            },
          ],
        },
        change: { files: ["src/sdk/governance/assurance-action.ts"] },
      };

      await expect(
        runAssuranceAction(
          { action: "risk", definition: JSON.stringify(request) },
          { path: pmPath },
        ),
      ).resolves.toMatchObject({
        risk_detected: true,
        total: 1,
        items: [{ family_id: "assurance-transport" }],
      });
      await expect(
        runAssuranceDispatch(
          { assuranceAction: "risk" },
          { definition: request },
          { path: pmPath },
        ),
      ).resolves.toMatchObject({ risk_detected: true, total: 1 });
      await expect(
        runAssuranceAction(
          { action: "risk", definition: "{" },
          { path: pmPath },
        ),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
        throw "non-error-json-failure";
      });
      await expect(
        runAssuranceAction(
          { action: "risk", definition: JSON.stringify(request) },
          { path: pmPath },
        ),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
        context: { reason: "invalid_json" },
      });
      await expect(
        runAssuranceAction(
          { action: "risk", definition: {} },
          { path: pmPath },
        ),
      ).rejects.toThrow("request.change must be an object");
      const throwingDefinition = new Proxy(
        {},
        {
          get() {
            throw "non-error-request-failure";
          },
        },
      );
      await expect(
        runAssuranceAction(
          { action: "risk", definition: throwingDefinition },
          { path: pmPath },
        ),
      ).rejects.toThrow("assurance risk request is invalid");
      const typedFailure = new PmCliError("typed request refusal", EXIT_CODE.USAGE);
      const typedThrowingDefinition = new Proxy(
        {},
        {
          get() {
            throw typedFailure;
          },
        },
      );
      await expect(
        runAssuranceAction(
          { action: "risk", definition: typedThrowingDefinition },
          { path: pmPath },
        ),
      ).rejects.toBe(typedFailure);
    });
  });

  it("evaluates dry and durable gates and bounds verdict output", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      await seedRegistry(pmPath);
      await expect(
        runAssuranceAction(
          { action: "run", id: gate.id, trigger: "ci", dry_run: true },
          global,
        ),
      ).resolves.toMatchObject({ dry_run: true, verdict: "pass" });
      await runAssuranceAction(
        { action: "run", id: gate.id, trigger: "ci", tree: "known-tree" },
        global,
      );
      await expect(
        runAssuranceDispatch(
          { subcommand: "verdicts", gate: gate.id, limit: 1 },
          {},
          global,
        ),
      ).resolves.toMatchObject({
        count: 1,
        items: [{ tree_id: "known-tree" }],
      });
    });
  });

  it("requires an explicit terminal Decision for assertion weakening", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      await seedRegistry(pmPath);
      const missingDecisionLoosening = {
        ...assertion,
        floor: -1,
        authorization_decision: "pm-missing",
        negative_control: {
          cases: [
            { observed: -1, expected: "pass" },
            { observed: -2, expected: "fail" },
          ],
        },
      };
      await expect(
        runAssuranceAction(
          {
            action: "put",
            kind: "assertion",
            id: assertion.id,
            definition: missingDecisionLoosening,
          },
          global,
        ),
      ).rejects.toThrow("terminal Decision item");
      const task = await runCreate(
        { title: "Not an authorization Decision", type: "Task" },
        { path: pmPath, json: true, quiet: true },
      );
      await runClose(
        task.item.id,
        "Terminal but not a Decision",
        { author: "transport-test" },
        global,
      );
      await expect(
        runAssuranceAction(
          {
            action: "put",
            kind: "assertion",
            id: assertion.id,
            definition: {
              ...missingDecisionLoosening,
              authorization_decision: task.item.id,
            },
          },
          global,
        ),
      ).rejects.toThrow("terminal Decision item");
      const created = await runCreate(
        { title: "Authorize assertion weakening", type: "Decision" },
        { path: pmPath, json: true, quiet: true },
      );
      const loosened = {
        ...assertion,
        floor: -1,
        authorization_decision: created.item.id,
        negative_control: {
          cases: [
            { observed: -1, expected: "pass" },
            { observed: -2, expected: "fail" },
          ],
        },
      };
      await expect(
        runAssuranceAction(
          {
            action: "put",
            kind: "assertion",
            id: assertion.id,
            definition: loosened,
          },
          global,
        ),
      ).rejects.toThrow("terminal Decision item");
      await runClose(
        created.item.id,
        "Approved assurance weakening",
        { author: "transport-test" },
        global,
      );
      await expect(
        runAssuranceAction(
          {
            action: "put",
            kind: "assertion",
            id: assertion.id,
            definition: loosened,
          },
          global,
        ),
      ).resolves.toMatchObject({ action: "updated" });
    });
  });

  it("removes declarations only after their dependants", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      await seedRegistry(pmPath);
      await runAssuranceAction(
        { action: "remove", kind: "gate", id: gate.id },
        global,
      );
      await runAssuranceAction(
        { action: "remove", kind: "assertion", id: assertion.id },
        global,
      );
      await expect(
        runAssuranceAction(
          {
            action: "remove",
            kind: "measurement",
            id: measurement.id,
            idOnly: true,
          },
          global,
        ),
      ).resolves.toEqual({ id: measurement.id });
    });
  });
});
