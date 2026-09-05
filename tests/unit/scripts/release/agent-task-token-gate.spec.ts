import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAdvertisedAgentTaskRecovery,
  assertMatchingAgentTaskFixtureAnchors,
  compareAgentTaskTokenBaseline,
  evaluateOrientationProtocolSelection,
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
    { id: "orient", estimated_tokens: 10, accounting_mode: "self_reported" },
    { id: "inspect", estimated_tokens: 20, accounting_mode: "self_reported" },
  ];
  const report = {
    transcript_digest: "sha256:test",
    composite_estimated_tokens: 30,
    orientation: {
      canonical_task_id: "orientation-context-intent",
      measured_winner_tokens: 30,
    },
    tasks: [{ id: "context", estimated_tokens: 30, steps }],
  };
  const baseline = {
    version: 4,
    transcript_digest: "sha256:test",
    composite_max_estimated_tokens: 30,
    orientation: {
      canonical_task_id: "orientation-context-intent",
      measured_winner_tokens: 30,
    },
    tasks: [
      {
        id: "context",
        max_estimated_tokens: 30,
        steps: [
          {
            id: "orient",
            max_estimated_tokens: 10,
            accounting_mode: "self_reported",
          },
          {
            id: "inspect",
            max_estimated_tokens: 20,
            accounting_mode: "self_reported",
          },
        ],
      },
    ],
  };
  const orientationReport = {
    tasks: [
      {
        id: "orientation-context-intent",
        step_count: 1,
        estimated_tokens: 300,
        steps: [
          {
            id: "context",
            verified_fields: ["summary.active_items", "activity"],
          },
        ],
      },
      {
        id: "orientation-contracts-next",
        step_count: 2,
        estimated_tokens: 800,
        steps: [
          { id: "contracts", verified_fields: ["commands"] },
          {
            id: "next",
            verified_fields: ["summary.in_progress", "recommended.id"],
          },
        ],
      },
    ],
  };
  const orientation = {
    canonical_task_id: "orientation-context-intent",
    required_capabilities: ["state", "ownership"],
    protocols: [
      {
        task_id: "orientation-context-intent",
        capabilities: ["ownership", "state"],
        capability_evidence: {
          ownership: [{ step_id: "context", field_path: "activity" }],
          state: [{ step_id: "context", field_path: "summary.active_items" }],
        },
      },
      {
        task_id: "orientation-contracts-next",
        capabilities: ["state", "ownership"],
        capability_evidence: {
          ownership: [{ step_id: "next", field_path: "summary.in_progress" }],
          state: [{ step_id: "next", field_path: "recommended.id" }],
        },
      },
    ],
  };

  it("selects the lowest-token equivalent orientation protocol", () => {
    expect(
      evaluateOrientationProtocolSelection(orientationReport, orientation),
    ).toMatchObject({
      canonical_task_id: "orientation-context-intent",
      measured_winner_tokens: 300,
      protocols: [
        { task_id: "orientation-context-intent", command_count: 1 },
        { task_id: "orientation-contracts-next", command_count: 2 },
      ],
    });
  });

  it("rejects a canonical orientation that is not the measured winner", () => {
    expect(() =>
      evaluateOrientationProtocolSelection(orientationReport, {
        ...orientation,
        canonical_task_id: "orientation-contracts-next",
      }),
    ).toThrow();
  });

  it.each([
    undefined,
    null,
    [],
    { state: [{ step_id: "next", field_path: "recommended.id" }] },
  ])("rejects malformed capability evidence: %j", (capabilityEvidence) => {
    expect(() =>
      evaluateOrientationProtocolSelection(orientationReport, {
        ...orientation,
        protocols: [
          orientation.protocols[0],
          {
            ...orientation.protocols[1],
            capability_evidence: capabilityEvidence,
          },
        ],
      }),
    ).toThrow();
  });

  it.each([
    null,
    { step_id: " ", field_path: "recommended.id" },
    { step_id: "next", field_path: 42 },
    { step_id: "next", field_path: " " },
    { step_id: "missing", field_path: "recommended.id" },
  ])("rejects an invalid capability evidence reference: %j", (reference) => {
    expect(() =>
      evaluateOrientationProtocolSelection(orientationReport, {
        ...orientation,
        protocols: [
          orientation.protocols[0],
          {
            ...orientation.protocols[1],
            capability_evidence: {
              ...orientation.protocols[1].capability_evidence,
              state: [reference],
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a measured protocol without step evidence", () => {
    expect(() =>
      evaluateOrientationProtocolSelection(
        {
          tasks: orientationReport.tasks.map((task) =>
            task.id === "orientation-contracts-next"
              ? { ...task, steps: undefined }
              : task,
          ),
        },
        orientation,
      ),
    ).toThrow();
  });

  it.each(orientation.required_capabilities)(
    "rejects empty %s capability evidence",
    (capability) => {
      expect(() =>
        evaluateOrientationProtocolSelection(orientationReport, {
          ...orientation,
          protocols: orientation.protocols.map((protocol) => ({
            ...protocol,
            capability_evidence: {
              ...protocol.capability_evidence,
              [capability]: [],
            },
          })),
        }),
      ).toThrow();
    },
  );

  it("rejects capability evidence for an unverified field", () => {
    expect(() =>
      evaluateOrientationProtocolSelection(orientationReport, {
        ...orientation,
        protocols: [
          orientation.protocols[0],
          {
            ...orientation.protocols[1],
            capability_evidence: {
              ...orientation.protocols[1].capability_evidence,
              state: [{ step_id: "next", field_path: "missing" }],
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("reports malformed required capabilities", () => {
    const invalidCapabilityLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(() =>
      evaluateOrientationProtocolSelection(orientationReport, {
        ...orientation,
        required_capabilities: "state",
      }),
    ).toThrow();
    expect(invalidCapabilityLog).toHaveBeenLastCalledWith(
      "Agent-task orientation required_capabilities must be an array of non-blank strings",
    );
  });

  it("reports a missing orientation protocol contract", () => {
    const invalidCapabilityLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(() =>
      evaluateOrientationProtocolSelection(orientationReport, {
        ...orientation,
        protocols: undefined,
      }),
    ).toThrow();
    expect(invalidCapabilityLog).toHaveBeenLastCalledWith(
      "Agent-task orientation protocol contract is incomplete",
    );
  });

  it("reports malformed protocol capabilities", () => {
    const invalidCapabilityLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(() =>
      evaluateOrientationProtocolSelection(orientationReport, {
        ...orientation,
        protocols: [
          orientation.protocols[0],
          {
            ...orientation.protocols[1],
            capabilities: "state",
          },
        ],
      }),
    ).toThrow();
    expect(invalidCapabilityLog).toHaveBeenLastCalledWith(
      "Agent-task orientation protocol capabilities must be an array of non-blank strings",
    );
  });

  it("normalizes and deduplicates capability names", () => {
    expect(
      evaluateOrientationProtocolSelection(orientationReport, {
        ...orientation,
        required_capabilities: [" state ", "ownership", "state"],
        protocols: orientation.protocols.map((protocol) => ({
          ...protocol,
          capabilities: [" ownership", "state ", "state"],
        })),
      }).required_capabilities,
    ).toEqual(["ownership", "state"]);
  });

  it("rejects an entirely absent orientation protocol contract", () => {
    expect(() =>
      evaluateOrientationProtocolSelection(orientationReport, {
        canonical_task_id: "orientation-context-intent",
        required_capabilities: undefined,
        protocols: undefined,
      }),
    ).toThrow();
  });

  it("orders equal-token protocols with locale-independent identifiers", () => {
    expect(
      evaluateOrientationProtocolSelection(
        {
          tasks: orientationReport.tasks.map((task) => ({
            ...task,
            estimated_tokens: 300,
          })),
        },
        orientation,
      ).protocols.map(({ task_id }) => task_id),
    ).toEqual(["orientation-context-intent", "orientation-contracts-next"]);
    const mixedCaseTasks = ["a-orientation", "Z-orientation"].map((id) => ({
      id,
      step_count: 1,
      estimated_tokens: 300,
      steps: [{ id: "context", verified_fields: ["state"] }],
    }));
    expect(
      evaluateOrientationProtocolSelection(
        { tasks: mixedCaseTasks },
        {
          canonical_task_id: "Z-orientation",
          required_capabilities: ["state"],
          protocols: mixedCaseTasks.map((task) => ({
            task_id: task.id,
            capabilities: ["state"],
            capability_evidence: {
              state: [{ step_id: "context", field_path: "state" }],
            },
          })),
        },
      ).protocols.map(({ task_id }) => task_id),
    ).toEqual(["Z-orientation", "a-orientation"]);
  });

  it("rejects a protocol without capability evidence", () => {
    expect(() =>
      evaluateOrientationProtocolSelection(orientationReport, {
        ...orientation,
        protocols: [
          orientation.protocols[0],
          {
            task_id: "orientation-contracts-next",
            capabilities: ["state"],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects duplicate protocol task identifiers", () => {
    expect(() =>
      evaluateOrientationProtocolSelection(orientationReport, {
        ...orientation,
        protocols: [orientation.protocols[0], orientation.protocols[0]],
      }),
    ).toThrow();
  });

  it.each([
    { capabilities: ["state", "ownership", 42] },
    { capabilities: ["state", "ownership", " "] },
  ])("rejects invalid capability values: $capabilities", ({ capabilities }) => {
    expect(() =>
      evaluateOrientationProtocolSelection(orientationReport, {
        ...orientation,
        required_capabilities: capabilities,
        protocols: orientation.protocols.map((protocol) => ({
          ...protocol,
          capabilities,
        })),
      }),
    ).toThrow();
  });

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
              steps: [
                {
                  id: "orient",
                  estimated_tokens: 11,
                  accounting_mode: "self_reported",
                },
                steps[1],
              ],
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
            steps: [
              {
                id: "orient",
                max_estimated_tokens: 10,
                accounting_mode: "self_reported",
              },
            ],
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
    expect(
      compareAgentTaskTokenBaseline(
        {
          ...report,
          orientation: { canonical_task_id: "new", measured_winner_tokens: 31 },
        },
        {
          ...baseline,
          orientation: {
            canonical_task_id: "old",
            measured_winner_tokens: 30,
          },
        },
      ),
    ).toContain("orientation:canonical_or_token_ceiling_drift");
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

  it("fails closed when a step changes or omits its accounting mode", () => {
    expect(
      compareAgentTaskTokenBaseline(
        {
          ...report,
          tasks: [
            {
              ...report.tasks[0],
              steps: [
                { ...steps[0], accounting_mode: "independent_transport" },
                steps[1],
              ],
            },
          ],
        },
        baseline,
      ),
    ).toEqual([
      "task:context:step:orient:accounting_mode:independent_transport!=self_reported",
    ]);
    expect(
      compareAgentTaskTokenBaseline(report, {
        ...baseline,
        tasks: [
          {
            ...baseline.tasks[0],
            steps: [
              { id: "orient", max_estimated_tokens: 10 },
              baseline.tasks[0].steps[1],
            ],
          },
        ],
      }),
    ).toEqual([
      "task:context:step:orient:accounting_mode:self_reported!=undefined",
    ]);
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

  it.each([
    [undefined, 30],
    ["30", 30],
    [30, undefined],
    [30, "30"],
  ])(
    "fails closed on invalid orientation ceilings (%s, %s)",
    (baselineWinnerTokens, reportWinnerTokens) => {
      expect(
        compareAgentTaskTokenBaseline(
          {
            ...report,
            orientation:
              reportWinnerTokens === undefined
                ? { canonical_task_id: report.orientation.canonical_task_id }
                : {
                    ...report.orientation,
                    measured_winner_tokens: reportWinnerTokens,
                  },
          },
          {
            ...baseline,
            orientation:
              baselineWinnerTokens === undefined
                ? { canonical_task_id: baseline.orientation.canonical_task_id }
                : {
                    ...baseline.orientation,
                    measured_winner_tokens: baselineWinnerTokens,
                  },
          },
        ),
      ).toContain("orientation:canonical_or_token_ceiling_drift");
    },
  );

  it("rejects invalid accounting, incomplete output, and envelope drift", () => {
    const step = {
      id: "validation",
      args: ["--json", "list"],
      expected_exit_code: 0,
      expected_output_kind: "collection",
      expected_accounting_mode: "self_reported",
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
    const validEstimate = accounted.token_accounting.total_estimated_tokens;
    for (const invalidEstimate of [
      undefined,
      validEstimate - 1,
      validEstimate + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      String(validEstimate),
    ]) {
      expect(() =>
        validateAgentTaskTokenInvocation(
          validBaseline,
          {
            ...validAccounted,
            stdout: render({
              ...accounted,
              token_accounting: {
                ...accounted.token_accounting,
                total_estimated_tokens: invalidEstimate,
              },
            }),
          },
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
    const payloadDriftLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(() =>
      validateAgentTaskTokenInvocation(
        {
          ...validBaseline,
          stdout: render({ items: [{ id: "pm-different" }] }),
        },
        validAccounted,
        step,
      ),
    ).toThrow();
    expect(payloadDriftLog).toHaveBeenLastCalledWith(
      "Agent-task transcript step validation changed its application payload when token accounting was enabled; first_difference=replace:/items/0/id",
    );
    expect(() =>
      validateAgentTaskTokenInvocation(
        validBaseline,
        {
          ...validAccounted,
          stdout: render({
            ...accounted,
            token_accounting: {
              ...accounted.token_accounting,
              padding: "x".repeat(1_024),
            },
          }),
        },
        step,
      ),
    ).toThrow();
    expect(() =>
      validateAgentTaskTokenInvocation(validBaseline, validAccounted, {
        ...step,
        required_fields: ["missing-field"],
      }),
    ).toThrow();
    expect(() =>
      validateAgentTaskTokenInvocation(validBaseline, validAccounted, {
        ...step,
        expected_field_values: { "items.0.id": "pm-different" },
      }),
    ).toThrow();
    expect(() =>
      validateAgentTaskTokenInvocation(validBaseline, validAccounted, {
        ...step,
        required_fields: ["token_accounting.total_bytes"],
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
    const independentTransportError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(() =>
      validateAgentTaskTokenInvocation(validBaseline, validBaseline, {
        ...step,
        expected_accounting_mode: "independent_transport",
      }),
    ).toThrow();
    expect(independentTransportError).toHaveBeenLastCalledWith(
      "Agent-task transcript step validation independent_transport accounting is supported only for refusal output",
    );
    expect(() =>
      validateAgentTaskTokenInvocation(validBaseline, validAccounted, {
        ...step,
        args: ["--json"],
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
      expected_accounting_mode: "independent_transport",
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
        { ...refusalStep, expected_accounting_mode: "self_reported" },
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
    expect(() =>
      validateAgentTaskTokenInvocation(
        { status: 2, stdout: "", stderr: render(refusal) },
        { status: 2, stdout: "", stderr: render(refusal) },
        { ...refusalStep, expected_accounting_mode: "self_reported" },
      ),
    ).toThrow();
    expect(() =>
      validateAgentTaskTokenInvocation(
        { status: 2, stdout: "", stderr: render(refusal) },
        {
          status: 2,
          stdout: "",
          stderr: render(attachOutputTokenAccounting(refusal, render)),
        },
        refusalStep,
      ),
    ).toThrow();
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
          {
            ...refusalStep,
            expected_accounting_mode: "self_reported",
            ...override,
          },
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
          expected_accounting_mode: "self_reported",
          required_fields: ["id"],
        },
      ),
    ).toThrow();
  });

  it("permits only the predicted accounting transport change in recovery evidence", () => {
    const render = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
    const baseline = {
      code: "unknown_option",
      refusal: { surface: "--bad" },
      recovery: {
        normalized_args: ["--json", "list", "--bad"],
        provided_fields: ["--json", "--bad"],
        attempted_command: "pm --json list --bad",
      },
    };
    const accounted = {
      ...baseline,
      recovery: {
        normalized_args: ["--json", "--token-accounting", "list", "--bad"],
        provided_fields: ["--json", "--token-accounting", "--bad"],
        attempted_command: "pm --json --token-accounting list --bad",
      },
    };
    const step = {
      id: "diagnostic-transport",
      args: ["list", "--bad"],
      expected_exit_code: 2,
      expected_output_kind: "refusal",
      expected_accounting_mode: "self_reported",
      required_fields: ["recovery"],
      expected_error_code: "unknown_option",
      expected_refusal_surface: "--bad",
    };
    const accountedTransport = {
      status: 2, stdout: "",
      stderr: render(attachOutputTokenAccounting(accounted, render)),
    };
    expect(validateAgentTaskTokenInvocation(
      { status: 2, stdout: "", stderr: render(baseline) }, accountedTransport, step,
    )).toMatchObject({ output_kind: "refusal" });
    for (const recovery of [
      { ...baseline.recovery, normalized_args: ["list", "--bad"] },
      { ...baseline.recovery, provided_fields: undefined },
      { ...baseline.recovery, provided_fields: ["--wrong"] },
      { ...baseline.recovery, normalized_args: ["--json", "delete", "pm-important"] },
    ]) {
      expect(() => validateAgentTaskTokenInvocation(
        { status: 2, stdout: "", stderr: render({ ...baseline, recovery }) },
        accountedTransport, step,
      )).toThrow();
    }
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
      task_count: 8,
      completed_task_count: 8,
      step_count: 21,
      retry_count: 2,
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
