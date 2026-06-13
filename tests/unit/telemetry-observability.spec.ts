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
        ok: true,
        errorCode: "unknown_command",
      }),
    ).toBeUndefined();
    expect(
      inferTelemetryErrorCode({
        ok: false,
        errorCode: "  CUSTOM_ERROR  ",
      }),
    ).toBe("custom_error");
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
        errorMessage: "Unknown option --bogus",
      }),
    ).toBe("unknown_option");
    expect(
      inferTelemetryErrorCode({
        ok: false,
        errorMessage: "Missing required argument <id>",
      }),
    ).toBe("missing_required_argument");
    expect(
      inferTelemetryErrorCode({
        ok: false,
        errorMessage: "Item pm-a1b2 is assigned to another-agent; use --force to override.",
      }),
    ).toBe("ownership_conflict");
    expect(
      inferTelemetryErrorCode({
        ok: false,
        errorMessage: "Item pm-a1b2 is locked by another process.",
      }),
    ).toBe("lock_conflict");
    expect(
      inferTelemetryErrorCode({
        ok: false,
        errorMessage: "Item pm-a1b2 not found",
      }),
    ).toBe("item_not_found");
    expect(
      inferTelemetryErrorCode({
        ok: false,
        errorMessage: "Provide either as positional argument or --id, not both.",
      }),
    ).toBe("invalid_command_usage");
    expect(
      inferTelemetryErrorCode({
        ok: false,
        errorMessage: "Strict create mode requires concrete values for --title.",
      }),
    ).toBe("invalid_argument_value");
    expect(
      inferTelemetryErrorCode({
        ok: false,
        exitCode: EXIT_CODE.USAGE,
      }),
    ).toBe("invalid_command_usage");
    expect(
      inferTelemetryErrorCode({
        ok: false,
        exitCode: EXIT_CODE.NOT_FOUND,
      }),
    ).toBe("item_not_found");
    expect(
      inferTelemetryErrorCode({
        ok: false,
        exitCode: EXIT_CODE.CONFLICT,
      }),
    ).toBe("lock_conflict");
    expect(
      inferTelemetryErrorCode({
        ok: false,
        exitCode: EXIT_CODE.DEPENDENCY_FAILED,
      }),
    ).toBe("dependency_failed");
    expect(
      inferTelemetryErrorCode({
        ok: false,
        exitCode: Number.NaN,
      }),
    ).toBe("command_failed");
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
        errorCode: "missing_required_option",
        errorCategory: "usage",
      }),
    ).toBe("missing_required_option");
    expect(
      deriveTelemetryCommandResolution({
        ok: false,
        errorCode: "missing_required_argument",
        errorCategory: "usage",
      }),
    ).toBe("missing_required_argument");
    expect(
      deriveTelemetryCommandResolution({
        ok: false,
        errorCategory: "usage",
      }),
    ).toBe("invalid_usage");
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
    expect(
      deriveTelemetryCommandResolution({
        ok: false,
      }),
    ).toBe("unknown_failed");
  });

  it("classifies command taxonomy for core command groups", () => {
    expect(deriveTelemetryCommandTaxonomy("   ")).toMatchObject({
      command_path: "<unknown>",
      command_root: "<unknown>",
      command_leaf: "<unknown>",
      command_family: "other",
    });
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
    expect(deriveTelemetryCommandTaxonomy("extension install")).toMatchObject({
      command_root: "extension",
      command_leaf: "install",
      command_family: "extension",
    });
    expect(deriveTelemetryCommandTaxonomy("telemetry status")).toMatchObject({
      command_root: "telemetry",
      command_leaf: "status",
      command_family: "diagnostics",
    });
    expect(deriveTelemetryCommandTaxonomy("custom command")).toMatchObject({
      command_root: "custom",
      command_leaf: "command",
      command_family: "other",
    });
  });
});
