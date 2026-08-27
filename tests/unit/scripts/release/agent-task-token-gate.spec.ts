import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAdvertisedAgentTaskRecovery,
  assertMatchingAgentTaskFixtureAnchors,
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

describe("agent-task transcript token gate", () => {
  const steps = [
    { id: "orient", estimated_tokens: 10 },
    { id: "inspect", estimated_tokens: 20 },
  ];
  const report = {
    transcript_digest: "sha256:test",
    composite_estimated_tokens: 30,
    tasks: [{ id: "context", estimated_tokens: 30, steps }],
  };
  const baseline = {
    version: 2,
    transcript_digest: "sha256:test",
    composite_max_estimated_tokens: 30,
    tasks: [
      {
        id: "context",
        max_estimated_tokens: 30,
        steps: [
          { id: "orient", max_estimated_tokens: 10 },
          { id: "inspect", max_estimated_tokens: 20 },
        ],
      },
    ],
  };

  it("accepts an exact per-task baseline and detects a seeded regression", () => {
    expect(compareAgentTaskTokenBaseline(report, baseline)).toEqual([]);
    expect(
      compareAgentTaskTokenBaseline(
        {
          ...report,
          composite_estimated_tokens: 31,
          tasks: [
            {
              ...report.tasks[0],
              estimated_tokens: 31,
              steps: [{ id: "orient", estimated_tokens: 11 }, steps[1]],
            },
          ],
        },
        baseline,
      ),
    ).toEqual([
      "task:context:31>baseline:30",
      "task:context:step:orient:11>baseline:10",
      "composite:31>baseline:30",
    ]);
  });

  it("fails closed on baseline version, digest, identity, and count drift", () => {
    expect(
      compareAgentTaskTokenBaseline(
        {
          ...report,
          transcript_digest: "sha256:new",
          tasks: [{ id: "new", estimated_tokens: 1, steps: [] }],
        },
        { ...baseline, version: 1 },
      ),
    ).toEqual([
      "baseline_version:1",
      "transcript_digest:mismatch",
      "task:new:missing_baseline",
    ]);
    expect(
      compareAgentTaskTokenBaseline(report, {
        ...baseline,
        tasks: [
          {
            id: "context",
            max_estimated_tokens: 30,
            steps: [{ id: "orient", max_estimated_tokens: 10 }],
          },
          { id: "removed", max_estimated_tokens: 1, steps: [] },
        ],
      }),
    ).toEqual([
      "task:context:step:inspect:missing_baseline",
      "task:context:step_count:2!=1",
      "task_count:1!=2",
    ]);
    expect(
      compareAgentTaskTokenBaseline(report, {
        ...baseline,
        tasks: undefined,
      }),
    ).toEqual(["task:context:missing_baseline", "task_count:1!=0"]);
    expect(
      compareAgentTaskTokenBaseline(report, {
        ...baseline,
        tasks: [{ id: "context", max_estimated_tokens: 30 }],
      }),
    ).toEqual([
      "task:context:step:orient:missing_baseline",
      "task:context:step:inspect:missing_baseline",
      "task:context:step_count:2!=0",
    ]);
    expect(() =>
      evaluateAgentTaskTokenReport(report, { ...baseline, version: 1 }),
    ).toThrow();
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
          ...baseline,
          composite_max_estimated_tokens: 2_000_000,
          tasks: baseline.tasks.map((task) => ({
            ...task,
            max_estimated_tokens: 2_000_000,
          })),
        },
        true,
      ),
    ).toThrow();
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    "fails closed on absent or non-finite task and composite ceilings (%s)",
    (invalidLimit) => {
      expect(
        compareAgentTaskTokenBaseline(report, {
          ...baseline,
          composite_max_estimated_tokens: invalidLimit,
          tasks: baseline.tasks.map((task) => ({
            ...task,
            max_estimated_tokens: invalidLimit,
          })),
        }),
      ).toEqual([
        "task:context:missing_baseline_limit",
        "composite:missing_baseline_limit",
      ]);
    },
  );

  it("rejects invalid accounting, incomplete output, and envelope drift", () => {
    const step = {
      id: "validation",
      args: ["list"],
      expected_exit_code: 0,
      expected_output_kind: "collection",
      required_fields: ["items.0.id"],
    };
    const payload = { items: [{ id: "pm-one" }] };
    const render = (value: unknown): string =>
      `${JSON.stringify(value, null, 2)}\n`;
    const accounted = attachOutputTokenAccounting(payload, render);
    const validBaseline = { status: 0, stdout: render(payload), stderr: "" };
    const validAccounted = { status: 0, stdout: render(accounted), stderr: "" };

    expect(
      validateAgentTaskTokenInvocation(validBaseline, validAccounted, step),
    ).toMatchObject({
      completeness: "required_fields_present",
      output_kind: "collection",
      payload,
    });
    expect(() =>
      validateAgentTaskTokenInvocation(
        { ...validBaseline, status: 1 },
        validAccounted,
        step,
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
          step,
        ),
      ).toThrow();
    }
    for (const invalidAccounted of [
      payload,
      {
        ...accounted,
        token_accounting: { ...accounted.token_accounting, total_bytes: 1 },
      },
      {
        ...accounted,
        token_accounting: {
          ...accounted.token_accounting,
          sections: { result_rows: { bytes: 0 } },
        },
      },
      {
        ...accounted,
        token_accounting: {
          ...accounted.token_accounting,
          accounting_receipt_bytes: 1_024,
        },
      },
    ]) {
      expect(() =>
        validateAgentTaskTokenInvocation(
          validBaseline,
          { ...validAccounted, stdout: render(invalidAccounted) },
          step,
        ),
      ).toThrow();
    }
    expect(() =>
      validateAgentTaskTokenInvocation(
        { ...validBaseline, stdout: render(accounted) },
        validAccounted,
        step,
      ),
    ).toThrow();
    expect(() =>
      validateAgentTaskTokenInvocation(validBaseline, validAccounted, {
        ...step,
        required_fields: ["missing-field"],
      }),
    ).toThrow();
    const misleadingPayload = {
      items: [{ id: "pm-one" }],
      message: "The missing-field name appears only in prose",
    };
    expect(() =>
      validateAgentTaskTokenInvocation(
        { status: 0, stdout: render(misleadingPayload), stderr: "" },
        {
          status: 0,
          stdout: render(
            attachOutputTokenAccounting(misleadingPayload, render),
          ),
          stderr: "",
        },
        { ...step, required_fields: ["missing-field"] },
      ),
    ).toThrow();
    expect(() =>
      validateAgentTaskTokenInvocation(
        { ...validBaseline, stdout: "not-json" },
        validAccounted,
        step,
      ),
    ).toThrow();
    expect(() =>
      validateAgentTaskTokenInvocation(validBaseline, validAccounted, {
        ...step,
        expected_output_kind: "entity",
      }),
    ).toThrow();
    expect(() =>
      validateAgentTaskTokenInvocation(
        { status: 0, stdout: render({ marker: true }), stderr: "" },
        {
          status: 0,
          stdout: render(attachOutputTokenAccounting({ marker: true }, render)),
          stderr: "",
        },
        { ...step, required_fields: ["marker"] },
      ),
    ).toThrow();
  });

  it("validates refusal identity and mutation receipt families", () => {
    const render = (value: unknown): string =>
      `${JSON.stringify(value, null, 2)}\n`;
    const refusal = {
      code: "unknown_option",
      refusal: { surface: "--bad", exit_code: 2 },
      recovery: { suggested_flags: ["--tag"] },
    };
    const refusalStep = {
      id: "refusal",
      args: ["list", "--bad"],
      expected_exit_code: 2,
      expected_output_kind: "refusal",
      required_fields: ["recovery"],
      expected_error_code: "unknown_option",
      expected_refusal_surface: "--bad",
    };
    expect(
      validateAgentTaskTokenInvocation(
        { status: 2, stdout: "", stderr: render(refusal) },
        {
          status: 2,
          stdout: "",
          stderr: render(attachOutputTokenAccounting(refusal, render)),
        },
        refusalStep,
      ),
    ).toMatchObject({ output_kind: "refusal" });
    expect(
      validateAgentTaskTokenInvocation(
        { status: 2, stdout: "", stderr: render(refusal) },
        { status: 2, stdout: "", stderr: render(refusal) },
        refusalStep,
      ),
    ).toMatchObject({
      output_kind: "refusal",
      accounting_mode: "independent_transport",
      accounting_receipt_bytes: 0,
    });
    for (const override of [
      { expected_error_code: "wrong" },
      { expected_refusal_surface: "--wrong" },
    ]) {
      expect(() =>
        validateAgentTaskTokenInvocation(
          { status: 2, stdout: "", stderr: render(refusal) },
          {
            status: 2,
            stdout: "",
            stderr: render(attachOutputTokenAccounting(refusal, render)),
          },
          { ...refusalStep, ...override },
        ),
      ).toThrow();
    }

    const invalidReceipt = { id: "pm-one", status: "open" };
    expect(() =>
      validateAgentTaskTokenInvocation(
        { status: 0, stdout: render(invalidReceipt), stderr: "" },
        {
          status: 0,
          stdout: render(attachOutputTokenAccounting(invalidReceipt, render)),
          stderr: "",
        },
        {
          id: "mutation",
          args: ["create"],
          expected_exit_code: 0,
          expected_output_kind: "mutation_receipt",
          required_fields: ["id"],
        },
      ),
    ).toThrow();
  });

  it("rejects mismatched advertised recovery and fixture identities", () => {
    const recoveryStep = {
      id: "retry",
      args: ["get", "pm-one"],
      recovery_for: "refusal",
    };
    expect(() =>
      assertAdvertisedAgentTaskRecovery(undefined, recoveryStep),
    ).toThrow();
    expect(() =>
      assertAdvertisedAgentTaskRecovery(
        { recovery: { suggested_retry_args: ["get", "pm-two"] } },
        recoveryStep,
      ),
    ).toThrow();
    expect(() =>
      assertMatchingAgentTaskFixtureAnchors(
        { anchorId: "pm-one" },
        { anchorId: "pm-two" },
      ),
    ).toThrow();
  });

  it("replays every versioned task and evaluates normal and negative reports", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "pm-agent-task-token-spec-"),
    );
    tempRoots.push(root);
    const baselinePath = path.join(root, "baseline.json");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const updated = await main(["--update", "--baseline", baselinePath]);
    expect(updated).toMatchObject({
      task_count: 5,
      completed_task_count: 5,
      step_count: 14,
      retry_count: 1,
    });
    const updatedBaseline = JSON.parse(
      await readFile(baselinePath, "utf8"),
    ) as Parameters<typeof evaluateAgentTaskTokenReport>[1];
    expect(evaluateAgentTaskTokenReport(updated, updatedBaseline)).toBe(
      updated,
    );
    expect(
      evaluateAgentTaskTokenReport(updated, updatedBaseline, true),
    ).toMatchObject({
      ok: true,
      negative_control: "seeded_completed_task_token_regression",
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
    ).toMatchObject({ ok: true });
  }, 180_000);
});
