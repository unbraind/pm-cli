import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runComments } from "../../../../src/cli/commands/annotations/comments.js";
import { runLearnings } from "../../../../src/cli/commands/annotations/learnings.js";
import { runNotes } from "../../../../src/cli/commands/annotations/notes.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import { applyReadOutputDimensions } from "../../../../src/sdk/read-output-contracts.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";
import { withTempPmPath, type TempPmContext } from "../../../helpers/withTempPmPath.js";

/**
 * pm-n98pir: a budgeted read shortens long entries to a prefix plus the
 * compaction marker. An edit built from that text would replace the stored
 * entry with the prefix, so the edit is refused and nothing is written.
 */

async function historyLineCount(context: TempPmContext, id: string): Promise<number> {
  const stream = await readFile(path.join(context.pmPath, "history", `${id}.jsonl`), "utf8");
  return stream.trim().split("\n").length;
}

async function refusal(promise: Promise<unknown>): Promise<PmCliError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PmCliError);
  return error as PmCliError;
}

const LONG_TEXT = `Release health 2026-11-11T09:00Z. ${"evidence ".repeat(400)}end.`;

describe("annotation edits refuse text copied from a compacted read (pm-n98pir)", () => {
  it.each([
    ["comments", runComments],
    ["notes", runNotes],
    ["learnings", runLearnings],
  ] as const)("refuses a one-word fix of a compacted %s entry and keeps the stored text", async (collection, run) => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: `Compacted ${collection}` });
      const global = { path: context.pmPath };
      await run(id, { add: LONG_TEXT }, global);
      const listed = (await run(id, {}, global)) as unknown as Record<string, unknown>;
      const bounded = applyReadOutputDimensions(collection, { outputBudget: 300 }, listed) as Record<string, unknown>;
      expect(bounded.read_output).toMatchObject({ strings_compacted: true });
      const compacted = (bounded[collection] as { text: string }[])[0]!.text;
      expect(compacted.endsWith(`…[+${LONG_TEXT.length - 240} chars]`)).toBe(true);
      const before = await historyLineCount(context, id);
      const error = await refusal(run(id, { edit: 1, add: compacted.replace("09:00Z", "10:00Z") }, global));
      expect(error.exitCode).toBe(EXIT_CODE.USAGE);
      expect(error.context).toMatchObject({
        code: "annotation_text_compacted",
        item_id: id,
        details: { collection, entry_index: 1, omitted_characters: LONG_TEXT.length - 240 },
      });
      expect(error.message).toContain("Nothing was written");
      expect(error.context.examples).toEqual([
        `pm ${collection} ${id} --output-budget unbounded --json`,
        `pm ${collection} ${id} --edit 1 --file <full-text-file>`,
      ]);
      expect(await historyLineCount(context, id)).toBe(before);
      const stored = (await run(id, {}, global)) as unknown as Record<string, { text: string }[]>;
      expect(stored[collection]![0]!.text).toBe(LONG_TEXT);
    });
  });

  it("accepts an edit of the full text and a genuine trailing ellipsis, and leaves appends alone", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Ellipsis edits" });
      const global = { path: context.pmPath };
      await runComments(id, { add: LONG_TEXT }, global);
      const fixed = LONG_TEXT.replace("09:00Z", "10:00Z");
      const edited = await runComments(id, { edit: 1, add: fixed }, global);
      expect(edited.comments[0]!.text).toBe(fixed);
      const ellipsis = await runComments(id, { edit: 1, add: "Waiting on the hosted runner…" }, global);
      expect(ellipsis.comments[0]!.text).toBe("Waiting on the hosted runner…");
      const quoted = await runComments(id, { add: "Quoting a compacted read: prefix…[+12 chars]" }, global);
      expect(quoted.comments[0]!.text).toBe("Quoting a compacted read: prefix…[+12 chars]");
    });
  });
});
