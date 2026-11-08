/**
 * pm-rrwh2o: a hybrid read-and-mutate command given universal output
 * controls is refused with a stable typed code that names the controls, and
 * the CLI retries the caller's own invocation without them.
 */
import { describe, expect, it } from "vitest";
import { repairReadOutputMutationRecovery } from "../../../../src/cli/runtime/read-output-mutation-retry.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import { PM_ERROR_CODE_CATALOG } from "../../../../src/sdk/generated-error-code-catalog.js";
import {
  READ_OUTPUT_MUTATION_CONFLICT_CODE,
  READ_OUTPUT_SHAPING_CONTROL_FLAGS,
  validateReadOutputOptions,
} from "../../../../src/sdk/read-output-contracts.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const CODE = READ_OUTPUT_MUTATION_CONFLICT_CODE;

function refusal(command: string, options: Record<string, unknown>): PmCliError {
  try {
    validateReadOutputOptions(command, options);
  } catch (error) {
    return error as PmCliError;
  }
  throw new Error("expected a refusal");
}

describe("pm-rrwh2o typed refusal for a mutation given universal output controls", () => {
  it("carries a stable catalogued code, the offending controls and a retry without them", () => {
    expect(PM_ERROR_CODE_CATALOG.map(({ code }) => code)).toContain(CODE);
    const error = refusal("learnings", { add: "x", outputCursor: "bad", output_limit: 2 });
    expect(error.message).toBe("Universal output controls (--output-limit, --output-cursor) cannot be combined with a learnings mutation; nothing was written.");
    expect(error.exitCode).toBe(2);
    expect(error.context).toMatchObject({
      code: CODE,
      field: "--output-limit",
      details: {
        surface: "learnings",
        output_controls: ["--output-limit", "--output-cursor"],
        output_option_keys: ["output_limit", "outputCursor"],
        mutation_options: ["add"],
      },
      required: expect.stringContaining("without --output-limit, --output-cursor"),
      examples: ['pm learnings <id> --add "<text>"', "pm learnings <id> --output-limit 5"],
    });
    expect(error.context?.why).toEqual(expect.any(String));
  });

  it.each(["comments", "notes", "learnings", "files", "docs", "package-catalog"])("names runnable examples for the %s surface", (surface) => {
    const key = surface === "package-catalog" ? "install" : "add";
    const error = refusal(surface, { [key]: "x", outputRowContract: true });
    expect(error.context?.code).toBe(CODE);
    expect(error.context?.details).toMatchObject({ output_controls: ["--output-row-contract"], mutation_options: [key] });
    expect(error.context?.examples).toHaveLength(2);
    for (const example of error.context!.examples!) expect(example.startsWith("pm ")).toBe(true);
  });

  it("leaves reads, format-only selections and non-hybrid surfaces alone", () => {
    expect(() => validateReadOutputOptions("comments", { limit: "5", outputBudget: 500 })).not.toThrow();
    expect(() => validateReadOutputOptions("comments", { add: "x", outputFormat: "json" })).not.toThrow();
    expect(() => validateReadOutputOptions("comments", { add: false, outputLimit: 1 })).not.toThrow();
    expect(() => validateReadOutputOptions("list", { add: "x", outputLimit: 1 })).not.toThrow();
  });
});

