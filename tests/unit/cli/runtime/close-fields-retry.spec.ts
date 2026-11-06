import { describe, expect, it } from "vitest";
import { repairCloseFieldsRecovery, type ParsedOptionArity } from "../../../../src/cli/runtime/close-fields-retry.js";

const CODE = "close_validation_missing_fields";
const MISSING = ["--resolution", "--expected-result", "--actual-result"];
const PRODUCER = {
  missing: MISSING,
  suggested_retry: "pm close pm-one --resolution \"<value>\"",
  suggested_retry_args: ["close", "pm-one", "--resolution", "<value>"],
  next_best_command: "pm update pm-one --resolution \"<value>\"",
};
const FILLED = ["--resolution", "<value>", "--expected-result", "<value>", "--actual-result", "<value>"];

const value = (long: string, short?: string): ParsedOptionArity => ({ long, short, required: true, optional: false });
const flag = (long: string, short?: string): ParsedOptionArity => ({ long, short, required: false, optional: false });

/** The parser's table for `pm close`, mirroring Commander's arity for each spelling. */
const CLOSE_OPTIONS: ParsedOptionArity[] = [
  flag("--json"), flag("--no-extensions"), value("--pm-path"), value("--path"), value("--expect-hash"), value("--author"),
  value("--reason", "-r"), value("--message", "-m"), value("--duplicate-of", "-d"), value("--completed-at"),
  { long: "--validate-close", required: false, optional: true },
  value("--resolution"), value("--expected-result"), value("--expected"), value("--actual-result"), value("--actual"),
  flag("--force"), flag("--release-assignment", "-a"), flag("--quiet", "-q"),
];

const repair = (argv: string[]) => repairCloseFieldsRecovery(argv, CODE, PRODUCER, CLOSE_OPTIONS);

describe("pm-gh1676 strict close retry replays the caller's close", () => {
  it("appends the missing flags to the exact invocation, preserving scope, output mode and the guard", () => {
    const argv = ["--no-extensions", "--pm-path", "../target/.agents/pm", "close", "pm-one", "Delivered by PR 7", "--validate-close", "strict", "--expect-hash", "pm-one=abc", "--json"];
    const repaired = repair(argv);
    expect(repaired?.suggested_retry_args).toEqual([...argv, ...FILLED]);
    expect(repaired?.suggested_retry).toContain('close pm-one "Delivered by PR 7" --validate-close strict --expect-hash pm-one=abc --json --resolution "<value>"');
    // The separate update stays available as the secondary route.
    expect(repaired?.next_best_command).toBe(PRODUCER.next_best_command);
    expect(argv).toHaveLength(11);
  });

  it("keeps short options, attached short values and boolean clusters, so a revision guard survives", () => {
    const argv = ["close", "pm-one", "Delivered", "-m", "audit", "-rReason", "-qa", "--expect-hash", "pm-one=abc", "--validate-close", "strict"];
    expect(repair(argv)?.suggested_retry_args).toEqual([...argv, ...FILLED]);
  });

  it("scans a short-only option by its short spelling", () => {
    const argv = ["close", "pm-one", "-x", "--resolution", "-xattached"];
    const options = [...CLOSE_OPTIONS, { short: "-x", required: true, optional: false }];
    expect(repairCloseFieldsRecovery(argv, CODE, PRODUCER, options)?.suggested_retry_args).toEqual([...argv, ...FILLED]);
  });

  it("replaces blank supplied values under every alias instead of repeating the flag", () => {
    const argv = ["close", "pm-one", "--resolution", "", "--expected=", "--actual", " ", "--json"];
    expect(repair(argv)?.suggested_retry_args).toEqual(["close", "pm-one", "--json", ...FILLED]);
  });

  it("consumes required values even when they look like flags or the terminator", () => {
    const argv = ["--pm-path", "--", "close", "pm-one", "--reason", "--actual-result", "-m", "--", "--json"];
    expect(repair(argv)?.suggested_retry_args).toEqual([...argv, ...FILLED]);
  });

  it("consumes an optional value only when the next token is not option-shaped", () => {
    // Commander reads: --validate-close (no value), --message "--resolution", --validate-close strict.
    const argv = ["close", "pm-one", "Delivered", "--validate-close", "--message", "--resolution", "--validate-close", "strict", "--validate-close", "-"];
    expect(repair(argv)?.suggested_retry_args).toEqual([...argv, ...FILLED]);
  });

  it("inserts the flags before a real -- terminator and keeps its literal operands", () => {
    const argv = ["close", "pm-one", "--json", "--", "--resolution"];
    expect(repairCloseFieldsRecovery(argv, CODE, { ...PRODUCER, missing: ["--resolution"] }, CLOSE_OPTIONS)?.suggested_retry_args).toEqual(["close", "pm-one", "--json", "--resolution", "<value>", "--", "--resolution"]);
  });

  it("keeps attached unknown long options, a lone dash operand and a trailing required option", () => {
    const argv = ["close", "pm-one", "-", "--extension-flag=value", "--author"];
    expect(repair(argv)?.suggested_retry_args).toEqual([...argv, ...FILLED]);
  });

  it("passes other refusals through and withdraws a retry it cannot prove instead of dropping the caller's tokens", () => {
    expect(repairCloseFieldsRecovery(["close", "pm-one"], "close_reason_required", PRODUCER, CLOSE_OPTIONS)).toBe(PRODUCER);
    expect(repairCloseFieldsRecovery(["close", "pm-one"], CODE, { ...PRODUCER, missing: [] }, CLOSE_OPTIONS)).toEqual({ ...PRODUCER, missing: [] });
    expect(repairCloseFieldsRecovery(["close", "pm-one"], CODE, undefined, CLOSE_OPTIONS)).toBeUndefined();
    const withdrawn = { ...PRODUCER, suggested_retry: undefined, suggested_retry_args: undefined };
    // No parser table, a command that does not declare the missing flags, an unknown option or short spelling.
    expect(repairCloseFieldsRecovery(["close", "pm-one"], CODE, PRODUCER, undefined)).toEqual(withdrawn);
    expect(repair(["list", "--json"])).toEqual(withdrawn);
    expect(repair(["close", "pm-one", "--extension-flag", "value", "--expect-hash", "pm-one=abc"])).toEqual(withdrawn);
    expect(repair(["close", "pm-one", "-z"])).toEqual(withdrawn);
    expect(repair(["close", "pm-one", "-qz"])).toEqual(withdrawn);
  });
});
