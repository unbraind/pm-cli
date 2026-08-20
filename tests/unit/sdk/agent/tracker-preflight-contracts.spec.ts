import { describe, expect, it } from "vitest";
import {
  listTrackerPreflightRecoveryContracts,
  scoreTrackerPreflightRecoveryClosure,
} from "../../../../src/sdk/agent/tracker-preflight-contracts.js";

describe("tracker preflight recovery contracts", () => {
  it("declares every tracker root filesystem state without duplicate probes", () => {
    const contracts = listTrackerPreflightRecoveryContracts();

    expect(contracts).toHaveLength(4);
    expect(new Set(contracts.map(({ probe_id: probeId }) => probeId)).size).toBe(
      contracts.length,
    );
    expect(contracts.map(({ failure_kind: kind }) => kind).sort()).toEqual([
      "missing_root",
      "not_directory",
      "settings_missing",
      "unreadable_root",
    ]);
    expect(
      contracts.find(({ failure_kind: kind }) => kind === "not_directory"),
    ).toMatchObject({
      expected_error_code: "tracker_root_not_directory",
      expected_exit_code: 2,
      recovery_kind: "select_directory",
    });
  });

  it("scores executable initialization and safe directory-selection closure", () => {
    expect(
      scoreTrackerPreflightRecoveryClosure([
        {
          probe_id: "tracker-root-missing",
          error_code: "tracker_root_missing",
          exit_code: 3,
          recovery_kind: "initialize",
          suggested_retry_args: ["--pm-path", "/tmp/missing", "init"],
          retry_succeeded: true,
          unsafe_init_recommended: false,
        },
        {
          probe_id: "tracker-root-settings-missing",
          error_code: "tracker_not_initialized",
          exit_code: 3,
          recovery_kind: "initialize",
          suggested_retry_args: ["--pm-path", "/tmp/empty", "init"],
          retry_succeeded: true,
          unsafe_init_recommended: false,
        },
        {
          probe_id: "tracker-root-not-directory",
          error_code: "tracker_root_not_directory",
          exit_code: 2,
          recovery_kind: "select_directory",
          suggested_retry_args: [],
          retry_succeeded: true,
          unsafe_init_recommended: false,
        },
        {
          probe_id: "tracker-root-unreadable",
          error_code: "tracker_root_unreadable",
          exit_code: 1,
          recovery_kind: "repair_permissions",
          suggested_retry_args: [],
          retry_succeeded: true,
          unsafe_init_recommended: false,
        },
      ]),
    ).toEqual({
      ok: true,
      probe_count: 4,
      closed_probe_count: 4,
      findings: [],
    });
  });

  it("fails closed for missing probes, mismatched refusals, and unsafe init guidance", () => {
    const report = scoreTrackerPreflightRecoveryClosure([
      {
        probe_id: "tracker-root-missing",
        error_code: "tracker_root_missing",
        exit_code: 3,
        recovery_kind: "select_directory",
        suggested_retry_args: [],
        retry_succeeded: true,
        unsafe_init_recommended: false,
      },
      {
        probe_id: "tracker-root-not-directory",
        error_code: "tracker_not_initialized",
        exit_code: 3,
        recovery_kind: "select_directory",
        suggested_retry_args: ["init", "/tmp/file"],
        retry_succeeded: false,
        unsafe_init_recommended: true,
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "missing_probe",
        "recovery_kind_mismatch",
        "missing_init_recovery",
        "error_code_mismatch",
        "exit_code_mismatch",
        "unsafe_init_recovery",
        "retry_failed",
      ]),
    );
  });
});
