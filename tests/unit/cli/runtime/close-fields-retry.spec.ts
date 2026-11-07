import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const WITHDRAWN = { ...PRODUCER, suggested_retry: undefined, suggested_retry_args: undefined };

const repair = (argv: string[]) => repairCloseFieldsRecovery(argv, CODE, PRODUCER);

beforeEach(() => {
  // The suite runs with a sandbox PM_PATH; only the environment-selection case below sets one.
  vi.stubEnv("PM_PATH", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("pm-gh1676 strict close retry replays the caller's close", () => {
  it("appends the missing flags after every typed token, preserving scope, output mode and the guard", () => {
    const argv = ["--no-extensions", "--pm-path", "../target/.agents/pm", "close", "pm-one", "Delivered by PR 7", "-m", "audit", "-rReason", "--expect-hash", "pm-one=abc", "--validate-close", "--json"];
    const repaired = repair(argv);
    expect(repaired?.suggested_retry_args).toEqual([...argv, ...FILLED]);
    expect(repaired?.suggested_retry).toContain('close pm-one "Delivered by PR 7" -m audit -rReason --expect-hash pm-one=abc --validate-close --json --resolution "<value>"');
    // The separate update stays available as the secondary route.
    expect(repaired?.next_best_command).toBe(PRODUCER.next_best_command);
    expect(argv).toHaveLength(13);
  });

  it("keeps every revision guard the producer read, including those from an enclosing SDK scope", () => {
    const producer = { ...PRODUCER, suggested_retry_args: ["close", "pm-one", "--expect-hash=pm-one=abc", "--expect-hash=pm-dep=def", ...FILLED] };
    const repaired = repairCloseFieldsRecovery(["close", "pm-one", "--expect-hash=pm-one=abc", "--json"], CODE, producer);
    // A typed guard repeats at the same revision, which the binder accepts; nothing is matched against argv.
    expect(repaired?.suggested_retry_args).toEqual(["close", "pm-one", "--expect-hash=pm-one=abc", "--json", ...FILLED, "--expect-hash=pm-one=abc", "--expect-hash=pm-dep=def"]);
    expect(repairCloseFieldsRecovery(["close", "pm-one", "--expect-hash", "abc"], CODE, producer)?.suggested_retry_args).toEqual(["close", "pm-one", "--expect-hash", "abc", ...FILLED, "--expect-hash=pm-one=abc", "--expect-hash=pm-dep=def"]);
  });

  it("never mistakes a hash-valued message or reason for a typed guard", () => {
    const producer = { ...PRODUCER, suggested_retry_args: ["close", "pm-one", "--expect-hash=pm-dep=def", ...FILLED] };
    for (const argv of [["close", "pm-one", "--message=def"], ["close", "pm-one", "Done", "-m", "def"], ["close", "pm-one", "--reason=x=def"]]) {
      expect(repairCloseFieldsRecovery(argv, CODE, producer)?.suggested_retry_args).toEqual([...argv, ...FILLED, "--expect-hash=pm-dep=def"]);
    }
  });

  it("reads guards only from the producer's guard run, never from a tracker operand that looks like one", () => {
    const producer = { ...PRODUCER, suggested_retry_args: ["--pm-path", "--expect-hash=bad", "close", "pm-one", "--reason=--expect-hash=x", ...FILLED] };
    expect(repairCloseFieldsRecovery(["--pm-path=--expect-hash=bad", "close", "pm-one"], CODE, producer)?.suggested_retry_args).toEqual(["--pm-path=--expect-hash=bad", "close", "pm-one", ...FILLED]);
  });

  it("proposes no retry when the producer withdrew its own, as for conflicting nested revision guards", () => {
    const producerWithdrawn = { missing: MISSING, next_best_command: PRODUCER.next_best_command };
    expect(repairCloseFieldsRecovery(["close", "pm-one", "--json"], CODE, producerWithdrawn)).toBe(producerWithdrawn);
  });

  it("overrides blank supplied values by appending, since the parser keeps the last value of a repeated option", () => {
    const argv = ["close", "pm-one", "--resolution", "", "--expected=", "--actual", " ", "--json"];
    expect(repair(argv)?.suggested_retry_args).toEqual([...argv, ...FILLED]);
  });

  it("keeps every token when a global option's value sits between a command option and its value", () => {
    // The root parse takes --pm-path and its value; close then reads --resolution "".
    const argv = ["close", "pm-one", "Done", "--resolution", "--pm-path", "/tmp/target", "", "--validate-close", "strict", "--json"];
    expect(repair(argv)?.suggested_retry_args).toEqual([...argv, ...FILLED]);
  });

  it("places the flags right after the command token when a -- may end option parsing", () => {
    expect(repair(["--pm-path", "t", "close", "pm-one", "--json", "--", "literal"])?.suggested_retry_args).toEqual(["--pm-path", "t", "close", ...FILLED, "pm-one", "--json", "--", "literal"]);
    expect(repair(["--pm-path", "t", "close", "pm-one", "--reason", "--"])?.suggested_retry_args).toEqual(["--pm-path", "t", "close", ...FILLED, "pm-one", "--reason", "--"]);
    // A typed spelling of a missing field after the command could win over an inserted flag, so no retry is proposed.
    expect(repair(["close", "pm-one", "--expected=", "--", "literal"])).toEqual(WITHDRAWN);
  });

  it("prepends the tracker selection the parsed invocation did not spell itself", () => {
    expect(repairCloseFieldsRecovery(["close", "pm-one", "--json"], CODE, PRODUCER, ["--pm-path", "../elsewhere/.agents/pm"])?.suggested_retry_args).toEqual(["--pm-path", "../elsewhere/.agents/pm", "close", "pm-one", "--json", ...FILLED]);
    expect(repair(["--path=mine", "close", "pm-one"])?.suggested_retry_args).toEqual(["--path=mine", "close", "pm-one", ...FILLED]);
    // A selection the host cannot make binding withdraws the retry.
    expect(repairCloseFieldsRecovery(["close", "pm-one"], CODE, PRODUCER, null)).toEqual(WITHDRAWN);
  });

  it("passes other refusals through and withdraws a retry it cannot place instead of dropping the caller's tokens", () => {
    expect(repairCloseFieldsRecovery(["close", "pm-one"], "close_reason_required", PRODUCER)).toBe(PRODUCER);
    expect(repairCloseFieldsRecovery(["close", "pm-one"], CODE, { ...PRODUCER, missing: [] })).toEqual({ ...PRODUCER, missing: [] });
    expect(repairCloseFieldsRecovery(["close", "pm-one"], CODE, undefined)).toBeUndefined();
    // No command token, or a command (close-task, list) that does not declare the missing flags itself.
    expect(repair(["--json"])).toEqual(WITHDRAWN);
    expect(repair(["list", "--json"])).toEqual(WITHDRAWN);
  });
});
