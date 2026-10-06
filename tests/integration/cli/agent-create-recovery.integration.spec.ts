import { describe, expect, it } from "vitest";
import { PmClient } from "../../../src/sdk/index.js";
import { resolveAuthor, resolveHistoryAgentIdentity, resolveHistoryAuthorSource } from "../../../src/core/shared/author.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("strict create recovery (GH-1397)", () => {
  it("accepts resolved identity and advertises canonical flags with honest empty collections", async () => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true });
      await client.init(undefined, { preset: "strict", force: true });
      resolveAuthor("test-author", "");
      const priorIdentity = resolveHistoryAgentIdentity("test-author");
      await expect(client.create({ title: "Refused explicit actor", author: "refused-author" })).rejects.toMatchObject({ exitCode: 2 });
      expect(resolveHistoryAgentIdentity("test-author")).toEqual(priorIdentity);
      expect(resolveHistoryAuthorSource("test-author")).toBe("asserted");
      const refused = await context.runCliInProcess(["create", "--type", "Task", "--title", "Strict recovery", "--description", "Real intent", "--priority", "3", "--json"]);
      expect(refused.code).toBe(2);
      const error = JSON.parse(refused.stderr) as { examples: string[]; recovery: { missing_required_fields: string[] } };
      expect(error.recovery.missing_required_fields).not.toContain("--author");
      expect(error.recovery.missing_required_fields).toContain("--status");
      const example = error.examples.at(-1)!;
      expect(example).toContain("--acceptance-criteria ");
      expect(example).toContain("--estimate ");
      expect(example).not.toMatch(/--[a-z-]+\/--[a-z-]+/u);
      for (const collection of ["comments", "deps", "docs", "files", "learnings", "notes", "tests"]) {
        expect(example).toContain(`--clear-${collection}`);
      }
      const created = await client.create({ title: "Strict recovery", description: "Real intent", type: "Task", priority: "3", status: "open", message: "Create verified recovery", acceptanceCriteria: "Real acceptance", assignee: "maintainer", body: "Real project context", deadline: "2099-01-01", estimatedMinutes: "15", tags: "recovery", clearComments: true, clearDeps: true, clearDocs: true, clearFiles: true, clearLearnings: true, clearNotes: true, clearTests: true });
      expect(created.item.author).toBe("test-author");
      expect(created.item.comments ?? []).toEqual([]);
      expect(created.item.dependencies ?? []).toEqual([]);
      expect(created.item.learnings ?? []).toEqual([]);
    });
  });
});
