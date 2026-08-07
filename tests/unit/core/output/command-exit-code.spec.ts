import { afterEach, describe, expect, it, vi } from "vitest";
import { printResult } from "../../../../src/core/output/output.js";

describe("structured result process exits", () => {
  const initialExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = initialExitCode;
    vi.restoreAllMocks();
  });

  it("accepts declared result exits and refuses undeclared numeric exits", () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.exitCode = undefined;

    printResult({ outcome: "no_effect", exit_code: 6 }, { json: true });
    expect(process.exitCode).toBe(6);

    process.exitCode = 0;
    printResult({ outcome: "partial_effect", exit_code: 7 }, { json: true });
    expect(process.exitCode).toBe(7);

    process.exitCode = undefined;
    printResult({ outcome: "unknown", exit_code: 99 }, { json: true });
    expect(process.exitCode).toBeUndefined();
  });
});
