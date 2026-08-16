import { afterEach, describe, expect, it, vi } from "vitest";
import { runPmCli } from "../../../src/cli/public.js";

describe("public embedded CLI entrypoint", () => {
  const initialExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = initialExitCode;
    vi.restoreAllMocks();
  });

  it("preserves host exit state across successful and failed invocations", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = 73;

    await runPmCli(["--version"]);
    expect(process.exitCode).toBe(73);

    await runPmCli(["not-a-pm-command", "--no-extensions"]);
    expect(process.exitCode).toBe(73);
  });
});
