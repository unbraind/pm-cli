import { describe, expect, it, vi } from "vitest";
import { _testOnly } from "../../../src/cli/main.js";
import { EXIT_CODE, PmCliError } from "../../../src/sdk/runtime-primitives.js";
import { wrapThrownErrorForSentry } from "../../../src/sdk/error-runtime.js";

describe("CLI known error projection", () => {
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
});
