import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import {
  main,
  runIfMain,
  verifyExecutableRefusalClosure,
} from "../../../scripts/release/refusal-closure-gate.mjs";

describe("executable refusal closure gate", () => {
  it("proves real retries and blocks a seeded omission", () => {
    expect(verifyExecutableRefusalClosure()).toMatchObject({
      ok: true,
      probe_count: 8,
      closed_probe_count: 8,
      closure_fraction: 1,
      findings: [],
    });
    expect(
      verifyExecutableRefusalClosure({ injectMismatch: true }),
    ).toMatchObject({
      ok: false,
      findings: [
        expect.objectContaining({
          code: "missing_allowed_values",
          probe_id: "context-invalid-intent",
        }),
      ],
    });
  });

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
          { probe_id: "malformed", args: [] },
          { probe_id: "missing-recovery", args: ["missing"] },
        ],
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
  });

  it("reports standalone success and negative-control exit status", () => {
    const originalExitCode = process.exitCode;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
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
      );
      expect(process.exitCode).toBeUndefined();
      expect(main(["--inject-mismatch"])).toMatchObject({ ok: false });
      expect(process.exitCode).toBe(1);
    } finally {
      write.mockRestore();
      process.exitCode = originalExitCode;
    }
  });
});
