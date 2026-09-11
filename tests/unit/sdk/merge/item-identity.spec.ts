/** Protects item identities against ambiguous reads and independent branch creation. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { locateItem } from "../../../../src/core/store/item-store.js";
import { scanStorageIntegrity } from "../../../../src/sdk/governance/storage-integrity.js";
import { runMergeDriver } from "../../../../src/sdk/merge/driver.js";
import { mergeHistoryStreams, mergeItemDocuments } from "../../../../src/sdk/merge/three-way.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const document = JSON.stringify({
  id: "pm-collision", title: "Independent work", description: "",
  type: "Task", status: "open", priority: 2, tags: [],
  created_at: "2026-09-11T00:00:00.000Z", updated_at: "2026-09-11T00:00:00.000Z",
});

describe("duplicate item identity boundaries", () => {
  it("refuses add/add documents even when their content is identical", () => {
    for (const theirs of [document, document.replace("Independent", "Other")]) {
      expect(() => mergeItemDocuments("", document, theirs, { format: "json" }))
        .toThrow(/duplicate.*identity/i);
    }
  });

  it("refuses sides addressing a different item from the ancestor", () => {
    const other = document.replace("pm-collision", "pm-other");
    for (const [ours, theirs] of [[document, other], [other, document]]) {
      expect(() => mergeItemDocuments(document, ours, theirs, { format: "json" }))
        .toThrow(/mismatched item identity/);
    }
  });

  it("leaves driver side files untouched when identity cannot be proven", async () => {
    await withTempPmPath(async ({ tempRoot, pmPath }) => {
      const basePath = path.join(tempRoot, "base");
      const oursPath = path.join(tempRoot, "ours");
      const theirsPath = path.join(tempRoot, "theirs");
      await Promise.all([
        writeFile(basePath, ""), writeFile(oursPath, document),
        writeFile(theirsPath, document.replace("Independent", "Other")),
      ]);
      const previousCwd = process.cwd();
      try {
        process.chdir(tempRoot);
        await expect(runMergeDriver({ artifact: "item", basePath, oursPath, theirsPath,
          itemPath: ".agents/pm/tasks/pm-collision.md" }, { path: pmPath }))
          .rejects.toMatchObject({ context: { code: "item_identity_conflict" } });
      } finally {
        process.chdir(previousCwd);
      }
      expect(await readFile(oursPath, "utf8")).toBe(document);
    });
  });

  it("rejects two independent create events before reanchoring or fast-forwarding", () => {
    const first = JSON.stringify({ op: "create", ts: "2026-09-11T00:00:00Z", author: "a", patch: [] }) + "\n";
    const second = JSON.stringify({ op: "create", ts: "2026-09-11T00:00:01Z", author: "b", patch: [] }) + "\n";
    for (const [ours, theirs] of [[first, second], [first + second, first], [first + second, first + second]]) {
      expect(() => mergeHistoryStreams("", ours, theirs)).toThrow(/duplicate.*identity/i);
    }
    expect(mergeHistoryStreams("", first, first).strategy).toBe("identical");
    expect(() => mergeHistoryStreams(first + second, first, first)).toThrow(/duplicate.*identity/i);
  });

  it("reports multiple creates in a single physical item history", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeFile(path.join(pmPath, "history", "pm-collision.jsonl"),
        '{"op":"create"}\n{"op":"update"}\n{"op":"create"}\n');
      const result = await scanStorageIntegrity(pmPath, new Set(), { Task: "tasks" });
      expect(result.history_unparseable_streams).toContainEqual({
        id: "pm-collision", path: "history/pm-collision.jsonl", line: 3,
        detail: "duplicate item identity: more than one create event in one history stream",
      });
    });
  });

  it("refuses cross-type and cross-format ambiguity without enumerating the corpus", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await mkdir(path.join(pmPath, "features"), { recursive: true });
      await writeFile(path.join(pmPath, "tasks", "pm-collision.md"), document);
      await writeFile(path.join(pmPath, "features", "pm-collision.md"), document);
      await expect(locateItem(pmPath, "pm-collision")).rejects.toMatchObject({
        context: { code: "item_identity_ambiguous", paths: ["features/pm-collision.md", "tasks/pm-collision.md"] },
      });
      await writeFile(path.join(pmPath, "tasks", "pm-collision.toon"), document);
      await expect(locateItem(pmPath, "pm-collision", "pm-", "toon", { Task: "tasks" }))
        .rejects.toMatchObject({ context: { code: "item_identity_ambiguous" } });
    });
  });

  it("deduplicates type aliases while detecting collisions with custom domain folders", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeFile(path.join(pmPath, "tasks", "pm-collision.md"), document);
      const types = { Task: "tasks", Work: "tasks", Specimen: "specimens" };
      expect(await locateItem(pmPath, "pm-collision", "pm-", "toon", types))
        .toMatchObject({ id: "pm-collision", type: "Task", item_format: "json_markdown" });
      await mkdir(path.join(pmPath, "specimens"));
      await writeFile(path.join(pmPath, "specimens", "pm-collision.md"), document);
      await expect(locateItem(pmPath, "pm-collision", "pm-", "toon", types))
        .rejects.toMatchObject({ context: { code: "item_identity_ambiguous", paths: ["specimens/pm-collision.md", "tasks/pm-collision.md"] } });
    });
  });
});
