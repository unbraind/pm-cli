import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  _testOnly,
  assertCalibrationRecoveryScript,
  assertCalibrationWithinApprovedCeilings,
  main,
  measureContextIntentCalibration,
  repeatedContinuationMetadata,
  runMain,
  structuralEnforcementNegativeControl,
} from "../../../../scripts/release/context-intent-calibration-gate.mjs";
import { createScriptHarness } from "../../../helpers/scriptModule.js";

const harness = createScriptHarness();
const SCRIPT = "scripts/release/context-intent-calibration-gate.mjs";

describe("context intent calibration gate", () => {
  it("fails closed when the advertised calibration recovery script is missing or renamed", () => {
    expect(() =>
      assertCalibrationRecoveryScript({
        scripts: {
          "context:intent:calibrate":
            "node scripts/release/context-intent-calibration-gate.mjs",
        },
      }),
    ).not.toThrow();
    expect(() => assertCalibrationRecoveryScript({ scripts: {} })).toThrow(
      "must declare context:intent:calibrate",
    );
    expect(() =>
      assertCalibrationRecoveryScript({
        scripts: { "context:intent:calibrate": "node renamed.mjs" },
      }),
    ).toThrow("must declare context:intent:calibrate");
  });

  it("rejects a declared intent when its enforcement receipt is removed", () => {
    expect(
      structuralEnforcementNegativeControl("list", {
        items: [{ id: "pm-example" }],
        context_intent: {
          command: "list",
          declaration_feasible: true,
          result_omitted: false,
          within_budget: true,
          estimated_tokens: 80,
          token_budget: 3200,
        },
      }),
    ).toBe(true);
  });

  it("detects every invariant block if first-page metadata is reintroduced", () => {
    expect(
      repeatedContinuationMetadata({
        items: [{ id: "pm-example" }],
        next_cursor: "cursor",
        context_intent: {},
        filters: {},
        projection: {},
        row_contract: {},
      }),
    ).toEqual(["context_intent", "filters", "projection", "row_contract"]);
    expect(
      repeatedContinuationMetadata({
        items: [{ id: "pm-example" }],
        next_cursor: "cursor",
        continuation_contract: { metadata: "reference" },
      }),
    ).toEqual([]);
    expect(
      _testOnly.countIntentRows({
        ready: [{ id: "pm-ready" }],
        blocked: [{ id: "pm-blocked" }],
      }),
    ).toBe(2);
    expect(
      _testOnly.countIntentRows({
        row_contract: { row_keys: ["custom_rows"] },
        custom_rows: [{ id: "pm-custom" }],
      }),
    ).toBe(1);
  });

  it("restores an existing usage setting and exercises both main output modes", async () => {
    process.env.PM_CONTEXT_USAGE_DISABLED = "existing";
    const tier = vi.fn(async (itemCount: number) => ({
      item_count: itemCount,
      intents: {},
    }));
    await expect(measureContextIntentCalibration(tier)).resolves.toMatchObject({
      tiers: [{ item_count: 2 }, { item_count: 2_243 }],
    });
    expect(process.env.PM_CONTEXT_USAGE_DISABLED).toBe("existing");
    delete process.env.PM_CONTEXT_USAGE_DISABLED;

    const report = { tiers: [{ item_count: 2 }, { item_count: 2_243 }] };
    const log = vi.fn();
    const writeReport = vi.fn(async () => {});
    await main([], {
      measure: async () => report,
      readReport: async () => JSON.stringify(report),
      log,
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("2 and 2243 items"),
    );
    await expect(
      main([], {
        measure: async () => report,
        readReport: async () => JSON.stringify({ tiers: [] }),
        log,
      }),
    ).rejects.toThrow("calibration drifted");
    await expect(
      main([], {
        measure: async () => report,
        readReport: async () => JSON.stringify(report),
        assertReport: () => {
          throw "raw calibration drift";
        },
        log,
      }),
    ).rejects.toThrow("raw calibration drift");
    await main(["--update"], {
      measure: async () => report,
      reportPath: "/tmp/context-calibration.json",
      writeReport,
      log,
    });
    expect(writeReport).toHaveBeenCalledWith(
      "/tmp/context-calibration.json",
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Updated"));
  });

  it("enforces portable calibration contract and performance ceilings", () => {
    const approved = {
      version: 1,
      metric: "utf8_bytes",
      token_estimate: "ceil(bytes / 4)",
      structural_negative_control: "negative control",
      tiers: [
        {
          item_count: 2_243,
          intents: {
            list: {
              delivered_bytes: 8_000,
              declared_tokens: 3_200,
              measured_tokens: 2_000,
              degradation: "budget_row_compaction",
            },
          },
          session_orientation: {
            command_count: 5,
            token_budget: 20_000,
            spent_tokens: 5_000,
            remaining_tokens: 15_000,
            seen_item_count: 100,
            suppressed_repeat_count: 20,
            delivered_bytes: 20_000,
          },
          cursor_walks: {
            list: {
              rows: 1_998,
              pages: 30,
              bytes_per_row: 172,
              optimized_to_unbounded_ratio: 0.22,
            },
          },
        },
      ],
    };
    expect(() =>
      assertCalibrationWithinApprovedCeilings(
        structuredClone(approved),
        approved,
      ),
    ).not.toThrow();
    expect(() =>
      assertCalibrationWithinApprovedCeilings(null, null),
    ).not.toThrow();
    for (const [measuredSession, approvedSession] of [
      [undefined, approved.tiers[0].session_orientation],
      [approved.tiers[0].session_orientation, undefined],
    ]) {
      const measured = structuredClone(approved);
      const approvedCopy = structuredClone(approved);
      measured.tiers[0].session_orientation = measuredSession;
      approvedCopy.tiers[0].session_orientation = approvedSession;
      expect(() =>
        assertCalibrationWithinApprovedCeilings(measured, approvedCopy),
      ).toThrow("session orientation regressed");
    }
    for (const measured of [
      { ...structuredClone(approved), version: 2 },
      { ...structuredClone(approved), tiers: [] },
      { ...structuredClone(approved), tiers: [null] },
      {
        ...structuredClone(approved),
        tiers: [{ ...approved.tiers[0], item_count: 2 }],
      },
      {
        ...structuredClone(approved),
        tiers: [{ ...approved.tiers[0], intents: {} }],
      },
    ]) {
      expect(() =>
        assertCalibrationWithinApprovedCeilings(measured, approved),
      ).toThrow("calibration");
    }
    for (const intent of [
      { declared_tokens: 1_800 },
      { degradation: "receipt_only" },
      { measured_tokens: 3_201 },
      { delivered_bytes: 12_801 },
    ]) {
      const measured = structuredClone(approved);
      Object.assign(measured.tiers[0].intents.list, intent);
      expect(() =>
        assertCalibrationWithinApprovedCeilings(measured, approved),
      ).toThrow("intent ceiling regressed");
    }
    for (const session of [
      { command_count: 4 },
      { token_budget: 19_999 },
      { spent_tokens: 20_001, remaining_tokens: -1 },
      { spent_tokens: 5_001, remaining_tokens: 14_999 },
      { remaining_tokens: 14_999 },
      { seen_item_count: 99 },
      { suppressed_repeat_count: 0 },
      { suppressed_repeat_count: 19 },
      { delivered_bytes: 20_001 },
      { delivered_bytes: 23_001 },
    ]) {
      const measured = structuredClone(approved);
      Object.assign(measured.tiers[0].session_orientation, session);
      expect(() =>
        assertCalibrationWithinApprovedCeilings(measured, approved),
      ).toThrow("session orientation regressed");
    }
    const missingWalk = structuredClone(approved);
    missingWalk.tiers[0].cursor_walks = {};
    expect(() =>
      assertCalibrationWithinApprovedCeilings(missingWalk, approved),
    ).toThrow("cursor-walk shape changed");
    for (const walk of [
      { rows: 1_997 },
      { pages: 36 },
      { bytes_per_row: 198 },
      { optimized_to_unbounded_ratio: 0.254 },
    ]) {
      const measured = structuredClone(approved);
      Object.assign(measured.tiers[0].cursor_walks.list, walk);
      expect(() =>
        assertCalibrationWithinApprovedCeilings(measured, approved),
      ).toThrow("cursor efficiency regressed");
    }
  });

  it("rejects every malformed receipt condition while accepting a valid receipt", () => {
    const valid = {
      items: [{ id: "pm-example" }],
      context_intent: {
        command: "list",
        declaration_feasible: true,
        result_omitted: false,
        within_budget: true,
        estimated_tokens: 80,
        token_budget: 3_200,
      },
    };
    expect(_testOnly.intentReceiptViolation("list", valid)).toBeUndefined();
    for (const context_intent of [
      { ...valid.context_intent, command: "search" },
      { ...valid.context_intent, declaration_feasible: false },
      { ...valid.context_intent, result_omitted: true },
      { ...valid.context_intent, within_budget: false },
      { ...valid.context_intent, estimated_tokens: Number.NaN },
      { ...valid.context_intent, token_budget: Number.NaN },
      { ...valid.context_intent, estimated_tokens: 3_201 },
    ]) {
      expect(
        _testOnly.intentReceiptViolation("list", { ...valid, context_intent }),
      ).toContain("within-budget receipt");
    }
    expect(
      _testOnly.intentReceiptViolation("list", {
        ...valid,
        payload: "x".repeat(1_000),
        context_intent: { ...valid.context_intent, token_budget: 100 },
      }),
    ).toContain("within-budget receipt");
  });

  it("rejects malformed cursor pages, parity drift, and inefficient walks", async () => {
    expect(() =>
      _testOnly.validateCursorPage("list", { context_intent: {} }, true),
    ).toThrow("repeated invariant metadata");
    expect(() => _testOnly.validateCursorPage("list", {}, false)).toThrow(
      "omitted its result collection",
    );
    expect(() =>
      _testOnly.validateCursorPage(
        "list",
        { items: [], next_cursor: "cursor" },
        false,
      ),
    ).toThrow("omitted every result row");
    expect(() =>
      _testOnly.assertCursorRowParity("list", ["a"], ["a", "b"]),
    ).toThrow("duplicated, omitted, or reordered");
    expect(() =>
      _testOnly.assertCursorRowParity("list", ["a", "a"], ["a", "a"]),
    ).toThrow("duplicated, omitted, or reordered");
    expect(() =>
      _testOnly.assertCursorRowParity("list", ["b", "a"], ["a", "b"]),
    ).toThrow("duplicated, omitted, or reordered");
    expect(() =>
      _testOnly.assertCursorRowParity("list", ["a", "b"], ["a", "b"]),
    ).not.toThrow();

    await expect(
      _testOnly.runCursorWalk(
        "list",
        {},
        {
          maxPages: 1,
          runPage: async () => ({ items: [{ id: "a" }], next_cursor: "next" }),
          runBaseline: async () => ({ items: [{ id: "a" }] }),
        },
      ),
    ).rejects.toThrow("did not terminate");
    await expect(
      _testOnly.runCursorWalk(
        "list",
        {},
        {
          runPage: async () => ({
            items: [{ id: "a" }],
            padding: "x".repeat(200),
          }),
          runBaseline: async () => ({ items: [{ id: "a" }] }),
        },
      ),
    ).rejects.toThrow("exceeds unbounded");
    let page = 0;
    await expect(
      _testOnly.runCursorWalk(
        "list",
        {},
        {
          runPage: async () =>
            page++ === 0
              ? { items: [{ id: "a" }], next_cursor: "next" }
              : { items: [{ id: "b" }] },
          runBaseline: async () => ({
            items: [{ id: "a" }, { id: "b" }],
            padding: "x".repeat(500),
          }),
        },
      ),
    ).rejects.toThrow("negative control was not more expensive");
  });

  it("fails calibration tiers on receipt and structural-control regressions", async () => {
    const cleanupWorkspaceRoot = vi.fn();
    const baseDependencies = {
      createWorkspaceRoot: async () => "/tmp/context-calibration-tier",
      generateWorkspace: async () => ({
        pm_root: "/tmp/context-calibration-tier/.agents/pm",
        sample_ids: { get: "pm-example" },
      }),
      cleanupWorkspaceRoot,
      runSessionOrientationFn: async () => ({
        command_count: 5,
        token_budget: 20_000,
        spent_tokens: 1_000,
        remaining_tokens: 19_000,
        seen_item_count: 1,
        suppressed_repeat_count: 1,
        delivered_bytes: 4_000,
      }),
    };
    const validResult = (command: string) => ({
      context_intent: {
        command,
        declaration_feasible: true,
        result_omitted: false,
        within_budget: true,
        estimated_tokens: 10,
        token_budget: 3_200,
        degradation: "bounded_fields_and_rows",
      },
    });
    await expect(
      _testOnly.measureTier(2, {
        ...baseDependencies,
        runIntentFn: async (command: string) => validResult(command),
        negativeControl: () => true,
      }),
    ).resolves.toMatchObject({
      item_count: 2,
      intents: { context: { delivered_rows: 0 } },
    });
    await expect(
      _testOnly.measureTier(2, {
        ...baseDependencies,
        runIntentFn: async () => validResult("wrong-command"),
        negativeControl: () => true,
      }),
    ).rejects.toThrow("lacks a feasible within-budget receipt");
    await expect(
      _testOnly.measureTier(2, {
        ...baseDependencies,
        runIntentFn: async (command: string) => validResult(command),
        negativeControl: () => false,
      }),
    ).rejects.toThrow("negative control escaped detection");
    expect(cleanupWorkspaceRoot).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid cross-call orientation receipts and missing suppression", async () => {
    await expect(
      _testOnly.runSessionOrientation({}, {}, async () => ({})),
    ).rejects.toThrow("session orientation receipt drifted");

    for (const nextStateMutation of [
      { id: "changed-session" },
      { version: 2 },
      { token_budget: 19_999 },
    ]) {
      await expect(
        _testOnly.runSessionOrientation(
          {},
          {},
          async (
            _command: string,
            _manifest: unknown,
            _global: unknown,
            options: {
              outputSession: {
                id: string;
                version: number;
                token_budget: number;
                spent_tokens: number;
              };
            },
          ) => ({
            read_session: {
              id: options.outputSession.id,
              measurement_scope: "complete_read_envelope",
              spent_this_call_tokens: 1,
              charged_this_call_tokens: 1,
              spent_before_tokens: options.outputSession.spent_tokens,
              spent_total_tokens: options.outputSession.spent_tokens + 1,
              suppressed_repeat_count: 1,
              next_state: {
                ...options.outputSession,
                spent_tokens: options.outputSession.spent_tokens + 1,
                ...nextStateMutation,
              },
            },
          }),
        ),
      ).rejects.toThrow("session orientation receipt drifted");
    }

    await expect(
      _testOnly.runSessionOrientation(
        {},
        {},
        async (
          _command: string,
          _manifest: unknown,
          _global: unknown,
          options: { outputSession: { id: string; spent_tokens: number } },
        ) => ({
          read_session: {
            id: options.outputSession.id,
            measurement_scope: "complete_read_envelope",
            spent_this_call_tokens: 1,
            charged_this_call_tokens: 1,
            spent_before_tokens: options.outputSession.spent_tokens,
            spent_total_tokens: options.outputSession.spent_tokens + 1,
            suppressed_repeat_count: 1,
            next_state: {
              ...options.outputSession,
              spent_tokens: options.outputSession.spent_tokens + 1,
            },
          },
          read_output: { estimated_tokens: 0 },
        }),
      ),
    ).rejects.toThrow("complete session envelope estimate drifted");

    await expect(
      _testOnly.runSessionOrientation(
        {},
        {},
        async (
          _command: string,
          _manifest: unknown,
          _global: unknown,
          options: {
            outputSession: {
              id: string;
              spent_tokens: number;
              seen_item_ids: string[];
            };
          },
        ) => {
          const nextState = {
            ...options.outputSession,
            spent_tokens: options.outputSession.spent_tokens + 1,
          };
          const result = {
            read_session: {
              id: options.outputSession.id,
              measurement_scope: "complete_read_envelope",
              spent_this_call_tokens: 1,
              charged_this_call_tokens: 1,
              spent_before_tokens: options.outputSession.spent_tokens,
              spent_total_tokens: nextState.spent_tokens,
              suppressed_repeat_count: 0,
              next_state: nextState,
            },
            read_output: { estimated_tokens: 0 },
          };
          for (let iteration = 0; iteration < 8; iteration += 1) {
            const estimate = Math.ceil(
              Buffer.byteLength(JSON.stringify(result), "utf8") / 4,
            );
            if (estimate === result.read_output.estimated_tokens) break;
            result.read_output.estimated_tokens = estimate;
          }
          return result;
        },
      ),
    ).rejects.toThrow("did not suppress repeated item facts");
  });

  it("normalizes Error and non-Error executable failures", async () => {
    const failWith = vi.fn();
    await runMain(async () => {
      throw new Error("error failure");
    }, failWith);
    await runMain(async () => {
      throw "string failure";
    }, failWith);
    expect(failWith.mock.calls).toEqual([
      ["error failure"],
      ["string failure"],
    ]);
  });

  it("executes the real top-level entrypoint", async () => {
    const previous = process.env.PM_CONTEXT_USAGE_DISABLED;
    delete process.env.PM_CONTEXT_USAGE_DISABLED;
    process.argv = [
      process.execPath,
      fileURLToPath(
        new URL(
          "../../../../scripts/release/context-intent-calibration-gate.mjs",
          import.meta.url,
        ),
      ),
    ];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await harness.importModule(SCRIPT);
    await harness.waitForCondition(
      () =>
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining("Context intent calibration passed"),
        ),
      120_000,
    );
    expect(process.env.PM_CONTEXT_USAGE_DISABLED).toBeUndefined();
    if (previous !== undefined)
      process.env.PM_CONTEXT_USAGE_DISABLED = previous;
  }, 120_000);
});
