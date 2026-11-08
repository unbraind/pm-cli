import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runComments } from "../../../../src/cli/commands/annotations/comments.js";
import { runAnnotationCommand } from "../../../../src/sdk/annotations.js";
import { runLearnings } from "../../../../src/cli/commands/annotations/learnings.js";
import { runNotes } from "../../../../src/cli/commands/annotations/notes.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";
import { withTempPmPath, type TempPmContext } from "../../../helpers/withTempPmPath.js";

/**
 * pm-hka7ep: annotation rows carry their absolute one-based index, and
 * --edit/--delete can prove they address the entry the caller read.
 */

async function seedComments(context: TempPmContext, id: string, count: number): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await runComments(id, { add: `comment ${index}` }, { path: context.pmPath });
  }
}

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

describe("annotation entry addressing (pm-hka7ep)", () => {
  it("indexes listing, limited, receipt and full-history rows by absolute position", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Indexed comments" });
      await seedComments(context, id, 4);
      const listed = await runComments(id, {}, { path: context.pmPath });
      expect(listed.comments.map((row) => row.index)).toEqual([1, 2, 3, 4]);
      expect(Object.keys(listed.comments[0]!)[0]).toBe("index");
      const limited = await runComments(id, { limit: "2" }, { path: context.pmPath });
      expect(limited.comments.map((row) => [row.index, row.text])).toEqual([
        [3, "comment 3"],
        [4, "comment 4"],
      ]);
      const appended = await runComments(id, { add: "comment 5" }, { path: context.pmPath });
      expect(appended.comments).toEqual([expect.objectContaining({ index: 5, text: "comment 5" })]);
      expect(appended.mutation_receipt?.entry_index).toBe(5);
      const edited = await runComments(id, { edit: 2, add: "comment 2 edited" }, { path: context.pmPath });
      expect(edited.comments).toEqual([expect.objectContaining({ index: 2, text: "comment 2 edited" })]);
      const full = await runComments(id, { add: "comment 6", fullHistory: true }, { path: context.pmPath });
      expect(full.comments.map((row) => row.index)).toEqual([1, 2, 3, 4, 5, 6]);
      const deleted = await runComments(id, { delete: 1 }, { path: context.pmPath });
      expect(deleted.comments).toEqual([]);
      const renumbered = await runComments(id, { limit: "1" }, { path: context.pmPath });
      expect(renumbered.comments).toEqual([expect.objectContaining({ index: 5, text: "comment 6" })]);
    });
  });

  it("indexes notes through event filters and learnings by stored position", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Indexed notes" });
      await runNotes(id, { add: "plain note" }, { path: context.pmPath });
      await runNotes(id, { addJson: '{"type":"probe","n":1}' }, { path: context.pmPath });
      await runNotes(id, { add: "second plain note" }, { path: context.pmPath });
      const filtered = await runNotes(id, { eventType: "probe" }, { path: context.pmPath });
      expect(filtered.notes.map((row) => row.index)).toEqual([2]);
      await runLearnings(id, { add: "first learning" }, { path: context.pmPath });
      await runLearnings(id, { add: "second learning" }, { path: context.pmPath });
      const learnings = await runLearnings(id, { limit: "1" }, { path: context.pmPath });
      expect(learnings.learnings).toEqual([expect.objectContaining({ index: 2, text: "second learning" })]);
    });
  });

  it("reports an added or edited entry by its position after the store's created_at ordering", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Post-sort addresses" });
      // A later-stamped entry (clock skew or import) is written first.
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2099-01-01T00:00:00.000Z") });
      try {
        await runComments(id, { add: "stamped in the future" }, { path: context.pmPath });
      } finally {
        vi.useRealTimers();
      }
      const added = await runComments(id, { add: "written now" }, { path: context.pmPath });
      expect(added.mutation_receipt?.entry_index).toBe(1);
      expect(added.comments).toEqual([expect.objectContaining({ index: 1, text: "written now" })]);
      // Two entries share a created_at, so an edit that changes text can reorder them.
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2098-01-01T00:00:00.000Z") });
      try {
        await runComments(id, { add: "b shared" }, { path: context.pmPath });
        await runComments(id, { add: "c shared" }, { path: context.pmPath });
      } finally {
        vi.useRealTimers();
      }
      const before = (await runComments(id, {}, { path: context.pmPath })).comments.map((row) => [row.index, row.text]);
      expect(before).toEqual([[1, "written now"], [2, "b shared"], [3, "c shared"], [4, "stamped in the future"]]);
      const edited = await runComments(id, { edit: 2, add: "z shared" }, { path: context.pmPath });
      expect(edited.mutation_receipt?.entry_index).toBe(3);
      expect(edited.comments).toEqual([expect.objectContaining({ index: 3, text: "z shared" })]);
    });
  });

  it("keeps write-order addresses for a custom SDK collection the store does not sort", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Custom collection" });
      type AuditEntry = { created_at: string; author: string; text: string };
      const append = (text: string, ifAbsent = false) =>
        runAnnotationCommand<"audits", AuditEntry>(
          id,
          { ifAbsent },
          { path: context.pmPath },
          {
            collectionKey: "audits",
            op: "comment_add",
            parseText: (raw) => raw,
            createEntry: (entry) => entry,
            bypassOwnershipConflict: false,
            conflictGuidance: { required: "required", examples: [], nextSteps: [] },
            input: { mode: "add", value: text },
          },
        );
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2099-01-01T00:00:00.000Z") });
      try {
        await append("future-dated audit");
      } finally {
        vi.useRealTimers();
      }
      const appended = await append("written now");
      expect(appended.mutation_receipt?.entry_index).toBe(2);
      expect(appended.audits).toEqual([expect.objectContaining({ index: 2, text: "written now" })]);
      const retried = await append("written now", true);
      expect(retried).toMatchObject({ changed: false, mutation_receipt: { entry_index: 2 } });
      expect(retried.audits).toEqual([expect.objectContaining({ index: 2, text: "written now" })]);
    });
  });

  it("tracks the written occurrence among entries that become identical twins", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Identical twins" });
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2097-01-01T00:00:00.000Z") });
      try {
        await runComments(id, { add: "b" }, { path: context.pmPath });
        await runComments(id, { add: "c" }, { path: context.pmPath });
        // Editing "b" to "c" makes two entries with the same created_at, author and text.
        const edited = await runComments(id, { edit: 1, add: "c" }, { path: context.pmPath });
        expect(edited.mutation_receipt?.entry_index).toBe(1);
        expect(edited.comments).toEqual([expect.objectContaining({ index: 1, text: "c", edited_at: expect.any(String) })]);
        const twin = await runComments(id, { add: "c" }, { path: context.pmPath });
        expect(twin.mutation_receipt?.entry_index).toBe(3);
      } finally {
        vi.useRealTimers();
      }
      const stored = (await runComments(id, {}, { path: context.pmPath })).comments;
      expect(stored.map((row) => [row.index, row.text, row.edited_at !== undefined])).toEqual([
        [1, "c", true],
        [2, "c", false],
        [3, "c", false],
      ]);
    });
  });

  it("keeps note event filters safe when a malformed stored note is not an object", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Malformed note" });
      await appendFile(path.join(context.pmPath, "tasks", `${id}.toon`), "notes[1]: null\n", "utf8");
      const listed = await runNotes(id, {}, { path: context.pmPath });
      expect(listed.notes).toEqual([null]);
      const filtered = await runNotes(id, { eventType: "probe", since: "2026-01-01T00:00:00.000Z" }, { path: context.pmPath });
      expect(filtered).toMatchObject({ notes: [], structured_event_count: 0 });
    });
  });

  it("delivers a malformed stored entry as stored instead of spreading it into indexed characters", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Malformed single entry" });
      await appendFile(path.join(context.pmPath, "tasks", `${id}.toon`), "comments[1]: just-a-string\n", "utf8");
      const listed = await runComments(id, {}, { path: context.pmPath });
      expect(listed.comments).toEqual(["just-a-string"]);
    });
  });

  it("edits and deletes only the entry whose created_at the caller read", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Guarded comments" });
      await seedComments(context, id, 3);
      const rows = (await runComments(id, {}, { path: context.pmPath })).comments;
      const newest = rows[2]!;
      const edited = await runComments(
        id,
        { edit: newest.index, add: "newest edited", expectAt: newest.created_at },
        { path: context.pmPath },
      );
      expect(edited.comments).toEqual([expect.objectContaining({ index: 3, text: "newest edited" })]);
      const deleted = await runComments(
        id,
        { delete: 1, expectAt: rows[0]!.created_at },
        { path: context.pmPath },
      );
      expect(deleted.mutation_receipt).toMatchObject({ action: "delete", entry_index: 1 });
      const remaining = await runComments(id, {}, { path: context.pmPath });
      expect(remaining.comments.map((row) => row.text)).toEqual(["comment 2", "newest edited"]);
    });
  });

  it("refuses an index that no longer names the entry read and writes nothing", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Mismatched comments" });
      await seedComments(context, id, 3);
      const rows = (await runComments(id, {}, { path: context.pmPath })).comments;
      const before = await historyLineCount(context, id);
      const retarget = await refusal(
        runComments(id, { edit: 1, add: "wrong", expectAt: rows[2]!.created_at }, { path: context.pmPath }),
      );
      expect(retarget.exitCode).toBe(EXIT_CODE.CONFLICT);
      expect(retarget.context).toMatchObject({
        code: "annotation_entry_mismatch",
        item_id: id,
        details: {
          collection: "comments",
          entry_index: 1,
          expected_created_at: rows[2]!.created_at,
          actual_created_at: rows[0]!.created_at,
          matching_indexes: [3],
        },
      });
      expect(retarget.message).toContain("is at index 3");
      expect(retarget.context.examples?.[1]).toContain(`--edit 3 --expect-at ${rows[2]!.created_at} --add`);
      const absent = await refusal(
        runComments(id, { delete: 2, expectAt: "2000-01-01T00:00:00.000Z" }, { path: context.pmPath }),
      );
      expect(absent.message).toContain("No comment on");
      expect(absent.context.details).toMatchObject({ matching_indexes: [] });
      expect(absent.context.examples?.[1]).toBe(
        `pm comments ${id} --delete <index> --expect-at 2000-01-01T00:00:00.000Z`,
      );
      expect(await historyLineCount(context, id)).toBe(before);
      expect((await runComments(id, {}, { path: context.pmPath })).comments.map((row) => row.text)).toEqual([
        "comment 1",
        "comment 2",
        "comment 3",
      ]);
    });
  });

  it("names every index sharing the expected timestamp", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Shared timestamps" });
      await seedComments(context, id, 1);
      // Only Date is faked, so the next two appends share one created_at.
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00.000Z") });
      try {
        await seedComments(context, id, 2);
      } finally {
        vi.useRealTimers();
      }
      const shared = "2026-11-07T12:00:00.000Z";
      const rows = (await runComments(id, {}, { path: context.pmPath })).comments;
      const sharing = rows.filter((row) => row.created_at === shared).map((row) => row.index);
      expect(sharing).toHaveLength(2);
      const other = rows.find((row) => row.created_at !== shared)!;
      const ambiguous = await refusal(
        runComments(id, { edit: other.index, add: "x", expectAt: shared }, { path: context.pmPath }),
      );
      expect(ambiguous.message).toContain(`2 comments were created at ${shared}: indexes ${sharing.join(", ")}.`);
      expect(ambiguous.context.details).toMatchObject({ matching_indexes: sharing });
      expect(ambiguous.context.examples?.[1]).toContain("--edit <index>");
    });
  });

  it("refuses an expectation without an edit or delete target, or with empty text", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Expectation targets" });
      await seedComments(context, id, 1);
      const listing = await refusal(
        runComments(id, { expectAt: "2026-01-01T00:00:00.000Z" }, { path: context.pmPath }),
      );
      expect(listing.context).toMatchObject({ code: "annotation_expectation_without_target" });
      expect(listing.context.examples).toEqual([
        'pm comments <id> --edit <index> --expect-at <created_at> --add "<text>"',
        "pm comments <id> --delete <index> --expect-at <created_at>",
      ]);
      const append = await refusal(
        runNotes(id, { add: "x", expectAt: "2026-01-01T00:00:00.000Z" }, { path: context.pmPath }),
      );
      expect(append.context).toMatchObject({ code: "annotation_expectation_without_target" });
      expect(append.message).toContain("one note");
      const empty = await refusal(
        runComments(id, { delete: 1, expectAt: "  " }, { path: context.pmPath }),
      );
      expect(empty.exitCode).toBe(EXIT_CODE.USAGE);
      expect(empty.context).toMatchObject({ code: "annotation_expectation_invalid" });
      // MCP callers can send a non-string value; it is refused, never trimmed.
      for (const value of [42, null]) {
        const nonString = await refusal(
          runComments(id, { delete: 1, expectAt: value as unknown as string }, { path: context.pmPath }),
        );
        expect(nonString.context).toMatchObject({ code: "annotation_expectation_invalid" });
      }
    });
  });

  it("negative control: the page count of a truncated listing names an older entry, which the guard refuses", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Truncated page addressing" });
      await seedComments(context, id, 5);
      const page = await runComments(id, { limit: "2" }, { path: context.pmPath });
      const newest = page.comments.at(-1)!;
      // The pm-hka7ep hazard: count (2) is a page size, not an address.
      expect(page.count).toBe(2);
      expect(newest.index).toBe(5);
      const hazard = await refusal(
        runComments(id, { edit: page.count, add: "meant the newest", expectAt: newest.created_at }, { path: context.pmPath }),
      );
      expect(hazard.context.details).toMatchObject({ entry_index: 2, matching_indexes: [5] });
      const intended = await runComments(
        id,
        { edit: newest.index, add: "meant the newest", expectAt: newest.created_at },
        { path: context.pmPath },
      );
      expect(intended.comments).toEqual([expect.objectContaining({ index: 5, text: "meant the newest" })]);
    });
  });

  it("keeps unguarded absolute-index edits valid: the row index addresses its entry, the page count does not", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Unguarded addressing" });
      await seedComments(context, id, 5);
      const page = await runComments(id, { limit: "2" }, { path: context.pmPath });
      const newest = page.comments.at(-1)!;
      // Without --expect-at nothing is refused: the absolute index is the contract.
      const byIndex = await runComments(id, { edit: newest.index, add: "newest by index" }, { path: context.pmPath });
      expect(byIndex.comments).toEqual([expect.objectContaining({ index: 5, text: "newest by index" })]);
      const byCount = await runComments(id, { edit: page.count, add: "older by count" }, { path: context.pmPath });
      expect(byCount.comments).toEqual([expect.objectContaining({ index: 2, text: "older by count" })]);
      const stored = (await runComments(id, {}, { path: context.pmPath })).comments.map((row) => row.text);
      expect(stored).toEqual(["comment 1", "older by count", "comment 3", "comment 4", "newest by index"]);
    });
  });
});
