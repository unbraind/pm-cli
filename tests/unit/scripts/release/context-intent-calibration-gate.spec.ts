import { describe, expect, it, vi } from "vitest";
import {
  _testOnly,
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
  });

  it("measures both real calibration tiers and restores an absent usage setting", async () => {
    const previous = process.env.PM_CONTEXT_USAGE_DISABLED;
    delete process.env.PM_CONTEXT_USAGE_DISABLED;
    try {
      const report = await measureContextIntentCalibration();
      expect(report).toMatchObject({
        version: 1,
        metric: "utf8_bytes",
        tiers: [
          { item_count: 2 },
          {
            item_count: 2_243,
            cursor_walks: {
              list: { rows: expect.any(Number), pages: expect.any(Number) },
              search: { rows: expect.any(Number), pages: expect.any(Number) },
            },
          },
        ],
      });
      expect(process.env.PM_CONTEXT_USAGE_DISABLED).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PM_CONTEXT_USAGE_DISABLED;
      else process.env.PM_CONTEXT_USAGE_DISABLED = previous;
    }
  }, 120_000);

  it("restores an existing usage setting and exercises both main output modes", async () => {
    process.env.PM_CONTEXT_USAGE_DISABLED = "existing";
    const tier = vi.fn(async (itemCount: number) => ({ item_count: itemCount, intents: {} }));
    await expect(measureContextIntentCalibration(tier)).resolves.toMatchObject({
      tiers: [{ item_count: 2 }, { item_count: 2_243 }],
    });
    expect(process.env.PM_CONTEXT_USAGE_DISABLED).toBe("existing");
    delete process.env.PM_CONTEXT_USAGE_DISABLED;

    const report = { tiers: [{ item_count: 2 }, { item_count: 2_243 }] };
    const log = vi.fn();
    const writeReport = vi.fn(async () => {});
    await main([], { measure: async () => report, log });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("2 and 2243 items"));
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
      _testOnly.runCursorWalk("list", {}, {
        maxPages: 1,
        runPage: async () => ({ items: [{ id: "a" }], next_cursor: "next" }),
        runBaseline: async () => ({ items: [{ id: "a" }] }),
      }),
    ).rejects.toThrow("did not terminate");
    await expect(
      _testOnly.runCursorWalk("list", {}, {
        runPage: async () => ({ items: [{ id: "a" }], padding: "x".repeat(200) }),
        runBaseline: async () => ({ items: [{ id: "a" }] }),
      }),
    ).rejects.toThrow("exceeds unbounded");
    let page = 0;
    await expect(
      _testOnly.runCursorWalk("list", {}, {
        runPage: async () =>
          page++ === 0
            ? { items: [{ id: "a" }], next_cursor: "next" }
            : { items: [{ id: "b" }] },
        runBaseline: async () => ({
          items: [{ id: "a" }, { id: "b" }],
          padding: "x".repeat(500),
        }),
      }),
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

  it("normalizes Error and non-Error executable failures", async () => {
    const failWith = vi.fn();
    await runMain(async () => {
      throw new Error("error failure");
    }, failWith);
    await runMain(async () => {
      throw "string failure";
    }, failWith);
    expect(failWith.mock.calls).toEqual([["error failure"], ["string failure"]]);
  });

  it("executes the real top-level entrypoint", async () => {
    process.argv = [
      process.execPath,
      "/home/steve/GITHUB_RELEASE/pm-cli/scripts/release/context-intent-calibration-gate.mjs",
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
  }, 120_000);
});