describe("pm-rrwh2o CLI retry replays the caller's invocation without the controls", () => {
  it("drops every control token and the value it consumed, keeping scope, operands and other flags", () => {
    const argv = ["--pm-path", "../t/.agents/pm", "item", "comments", "pm-one", "--add", "300", "--output-budget", "300", "--output-cursor=abc", "--output-row-contract", "--message", "why", "--json"];
    const repaired = repairReadOutputMutationRecovery(argv, CODE, { attempted_command: "pm ..." });
    // Only the control's own value goes: the comment text "300" stays.
    expect(repaired?.suggested_retry_args).toEqual(["--pm-path", "../t/.agents/pm", "item", "comments", "pm-one", "--add", "300", "--message", "why", "--json"]);
    expect(repaired?.suggested_retry).toBe("pm --pm-path ../t/.agents/pm item comments pm-one --add 300 --message why --json");
    expect(repaired?.attempted_command).toBe("pm ...");
    expect(argv).toHaveLength(14);

  });

  it("binds an environment-selected tracker and resolves bare and namespaced command paths", () => {
    expect(repairReadOutputMutationRecovery(["learnings", "pm-one", "--add", "x", "--output-limit", "3"], CODE, undefined, ["--pm-path", "/srv/t"])).toEqual({
      suggested_retry: "pm --pm-path /srv/t learnings pm-one --add x",
      suggested_retry_args: ["--pm-path", "/srv/t", "learnings", "pm-one", "--add", "x"],
    });
    expect(repairReadOutputMutationRecovery(["files", "pm-one", "--add", "path=a.ts", "--output-limit=2"], CODE, undefined)?.suggested_retry_args).toEqual([
      "files",
      "pm-one",
      "--add",
      "path=a.ts",
    ]);
  });

  it("withholds the retry when the argv is ambiguous, names no control or cannot bind its tracker", () => {
    const producer = { attempted_command: "pm x", suggested_retry: "stale", suggested_retry_args: ["stale"] };
    const withheld = { attempted_command: "pm x", suggested_retry: undefined, suggested_retry_args: undefined };
    // An unknown flag leaves the value arity ambiguous.
    expect(repairReadOutputMutationRecovery(["comments", "pm-one", "--unknown-flag", "--output-limit", "2"], CODE, producer)).toEqual(withheld);
    // No control token: nothing to drop.
    expect(repairReadOutputMutationRecovery(["comments", "pm-one", "--add", "x"], CODE, producer)).toEqual(withheld);
    expect(repairReadOutputMutationRecovery(["comments", "pm-one", "--add", "x"], CODE, undefined)).toBeUndefined();
    // A tracker selection that cannot be made binding.
    expect(repairReadOutputMutationRecovery(["comments", "pm-one", "--output-limit", "2"], CODE, producer, null)).toEqual(withheld);
    // A command path that is only flags, or a namespace whose next token is a flag.
    expect(repairReadOutputMutationRecovery(["--json"], CODE, producer)).toEqual(withheld);
    expect(repairReadOutputMutationRecovery(["comments", "--output-limit", "2"], CODE, undefined)?.suggested_retry_args).toEqual(["comments"]);
    // Codex review of PR #1688: global normalization lets --output-limit swallow --pm-path, leaving the
    // tracker path as the --message value. Rebuilding a retry would replay that misparse as a clean
    // write to the environment tracker, so a control that took a flag-like token withholds the retry.
    const misparsed = ["item", "comments", "pm-one", "--add", "kept", "--message", "--output-limit", "--pm-path", "/tmp/A", "--output-budget", "500", "--json"];
    expect(repairReadOutputMutationRecovery(misparsed, CODE, producer)).toEqual(withheld);
    expect(repairReadOutputMutationRecovery(["comments", "pm-one", "x", "--output-limit", "--output-budget", "5"], CODE, producer)).toEqual(withheld);
    // Greptile review of PR #1688: a control right after a value-taking option may be that option's value.
    expect(repairReadOutputMutationRecovery(["comments", "pm-one", "--add", "x", "--message", "--output-budget=300", "--output-limit", "2"], CODE, producer)).toEqual(withheld);
    expect(repairReadOutputMutationRecovery(["learnings", "pm-one", "--add", "--output-limit", "2"], CODE, producer)).toEqual(withheld);
    // An inline value or a boolean flag before the control leaves no ambiguity.
    expect(repairReadOutputMutationRecovery(["comments", "pm-one", "--message=why", "--add", "x", "--json", "--output-limit", "2"], CODE, undefined)?.suggested_retry_args).toEqual([
      "comments",
      "pm-one",
      "--message=why",
      "--add",
      "x",
      "--json",
    ]);
    // A control before the command, or last with nothing left to consume, is dropped alone.
    expect(repairReadOutputMutationRecovery(["--output-limit", "2", "comments", "pm-one", "--add", "x"], CODE, undefined)?.suggested_retry_args).toEqual(["comments", "pm-one", "--add", "x"]);
    expect(repairReadOutputMutationRecovery(["comments", "pm-one", "x", "--output-limit"], CODE, undefined)?.suggested_retry_args).toEqual(["comments", "pm-one", "x"]);
    // Other refusals are never touched.
    expect(repairReadOutputMutationRecovery(["comments", "pm-one", "--output-limit", "2"], "other_code", producer)).toBe(producer);
    expect(READ_OUTPUT_SHAPING_CONTROL_FLAGS).not.toContain("--output-format");
  });

  it("withholds the CLI retry for a misparsed two-tracker invocation and writes to neither tracker", async () => {
    await withTempPmPath(async (environment) => {
      await withTempPmPath(async (explicit) => {
        const id = createTestItemId(environment, { title: "Environment tracker item" });
        const refused = environment.runCli(["comments", id, "--add", "kept", "--message", "--output-limit", "--pm-path", explicit.pmPath, "--output-budget", "500", "--json"]);
        expect(refused.code).toBe(2);
        const body = JSON.parse(refused.stdout || refused.stderr) as { code: string; recovery?: { suggested_retry_args?: string[] } };
        expect(body.code).toBe(CODE);
        expect(body.recovery?.suggested_retry_args).toBeUndefined();
        const listed = environment.runCli(["comments", id, "--json"], { expectJson: true }).json as { comments: unknown[] };
        expect(listed.comments).toEqual([]);
      });
    });
  }, 60_000);

  it("refuses through the CLI with the typed code and a retry that runs", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Mutation with output controls" });
      const refused = context.runCli(["learnings", id, "--add", "kept", "--output-limit", "3", "--json"]);
      expect(refused.code).toBe(2);
      const body = JSON.parse(refused.stdout || refused.stderr) as { code: string; details: Record<string, unknown>; recovery: { suggested_retry_args: string[] } };
      expect(body.code).toBe(CODE);
      expect(body.details).toMatchObject({ output_controls: ["--output-limit"], mutation_options: ["add"] });
      const retryArgs = body.recovery.suggested_retry_args;
      expect(retryArgs).not.toContain("--output-limit");
      expect(retryArgs).toContain("kept");
      expect(context.runCli(retryArgs.filter((token) => token !== "--json").concat("--json")).code).toBe(0);
      const listed = context.runCli(["learnings", id, "--json"], { expectJson: true }).json as { learnings: Array<{ text: string }> };
      expect(listed.learnings.map(({ text }) => text)).toEqual(["kept"]);
    });
  }, 60_000);
});
