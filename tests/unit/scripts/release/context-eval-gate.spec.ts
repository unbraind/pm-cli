import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../../helpers/scriptModule";

const harness = createScriptHarness();

interface ContextEvalGateModule {
  buildContextEvaluationBaseline: (report: EvaluationReport, corpusVersion: number) => unknown;
  compareContextEvaluationBaseline: (report: EvaluationReport, baseline: Record<string, unknown>) => string[];
  mapScenarioDefinition: (definition: Record<string, unknown>, idByKey: Map<string, string>) => Record<string, unknown>;
  main: (argv?: string[]) => Promise<EvaluationReport>;
}

interface EvaluationReport {
  scenario_count: number;
  aggregate: Record<string, number>;
  scenarios: Array<{ id: string; metrics: Record<string, number | boolean> }>;
}

async function loadGate(): Promise<ContextEvalGateModule> {
  return harness.importModule<ContextEvalGateModule>("scripts/release/context-eval-gate.mjs");
}

describe("context evaluation gate", () => {
  it("maps reviewable corpus keys onto generated tracker ids", async () => {
    const gate = await loadGate();
    const mapped = gate.mapScenarioDefinition({
      id: "case",
      surface: "context",
      options: { parent_key: "parent" },
      judgments: { target: 3 },
      required_keys: ["target"],
      continuity_keys: ["parent"],
      token_budget: 100,
      rationale: "graded case",
    }, new Map([["parent", "pm-parent"], ["target", "pm-target"]]));

    expect(mapped).toMatchObject({
      options: { parent: "pm-parent" },
      judgments: { "pm-target": 3 },
      required_ids: ["pm-target"],
      continuity_ids: ["pm-parent"],
    });

    expect(gate.mapScenarioDefinition({
      id: "minimal",
      surface: "next",
      token_budget: 10,
      rationale: "defaults",
    }, new Map())).toMatchObject({ options: {}, required_ids: [], continuity_ids: [] });

    harness.mockProcessExit();
    expect(() => gate.mapScenarioDefinition({
      options: { parent_key: "missing" },
      judgments: {},
    }, new Map())).toThrow("EXIT:1");
    expect(() => gate.mapScenarioDefinition({
      judgments: { missing: 1 },
    }, new Map())).toThrow("EXIT:1");
  });

  it("builds a versioned baseline and detects metric or corpus regressions", async () => {
    const gate = await loadGate();
    const report: EvaluationReport = {
      scenario_count: 1,
      aggregate: { ndcg: 0.9, required_recall: 1 },
      scenarios: [{ id: "case", metrics: { ndcg: 0.9 } }],
    };
    const baseline = gate.buildContextEvaluationBaseline(report, 1) as Record<string, unknown>;
    expect(baseline).toMatchObject({ version: 1, corpus_version: 1, aggregate: report.aggregate });
    expect(gate.compareContextEvaluationBaseline(report, baseline)).toEqual([]);

    expect(gate.compareContextEvaluationBaseline(
      { ...report, scenario_count: 2, aggregate: { ndcg: 0.8, required_recall: 1 } },
      baseline,
    )).toEqual(["scenario_count:2!=1", "ndcg:0.8<baseline:0.9"]);
    expect(gate.compareContextEvaluationBaseline(report, {
      version: 2,
      aggregate: { removed_metric: 1 },
    })).toEqual([
      "baseline_version:2",
      "scenario_count:1!=0",
      "removed_metric:removed_from_report",
      "ndcg:missing_baseline",
      "required_recall:missing_baseline",
      "scenario:case:missing_baseline",
    ]);
    expect(gate.compareContextEvaluationBaseline(report, {
      version: 1,
      scenarios: report.scenarios,
    })).toEqual(["ndcg:missing_baseline", "required_recall:missing_baseline"]);

    const balancedReport: EvaluationReport = {
      scenario_count: 2,
      aggregate: { ndcg: 0.9 },
      scenarios: [
        { id: "regressed", metrics: { ndcg: 0.8, within_token_budget: false } },
        { id: "improved", metrics: { ndcg: 1 } },
      ],
    };
    expect(gate.compareContextEvaluationBaseline(balancedReport, {
      version: 1,
      aggregate: { ndcg: 0.9 },
      scenarios: [
        { id: "regressed", metrics: { ndcg: 0.9, within_token_budget: true } },
        { id: "improved", metrics: { ndcg: 0.9 } },
      ],
    })).toEqual([
      "scenario:regressed:ndcg:0.8<baseline:0.9",
      "scenario:regressed:within_token_budget:false<baseline:true",
    ]);
    expect(gate.compareContextEvaluationBaseline(
      { ...balancedReport, scenario_count: 1, scenarios: balancedReport.scenarios.slice(1) },
      {
        version: 1,
        aggregate: { ndcg: 0.9 },
        scenarios: balancedReport.scenarios,
      },
    )).toEqual([
      "scenario_count:1!=2",
      "scenario:regressed:missing_from_report",
    ]);
    expect(gate.compareContextEvaluationBaseline(
      { scenario_count: 1, aggregate: {}, scenarios: [{ id: "case", metrics: { within_token_budget: true } }] },
      { version: 1, aggregate: {}, scenarios: [{ id: "case", metrics: {} }] },
    )).toEqual(["scenario:case:within_token_budget:missing_baseline"]);
  });

  it("executes a real isolated SDK corpus and verifies its committed baseline", async () => {
    const root = await harness.createTempRoot("pm-context-eval-gate-");
    const corpusPath = path.join(root, "corpus.json");
    const baselinePath = path.join(root, "baseline.json");
    await writeFile(corpusPath, JSON.stringify({
      version: 1,
      thresholds: {
        ndcg: 0,
        reciprocal_rank: 0,
        required_recall: 0,
        continuity_coverage: 0,
        token_budget_adherence: 0,
      },
      scenarios: [{
        id: "real-sdk",
        surface: "context",
        options: { parent_key: "parent" },
        workspace: {
          items: [
            { key: "parent", title: "Parent", description: "Parent", type: "Feature", status: "open", priority: 1 },
            { key: "child", parent_key: "parent", title: "Child", description: "Child", type: "Task", status: "open", priority: 0 },
          ],
          generators: [{
            key_prefix: "generated-",
            title_prefix: "Generated",
            description: "Generated scale item",
            type: "Task",
            status: "open",
            priority: 2,
            count: 1,
          }],
        },
        judgments: { parent: 1, child: 3 },
        required_keys: ["child"],
        continuity_keys: ["parent"],
        token_budget: 10_000,
        rationale: "Exercise the real public SDK reader against an isolated tracker.",
      }],
    }));
    const gate = await loadGate();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.env.PM_AUTHOR = "original-author";

    const updated = await gate.main(["--corpus", corpusPath, "--baseline", baselinePath, "--update"]);
    expect(updated.scenario_count).toBe(1);
    expect(process.env.PM_AUTHOR).toBe("original-author");
    expect(JSON.parse(await readFile(baselinePath, "utf8"))).toMatchObject({ version: 1, corpus_version: 1 });
    await expect(gate.main(["--corpus", corpusPath, "--baseline", baselinePath])).resolves.toMatchObject({ passed: true });
  });

  it("uses the committed corpus and baseline when no path flags are supplied", async () => {
    const gate = await loadGate();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    delete process.env.PM_AUTHOR;
    await expect(gate.main()).resolves.toMatchObject({ scenario_count: 4, passed: true });
    expect(process.env.PM_AUTHOR).toBeUndefined();
  });

  it("fails closed for missing, malformed, unseedable, and regressed inputs", async () => {
    const root = await harness.createTempRoot("pm-context-eval-errors-");
    const corpusPath = path.join(root, "corpus.json");
    const baselinePath = path.join(root, "baseline.json");
    const gate = await loadGate();
    harness.mockProcessExit();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(gate.main(["--corpus", path.join(root, "missing.json")])).rejects.toThrow("EXIT:1");
    await writeFile(corpusPath, "[]");
    await expect(gate.main(["--corpus", corpusPath])).rejects.toThrow("EXIT:1");
    await writeFile(corpusPath, JSON.stringify({ version: 1, thresholds: {}, scenarios: [] }));
    await expect(gate.main(["--corpus", corpusPath])).rejects.toThrow("EXIT:1");

    const corpus = {
      version: 1,
      thresholds: {
        ndcg: 0,
        reciprocal_rank: 0,
        required_recall: 0,
        continuity_coverage: 0,
        token_budget_adherence: 0,
      },
      scenarios: [{
        id: "empty",
        surface: "next",
        workspace: {},
        judgments: {},
        token_budget: 10_000,
        rationale: "Empty workspace fallback",
      }],
    };
    await writeFile(corpusPath, JSON.stringify(corpus));
    await expect(gate.main(["--corpus", corpusPath, "--baseline", baselinePath])).rejects.toThrow("EXIT:1");
    await gate.main(["--corpus", corpusPath, "--baseline", baselinePath, "--update"]);
    const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as Record<string, unknown>;
    await writeFile(baselinePath, JSON.stringify({ version: 1, scenarios: {}, aggregate: {} }));
    await expect(gate.main(["--corpus", corpusPath, "--baseline", baselinePath])).rejects.toThrow("EXIT:1");
    await writeFile(baselinePath, JSON.stringify({ version: 1, scenarios: [], aggregate: [] }));
    await expect(gate.main(["--corpus", corpusPath, "--baseline", baselinePath])).rejects.toThrow("EXIT:1");
    await writeFile(baselinePath, JSON.stringify({ ...baseline, version: 2 }));
    await expect(gate.main(["--corpus", corpusPath, "--baseline", baselinePath])).rejects.toThrow("EXIT:1");

    const invalidWorkspaces: unknown[] = [
      null,
      { items: {} },
      { items: [null] },
      { items: [{ key: "" }] },
      { generators: {} },
      { generators: [null] },
      { generators: [{ key_prefix: "", count: 0 }] },
      { generators: [{ key_prefix: "generated-", count: -1 }] },
    ];
    for (const workspace of invalidWorkspaces) {
      await writeFile(corpusPath, JSON.stringify({
        ...corpus,
        scenarios: [{ ...corpus.scenarios[0], workspace }],
      }));
      await expect(gate.main(["--corpus", corpusPath, "--baseline", baselinePath])).rejects.toThrow("EXIT:1");
    }

    await writeFile(corpusPath, JSON.stringify({
      ...corpus,
      scenarios: [{
        ...corpus.scenarios[0],
        id: "bad-parent",
        workspace: {
          items: [{ key: "child", parent_key: "missing", title: "Child", description: "Child", type: "Task", status: "open", priority: 1 }],
        },
      }],
    }));
    await expect(gate.main(["--corpus", corpusPath, "--baseline", baselinePath])).rejects.toThrow("EXIT:1");
  });
});
