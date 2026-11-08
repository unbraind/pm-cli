import { describe, expect, it } from "vitest";
import { annotationPositionalMutationOptions } from "../../../src/cli/register-annotations.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

/**
 * Codex review of PR #1685: positional annotation text is a mutation the
 * read-output guard never saw, so `pm learnings <id> "text" --output-budget 1`
 * appended the entry and then failed the budget, and a retry appended again.
 */
describe("positional annotation text with universal output controls", () => {
  it("exposes only an annotation command's text slot as the add mutation key", () => {
    expect(annotationPositionalMutationOptions("learnings", ["pm-1", "text"])).toEqual({ add: "text" });
    expect(annotationPositionalMutationOptions("comments", ["pm-1", "text"])).toEqual({ add: "text" });
    expect(annotationPositionalMutationOptions("notes", ["pm-1"])).toEqual({});
    expect(annotationPositionalMutationOptions("notes", ["pm-1", undefined])).toEqual({});
    expect(annotationPositionalMutationOptions("get", ["pm-1", "text"])).toEqual({});
  });

  it.each(["comments", "notes", "learnings"] as const)(
    "refuses %s positional text with an output budget before anything is written",
    async (command) => {
      await withTempPmPath(async (context) => {
        const id = createTestItemId(context, { title: `Positional ${command}` });
        const refused = context.runCli([command, id, "must not be written", "--output-budget", "1", "--json"]);
        expect(refused.code).toBe(2);
        expect(`${refused.stdout}${refused.stderr}`).toContain(`cannot be combined with a ${command} mutation`);
        const listed = context.runCli([command, id, "--json"], { expectJson: true }).json as Record<string, Array<{ text: string }>>;
        expect(listed[command]!.map((row) => row.text)).not.toContain("must not be written");
        const appended = context.runCli([command, id, "written without output controls", "--json"]);
        expect(appended.code).toBe(0);
        const read = context.runCli([command, id, "--output-budget", "600", "--json"], { expectJson: true }).json as Record<
          string,
          Array<{ index: number; text: string }>
        >;
        expect(read[command]!.at(-1)).toMatchObject({ text: "written without output controls" });
      });
    },
  );
});
