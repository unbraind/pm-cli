/**
 * pm-y26mvc: `pm comments|notes|learnings <id> --add --file <path>` refuses the
 * swallowed --file before the positional/--add conflict, and the executable
 * retry it prescribes appends the file's text to the same item.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

interface AnnotationRefusal {
  code: string;
  detail: string;
  examples: string[];
  recovery?: { suggested_retry?: string; suggested_retry_args?: string[] };
}

function run(context: TempPmContext, args: string[], input?: string) {
  // The caller's exact argv: no harness-injected mutation output flags.
  return context.runCli(args, { cwd: context.tempRoot, preserveDefaultMutationOutput: true, ...(input === undefined ? {} : { input }) });
}

function refused(context: TempPmContext, args: string[]): AnnotationRefusal {
  const result = run(context, args);
  expect(result.code).toBe(EXIT_CODE.USAGE);
  return JSON.parse(result.stderr) as AnnotationRefusal;
}

describe("pm-y26mvc swallowed annotation source option", () => {
  it.each(["comments", "notes", "learnings"])("%s --add --file <path> refuses with the swallowed option named, and its retry appends the file", async (collection) => {
    await withTempPmPath(async (context) => {
      expect(run(context, ["create", "Task", "Swallowed option", "--id", "swallow", "--json"]).code).toBe(0);
      await writeFile(path.join(context.tempRoot, "note.md"), "from the file\n", "utf8");

      const refusal = refused(context, [collection, "pm-swallow", "--add", "--file", "note.md", "--message", "why", "--json"]);
      expect(refusal).toMatchObject({ code: "annotation_flag_like_value", examples: [`pm ${collection} pm-swallow --file <path>`, `pm ${collection} pm-swallow --add text=--file`] });
      expect(refusal.detail).toContain("Drop --add and pass --file <path> on its own.");
      const retry = refusal.recovery?.suggested_retry_args;
      expect(retry).toBeDefined();
      expect(retry).not.toContain("--add");
      expect(retry!.slice(-5)).toEqual(["--file", "note.md", "--message", "why", "--json"]);

      const replayed = run(context, retry!);
      expect(replayed.code).toBe(0);
      const entries = (JSON.parse(replayed.stdout) as Record<string, Array<{ text: string }>>)[collection]!;
      // Comments keep the file verbatim; notes and learnings store trimmed text.
      expect(entries.at(-1)?.text.trimEnd()).toBe("from the file");
    });
  });

  it("refuses --add --stdin <operand> with the operand named and no retry, and retries --add --stdin through stdin", async () => {
    await withTempPmPath(async (context) => {
      expect(run(context, ["create", "Task", "Swallowed stdin", "--id", "stdin", "--json"]).code).toBe(0);
      const withOperand = refused(context, ["notes", "pm-stdin", "--add", "--stdin", "x", "--json"]);
      expect(withOperand.code).toBe("annotation_flag_like_value");
      expect(withOperand.detail).toContain('"x" was read as positional text, which --stdin cannot be combined with');
      expect(withOperand.recovery?.suggested_retry).toBeUndefined();

      const bare = refused(context, ["learnings", "pm-stdin", "--add", "--stdin", "--json"]);
      const replayed = run(context, bare.recovery!.suggested_retry_args!, "from stdin\n");
      expect(replayed.code).toBe(0);
      expect((JSON.parse(replayed.stdout) as { learnings: Array<{ text: string }> }).learnings.at(-1)?.text).toBe("from stdin");
    });
  });
});
