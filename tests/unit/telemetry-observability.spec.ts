import { describe, expect, it } from "vitest";
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
        errorCode: "lock_conflict",
        errorCategory: "conflict",
      }),
    ).toBe("conflict");
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
