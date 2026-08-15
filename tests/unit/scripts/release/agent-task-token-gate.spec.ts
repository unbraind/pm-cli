import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareAgentTaskTokenBaseline,
  evaluateAgentTaskTokenReport,
  finalizeAgentTaskTokenReport,
  main,
  resolveAgentTaskTokenBaselinePath,
  validateAgentTaskTokenInvocation,
} from "../../../../scripts/release/agent-task-token-gate.mjs";
import { attachOutputTokenAccounting } from "../../../../src/sdk/output-token-accounting.js";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("agent-task token gate", () => {
  const report = {
    scenarios: [
      { id: "small", estimated_tokens: 10 },
      { id: "large", estimated_tokens: 20 },
    ],
  };
  const baseline = {
    version: 1,
    scenarios: [
      { id: "small", max_estimated_tokens: 10 },
      { id: "large", max_estimated_tokens: 20 },
    ],
  };

  it("accepts an exact per-task baseline and detects a seeded regression", () => {
    expect(compareAgentTaskTokenBaseline(report, baseline)).toEqual([]);
    expect(
      compareAgentTaskTokenBaseline(
        {
          scenarios: [
            { id: "small", estimated_tokens: 11 },
            report.scenarios[1],
          ],
        },
        baseline,
      ),
    ).toContain("scenario:small:11>baseline:10");
  });

  it("fails closed on baseline version, scenario, and count drift", () => {
    expect(
      compareAgentTaskTokenBaseline(
        { scenarios: [{ id: "new", estimated_tokens: 1 }] },
        { version: 2, scenarios: baseline.scenarios },
      ),
    ).toEqual([
      "baseline_version:2",
      "scenario:new:missing_baseline",
      "scenario_count:1!=2",
    ]);
    expect(() =>
      evaluateAgentTaskTokenReport(report, { ...baseline, version: 2 }),
    ).toThrow();
    expect(compareAgentTaskTokenBaseline(report, { version: 1 })).toEqual([
      "scenario:small:missing_baseline",
      "scenario:large:missing_baseline",
      "scenario_count:2!=0",
    ]);
    expect(resolveAgentTaskTokenBaselinePath(undefined)).toBe(
      resolveAgentTaskTokenBaselinePath(true),
    );
    expect(resolveAgentTaskTokenBaselinePath("relative-baseline.json")).toBe(
      path.resolve("relative-baseline.json"),
    );
    expect(() =>
      evaluateAgentTaskTokenReport(
        report,
        {
          version: 1,
          scenarios: baseline.scenarios.map((scenario) => ({
            ...scenario,
            max_estimated_tokens: 2_000_000,
          })),
        },
        true,
      ),
    ).toThrow();
  });

  it("rejects invalid transport accounting and incomplete task output", () => {
    const scenario = {
      id: "validation",
      args: ["list"],
      expectedStatus: 0,
      requiredFields: ["items"],
    };
    const payload = { items: [{ id: "pm-one" }] };
    const render = (value: unknown): string =>
      `${JSON.stringify(value, null, 2)}\n`;
    const accounted = attachOutputTokenAccounting(payload, render);
    const validBaseline = { status: 0, stdout: render(payload), stderr: "" };
    const validAccounted = { status: 0, stdout: render(accounted), stderr: "" };

    expect(
      validateAgentTaskTokenInvocation(validBaseline, validAccounted, scenario),
    ).toMatchObject({
      completeness: "required_fields_present",
    });
    expect(() =>
      validateAgentTaskTokenInvocation(
        { ...validBaseline, status: 1 },
        validAccounted,
        scenario,
      ),
    ).toThrow();
    for (const sections of [undefined, { invalid: null }]) {
      expect(() =>
        validateAgentTaskTokenInvocation(
          validBaseline,
          {
            ...validAccounted,
            stdout: render({
              ...accounted,
              token_accounting: { ...accounted.token_accounting, sections },
            }),
          },
          scenario,
        ),
      ).toThrow();
    }
    expect(() =>
      validateAgentTaskTokenInvocation(
        validBaseline,
        { ...validAccounted, stdout: render(payload) },
        scenario,
      ),
    ).toThrow();
    expect(() =>
      validateAgentTaskTokenInvocation(
        { ...validBaseline, stdout: render(accounted) },
        validAccounted,
        scenario,
      ),
    ).toThrow();
    expect(() =>
      validateAgentTaskTokenInvocation(
        validBaseline,
        {
          ...validAccounted,
          stdout: render({
            ...accounted,
            token_accounting: { ...accounted.token_accounting, total_bytes: 1 },
          }),
        },
        scenario,
      ),
    ).toThrow();
    expect(() =>
      validateAgentTaskTokenInvocation(
        validBaseline,
        {
          ...validAccounted,
          stdout: render({
            ...accounted,
            token_accounting: {
              ...accounted.token_accounting,
              sections: { result_rows: { bytes: 0 } },
            },
          }),
        },
        scenario,
      ),
    ).toThrow();
    expect(() =>
      validateAgentTaskTokenInvocation(
        validBaseline,
        {
          ...validAccounted,
          stdout: render({
            ...accounted,
            token_accounting: {
              ...accounted.token_accounting,
              accounting_receipt_bytes: 1_024,
            },
          }),
        },
        scenario,
      ),
    ).toThrow();
    expect(() =>
      validateAgentTaskTokenInvocation(validBaseline, validAccounted, {
        ...scenario,
        requiredFields: ["missing-field"],
      }),
    ).toThrow();
    expect(() =>
      validateAgentTaskTokenInvocation(
        { ...validBaseline, stdout: "not-json" },
        validAccounted,
        scenario,
      ),
    ).toThrow();
  });

  it("executes one real transport pass and evaluates normal and negative reports", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "pm-agent-task-token-spec-"),
    );
    tempRoots.push(root);
    const baselinePath = path.join(root, "baseline.json");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const updated = await main(["--update", "--baseline", baselinePath]);
    expect(updated.scenario_count).toBe(4);
    const updatedBaseline = {
      version: 1,
      scenarios: updated.scenarios.map(
        (scenario: { id: string; estimated_tokens: number }) => ({
          id: scenario.id,
          max_estimated_tokens: scenario.estimated_tokens,
        }),
      ),
    };
    expect(evaluateAgentTaskTokenReport(updated, updatedBaseline)).toBe(
      updated,
    );
    expect(
      evaluateAgentTaskTokenReport(updated, updatedBaseline, true),
    ).toMatchObject({
      ok: true,
      negative_control: "seeded_per_task_token_regression",
    });
    expect(finalizeAgentTaskTokenReport(updated, new Map(), baselinePath)).toBe(
      updated,
    );
    expect(
      finalizeAgentTaskTokenReport(
        updated,
        new Map([["negative-control", true]]),
        baselinePath,
      ),
    ).toMatchObject({
      ok: true,
      negative_control: "seeded_per_task_token_regression",
    });
  }, 180_000);
});
