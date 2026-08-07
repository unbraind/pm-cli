import { afterEach, describe, expect, it } from "vitest";
import { _testOnly } from "../../../src/cli/main.js";
import { setActiveCommandResult } from "../../../src/core/extensions/index.js";

describe("command exit telemetry", () => {
  const initialExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = initialExitCode;
    setActiveCommandResult(undefined);
  });

  it.each([
    [0, "effect"],
    [6, "no_effect"],
    [7, "partial_effect"],
  ])("classifies successful exit %i as successful telemetry", (exitCode, outcome) => {
    process.exitCode = undefined;
    setActiveCommandResult({ exit_code: exitCode, outcome });

    expect(_testOnly.buildPostActionTelemetryOutcome()).toMatchObject({
      ok: true,
      exit_code: exitCode,
      command_resolution: "success",
    });
  });
});
