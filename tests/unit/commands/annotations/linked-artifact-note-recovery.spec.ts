import { describe, expect, it } from "vitest";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import { runDocs } from "../../../../src/sdk/docs.js";
import { runFiles } from "../../../../src/sdk/files.js";
import { findMisreadNoteSegment } from "../../../../src/sdk/linked-artifacts.js";
import { runUpdate } from "../../../../src/sdk/lifecycle/update.js";
import { runTest } from "../../../../src/sdk/test/execution.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

/**
 * pm-pwqiao: a files/docs --add refusal caused by note prose names the
 * segment it misread as a key and offers the same link with the prose moved
 * to the standalone --note flag. pm-oglm0t: a repeated key inside one entry
 * is refused instead of silently replacing the earlier value.
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

describe("pm-pwqiao misread note recovery", () => {
  it.each([
    ["the generic invalid-entry refusal", "path=a.txt,scope=project,note=Single-label host, host:port, whitespace", "host:port", "host", "invalid_argument_value"],
    ["the unknown-key refusal", "path=a.txt,scope=project,note=Single-label host, host:port", "host:port", "host", "invalid_argument_value"],
    ["a repeated known key (pm-oglm0t)", "path=a.txt,scope=project,note=moved here, path: b.txt", "path: b.txt", "path", "structured_entry_key_repeated"],
  ])("names the misread segment for %s and its recovery links the full note", async (_label, entry, segment, key, cause) => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "misread note" });
      const error = await refusal(runFiles(id, { add: [entry] }, { path: context.pmPath }));
      const note = entry.slice(entry.indexOf("note=") + "note=".length);
      expect(error.exitCode).toBe(EXIT_CODE.USAGE);
      expect(error.message).toContain(`note segment "${segment}" as a new key "${key}"`);
      expect(error.context).toMatchObject({
        code: "linked_artifact_note_key_misread",
        details: { entry_index: 1, misread_segment: segment, misread_key: key, note, cause },
      });
      const retry = error.context.recovery?.suggested_retry_args as string[];
      expect(retry.slice(-6)).toEqual(["files", id, "--add", "path=a.txt,scope=project", "--note", note]);
      expect(error.context.nextSteps).toEqual([error.context.recovery?.suggested_retry]);
      // Nothing was written by the refused invocation.
      expect((await runFiles(id, {}, { path: context.pmPath })).files).toEqual([]);

      const executed = context.runCli([...retry, "--json"], { expectJson: true, preserveDefaultMutationOutput: true });
      expect(executed.code, executed.stderr).toBe(0);
      expect((await runFiles(id, {}, { path: context.pmPath })).files).toEqual([{ path: "a.txt", scope: "project", note }]);
    });
  });

  it("carries the invocation's controls into the retry and warns that other entries were not written", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "misread note controls" });
      const error = await refusal(
        runFiles(
          id,
          { add: ["path=ok.txt", "path=a.txt,note=see, host:port, x"], appendStable: true, message: "link", force: true },
          { path: context.pmPath },
        ),
      );
      expect(error.context.details).toMatchObject({ entry_index: 2 });
      expect(error.context.recovery?.suggested_retry_args).toEqual(
        expect.arrayContaining(["--append-stable", "--message", "link", "--force"]),
      );
      expect(error.context.required).toContain("re-run its other entries too");

      // A glob in the same refused invocation was not written either.
      const withGlob = await refusal(runFiles(id, { add: ["path=a.txt,note=see, host:port, x"], addGlob: ["nothing-matches/*.md"] }, { path: context.pmPath }));
      expect(withGlob.context.required).toContain("re-run its other entries too");
      const single = await refusal(runFiles(id, { add: ["path=a.txt,note=see, host:port, x"], addGlob: [] }, { path: context.pmPath }));
      expect(single.context.required).not.toContain("re-run its other entries too");

      const docs = await refusal(runDocs(id, { add: ["path=README.md,note=see, host:port, x"], author: "someone" }, { path: context.pmPath }));
      expect(docs.context.recovery?.suggested_retry_args).toEqual(expect.arrayContaining(["docs", id, "--author", "someone"]));
      expect(docs.context.recovery?.suggested_retry_args).not.toContain("--append-stable");
      expect(docs.message).toContain("so the doc link was refused");
    });
  });

  it("leaves every refusal that note prose did not cause unchanged", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "unrelated refusals" });
      // GH-258: a typo key without a note keeps its strict unknown-key refusal.
      const typo = await refusal(runFiles(id, { add: ["path=README.md,lable=main"] }, { path: context.pmPath }));
      expect(typo.message).toBe('--add does not recognize key "lable". Allowed keys: path, scope, note.');
      expect(typo.context.code).not.toBe("linked_artifact_note_key_misread");
      // The link itself is invalid, so the note is not the cause.
      const scope = await refusal(runFiles(id, { add: ["path=a.txt,scope=bogus,note=see, host:port, x"] }, { path: context.pmPath }));
      expect(scope.context.code).not.toBe("linked_artifact_note_key_misread");
    });
  });

  it("finds the misread segment only for a note followed by a key-shaped segment", () => {
    expect(findMisreadNoteSegment("path=a.txt,note=see, host:port", "file")).toEqual({
      link: "path=a.txt",
      note: "see, host:port",
      segment: "host:port",
      key: "host",
    });
    // A key-shaped word inside a segment is prose; only a segment that opens with one is misread.
    expect(findMisreadNoteSegment("path=a.txt,note=see host:port, x", "file")).toBeUndefined();
    expect(findMisreadNoteSegment("note:see, host:port", "file")).toBeUndefined();
    expect(findMisreadNoteSegment("path=a.txt,note=", "file")).toBeUndefined();
    expect(findMisreadNoteSegment("path=a.txt,note=plain prose, more prose", "file")).toBeUndefined();
    expect(findMisreadNoteSegment("path=a.txt,note=see, https://example.test/x", "file")).toBeUndefined();
    expect(findMisreadNoteSegment("path=a.txt,lable=main", "file")).toBeUndefined();
    expect(findMisreadNoteSegment("path=a.txt,scope=bogus,note=x, host:port", "doc")).toBeUndefined();
  });
});

describe("pm-oglm0t repeated keys across structured flags", () => {
  it("refuses a repeated key in files --add, --dep and test --add before writing", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "repeated keys" });
      for (const attempt of [
        () => runFiles(id, { add: ["path=d.txt,path=e.txt"] }, { path: context.pmPath }),
        () => runUpdate(id, { dep: ["id=pm-a,kind=blocks,kind=related"] }, { path: context.pmPath }),
        () => runTest(id, { add: ["command=node -e 1,command=node -e 2"] }, { path: context.pmPath }),
      ]) {
        const error = await refusal(attempt());
        expect(error.context).toMatchObject({ code: "structured_entry_key_repeated" });
      }
      expect((await runFiles(id, {}, { path: context.pmPath })).files).toEqual([]);
      expect((await runTest(id, {}, { path: context.pmPath })).tests).toEqual([]);
    });
  });
});
