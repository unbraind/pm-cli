import { describe, expect, it } from "vitest";
import {
  _testOnly,
  createUnknownSubcommandError,
} from "../../../src/sdk/agent/subcommand-recovery.js";

describe("unknown subcommand recovery", () => {
  it("preserves a complete sorted vocabulary and trailing retry arguments", () => {
    const error = createUnknownSubcommandError({
      command_path: "schema",
      token: "add-typ",
      allowed: ["show", "add-type", "list", "add-type"],
      trailing_args: ["Example Project"],
    });

    expect(error).toMatchObject({
      code: "unknown_subcommand",
      exitCode: 2,
      context: {
        reason: "unknown_positional_token",
        recovery: {
          attempted_command: 'pm schema add-typ "Example Project"',
          allowed_values: ["add-type", "list", "show"],
          suggested_retry: 'pm schema add-type "Example Project"',
        },
      },
    });
  });

  it("omits a misleading retry when no declared value is nearby", () => {
    const error = createUnknownSubcommandError({
      command_path: "profile",
      token: "completely-different",
      allowed: ["apply", "lint", "list", "show"],
    });

    expect(error.context.recovery).toMatchObject({
      attempted_command: "pm profile completely-different",
      allowed_values: ["apply", "lint", "list", "show"],
    });
    expect(error.context.recovery?.suggested_retry).toBeUndefined();
  });

  it("rejects incomplete refusal declarations", () => {
    expect(() =>
      createUnknownSubcommandError({
        command_path: " ",
        token: "bad",
        allowed: ["list"],
      }),
    ).toThrow(TypeError);
  });

  it("supports family-aware compatibility labels and retry overrides", () => {
    const error = createUnknownSubcommandError({
      command_path: "workspace snapshot",
      display_name: "workspace snapshot",
      token_kind: "action",
      token: "ls",
      allowed: ["create", "list"],
      retry_command: "pm workspace snapshot list",
    });
    expect(error.message).toContain('Unknown workspace snapshot action "ls"');
    expect(error.context.recovery?.suggested_retry).toBe(
      "pm workspace snapshot list",
    );
  });

  it("covers empty and equal-distance nearest-match decisions", () => {
    expect(_testOnly.nearestSubcommand(" ", ["list"])).toBeUndefined();
    expect(_testOnly.nearestSubcommand("cat", ["car", "bat"])).toBe("bat");
  });
});
