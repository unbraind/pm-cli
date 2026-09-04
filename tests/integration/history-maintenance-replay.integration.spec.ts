import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import jsonPatch, { type Operation } from "fast-json-patch";
import { describe, expect, it } from "vitest";
import {
  canonicalDocument,
  parseItemDocument,
} from "../../src/core/item/item-format.js";
import {
  getItemAt,
  readHistoryEntries,
  findHistoryIdentityDiscontinuities,
  verifyHistoryEntries,
} from "../../src/sdk/history-read.js";
import { runHistoryRedact } from "../../src/sdk/history-redact.js";
import { runRestore } from "../../src/sdk/lifecycle/restore.js";
import { runHistory } from "../../src/sdk/query/history.js";
import type { HistoryEntry, ItemDocument } from "../../src/types/index.js";
import { createTaskFixture } from "../helpers/createTaskFixture.js";
import {
  withTempPmPath,
  type TempPmContext,
} from "../helpers/withTempPmPath.js";

/** Compare every API version with an independent strict patch fold, without the item file. */
async function assertHistoryOnlyReplay(
  context: TempPmContext,
  id: string,
  expected: ItemDocument,
) {
  const history = await readHistoryEntries(
    path.join(context.pmPath, "history", `${id}.jsonl`),
    id,
  );
  await rm(path.join(context.pmPath, "tasks", `${id}.toon`));
  let folded: { metadata: Record<string, unknown>; body: string } = {
    metadata: {},
    body: "",
  };
  for (const [index, entry] of history.entries()) {
    folded = jsonPatch.applyPatch(
      folded,
      entry.patch as Operation[],
      true,
      false,
      true,
    ).newDocument;
    const actual = await getItemAt(id, String(index + 1), {
      pmRoot: context.pmPath,
    });
    expect(actual.document, `${id} version ${index + 1} (${entry.op})`).toEqual(
      folded,
    );
  }
  expect(folded, `${id} final state versus independently read item`).toEqual(
    expected,
  );
  await runRestore(id, String(history.length), {}, { path: context.pmPath });
  expect(
    (await runHistory(id, { verify: true }, { path: context.pmPath }))
      .verification?.ok,
  ).toBe(true);
}

describe("history-only replay across real maintenance boundaries", () => {
  it("preserves every version's non-redacted fields and never reconstructs removed text", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-redaction-replay";
      createTaskFixture(
        context,
        id,
        "Example private-marker in original description",
      );
      const file = path.join(context.pmPath, "tasks", `${id}.toon`);
      const captured = [
        canonicalDocument(parseItemDocument(await readFile(file, "utf8"))),
      ];
      for (const operation of [
        ["update", id, "--title", "Renamed private-marker"],
        ["append", id, "--body", "Body private-marker"],
        ["comments", id, "Comment private-marker"],
      ]) {
        const result = context.runCli(operation);
        expect(result.code, result.stderr).toBe(0);
        captured.push(
          canonicalDocument(parseItemDocument(await readFile(file, "utf8"))),
        );
      }
      await runHistoryRedact(
        id,
        { literal: "private-marker", replacement: "[removed]" },
        { path: context.pmPath },
      );
      for (const [index, snapshot] of captured.entries()) {
        const expected: unknown = JSON.parse(
          JSON.stringify(snapshot).replaceAll("private-marker", "[removed]"),
        );
        expect(
          (await getItemAt(id, String(index + 1), { pmRoot: context.pmPath }))
            .document,
        ).toEqual(expected);
      }
      const expected = canonicalDocument(
        parseItemDocument(await readFile(file, "utf8")),
      );
      await assertHistoryOnlyReplay(context, id, expected);
      expect(
        await readFile(
          path.join(context.pmPath, "history", `${id}.jsonl`),
          "utf8",
        ),
      ).not.toContain("private-marker");
    });
  });

  it("replays an actual divergent Git merge and its audited reconciliation", async () => {
    await withTempPmPath(async (context) => {
      const git = (...args: string[]) =>
        execFileSync(
          "git",
          [
            "-c",
            "user.name=History Test",
            "-c",
            "user.email=history-test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=nonexistent-test-hooks",
            ...args,
          ],
          {
            cwd: context.tempRoot,
            env: context.env,
            encoding: "utf8",
            stdio: "pipe",
          },
        );
      git("init", "--quiet", "--initial-branch=base");
      const install = context.runCli(["merge", "install"], {
        cwd: context.tempRoot,
      });
      expect(install.code, install.stderr).toBe(0);
      const id = "pm-divergent-replay";
      createTaskFixture(context, id, "Shared baseline");
      const itemRelative = `.agents/pm/tasks/${id}.toon`;
      const historyRelative = `.agents/pm/history/${id}.jsonl`;
      git("add", ".gitattributes", itemRelative, historyRelative);
      git("commit", "--quiet", "-m", "Create shared baseline");
      git("switch", "--quiet", "-c", "priority-change");
      const first = context.runCli(["update", id, "--priority", "high"]);
      expect(first.code, first.stderr).toBe(0);
      git("add", itemRelative, historyRelative);
      git("commit", "--quiet", "-m", "Prioritize work");
      git("switch", "--quiet", "base");
      const second = context.runCli([
        "update",
        id,
        "--description",
        "Detailed parallel context",
      ]);
      expect(second.code, second.stderr).toBe(0);
      git("add", itemRelative, historyRelative);
      git("commit", "--quiet", "-m", "Clarify context");
      git("merge", "--no-edit", "priority-change");
      const reconciliation = context.runCli(["merge", "reconcile", "--json"], {
        cwd: context.tempRoot,
        expectJson: true,
      });
      expect(reconciliation.code, reconciliation.stderr).toBe(0);
      const expected = canonicalDocument(
        parseItemDocument(
          await readFile(path.join(context.tempRoot, itemRelative), "utf8"),
        ),
      );
      expect(expected.metadata).toMatchObject({
        priority: 1,
        description: "Detailed parallel context",
      });
      await assertHistoryOnlyReplay(context, id, expected);
      git("add", itemRelative, historyRelative);
      git("commit", "--quiet", "-m", "Record restoration proof");
      git("switch", "--quiet", "-c", "independent-identity");
      const collisionId = "pm-independent-subject";
      const collisionItem = `.agents/pm/tasks/${collisionId}.toon`;
      const collisionHistory = `.agents/pm/history/${collisionId}.jsonl`;
      createTaskFixture(
        context,
        collisionId,
        "Independently created left subject",
      );
      git("add", collisionItem, collisionHistory);
      git("commit", "--quiet", "-m", "Create left subject");
      git("switch", "--quiet", "base");
      createTaskFixture(
        context,
        collisionId,
        "Independently created right subject",
      );
      git("add", collisionItem, collisionHistory);
      git("commit", "--quiet", "-m", "Create right subject");
      expect(() => git("merge", "--no-edit", "independent-identity")).toThrow();
      // An add/add conflict must not be mistaken for a shared genesis. Importers
      // can diagnose both original branch streams without accepting a merge.
      const union = [
        git("show", `base:${collisionHistory}`),
        git("show", `independent-identity:${collisionHistory}`),
      ].flatMap((raw) =>
        raw
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as HistoryEntry),
      );
      expect(
        findHistoryIdentityDiscontinuities(union),
        "independent branch creates, not deleted-ID reminting",
      ).toEqual([
        {
          prior_genesis_index: 1,
          repeated_create_index: 2,
          sequence: "multiple_creates",
        },
      ]);
      expect(verifyHistoryEntries(union)).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([
          "verify_failed:duplicate_create:entry_2:prior_1",
        ]),
      });
    });
  });
});
