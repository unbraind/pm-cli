import { describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  main,
  runIfMain,
  scorePmRefusalCatalogClosure,
  verifyExecutableRefusalClosure,
} from "../../../scripts/release/refusal-closure-gate.mjs";

const SAMPLE_CONTRACT = {
  probe_id: "context-invalid-intent",
  refusal_args: ["context", "--for", "not-a-declared-intent"],
  rejected_value: "not-a-declared-intent",
  allowed_values: ["resume"],
  error_code: "unknown_context_intent",
  suggested_retry_args: ["context", "--for", "resume"],
};

const EMPTY_BASELINE = {
  version: 1,
  minimum_probe_count: 0,
  required_probe_ids: [],
};

function createSuccessfulOptions(errorEnvelope = {}) {
  const results = [
    { status: 0, stderr: "" },
    { status: 0, stderr: "" },
    {
      status: 2,
      stderr: JSON.stringify({
        code: SAMPLE_CONTRACT.error_code,
        required: "Use the advertised retry.",
        recovery: {
          allowed_values: SAMPLE_CONTRACT.allowed_values,
          suggested_retry: "pm context --for resume",
          suggested_retry_args: SAMPLE_CONTRACT.suggested_retry_args,
        },
        ...errorEnvelope,
      }),
    },
    { status: 0, stderr: "" },
  ];
  return {
    probes: [SAMPLE_CONTRACT],
    baseline: EMPTY_BASELINE,
    makeTemporaryDirectory: () => "/tmp/pm-refusal-unit",
    removeDirectory: () => {},
    spawn: () => results.shift(),
  };
}

