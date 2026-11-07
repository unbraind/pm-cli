/**
 * pm-y26mvc: `pm comments|notes|learnings <id> --add --file <path>` binds
 * `--file` as the annotation text and `<path>` as positional text. The CLI
 * refuses the swallowed option before the positional/--add conflict check and
 * names the option's own form.
 */
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerAnnotationCommands } from "../../../../src/cli/register-annotations.js";
import { createFlagLikeAnnotationValueRefusal } from "../../../../src/sdk/annotations.js";
import { EXIT_CODE, PmCliError } from "../../../../src/sdk/runtime-primitives.js";

const parsePositiveInteger = () => (value: string) => Number.parseInt(value, 10);

/** Parse one annotation invocation in-process; every case here refuses before any tracker read. */
async function refusal(argv: string[]): Promise<PmCliError> {
  const program = new Command().exitOverride();
  registerAnnotationCommands(program, parsePositiveInteger);
  const error = await program.parseAsync(argv, { from: "user" }).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PmCliError);
  return error as PmCliError;
}

describe("pm-y26mvc swallowed annotation source options", () => {
  it.each(["comments", "notes", "learnings"])("%s --add --file <path> names --file and offers the retry without --add", async (collection) => {
    const error = await refusal([collection, "pm-one", "--add", "--file", "note.md"]);
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(error.message).toContain("--add took --file as its value. Drop --add and pass --file <path> on its own.");
    expect(error.context).toMatchObject({
      code: "annotation_flag_like_value",
      field: "--add",
      examples: [`pm ${collection} pm-one --file <path>`, `pm ${collection} pm-one --add text=--file`],
      recovery: {
        suggested_flags: ["--file"],
        suggested_retry_args: [collection, "pm-one", "--file", "note.md"],
        suggested_retry: `pm ${collection} pm-one --file note.md`,
      },
    });
  });

  it("names a following operand that --stdin cannot be combined with, and offers no retry", async () => {
    const error = await refusal(["notes", "pm-one", "--add", "--stdin", "x"]);
    expect(error.message).toContain('Drop --add and pass --stdin on its own. "x" was read as positional text, which --stdin cannot be combined with');
    expect(error.context?.recovery).toBeUndefined();
    expect(error.context?.examples).toEqual(["pm notes pm-one --stdin", "pm notes pm-one --add text=--stdin"]);
  });

  it("retries --stdin and --file=<path> only without a trailing operand, and keeps an edit index", async () => {
    expect((await refusal(["learnings", "pm-one", "--add", "--stdin"])).context?.recovery?.suggested_retry_args).toEqual(["learnings", "pm-one", "--stdin"]);
    const attached = await refusal(["comments", "pm-one", "--edit", "2", "--add", "--file=note.md"]);
    expect(attached.context?.recovery?.suggested_retry_args).toEqual(["comments", "pm-one", "--edit", "2", "--file=note.md"]);
    expect(attached.context?.examples?.[0]).toBe("pm comments pm-one --edit 2 --file=note.md");
    expect((await refusal(["comments", "pm-one", "--add", "--file=note.md", "x"])).context?.recovery).toBeUndefined();
    // --file without an operand has no path to retry with.
    expect((await refusal(["comments", "pm-one", "--add", "--file"])).context?.recovery).toBeUndefined();
  });

  it("offers no retry when another source is already present, and refuses hidden aliases too", async () => {
    const withStdin = await refusal(["comments", "pm-one", "--stdin", "--body", "--file", "note.md"]);
    expect(withStdin.context).toMatchObject({ code: "annotation_flag_like_value", examples: ["pm comments pm-one --file <path>", "pm comments pm-one --body text=--file"] });
    expect(withStdin.context?.recovery).toBeUndefined();
    const withFile = await refusal(["notes", "pm-one", "--file", "a.md", "--note", "--stdin"]);
    expect(withFile.context?.recovery).toBeUndefined();
    // Another text alias or a structured event is a second source after --add is dropped.
    expect((await refusal(["comments", "pm-one", "--text", "hello", "--add", "--stdin"])).context?.recovery).toBeUndefined();
    expect((await refusal(["notes", "pm-one", "--add-json", "{}", "--add", "--stdin"])).context?.recovery).toBeUndefined();
    // Delete takes no text, so no retry with a text source is valid.
    expect((await refusal(["notes", "pm-one", "--delete", "1", "--add", "--stdin"])).context?.recovery).toBeUndefined();
    // --if-absent is append-only: an edit retry keeping it would be refused; edit alone keeps its retry.
    expect((await refusal(["comments", "pm-one", "--edit", "1", "--if-absent", "--add", "--file=README.md"])).context?.recovery).toBeUndefined();
    expect((await refusal(["comments", "pm-one", "--if-absent", "--add", "--file=README.md"])).context?.recovery?.suggested_retry_args).toEqual(["comments", "pm-one", "--file=README.md"]);
  });

  it("keeps the generic guidance for a swallowed option that is not a text source", async () => {
    const error = await refusal(["comments", "pm-one", "--add", "--json", "text"]);
    expect(error.message).toBe('--add value "--json" looks like an option, not annotation text. Use --stdin to read stdin, or use text=--json for literal dash-leading text.');
    expect(error.context?.recovery).toBeUndefined();
  });

  it("negative control: without the swallowed-option check the positional/--add conflict hides --file", async () => {
    vi.resetModules();
    vi.doMock("../../../../src/sdk/annotations.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../../../src/sdk/annotations.js")>()),
      isFlagLikeAnnotationValue: () => false,
    }));
    try {
      const { registerAnnotationCommands: register } = await import("../../../../src/cli/register-annotations.js");
      const program = new Command().exitOverride();
      register(program, parsePositiveInteger);
      await expect(program.parseAsync(["comments", "pm-one", "--add", "--file", "note.md"], { from: "user" })).rejects.toThrow(
        "Specify comment text either as positional [text] or with --add, not both",
      );
    } finally {
      vi.doUnmock("../../../../src/sdk/annotations.js");
      vi.resetModules();
    }
  });
});

describe("flag-like annotation value refusal", () => {
  it("names the source option's own form for direct callers", () => {
    const file = createFlagLikeAnnotationValueRefusal({ collectionKey: "notes", textFlag: "--add", value: " --file ", commandPrefix: "pm notes <id>" });
    expect(file.context).toMatchObject({
      code: "annotation_flag_like_value",
      required: 'Drop --add: --file <path> reads the note text from that file by itself. Use --add text=--file only when the text really is "--file".',
    });
    expect(file.context?.field).toBeUndefined();
    const stdin = createFlagLikeAnnotationValueRefusal({ collectionKey: "comments", textFlag: "--add", value: "--stdin", commandPrefix: "pm comments <id>", retryArgs: ["comments", "pm-one", "--stdin"] });
    expect(stdin.context).toMatchObject({ field: "--add", required: expect.stringContaining("--stdin reads the comment text from stdin by itself") });
    const generic = createFlagLikeAnnotationValueRefusal({ collectionKey: "learnings", textFlag: "--add", value: "-x", commandPrefix: "pm learnings <id>", conflictingOperand: "y" });
    expect(generic.message).not.toContain('"y"');
    expect(generic.context?.examples).toEqual(["pm learnings <id> --add -", "pm learnings <id> --add text=-x"]);
  });
});
