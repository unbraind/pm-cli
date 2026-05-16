import { describe, expect, it } from "vitest";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import {
  deriveTelemetryCommandResolution,
  deriveTelemetryCommandTaxonomy,
  inferTelemetryErrorCode,
} from "../../src/core/telemetry/observability.js";

describe("core/telemetry/observability", () => {
  it("infers known telemetry error codes from common runtime failures", () => {
    expect(
      inferTelemetryErrorCode({
        ok: false,
        errorMessage: "unknown command 'lst'",
      }),
    ).toBe("unknown_command");
    expect(
      inferTelemetryErrorCode({
        ok: false,
        errorMessage: "Missing required option --type",
      }),
    ).toBe("missing_required_option");
    expect(
      inferTelemetryErrorCode({
        ok: false,
        errorMessage: 'Invalid --status value "closed". Use "pm close <ID> <TEXT>" to close an item.',
      }),
    ).toBe("close_through_update");
    expect(
      inferTelemetryErrorCode({
        ok: false,
        errorMessage: "No update flags provided",
      }),
    ).toBe("no_update_fields");
    expect(
      inferTelemetryErrorCode({
        ok: false,
        errorMessage: "--reminder requires at=<iso|relative> and text=<value>",
      }),
    ).toBe("invalid_argument_value");
    expect(
      inferTelemetryErrorCode({
        ok: false,
        errorMessage: "Tracker is not initialized at /tmp/project/.agents/pm. Run pm init first.",
      }),
    ).toBe("tracker_not_initialized");
    expect(
      inferTelemetryErrorCode({
        ok: false,
        errorMessage: "Item pm-a1b2 is already terminal; use --force to close again.",
      }),
    ).toBe("terminal_state_conflict");
    expect(
      inferTelemetryErrorCode({
        ok: false,
        exitCode: EXIT_CODE.DEPENDENCY_FAILED,
      }),
    ).toBe("dependency_failed");
  });

  it("derives command resolution classes from error signals", () => {
    expect(
      deriveTelemetryCommandResolution({
        ok: true,
      }),
    ).toBe("success");
    expect(
      deriveTelemetryCommandResolution({
        ok: false,
        errorCode: "unknown_command",
        errorCategory: "usage",
      }),
    ).toBe("nonexistent_command");
    expect(
      deriveTelemetryCommandResolution({
        ok: false,
        errorCode: "unknown_option",
        errorCategory: "usage",
      }),
    ).toBe("invalid_option");
    expect(
      deriveTelemetryCommandResolution({
        ok: false,
        errorCode: "invalid_argument_value",
        errorCategory: "validation",
      }),
    ).toBe("validation_failed");
    expect(
      deriveTelemetryCommandResolution({
        ok: false,
        errorCode: "health_findings",
        errorCategory: "validation",
      }),
    ).toBe("health_findings");
    expect(
      deriveTelemetryCommandResolution({
        ok: false,
        errorCode: "validation_findings",
        errorCategory: "validation",
      }),
    ).toBe("validation_findings");
    expect(
      deriveTelemetryCommandResolution({
        ok: false,
        errorCode: "lock_conflict",
        errorCategory: "conflict",
      }),
    ).toBe("conflict");
    expect(
      deriveTelemetryCommandResolution({
        ok: false,
        errorCode: "dependency_failed",
        errorCategory: "runtime",
      }),
    ).toBe("runtime_failed");
  });

  it("classifies command taxonomy for core command groups", () => {
    expect(deriveTelemetryCommandTaxonomy("create")).toMatchObject({
      command_root: "create",
      command_family: "mutation",
      command_depth: 1,
    });
    expect(deriveTelemetryCommandTaxonomy("list-open")).toMatchObject({
      command_root: "list-open",
      command_family: "query",
    });
    expect(deriveTelemetryCommandTaxonomy("config project set")).toMatchObject({
      command_root: "config",
      command_leaf: "set",
      command_family: "setup",
      command_depth: 3,
    });
    expect(deriveTelemetryCommandTaxonomy("test-all")).toMatchObject({
      command_family: "testing",
    });
  });
});
