import { describe, expect, it } from "vitest";
import { repairCloseFieldsRecovery } from "../../../../src/cli/runtime/close-fields-retry.js";

const CODE = "close_validation_missing_fields";
const MISSING = ["--resolution", "--expected-result", "--actual-result"];
const PRODUCER = {
  missing: MISSING,
  suggested_retry: "pm close pm-one --resolution \"<value>\"",
  suggested_retry_args: ["close", "pm-one", "--resolution", "<value>"],
  next_best_command: "pm update pm-one --resolution \"<value>\"",
};
const FILLED = ["--resolution", "<value>", "--expected-result", "<value>", "--actual-result", "<value>"];

describe("pm-gh1676 strict close retry replays the caller's close", () => {
  it("appends the missing flags to the exact invocation, preserving scope, output mode and the guard", () => {
    const argv = ["--no-extensions", "--pm-path", "../target/.agents/pm", "close", "pm-one", "Delivered by PR 7", "--validate-close", "strict", "--expect-hash", "pm-one=abc", "--json"];
    const repaired = repairCloseFieldsRecovery(argv, CODE, PRODUCER);
    expect(repaired?.suggested_retry_args).toEqual([...argv, ...FILLED]);
    expect(repaired?.suggested_retry).toContain('close pm-one "Delivered by PR 7" --validate-close strict --expect-hash pm-one=abc --json --resolution "<value>"');
    // The separate update stays available as the secondary route.
    expect(repaired?.next_best_command).toBe(PRODUCER.next_best_command);
    expect(argv).toHaveLength(11);
  });

  it("replaces blank supplied values under every alias instead of repeating the flag", () => {
    const argv = ["close", "pm-one", "--resolution", "", "--expected=", "--actual", " ", "--json"];
    expect(repairCloseFieldsRecovery(argv, CODE, PRODUCER)?.suggested_retry_args).toEqual(["close", "pm-one", "--json", ...FILLED]);
  });

  it("consumes declared option values, so a flag-looking value is never removed as a flag", () => {
    const argv = ["--pm-path", "--resolution", "close", "pm-one", "--reason", "--actual-result", "--json"];
    expect(repairCloseFieldsRecovery(argv, CODE, PRODUCER)?.suggested_retry_args).toEqual([...argv, ...FILLED]);
  });

  it("inserts the flags before a -- terminator and keeps its literal operands", () => {
    const argv = ["close", "pm-one", "--json", "--", "--resolution"];
    expect(repairCloseFieldsRecovery(argv, CODE, { ...PRODUCER, missing: ["--resolution"] })?.suggested_retry_args).toEqual(["close", "pm-one", "--json", "--resolution", "<value>", "--", "--resolution"]);
  });

  it("keeps the producer recovery when the retry cannot be proven from the invocation", () => {
    // Another refusal, no missing flags, or no command token.
    expect(repairCloseFieldsRecovery(["close", "pm-one"], "close_reason_required", PRODUCER)).toBe(PRODUCER);
    expect(repairCloseFieldsRecovery(["close", "pm-one"], CODE, { ...PRODUCER, missing: [] })).toEqual({ ...PRODUCER, missing: [] });
    expect(repairCloseFieldsRecovery(["close", "pm-one"], CODE, undefined)).toBeUndefined();
    expect(repairCloseFieldsRecovery(["--json"], CODE, PRODUCER)).toBe(PRODUCER);
    // A command that does not declare the missing flags itself.
    expect(repairCloseFieldsRecovery(["list", "--json"], CODE, PRODUCER)).toBe(PRODUCER);
    // An option whose arity no contract declares could hide an operand.
    expect(repairCloseFieldsRecovery(["close", "pm-one", "--extension-flag", "value"], CODE, PRODUCER)).toBe(PRODUCER);
  });

  it("keeps attached unknown options and a lone dash operand", () => {
    const argv = ["close", "pm-one", "-", "--extension-flag=value"];
    expect(repairCloseFieldsRecovery(argv, CODE, PRODUCER)?.suggested_retry_args).toEqual([...argv, ...FILLED]);
  });
});
