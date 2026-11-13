import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
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
      // One outcome per link, however many entries in the write named it.
      expect(repeated.mutation_receipt?.link_outcomes?.map((entry) => entry.outcome)).toEqual(["unchanged", "note_added"]);

      const appended = await runDocs(id, { add: ["path=docs/a.md,note=two"], noteConflict: "append" }, global);
      expect(appended.docs).toEqual([{ path: "docs/a.md", scope: "project", note: "one; two" }]);
      const again = await runDocs(id, { add: ["path=docs/a.md,note=two"], noteConflict: "append" }, global);
      expect(again).toMatchObject({ changed: false, mutation_receipt: { changed_count: 0, link_outcomes: [{ outcome: "unchanged" }] } });

      // The standalone note follows the same policy as an embedded one.
      const standalone = await refusal(runDocs(id, { add: ["docs/b.md"], note: "second note" }, global));
      expect(standalone.message).toContain('already links doc docs/b.md with the note "first note"');
      const replaced = await runDocs(id, { add: ["docs/b.md"], note: "second note", noteConflict: " Replace " }, global);
      expect(replaced.mutation_receipt?.link_outcomes).toEqual([{ path: "docs/b.md", scope: "project", outcome: "note_replaced" }]);

      // Entries of one write apply in order under one rule, so a write whose own notes disagree is refused...
      const disagreeing = { add: ["path=docs/c.md,note=draft", "path=docs/c.md,note=final"] };
      const sameWrite = await refusal(runDocs(id, disagreeing, global));
      expect(sameWrite.message).toBe(`The add names doc docs/c.md on ${id} with two notes, "draft" and then "final"; the add was refused because they disagree`);
      expect(sameWrite.context.details).toMatchObject({ conflicts: [{ existing_note: "draft", requested_note: "final", source: "this_write" }] });
      // ...and a successful write replays as a no-op under either explicit mode (Codex review round 2).
      for (const [noteConflict, note] of [["append", "draft; final"], ["replace", "final"]] as const) {
        const pathFor = `docs/${noteConflict}.md`;
        const entries = [`path=${pathFor},note=draft`, `path=${pathFor},note=final`];
        const first = await runDocs(id, { add: entries, noteConflict }, global);
        expect(first.docs).toEqual([{ path: pathFor, scope: "project", note }]);
        expect(first.mutation_receipt?.link_outcomes).toEqual([{ path: pathFor, scope: "project", outcome: "added" }]);
        expect(await runDocs(id, { add: entries, noteConflict }, global)).toMatchObject({ changed: false, mutation_receipt: { changed_count: 0 } });
      }
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

  it("judges outcomes from saved end states, in storage's path form (Codex review)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "end-state outcomes" });
      const global = { path: context.pmPath };
      await runFiles(id, { add: ["path=a.ts,note=original"] }, global);

      // Revising a note and restoring it in one write saves nothing, so nothing is reported as replaced.
      const restored = await runFiles(id, { add: ["path=a.ts,note=temporary", "path=a.ts,note=original"], noteConflict: "replace" }, global);
      expect(restored).toMatchObject({ changed: false, mutation_receipt: { changed_count: 0, link_outcomes: [{ path: "a.ts", outcome: "unchanged" }] } });

      // An append whose text contains the joiner is recognised on retry.
      const compound = { add: ["path=a.ts,note=first; second"], noteConflict: "append" as const };
      expect((await runFiles(id, compound, global)).files).toEqual([{ path: "a.ts", scope: "project", note: "original; first; second" }]);
      expect(await runFiles(id, compound, global)).toMatchObject({ changed: false, mutation_receipt: { link_outcomes: [{ outcome: "unchanged" }] } });

      // Replacing then appending in one write is a replacement of the stored note.
      const replacedThenAppended = await runFiles(id, { add: ["path=a.ts,note=x", "path=a.ts,note=y"], noteConflict: "replace" }, global);
      expect(replacedThenAppended.mutation_receipt?.link_outcomes).toEqual([{ path: "a.ts", scope: "project", outcome: "note_replaced" }]);

      // A migration whose destination uses backslashes reports the path storage saved.
      const migrated = await runFiles(id, { add: ["path=old/b.ts,note=moved"], migrate: ["from=old/,to=new\\"] }, global);
      expect(migrated.files).toEqual([{ path: "new/b.ts", scope: "project", note: "moved" }]);
      expect(migrated.mutation_receipt?.link_outcomes).toEqual([{ path: "new/b.ts", scope: "project", outcome: "added" }]);

      // That spelling is the stored link's identity too: it cannot bypass the refusal or save a duplicate (Codex review round 2).
      const bypass = await refusal(runFiles(id, { add: ["path=old/b.ts,note=other"], migrate: ["from=old/,to=new\\"] }, global));
      expect(bypass.context.details).toMatchObject({ conflicts: [{ path: "new/b.ts", existing_note: "moved", source: "stored" }] });
      await runFiles(id, { add: ["path=old/b.ts,note=other"], migrate: ["from=old/,to=new\\"], noteConflict: "replace" }, global);
      expect((await runFiles(id, {}, global)).files.filter((file) => file.path === "new/b.ts")).toEqual([
        { path: "new/b.ts", scope: "project", note: "other" },
      ]);
      // Adding and removing two spellings of one saved path is the same ambiguous intent.
      const ambiguous = await refusal(runFiles(id, { add: ["new\\c.ts"], remove: ["new/c.ts"] }, global));
      expect(ambiguous.context.code).toBe("linked_artifact_mutation_conflict");
    });
  });

  it("spells a resolved literal '-' entry in its keyed form so the retry never reads stdin (Codex review)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "dash path" });
      const global = { path: context.pmPath };
      await runFiles(id, { add: ["path=-,note=kept"] }, global);
      // The add entry arrives on stdin and resolves to the literal path "-".
      const refused = context.runCli(["files", id, "--add", "-", "--note", "second", "--json"], { input: "-" });
      expect(refused.code).toBe(4);
      const envelope = JSON.parse(refused.stderr || refused.stdout) as { recovery: { suggested_retry_args: string[] } };
      const retry = envelope.recovery.suggested_retry_args;
      expect(retry.slice(retry.indexOf("files"))).toEqual([
        "files", id, "--add", "path=-", "--note", "second", "--note-conflict", "append",
      ]);
      const executed = context.runCli([...retry, "--json"], { expectJson: true, preserveDefaultMutationOutput: true });
      expect(executed.code, executed.stderr).toBe(0);
      expect((await runFiles(id, {}, global)).files).toEqual([{ path: "-", scope: "project", note: "kept; second" }]);
    });
  });

  it("spells a stdin-resolved '-' remove and glob in keyed form in the in-process retry", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "dash remove" });
      const global = { path: context.pmPath };
      await runFiles(id, { add: ["path=a.ts,note=kept", "path=-"] }, global);
      const stdinStream = new PassThrough();
      stdinStream.end("-");
      Object.defineProperty(stdinStream, "isTTY", { value: false, configurable: true });
      const stdin = vi.spyOn(process, "stdin", "get").mockReturnValue(stdinStream as unknown as NodeJS.ReadStream & { fd: 0 });
      try {
        const error = await refusal(runFiles(id, { add: ["path=a.ts,note=other"], remove: ["-"], addGlob: ["nothing-matches/*.md"] }, global));
        const retry = error.context.recovery?.suggested_retry_args as string[];
        expect(retry.slice(retry.indexOf("files"))).toEqual([
          "files", id, "--add", "path=a.ts,note=other", "--add-glob", "nothing-matches/*.md", "--remove", "path=-", "--note-conflict", "append",
        ]);
      } finally {
        stdin.mockRestore();
      }
    });
  });

  it("replays a conflict with the canonical item id, not the shorthand the caller passed (Codex review round 2)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "shorthand" });
      const global = { path: context.pmPath };
      await runFiles(id, { add: ["path=a.ts,note=kept"] }, global);
      const shorthand = id.replace(/^pm-/u, "");
      const error = await refusal(runFiles(shorthand, { add: ["path=a.ts,note=new"] }, global));
      const retry = error.context.recovery?.suggested_retry_args as string[];
      expect(retry.slice(retry.indexOf("files"), retry.indexOf("files") + 2)).toEqual(["files", id]);
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
    expect(reviseLinkedNote("a; b; c", "b; c", "append")).toEqual({ note: "a; b; c", outcome: "unchanged", conflict: false });
    expect(reviseLinkedNote("ab", "b", "append")).toEqual({ note: "ab; b", outcome: "note_appended", conflict: false });
    expect(reviseLinkedNote("a", "b", "append")).toEqual({ note: "a; b", outcome: "note_appended", conflict: false });
    expect(parseNoteConflictMode(undefined, false)).toBe("refuse");
  });
});