describe("executable refusal closure gate", () => {
  it("fails the catalog ratchet when executable evidence regresses", () => {
    expect(scorePmRefusalCatalogClosure([])).toMatchObject({
      catalogRatchet: { ok: false, baseline: 13, actual: 0 },
      catalogRatchetFindings: expect.arrayContaining([
        expect.objectContaining({
          code: "executable_error_code_count_regressed",
          probe_id: "catalog-census",
        }),
        expect.objectContaining({
          code: "executable_error_code_identity_regressed",
        }),
      ]),
    });
  });

  it.runIf(process.platform !== "win32")(
    "proves real retries and blocks a seeded omission",
    () => {
      const result = verifyExecutableRefusalClosure();
      expect(result).toMatchObject({
        ok: true,
        probe_count: 117,
        closed_probe_count: 117,
        closure_fraction: 1,
        contract_count: 117,
        closed_domain_contract_count: 18,
        grammar_refusal_contract_count: 95,
        required_argument_contract_count: 88,
        subcommand_contract_count: 7,
        tracker_preflight_contract_count: 4,
        baseline_version: 2,
        diagnostic_output: {
          ok: true,
          baseline_version: 1,
          probe_count: 10,
          within_budget_count: 10,
          corrective_action_count: 10,
        },
        catalog_closure: {
          complete: false,
          executable_error_code_count: 13,
          ratchet: { ok: true, baseline: 13, actual: 13 },
          restore_with: "docs/generated/REFUSAL_CLOSURE_CENSUS.md",
        },
        findings: [],
      });
      expect(
        result.catalog_closure.executable_error_code_count +
          result.catalog_closure.uncovered_error_code_count,
      ).toBe(result.catalog_closure.catalog_error_code_count);
      expect(
        verifyExecutableRefusalClosure({
          ...createSuccessfulOptions(),
          injectMismatch: true,
        }),
      ).toMatchObject({
        ok: false,
        findings: expect.arrayContaining([
          expect.objectContaining({
            code: "missing_allowed_values",
            probe_id: "context-invalid-intent",
          }),
        ]),
      });
      expect(
        verifyExecutableRefusalClosure({
          ...createSuccessfulOptions(),
          errorCodeCatalog: [],
        }),
      ).toMatchObject({
        ok: false,
        catalog_closure: {
          ratchet: { ok: false, baseline: 13, actual: 0 },
        },
        findings: expect.arrayContaining([
          expect.objectContaining({
            code: "executable_error_code_count_regressed",
            probe_id: "catalog-census",
          }),
        ]),
      });
      expect(
        verifyExecutableRefusalClosure({
          ...createSuccessfulOptions(),
          diagnosticBaseline: {
            version: 9,
            required_probe_ids: ["missing-diagnostic-probe"],
          },
        }),
      ).toMatchObject({
        ok: false,
        diagnostic_output: {
          ok: false,
          baseline_version: 9,
          findings: [
            expect.objectContaining({
              code: "diagnostic_probe_missing",
              probe_id: "missing-diagnostic-probe",
            }),
          ],
        },
      });
      expect(
        verifyExecutableRefusalClosure({
          ...createSuccessfulOptions({ required: undefined }),
          diagnosticBaseline: {
            version: 9,
            required_probe_ids: [SAMPLE_CONTRACT.probe_id],
          },
        }),
      ).toMatchObject({
        ok: false,
        diagnostic_output: {
          ok: false,
          findings: [
            expect.objectContaining({
              code: "diagnostic_corrective_action_missing",
              probe_id: SAMPLE_CONTRACT.probe_id,
            }),
          ],
        },
      });
      expect(
        verifyExecutableRefusalClosure({
          ...createSuccessfulOptions({
            diagnostic_output: {
              budget: 1,
              estimated_tokens: 1,
              original_estimated_tokens: 1,
            },
          }),
          diagnosticBaseline: {
            version: 9,
            required_probe_ids: [SAMPLE_CONTRACT.probe_id],
          },
        }),
      ).toMatchObject({
        ok: false,
        diagnostic_output: {
          ok: false,
          findings: [
            expect.objectContaining({
              code: "diagnostic_budget_mismatch",
              probe_id: SAMPLE_CONTRACT.probe_id,
            }),
          ],
        },
      });
      for (const diagnosticOutput of [null, "invalid", [], 42]) {
        expect(
          verifyExecutableRefusalClosure({
            ...createSuccessfulOptions({
              diagnostic_output: diagnosticOutput,
            }),
            diagnosticBaseline: {
              version: 9,
              required_probe_ids: [SAMPLE_CONTRACT.probe_id],
            },
          }),
        ).toMatchObject({
          ok: false,
          diagnostic_output: {
            ok: false,
            findings: [
              expect.objectContaining({
                code: "diagnostic_receipt_invalid",
                probe_id: SAMPLE_CONTRACT.probe_id,
              }),
            ],
          },
        });
      }
      for (const errorEnvelope of [
        {
          required: "Choose an allowed value.",
          recovery: {
            allowed_values: SAMPLE_CONTRACT.allowed_values,
            suggested_retry_args: [],
          },
        },
        {
          required: "Run the next step.",
          recovery: { allowed_values: [], suggested_retry_args: [] },
          next_steps: ["pm context --for resume"],
        },
      ]) {
        expect(
          verifyExecutableRefusalClosure({
            ...createSuccessfulOptions(errorEnvelope),
            diagnosticBaseline: {
              version: 9,
              required_probe_ids: [SAMPLE_CONTRACT.probe_id],
            },
          }).diagnostic_output,
        ).toMatchObject({
          probe_count: 1,
          corrective_action_count: 1,
        });
      }
      expect(
        verifyExecutableRefusalClosure({
          ...createSuccessfulOptions({
            required: "Choose a usable corrective action.",
            recovery: {
              allowed_values: ["   "],
              suggested_retry_args: [""],
            },
            next_steps: ["\t"],
          }),
          diagnosticBaseline: {
            version: 9,
            required_probe_ids: [SAMPLE_CONTRACT.probe_id],
          },
        }).diagnostic_output,
      ).toMatchObject({
        ok: false,
        corrective_action_count: 0,
        findings: [
          expect.objectContaining({
            code: "diagnostic_corrective_action_missing",
            probe_id: SAMPLE_CONTRACT.probe_id,
          }),
        ],
      });
    },
    240_000,
  );

  it("fails setup closed and normalizes malformed refusal recovery", () => {
    const removed: string[] = [];
    expect(() =>
      verifyExecutableRefusalClosure({
        makeTemporaryDirectory: () => "/tmp/pm-refusal-setup-failure",
        removeDirectory: (target) => removed.push(target),
        spawn: () => ({ status: 1, stderr: "setup failed" }),
      }),
    ).toThrow("Refusal closure tracker setup failed: setup failed");
    expect(removed).toEqual(["/tmp/pm-refusal-setup-failure"]);

    const itemSetupResults = [
      { status: 0, stderr: "" },
      { status: 1, stderr: "item setup failed" },
    ];
    expect(() =>
      verifyExecutableRefusalClosure({
        makeTemporaryDirectory: () => "/tmp/pm-refusal-item-failure",
        removeDirectory: () => {},
        spawn: () => itemSetupResults.shift(),
      }),
    ).toThrow("Refusal closure item setup failed: item setup failed");

    const unreadableSetupResults = [
      { status: 0, stderr: "" },
      { status: 0, stderr: "" },
      { status: 1, stderr: "permission fixture failed" },
    ];
    expect(() =>
      verifyExecutableRefusalClosure({
        probes: [],
        preflightProbes: [
          {
            probe_id: "tracker-root-unreadable",
            failure_kind: "unreadable_root",
            expected_error_code: "tracker_root_unreadable",
            expected_exit_code: 1,
            recovery_kind: "repair_permissions",
          },
        ],
        baseline: EMPTY_BASELINE,
        spawn: () => unreadableSetupResults.shift(),
      }),
    ).toThrow(
      "Refusal closure unreadable tracker setup failed: permission fixture failed",
    );

    const results = [
      { status: 0, stderr: "" },
      { status: 0, stderr: "" },
      {
        status: null,
        stderr: JSON.stringify({
          recovery: {
            allowed_values: ["valid", 1],
            suggested_retry: 42,
            suggested_retry_args: [1],
          },
        }),
      },
      { status: 2, stderr: JSON.stringify({}) },
    ];
    expect(
      verifyExecutableRefusalClosure({
        probes: [
          {
            probe_id: "malformed",
            refusal_args: [],
            rejected_value: "invalid",
            allowed_values: ["valid"],
            error_code: "unknown_context_intent",
            suggested_retry_args: ["list", "--for", "triage"],
          },
          {
            probe_id: "missing-recovery",
            refusal_args: ["missing"],
            rejected_value: "invalid",
            allowed_values: ["valid"],
            error_code: "unknown_context_intent",
            suggested_retry_args: ["list", "--for", "triage"],
          },
        ],
        baseline: {
          version: 1,
          minimum_probe_count: 0,
          required_probe_ids: [],
        },
        makeTemporaryDirectory: () => "/tmp/pm-refusal-malformed",
        removeDirectory: () => {},
        spawn: () => results.shift(),
      }),
    ).toMatchObject({
      ok: false,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "missing_suggested_retry" }),
        expect.objectContaining({ code: "retry_failed" }),
      ]),
    });

    const invalidJsonResults = [
      { status: 0, stderr: "" },
      { status: 0, stderr: "" },
      { status: 2, stderr: "not-json" },
    ];
    expect(() =>
      verifyExecutableRefusalClosure({
        ...createSuccessfulOptions(),
        spawn: () => invalidJsonResults.shift(),
      }),
    ).toThrow(SyntaxError);
  });

  it.runIf(process.platform !== "win32")(
    "restores an unreadable fixture when an earlier preflight probe throws",
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "pm-refusal-cleanup-unit-"));
      const unreadableRoot = path.join(root, "tracker-root-unreadable");
      mkdirSync(unreadableRoot);
      const results = [
        { status: 0, stderr: "" },
        { status: 0, stderr: "" },
        { status: 0, stderr: "" },
        { status: 2, stderr: "not-json" },
      ];
      let restoredMode = 0;
      expect(() =>
        verifyExecutableRefusalClosure({
          probes: [],
          preflightProbes: [
            {
              probe_id: "tracker-root-not-directory",
              failure_kind: "not_directory",
              expected_error_code: "tracker_root_not_directory",
              expected_exit_code: 2,
              recovery_kind: "select_directory",
            },
            {
              probe_id: "tracker-root-unreadable",
              failure_kind: "unreadable_root",
              expected_error_code: "tracker_root_unreadable",
              expected_exit_code: 1,
              recovery_kind: "repair_permissions",
            },
          ],
          baseline: EMPTY_BASELINE,
          makeTemporaryDirectory: () => root,
          removeDirectory: (target) => {
            restoredMode = statSync(unreadableRoot).mode & 0o777;
            rmSync(target, { recursive: true, force: true });
          },
          spawn: () => results.shift(),
        }),
      ).toThrow(SyntaxError);
      expect(restoredMode).toBe(0o700);
    },
  );

  it("fails closed when the historical contract corpus regresses", () => {
    const report = verifyExecutableRefusalClosure({
      ...createSuccessfulOptions(),
      baseline: {
        version: 99,
        minimum_probe_count: 19,
        required_probe_ids: ["removed-probe"],
      },
    });
    expect(report).toMatchObject({
      ok: false,
      baseline_version: 99,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "minimum_probe_count_regressed" }),
        expect.objectContaining({
          code: "required_probe_missing",
          probe_id: "removed-probe",
        }),
      ]),
    });

    expect(
      verifyExecutableRefusalClosure({
        probes: [],
        preflightProbes: [
          {
            probe_id: "invalid-kind",
            failure_kind: "unknown",
            expected_error_code: "invalid",
            expected_exit_code: 1,
            recovery_kind: "select_directory",
          },
        ],
        baseline: EMPTY_BASELINE,
        spawn: () => ({ status: 0, stderr: "" }),
      }),
    ).toMatchObject({
      ok: false,
      tracker_preflight_contract_count: 1,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "missing_probe" }),
      ]),
    });
  });

  it("handles an empty corpus and malformed preflight envelopes deterministically", () => {
    expect(
      verifyExecutableRefusalClosure({
        probes: [],
        preflightProbes: [],
        baseline: EMPTY_BASELINE,
        spawn: () => ({ status: 0, stderr: "" }),
      }),
    ).toMatchObject({
      ok: false,
      probe_count: 0,
      closed_probe_count: 0,
      closure_fraction: 1,
    });

    const results = [
      { status: 0, stderr: "" },
      { status: 0, stderr: "" },
      { status: null, stderr: JSON.stringify({ code: 7 }) },
      { status: 0, stderr: "" },
    ];
    expect(
      verifyExecutableRefusalClosure({
        probes: [],
        preflightProbes: [
          {
            probe_id: "tracker-root-not-directory",
            failure_kind: "not_directory",
            expected_error_code: "tracker_root_not_directory",
            expected_exit_code: 2,
            recovery_kind: "select_directory",
          },
        ],
        baseline: EMPTY_BASELINE,
        spawn: () => results.shift(),
      }),
    ).toMatchObject({
      ok: false,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "error_code_mismatch" }),
        expect.objectContaining({ code: "exit_code_mismatch" }),
      ]),
    });
  });

  it("fails closed for malformed grammar refusals against a non-directory tracker fixture", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pm-refusal-grammar-unit-"));
    const results = [
      { status: 0, stderr: "" },
      { status: 0, stderr: "" },
      { status: null, stderr: JSON.stringify({ code: 7 }) },
      { status: 0, stderr: "" },
    ];
    try {
      expect(
        verifyExecutableRefusalClosure({
          probes: [],
          grammarProbes: [
            {
              probe_id: "malformed-grammar-refusal",
              command: "synthetic",
              refusal_args: ["synthetic"],
              recovery_args: ["synthetic", "--help"],
              error_code: "missing_required_argument",
              missing_argument: "id",
              missing_argument_index: 0,
            },
          ],
          preflightProbes: [],
          baseline: EMPTY_BASELINE,
          makeTemporaryDirectory: () => root,
          removeDirectory: () => {},
          spawn: (
            _executable: string,
            _arguments: string[],
            options: { env: NodeJS.ProcessEnv },
          ) => {
            if (results.length === 4) {
              writeFileSync(options.env.PM_PATH, "not a directory", "utf8");
            }
            return results.shift();
          },
        }),
      ).toMatchObject({
        ok: false,
        findings: expect.arrayContaining([
          expect.objectContaining({ code: "refusal_error_code_mismatch" }),
          expect.objectContaining({ code: "refusal_exit_code_mismatch" }),
        ]),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports standalone success and negative-control exit status", () => {
    const originalExitCode = process.exitCode;
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      process.exitCode = undefined;
      runIfMain("");
      runIfMain(
        fileURLToPath(
          new URL(
            "../../../scripts/release/refusal-closure-gate.mjs",
            import.meta.url,
          ),
        ),
        createSuccessfulOptions(),
      );
      expect(process.exitCode).toBeUndefined();
      expect(
        main(["--inject-mismatch"], createSuccessfulOptions()),
      ).toMatchObject({ ok: false });
      expect(process.exitCode).toBe(1);
    } finally {
      write.mockRestore();
      process.exitCode = originalExitCode;
    }
  });
});
