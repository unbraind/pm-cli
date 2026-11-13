import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import { runDocs } from "../../../../src/sdk/docs.js";
import { runFiles } from "../../../../src/sdk/files.js";
import {
  LINKED_ARTIFACT_NOTE_CONFLICT_MODES,
  parseNoteConflictMode,
  reviseLinkedNote,
} from "../../../../src/sdk/linked-artifacts.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

/**
 * GH-1716: an --add on a link already stored with a different note is
 * refused by default so another agent's rationale is never overwritten
 * silently; --note-conflict replace keeps the earlier overwrite and
 * --note-conflict append joins the notes. Every requested link reports what
 * it became, so a receipt never reads an overwrite as an add.
 */

async function refusal(promise: Promise<unknown>): Promise<PmCliError> {
  const error = await promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PmCliError);
  return error as PmCliError;
}

async function historyOps(pmPath: string, id: string): Promise<string[]> {
  const raw = await fs.readFile(path.join(pmPath, "history", `${id}.jsonl`), "utf8");
  return raw.trim().split("\n").map((line) => (JSON.parse(line) as { op: string }).op);
}

describe("GH-1716 linked-artifact note conflicts", () => {
  it("refuses an add that would overwrite a stored note, keeping it, and replays the write with an explicit mode", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "note conflict" });
      const global = { path: context.pmPath };
      const first = await runFiles(id, { add: ["path=src/a.ts,note=implementer rationale", "path=src/b.ts"] }, global);
      expect(first.mutation_receipt?.link_outcomes).toEqual([
        { path: "src/a.ts", scope: "project", outcome: "added" },
        { path: "src/b.ts", scope: "project", outcome: "added" },
      ]);
      const opsBefore = await historyOps(context.pmPath, id);

      const error = await refusal(runFiles(id, { add: ["path=src/a.ts,note=orchestrator note", "path=src/c.ts"] }, global));
      expect(error.exitCode).toBe(EXIT_CODE.CONFLICT);
      expect(error.message).toBe(`${id} already links file src/a.ts with the note "implementer rationale"; the add was refused so that note is kept`);
      expect(error.context).toMatchObject({
        code: "linked_artifact_note_conflict",
        item_id: id,
        details: {
          conflicts: [{ path: "src/a.ts", scope: "project", existing_note: "implementer rationale", requested_note: "orchestrator note" }],
        },
      });
      // Nothing was written: the stored note and the collection are unchanged, and no history entry was appended.
      expect((await runFiles(id, {}, global)).files).toEqual([
        { path: "src/a.ts", scope: "project", note: "implementer rationale" },
        { path: "src/b.ts", scope: "project" },
      ]);
      expect(await historyOps(context.pmPath, id)).toEqual(opsBefore);

      const retry = error.context.recovery?.suggested_retry_args as string[];
      expect(retry.slice(retry.indexOf("files"))).toEqual([
        "files", id, "--add", "path=src/a.ts,note=orchestrator note", "--add", "path=src/c.ts", "--note-conflict", "append",
      ]);
      expect(error.context.nextSteps?.[1]).toContain("--note-conflict replace");
      const executed = context.runCli([...retry, "--json"], { expectJson: true, preserveDefaultMutationOutput: true });
      expect(executed.code, executed.stderr).toBe(0);
      expect((executed.json as { mutation_receipt: { link_outcomes: unknown } }).mutation_receipt.link_outcomes).toEqual([
        { path: "src/a.ts", scope: "project", outcome: "note_appended" },
        { path: "src/c.ts", scope: "project", outcome: "added" },
      ]);
      expect((await runFiles(id, {}, global)).files[0]).toEqual({
        path: "src/a.ts",
        scope: "project",
        note: "implementer rationale; orchestrator note",
      });
      // The append is one history operation.
      expect(await historyOps(context.pmPath, id)).toEqual([...opsBefore, "files_add"]);
    });
  });

  it("reports each requested link's outcome and keeps identical, note-less and already-appended repeats idempotent", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "note outcomes" });
      const global = { path: context.pmPath };
      await runDocs(id, { add: ["path=docs/a.md,note=one", "path=docs/b.md"] }, global);

      const repeated = await runDocs(id, { add: ["path=docs/a.md,note=one", "docs/a.md", "path=docs/b.md,note=first note"] }, global);
      expect(repeated).toMatchObject({ changed: true, docs: [{ path: "docs/b.md", scope: "project", note: "first note" }] });
      expect(repeated.mutation_receipt?.link_outcomes?.map((entry) => entry.outcome)).toEqual(["unchanged", "unchanged", "note_added"]);

      const appended = await runDocs(id, { add: ["path=docs/a.md,note=two"], noteConflict: "append" }, global);
      expect(appended.docs).toEqual([{ path: "docs/a.md", scope: "project", note: "one; two" }]);
      const again = await runDocs(id, { add: ["path=docs/a.md,note=two"], noteConflict: "append" }, global);
      expect(again).toMatchObject({ changed: false, mutation_receipt: { changed_count: 0, link_outcomes: [{ outcome: "unchanged" }] } });

      // The standalone note follows the same policy as an embedded one.
      const standalone = await refusal(runDocs(id, { add: ["docs/b.md"], note: "second note" }, global));
      expect(standalone.message).toContain('already links doc docs/b.md with the note "first note"');
      const replaced = await runDocs(id, { add: ["docs/b.md"], note: "second note", noteConflict: " Replace " }, global);
      expect(replaced.mutation_receipt?.link_outcomes).toEqual([{ path: "docs/b.md", scope: "project", outcome: "note_replaced" }]);

      // A link first added in this same write takes a later note: no stored rationale is at stake.
      const sameWrite = await runDocs(id, { add: ["path=docs/c.md,note=draft", "path=docs/c.md,note=final"] }, global);
      expect(sameWrite.docs).toEqual([{ path: "docs/c.md", scope: "project", note: "final" }]);
      expect(sameWrite.mutation_receipt?.link_outcomes?.map((entry) => entry.outcome)).toEqual(["added", "added"]);
      const sameWriteNoteless = await runDocs(id, { add: ["docs/d.md", "path=docs/d.md,note=later", "docs/d.md"] }, global);
      expect(sameWriteNoteless.docs).toEqual([{ path: "docs/d.md", scope: "project", note: "later" }]);
    });
  });

  it("counts every conflicting link and replays a glob-only write", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "glob conflicts" });
      const global = { path: context.pmPath };
      await runDocs(id, { add: ["path=docs/a.md,note=one", "path=docs/b.md,note=two"] }, global);
      const many = await refusal(runDocs(id, { add: ["path=docs/a.md,note=x", "path=docs/b.md,note=y"] }, global));
      expect(many.message).toBe(`${id} already links doc docs/a.md with the note "one" and 1 more; the add was refused so that note is kept`);
      expect((many.context.details as { conflicts: unknown[] }).conflicts).toHaveLength(2);

      // A glob-only write has no --add entries to replay; the retry carries its glob and the mode.
      await fs.mkdir(path.join(context.tempRoot, "notes"), { recursive: true });
      await fs.writeFile(path.join(context.tempRoot, "notes", "c.md"), "c\n");
      const cwd = process.cwd();
      process.chdir(context.tempRoot);
      try {
        await runDocs(id, { addGlob: ["pattern=notes/*.md,note=first"] }, global);
        const glob = await refusal(runDocs(id, { addGlob: ["pattern=notes/*.md,note=second"] }, global));
        const retry = glob.context.recovery?.suggested_retry_args as string[];
        expect(retry.slice(retry.indexOf("docs"))).toEqual([
          "docs", id, "--add-glob", "pattern=notes/*.md,note=second", "--note-conflict", "append",
        ]);
      } finally {
        process.chdir(cwd);
      }
    });
  });

  it("refuses an unknown mode and a mode with nothing to add", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "note modes" });
      const global = { path: context.pmPath };
      const unknown = await refusal(runFiles(id, { add: ["a.ts"], noteConflict: "merge" }, global));
      expect(unknown.context).toMatchObject({ code: "invalid_argument_value", flag: "--note-conflict", value: "merge" });
      const orphan = await refusal(runFiles(id, { noteConflict: "append" }, global));
      expect(orphan.context).toMatchObject({ code: "missing_required_argument", flag: "--note-conflict" });
    });
  });

  it("replays the revision guard it ran under, and withholds a retry once the guarded scope has advanced", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "guarded conflict" });
      const global = { path: context.pmPath };
      await runFiles(id, { add: ["path=a.ts,note=kept"] }, global);
      const { readItemRevision, withExpectedItemRevisions } = await import("../../../../src/sdk/lifecycle/item-revision.js");
      const hash = (await readItemRevision(id, { pmRoot: context.pmPath })).item_hash;
      const conflict = () => runFiles(id, { add: ["path=a.ts,note=new"] }, global);
      const guarded = await refusal(withExpectedItemRevisions([{ id, itemHash: hash }], conflict, { pmRoot: context.pmPath }));
      expect(guarded.context.recovery?.suggested_retry_args).toContain(`--expect-hash=${id}=${hash}`);

      // A write inside the scope advances its expectation past the declared hash, which no single invocation can spell.
      const advanced = await refusal(
        withExpectedItemRevisions(
          [{ id, itemHash: hash }],
          async () => {
            await runFiles(id, { add: ["b.ts"] }, global);
            return conflict();
          },
          { pmRoot: context.pmPath },
        ),
      );
      expect(advanced.context.code).toBe("linked_artifact_note_conflict");
      expect(advanced.context.recovery).toBeUndefined();
      expect(advanced.context.nextSteps).toBeUndefined();
      expect(advanced.context.required).toContain("--note-conflict append");
    });
  });

  it("revises a stored note only as the mode allows", () => {
    expect(LINKED_ARTIFACT_NOTE_CONFLICT_MODES).toEqual(["refuse", "replace", "append"]);
    expect(reviseLinkedNote("a", undefined, "refuse")).toEqual({ note: "a", outcome: "unchanged", conflict: false });
    expect(reviseLinkedNote("a", "a", "refuse")).toEqual({ note: "a", outcome: "unchanged", conflict: false });
    expect(reviseLinkedNote(undefined, "b", "refuse")).toEqual({ note: "b", outcome: "note_added", conflict: false });
    expect(reviseLinkedNote("a", "b", "refuse")).toEqual({ note: "a", outcome: "unchanged", conflict: true });
    expect(reviseLinkedNote("a", "b", "replace")).toEqual({ note: "b", outcome: "note_replaced", conflict: false });
    expect(reviseLinkedNote("a; b", "b", "append")).toEqual({ note: "a; b", outcome: "unchanged", conflict: false });
    expect(reviseLinkedNote("a", "b", "append")).toEqual({ note: "a; b", outcome: "note_appended", conflict: false });
    expect(parseNoteConflictMode(undefined, false)).toBe("refuse");
  });
});
