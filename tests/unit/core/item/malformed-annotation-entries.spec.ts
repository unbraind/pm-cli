import { appendFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runComments } from "../../../../src/cli/commands/annotations/comments.js";
import { compareLogValues } from "../../../../src/core/item/item-format.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import type { Comment } from "../../../../src/types/index.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

/**
 * pm-30tjoh: a malformed comments, notes or learnings entry used to crash
 * every read of its item (sortLogValues called localeCompare on a missing
 * text), surfacing as an unknown_error and an unexpected Sentry fault
 * (PM-CLI-3Y). Reads now tolerate it and deliver it as stored.
 */

const MALFORMED_COLLECTIONS = ["comments", "notes", "learnings"] as const;

describe("malformed stored annotation entries (pm-30tjoh)", () => {
  it("orders malformed entries deterministically instead of throwing", () => {
    const valid = { created_at: "2026-11-08T00:00:00.000Z", author: "a", text: "valid" } as Comment;
    const malformed = ["just-a-string", 42, null, { created_at: "2026-11-07T00:00:00.000Z", author: "b" }] as unknown as Comment[];
    const sorted = [valid, ...malformed].sort(compareLogValues);
    expect(sorted.at(-1)).toBe(valid);
    expect(compareLogValues(malformed[0]!, malformed[2]!)).toBe(0);
  });

  it.each(MALFORMED_COLLECTIONS)("reads, appends to and guards a %s collection holding malformed entries", async (collection) => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: `Malformed ${collection}` });
      await appendFile(
        path.join(context.pmPath, "tasks", `${id}.toon`),
        `${collection}[3]:\n  - just-a-string\n  - 42\n  - created_at: "2026-11-07T00:00:00.000Z"\n    author: someone\n`,
        "utf8",
      );
      const listed = context.runCli([collection, id, "--json"], { expectJson: true });
      expect(listed.code).toBe(0);
      const rows = (listed.json as Record<string, unknown[]>)[collection]!;
      expect(rows).toHaveLength(3);
      expect(rows).toEqual(expect.arrayContaining(["just-a-string", 42]));
      expect(context.runCli(["get", id, "--json"], { expectJson: true }).code).toBe(0);
      const appended = context.runCli([collection, id, "a valid entry", "--json"], { expectJson: true });
      expect(appended.code).toBe(0);
      const after = context.runCli([collection, id, "--json"], { expectJson: true }).json as Record<string, unknown[]>;
      expect(after[collection]).toHaveLength(4);
      expect(after[collection]).toEqual(expect.arrayContaining([expect.objectContaining({ text: "a valid entry" })]));
    });
  });

  it("refuses a guarded edit of a malformed entry with the typed mismatch, not a TypeError", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Guarded malformed edit" });
      await appendFile(path.join(context.pmPath, "tasks", `${id}.toon`), "comments[1]: null\n", "utf8");
      const error = await runComments(
        id,
        { edit: 1, add: "replacement", expectAt: "2026-11-07T00:00:00.000Z" },
        { path: context.pmPath },
      ).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(PmCliError);
      expect((error as PmCliError).context).toMatchObject({
        code: "annotation_entry_mismatch",
        details: { actual_created_at: null, matching_indexes: [] },
      });
      expect((error as PmCliError).message).toContain("an unrecorded time (malformed entry)");
    });
  });
});
