/**
 * pm-y26mvc: an annotation refusal for a swallowed source option retries as
 * the caller's own invocation without the text flag that took the option.
 */
import { describe, expect, it } from "vitest";
import { repairAnnotationOptionRecovery } from "../../../../src/cli/runtime/annotation-option-retry.js";

const CODE = "annotation_flag_like_value";
const PRODUCER = {
  suggested_flags: ["--file"],
  suggested_retry: "pm comments pm-one --file note.md",
  suggested_retry_args: ["comments", "pm-one", "--file", "note.md"],
};
const WITHDRAWN = { ...PRODUCER, suggested_retry: undefined, suggested_retry_args: undefined };

describe("pm-y26mvc annotation option retry replays the caller's command", () => {
  it("drops only the text flag, keeping tracker scope, output mode and every other option", () => {
    const argv = ["--pm-path", "../target/.agents/pm", "comments", "pm-one", "--add", "--file", "note.md", "--message", "why", "--json"];
    const repaired = repairAnnotationOptionRecovery(argv, CODE, "--add", PRODUCER);
    expect(repaired?.suggested_retry_args).toEqual(["--pm-path", "../target/.agents/pm", "comments", "pm-one", "--file", "note.md", "--message", "why", "--json"]);
    expect(repaired?.suggested_retry).toBe("pm --pm-path ../target/.agents/pm comments pm-one --file note.md --message why --json");
    expect(repaired?.suggested_flags).toEqual(["--file"]);
    expect(argv).toHaveLength(10);
  });

  it("unwraps an attached text-flag spelling into the option it carried", () => {
    const repaired = repairAnnotationOptionRecovery(["notes", "pm-one", "--add=--stdin"], CODE, "--add", { suggested_flags: ["--stdin"], suggested_retry_args: ["notes", "pm-one", "--stdin"] });
    expect(repaired?.suggested_retry_args).toEqual(["notes", "pm-one", "--stdin"]);
  });

  it("withdraws the retry when the typed argv does not hold exactly one swallowing pair", () => {
    // No pair: the option arrived through an alias the producer did not name.
    expect(repairAnnotationOptionRecovery(["comments", "pm-one", "--text", "--file", "note.md"], CODE, "--add", PRODUCER)).toEqual(WITHDRAWN);
    // Two pairs are ambiguous.
    expect(repairAnnotationOptionRecovery(["comments", "pm-one", "--add", "--file", "--add", "--file", "x"], CODE, "--add", PRODUCER)).toEqual(WITHDRAWN);
    // Tokens after `--` are operands, never options.
    expect(repairAnnotationOptionRecovery(["comments", "pm-one", "--", "--add", "--file"], CODE, "--add", PRODUCER)).toEqual(WITHDRAWN);
    // Dropping --add before the item id would make --file read the id as its path and retarget the append.
    const reordered = { suggested_flags: ["--file"], suggested_retry_args: ["comments", "pm-one", "--file", "pm-two"] };
    expect(repairAnnotationOptionRecovery(["item", "comments", "--add", "--file", "pm-one", "pm-two"], CODE, "--add", reordered)).toEqual({ ...reordered, suggested_retry: undefined, suggested_retry_args: undefined });
    // An earlier --add Commander overwrote would become a second text source.
    expect(repairAnnotationOptionRecovery(["comments", "pm-one", "--add", "hello", "--add", "--file", "note.md"], CODE, "--add", PRODUCER)).toEqual(WITHDRAWN);
    expect(repairAnnotationOptionRecovery(["comments", "pm-one", "--add=hello", "--add", "--file", "note.md"], CODE, "--add", PRODUCER)).toEqual(WITHDRAWN);
    // A producer retry that does not name the option is never trusted.
    expect(repairAnnotationOptionRecovery(["comments", "pm-one", "--add", "--file", "note.md"], CODE, "--add", { ...PRODUCER, suggested_retry_args: ["comments", "pm-one"] })).toEqual(WITHDRAWN);
    // A pair a namespace parent consumed before the annotation command would not dispatch it alone.
    const stdinProducer = { suggested_flags: ["--stdin"], suggested_retry_args: ["comments", "pm-one", "--stdin"] };
    expect(repairAnnotationOptionRecovery(["item", "--add=--stdin", "comments", "pm-one"], CODE, "--add", stdinProducer)).toEqual({ ...stdinProducer, suggested_retry: undefined, suggested_retry_args: undefined });
    expect(repairAnnotationOptionRecovery(["item", "notes", "pm-one", "--add", "--stdin"], CODE, "--add", stdinProducer)).toEqual({ ...stdinProducer, suggested_retry: undefined, suggested_retry_args: undefined });
    // Without a command token nothing can be placed.
    expect(repairAnnotationOptionRecovery(["--json"], CODE, "--add", PRODUCER)).toEqual(WITHDRAWN);
  });

  it("leaves other refusals, and producers that offered no retry, untouched", () => {
    const argv = ["comments", "pm-one", "--add", "--file", "note.md"];
    expect(repairAnnotationOptionRecovery(argv, "close_validation_missing_fields", "--add", PRODUCER)).toBe(PRODUCER);
    expect(repairAnnotationOptionRecovery(argv, CODE, undefined, PRODUCER)).toBe(PRODUCER);
    const noRetry = { suggested_flags: ["--file"] };
    expect(repairAnnotationOptionRecovery(argv, CODE, "--add", noRetry)).toBe(noRetry);
    const noFlag = { suggested_retry_args: ["comments"] };
    expect(repairAnnotationOptionRecovery(argv, CODE, "--add", noFlag)).toBe(noFlag);
    expect(repairAnnotationOptionRecovery(argv, CODE, "--add", undefined)).toBeUndefined();
  });
});
