import { describe, expect, it, vi } from "vitest";
import { _testOnly } from "../../../src/cli/main.js";
import { EXIT_CODE, PmCliError } from "../../../src/sdk/runtime-primitives.js";
import { wrapThrownErrorForSentry } from "../../../src/sdk/error-runtime.js";
import { formatPmCliErrorForDisplay, formatPmCliErrorForJson } from "../../../src/cli/error-guidance.js";

describe("CLI known error projection", () => {
  it.each([null, "brief|full", { choices: ["brief", "full"] }])("preserves malformed non-array domains through enrichment for a truthful refusal (%j)", (domain) => {
    const context = { recovery: { allowed_values: domain as never } };
    const enriched = _testOnly.buildPmCliRecoveryContext(context, ["probe", "run"], "Producer failure");
    expect(enriched.recovery?.allowed_values).toEqual(domain);
    const envelope = formatPmCliErrorForJson("Producer failure", 2, enriched);
    expect(envelope.next_steps?.join(" ")).toContain("Incomplete legal domain");
    expect(envelope.recovery?.allowed_values).toBeUndefined();
    expect(envelope.refusal.legal_domain).toBeUndefined();
    expect(formatPmCliErrorForDisplay("Producer failure", enriched, { lean: true })).toContain("Incomplete legal domain");
    expect(context.recovery.allowed_values).toEqual(domain);
  });
  it("wraps primitive failures without inventing an exit code", () => {
    const wrapped = wrapThrownErrorForSentry("failure", "wrapped") as Error & {
      exitCode?: number;
    };
    expect(wrapped.message).toBe("wrapped");
    expect(wrapped.exitCode).toBeUndefined();
  });

  it("projects known execution errors through the lean JSON envelope", async () => {
    const previousExitCode = process.exitCode;
    let stderr = "";
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderr += String(chunk);
        return true;
      });
    try {
      await _testOnly.handleRunPmCliKnownError(
        {
          error: new PmCliError(
            "Item pm-missing not found",
            EXIT_CODE.NOT_FOUND,
          ),
          invocationArgv: ["--lean", "get", "pm-missing", "--json"],
          bootstrapGlobal: { json: true, lean: true },
          jsonErrors: true,
          bootstrapPmRoot: "/tmp/pm-missing",
          attemptedCommand: "get",
          emitTelemetryCommandError: vi.fn(async () => ({
            errorCategory: "runtime" as const,
            commandResolution: "runtime_failed" as const,
          })),
        },
        EXIT_CODE.NOT_FOUND,
      );
      expect(JSON.parse(stderr)).toMatchObject({
        code: "item_not_found",
        exit_code: EXIT_CODE.NOT_FOUND,
      });
      expect(JSON.parse(stderr)).not.toHaveProperty("title");
    } finally {
      stderrSpy.mockRestore();
      process.exitCode = previousExitCode;
    }
  });

  it("reports a separately bundled refusal's details getter without running it, even from a frozen context (GH-1631)", async () => {
    const previousExitCode = process.exitCode;
    let calls = 0;
    const context = Object.freeze(Object.defineProperty({ code: "probe_expected", recovery: { suggested_flags: ["--x"] } }, "details", {
      enumerable: true,
      get() {
        calls += 1;
        throw new Error("details getter fault");
      },
    }));
    const bundled = Object.assign(new Error("bundled refusal"), { name: "PmCliError", exitCode: EXIT_CODE.USAGE, context });
    let stderr = "";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    try {
      await _testOnly.handleRunPmCliKnownError(
        {
          error: bundled,
          invocationArgv: ["probe", "run", "--json"],
          bootstrapGlobal: { json: true },
          jsonErrors: true,
          bootstrapPmRoot: "/tmp/pm-probe",
          attemptedCommand: "probe run",
          emitTelemetryCommandError: vi.fn(async () => ({
            errorCategory: "usage" as const,
            commandResolution: "runtime_failed" as const,
          })),
        },
        EXIT_CODE.USAGE,
      );
      expect(JSON.parse(stderr)).toMatchObject({
        code: "probe_expected",
        details_omitted: { reason: "unsupported_value", path: "details", byte_limit: 4096 },
      });
      expect(calls).toBe(0);
    } finally {
      stderrSpy.mockRestore();
      process.exitCode = previousExitCode;
    }
    // Enrichment reads the frozen context once as plain data and still adds recovery.
    const enriched = _testOnly.buildPmCliRecoveryContext(context, ["probe", "run"], "bundled refusal");
    expect(Object.getOwnPropertyDescriptor(enriched, "details")).toBeUndefined();
    expect(enriched.details_omitted).toEqual({ reason: "unsupported_value", path: "details", byte_limit: 4096 });
    expect(enriched.recovery).toMatchObject({ suggested_flags: ["--x"] });
    expect(calls).toBe(0);
  });
});
