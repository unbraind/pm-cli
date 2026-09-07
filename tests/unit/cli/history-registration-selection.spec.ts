/** @module tests/unit/cli/history-registration-selection
 * Keeps maintenance registration and recovery tied to the selected command.
 */
import { describe, expect, it } from "vitest";
import { _testOnly } from "../../../src/cli/main.js";

describe("history maintenance registration selection", () => {
  it("loads only mutation registrations for each legacy maintenance command", () => {
    for (const command of ["history-repair", "history-redact", "history-compact"]) {
      expect(_testOnly.resolveCoreCommandRegistrationSelection([command])).toEqual({
        setup: false,
        listQuery: false,
        mutation: true,
        operation: false,
        targetCommandName: command,
      });
    }
  });

  it("preserves unrelated recovery when redaction names occur in argument values", () => {
    const recovery = {
      recovery_mode: "compact" as const,
      attempted_command: "pm create --title original",
      normalized_args: ["create", "--title", "original"],
      suggested_retry: "pm create --create-mode progressive",
      suggested_retry_args: ["create", "--create-mode", "progressive"],
    };
    for (const argv of [
      ["create", "--title", "history-redact"],
      ["create", "--title", "history", "--description", "redact"],
      ["history", "pm-example", "--author", "redact"],
      ["--author", "history-redact", "create", "--title", "ordinary"],
      [],
    ]) {
      expect(_testOnly.buildPmCliRecoveryContext({ recovery }, argv, "Invalid input").recovery).toEqual(recovery);
    }
  });

  it("sanitizes actual redaction recovery around global options and parse failures", () => {
    const canary = "recovery-boundary-canary";
    for (const command of [
      ["--json", "history", "--author", "someone", "redact"],
      ["--unknown", "history-redact"],
      ["history", "--json", "redact"],
      ["history-redact"],
    ]) {
      const argv = [...command, "pm-example", `--literal=${canary}`];
      const recovery = {
        recovery_mode: "compact" as const,
        attempted_command: `pm history-redact pm-example --literal=${canary}`,
        normalized_args: argv,
        suggested_retry: `pm history-redact pm-example --literal=${canary}`,
        suggested_retry_args: argv,
      };
      const context = _testOnly.buildPmCliRecoveryContext({ recovery }, argv, "Invalid input");
      expect(JSON.stringify(context)).not.toContain(canary);
      expect(context.recovery?.suggested_retry_args).toContain("--literal=[redacted]");
    }
  });
});
