import { describe, expect, it } from "vitest";
import { runComments } from "../../../src/cli/commands/annotations/comments.js";
import { runLearnings } from "../../../src/cli/commands/annotations/learnings.js";
import { runNotes } from "../../../src/cli/commands/annotations/notes.js";
import { decodeReadOutputContinuationCursor } from "../../../src/sdk/read-output-contracts.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

/**
 * pm-8s53lj regression through the built CLI: a bare comments, notes or
 * learnings read that exceeds the default output budget delivers the newest
 * entry in JSON and TOON, reports the complete total, and pages backwards.
 */

const ENTRIES = 40;
const RUNNERS = {
  comments: runComments,
  notes: runNotes,
  learnings: runLearnings,
} as const;

async function seed(context: TempPmContext, command: keyof typeof RUNNERS, id: string): Promise<void> {
  for (let index = 1; index <= ENTRIES; index += 1) {
    await RUNNERS[command](id, { add: `${command} entry ${index} ${"x".repeat(320)}` }, { path: context.pmPath });
  }
}

describe("bare annotation reads keep the newest entries through the CLI (pm-8s53lj)", () => {
  it.each(Object.keys(RUNNERS) as Array<keyof typeof RUNNERS>)(
    "bounds a bare %s read to the newest entries in JSON and TOON and pages backwards",
    async (command) => {
      await withTempPmPath(async (context) => {
        const id = createTestItemId(context, { title: `Bare ${command} read` });
        await seed(context, command, id);

        const json = context.runCli([command, id, "--json"], { expectJson: true }).json as Record<string, unknown>;
        const rows = json[command] as Array<{ index: number; text: string }>;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBeLessThan(ENTRIES);
        expect(rows.at(-1)).toMatchObject({ index: ENTRIES });
        expect(rows.at(-1)!.text.startsWith(`${command} entry ${ENTRIES} `)).toBe(true);
        expect(json).toMatchObject({ count: rows.length, total_count: ENTRIES, has_more: true, continuation_kind: "output_cursor" });
        const cursor = decodeReadOutputContinuationCursor(String(json.next_cursor));
        expect(cursor).toMatchObject({ command, direction: "backward", offset: ENTRIES - rows.length, total_rows: ENTRIES });

        const older = context.runCli([command, id, "--json", "--output-cursor", String(json.next_cursor)], { expectJson: true })
          .json as Record<string, unknown>;
        const olderRows = older[command] as Array<{ index: number }>;
        expect(olderRows.at(-1)!.index).toBe(rows[0]!.index - 1);
        expect(older).toMatchObject({ count: olderRows.length, total_count: ENTRIES });

        const toon = context.runCli([command, id]);
        expect(toon.code).toBe(0);
        expect(toon.stdout).toContain(`${command} entry ${ENTRIES} `);
        expect(toon.stdout).not.toContain(`${command} entry 1 `);
        expect(toon.stdout).toMatch(new RegExp(`^total_count: ${ENTRIES}$`, "mu"));
        const toonCursor = /^next_cursor: "?([^"\n]+)"?$/mu.exec(toon.stdout)?.[1];
        expect(toonCursor).toBeDefined();
        expect(decodeReadOutputContinuationCursor(toonCursor!)).toMatchObject({ command, direction: "backward" });
        const olderToon = context.runCli([command, id, "--output-cursor", toonCursor!]);
        expect(olderToon.code).toBe(0);
        const newestDelivered = rows[0]!.index;
        expect(olderToon.stdout).toContain(`${command} entry ${newestDelivered - 1} `);
        expect(olderToon.stdout).not.toContain(`${command} entry ${ENTRIES} `);
      });
    },
    120_000,
  );
});
