import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBeadsImport } from "../../src/cli/commands/beads.js";
import { clearActiveExtensionHooks, setActiveExtensionHooks } from "../../src/core/extensions/index.js";
import { EXIT_CODE } from "../../src/constants.js";
import type { TempPmContext } from "../helpers/withTempPmPath.js";
import { readJsonlFixture } from "../helpers/fixtures.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

type BeadsFixtureRecord = Record<string, unknown>;

const beadsImportRecordsFixture = readJsonlFixture<BeadsFixtureRecord>("beads", "import-records.jsonl");
const beadsConversionFixture = readJsonlFixture<BeadsFixtureRecord>("beads", "conversion-branches.jsonl");

function createSeedItem(context: TempPmContext, title: string): string {
  const created = context.runCli(
    [
      "create",
      "--json",
      "--title",
      title,
      "--description",
      `${title} description`,
      "--type",
      "Task",
      "--status",
      "open",
      "--priority",
      "1",
      "--tags",
      "beads,unit",
      "--body",
      "",
      "--deadline",
      "none",
      "--estimate",
      "10",
      "--acceptance-criteria",
      "seed item exists",
      "--author",
      "unit-test",
      "--message",
      "Create beads seed item",
      "--assignee",
      "none",
      "--dep",
      "none",
      "--comment",
      "none",
      "--note",
      "none",
      "--learning",
      "none",
      "--file",
      "none",
      "--test",
      "none",
      "--doc",
      "none",
    ],
    { expectJson: true },
  );
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

describe("runBeadsImport", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-beads-not-init-"));
    try {
      const sourcePath = path.join(tempDir, "issues.jsonl");
      await writeFile(sourcePath, `${JSON.stringify({ title: "Uninitialized import" })}\n`, "utf8");
      await expect(runBeadsImport({ file: sourcePath }, { path: tempDir })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails when the source JSONL path is missing", async () => {
    await withTempPmPath(async (context) => {
      const missingPath = path.join(context.tempRoot, "missing-beads.jsonl");
      await expect(runBeadsImport({ file: missingPath }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("fails when no Beads source can be auto-discovered", async () => {
    await withTempPmPath(async (context) => {
      const previousCwd = process.cwd();
      process.chdir(context.tempRoot);
      try {
        await expect(runBeadsImport({}, { path: context.pmPath })).rejects.toMatchObject({
          exitCode: EXIT_CODE.NOT_FOUND,
          message: expect.stringContaining("Checked .beads/issues.jsonl, issues.jsonl"),
        });
      } finally {
        process.chdir(previousCwd);
      }
    });
  });

  it("reads Beads JSONL from stdin when --file - is requested", async () => {
    await withTempPmPath(async (context) => {
      const setEncodingSpy = vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
      const onSpy = vi.spyOn(process.stdin, "on").mockImplementation(((event: string, handler: (...args: any[]) => void) => {
        if (event === "data") {
          handler(`${JSON.stringify({ id: "stdin-item", title: "STDIN import" })}\n`);
        }
        if (event === "end") {
          handler();
        }
        return process.stdin;
      }) as typeof process.stdin.on);

      try {
        const result = await runBeadsImport({ file: "-" }, { path: context.pmPath });
        expect(result.source).toBe("-");
        expect(result.ids).toEqual(["pm-stdin-item"]);
      } finally {
        setEncodingSpy.mockRestore();
        onSpy.mockRestore();
      }
    });
  });

  it("imports beads records with deterministic mapping and import history entries", async () => {
    await withTempPmPath(async (context) => {
      const sourcePath = path.join(context.tempRoot, "issues.jsonl");
      const records = beadsImportRecordsFixture;
      const firstRecord = records[0] as { created_at: string; updated_at: string };
      const createdAt = firstRecord.created_at;
      await writeFile(sourcePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

      const result = await runBeadsImport(
        {
          file: sourcePath,
          author: "unit-beads-author",
          message: "Unit beads import",
        },
        { path: context.pmPath },
      );

      expect(result).toEqual({
        ok: true,
        source: sourcePath,
        imported: 13,
        skipped: 0,
        ids: [
          "pm-legacy.1",
          "pm-legacy.2",
          "pm-legacy.3",
          "pm-legacy.4",
          "pm-legacy.5",
          "pm-legacy.6",
          "pm-legacy.7",
          "pm-legacy.8",
          "pm-legacy.9",
          "pm-legacy.10",
          "pm-legacy.11",
          "pm-legacy.12",
          "pm-legacy.13",
        ],
        warnings: [],
      });

      const first = context.runCli(["get", "pm-legacy.1", "--json"], { expectJson: true });
      expect(first.code).toBe(0);
      const firstJson = first.json as {
        item: {
          type: string;
          status: string;
          priority: number;
          tags: string[];
          estimated_minutes: number;
          acceptance_criteria: string;
          dependencies: Array<{ id: string; kind: string }>;
          comments: Array<{ text: string }>;
          notes: Array<{ text: string }>;
          learnings: Array<{ text: string }>;
          files: Array<{ path: string; scope: string; note?: string }>;
          tests: Array<{ command?: string; path?: string; scope: string; timeout_seconds?: number; note?: string }>;
          docs: Array<{ path: string; scope: string; note?: string }>;
        };
        body: string;
      };
      expect(firstJson.item.type).toBe("Feature");
      expect(firstJson.item.status).toBe("blocked");
      expect(firstJson.item.priority).toBe(0);
      expect(firstJson.item.tags).toEqual(["beads", "import"]);
      expect(firstJson.item.estimated_minutes).toBe(45);
      expect(firstJson.item.acceptance_criteria).toBe("Importer maps fields");
      expect(firstJson.item.dependencies).toEqual([{ id: "pm-dep-1", kind: "blocks", created_at: createdAt, author: "beads" }]);
      expect(firstJson.item.comments).toEqual([{ created_at: createdAt, author: "beads", text: "comment-1" }]);
      expect(firstJson.item.notes).toEqual([{ created_at: createdAt, author: "unit-beads-author", text: "note-1" }]);
      expect(firstJson.item.learnings).toEqual([{ created_at: createdAt, author: "unit-beads-author", text: "learning-1" }]);
      expect(firstJson.item.files).toEqual([
        { path: "src/foo.ts", scope: "global", note: "global file" },
        { path: "src/bar.ts", scope: "project" },
      ]);
      expect(firstJson.item.tests).toEqual([
        { command: "pnpm test", scope: "project", timeout_seconds: 120, note: "run tests" },
      ]);
      expect(firstJson.item.docs).toEqual([
        { path: "docs/design.md", scope: "project" },
        { path: "docs/readme.md", scope: "project" },
      ]);
      expect(firstJson.body).toBe("beads-body");

      const second = context.runCli(["get", "pm-legacy.2", "--json"], { expectJson: true });
      expect(second.code).toBe(0);
      const secondJson = second.json as {
        item: { type: string; status: string; priority: number; description: string; author: string };
      };
      expect(secondJson.item.type).toBe("Task");
      expect(secondJson.item.status).toBe("open");
      expect(secondJson.item.priority).toBe(2);
      expect(secondJson.item.description).toBe("");
      expect(secondJson.item.author).toBe("source-author");

      const ninth = context.runCli(["get", "pm-legacy.9", "--json"], { expectJson: true });
      expect(ninth.code).toBe(0);
      const ninthJson = ninth.json as any;
      expect(ninthJson.item.type).toBe("Issue");
      expect(ninthJson.item.source_type).toBe("bug");
      expect(ninthJson.item.tags).toEqual(["bug", "ui"]);
      expect(ninthJson.item.status).toBe("closed");
      expect(ninthJson.item.closed_at).toBe("2026-01-05T00:00:00.000Z");
      expect(ninthJson.item.close_reason).toBeUndefined();
      expect(ninthJson.item.design).toBe("This is the design doc");
      expect(ninthJson.item.external_ref).toBe("JIRA-123");
      expect(ninthJson.item.dependencies).toEqual([
        {
          id: "pm-legacy.1",
          kind: "parent_child",
          created_at: ninthJson.item.created_at,
          author: "daemon",
          source_kind: "parent-child",
        },
      ]);
      expect(ninthJson.item.author).toBe("original_creator");
      expect(ninthJson.body).toBe("## Design\n\nThis is the design doc\n\n## External Reference\nJIRA-123");

      const tenth = context.runCli(["get", "pm-legacy.10", "--json"], { expectJson: true });
      expect(tenth.code).toBe(0);
      const tenthJson = tenth.json as { body: string };
      expect(tenthJson.body).toBe("Existing body\n\n## Design\n\nDesign details\n\n## External Reference\nEXT-456");

      const eleventh = context.runCli(["get", "pm-legacy.11", "--json"], { expectJson: true });
      expect(eleventh.code).toBe(0);
      const eleventhJson = eleventh.json as { item: { external_ref: string }; body: string };
      expect(eleventhJson.item.external_ref).toBe("EXT-ONLY");
      expect(eleventhJson.body).toBe("## External Reference\nEXT-ONLY");

      const twelfth = context.runCli(["get", "pm-legacy.12", "--json"], { expectJson: true });
      expect(twelfth.code).toBe(0);
      const twelfthJson = twelfth.json as any;
      expect(twelfthJson.item.type).toBe("Task");
      expect(twelfthJson.item.source_type).toBe("event");
      expect(twelfthJson.item.assignee).toBe("owner-a");
      expect(twelfthJson.item.source_owner).toBe("owner-a");
      expect(twelfthJson.item.deadline).toBe("2026-03-15T11:18:44.832869327+01:00");
      expect(twelfthJson.item.dependencies).toEqual([
        {
          id: "pm-legacy.1",
          kind: "discovered_from",
          created_at: twelfthJson.item.created_at,
          author: "daemon",
          source_kind: "discovered-from",
        },
      ]);

      const thirteenth = context.runCli(["get", "pm-legacy.13", "--json"], { expectJson: true });
      expect(thirteenth.code).toBe(0);
      const thirteenthJson = thirteenth.json as any;
      expect(thirteenthJson.item.dependencies).toEqual([
        {
          id: "pm-legacy.2",
          kind: "related_to",
          created_at: "2026-01-06T01:02:03.000Z",
          author: "beads",
          source_kind: "relates-to",
        },
      ]);

      const history = context.runCli(["history", "pm-legacy.1", "--json"], { expectJson: true });
      expect(history.code).toBe(0);
      const historyJson = history.json as { history: Array<{ op: string }> };
      expect(historyJson.history.some((entry) => entry.op === "import")).toBe(true);
    });
  });

  it("covers specific mapping branches for arrays", async () => {
    await withTempPmPath(async (context) => {
      const sourcePath = path.join(context.tempRoot, "branch-arrays.jsonl");
      const lines = [
        JSON.stringify({ id: "b1", title: "B1", docs: "   ", tests: "   ", files: "   " }),
        JSON.stringify({ id: "b2", title: "B2", docs: "doc-str", tests: "test-str", files: "file-str" }),
        JSON.stringify({ id: "b3", title: "B3", docs: [" ", {}], tests: [" ", {}], files: [" ", {}] }),
        JSON.stringify({ id: "b4", title: "B4", docs: [{doc: "d", scope: "global"}], tests: [{test: "t", scope: "global"}], files: [{file: "f", scope: "global"}] }),
        JSON.stringify({ id: "b5", title: "B5", docs: [{path: "p"}], tests: [{path: "p"}], files: [{path: "p"}] }),
      ];
      await writeFile(sourcePath, `${lines.join("\n")}\n`, "utf8");
      const result = await runBeadsImport({ file: sourcePath }, { path: context.pmPath });
      expect(result.imported).toBe(5);
    });
  });

  it("maps additional Beads dependency kind aliases deterministically", async () => {
    await withTempPmPath(async (context) => {
      const sourcePath = path.join(context.tempRoot, "dependency-aliases.jsonl");
      const lines = [
        JSON.stringify({ id: "dep-target", title: "Dependency target" }),
        JSON.stringify({ id: "kindless", title: "Kindless dependency", dependencies: [{ depends_on_id: "dep-target" }] }),
        JSON.stringify({ id: "child-of", title: "Child Of dependency", dependencies: [{ depends_on_id: "dep-target", type: "child-of" }] }),
        JSON.stringify({ id: "blocked-by", title: "Blocked By dependency", dependencies: [{ depends_on_id: "dep-target", type: "blocked-by" }] }),
        JSON.stringify({ id: "incident-from", title: "Incident From dependency", dependencies: [{ depends_on_id: "dep-target", type: "incident-from" }] }),
        JSON.stringify({ id: "related-to", title: "Related To dependency", dependencies: [{ depends_on_id: "dep-target", type: "related-to" }] }),
      ];
      await writeFile(sourcePath, `${lines.join("\n")}\n`, "utf8");

      await runBeadsImport({ file: sourcePath }, { path: context.pmPath });

      const kindlessJson = context.runCli(["get", "pm-kindless", "--json"], { expectJson: true }).json as any;
      const childOfJson = context.runCli(["get", "pm-child-of", "--json"], { expectJson: true }).json as any;
      const blockedByJson = context.runCli(["get", "pm-blocked-by", "--json"], { expectJson: true }).json as any;
      const incidentFromJson = context.runCli(["get", "pm-incident-from", "--json"], { expectJson: true }).json as any;
      const relatedToJson = context.runCli(["get", "pm-related-to", "--json"], { expectJson: true }).json as any;

      expect(kindlessJson.item.dependencies).toEqual([
        {
          id: "pm-dep-target",
          kind: "related",
          created_at: kindlessJson.item.created_at,
        },
      ]);
      expect(childOfJson.item.dependencies).toEqual([
        {
          id: "pm-dep-target",
          kind: "child_of",
          created_at: childOfJson.item.created_at,
          source_kind: "child-of",
        },
      ]);
      expect(blockedByJson.item.dependencies).toEqual([
        {
          id: "pm-dep-target",
          kind: "blocked_by",
          created_at: blockedByJson.item.created_at,
          source_kind: "blocked-by",
        },
      ]);
      expect(incidentFromJson.item.dependencies).toEqual([
        {
          id: "pm-dep-target",
          kind: "incident_from",
          created_at: incidentFromJson.item.created_at,
          source_kind: "incident-from",
        },
      ]);
      expect(relatedToJson.item.dependencies).toEqual([
        {
          id: "pm-dep-target",
          kind: "related_to",
          created_at: relatedToJson.item.created_at,
          source_kind: "related-to",
        },
      ]);
    });
  });

  it("skips invalid records and existing ids with deterministic warnings", async () => {
    await withTempPmPath(async (context) => {
      const existingId = createSeedItem(context, "Existing Beads Item");
      const sourcePath = path.join(context.tempRoot, "invalid-mix.jsonl");
      const lines = [
        "{not-json",
        JSON.stringify({ id: "missing-title" }),
        JSON.stringify({ id: existingId, title: "Duplicate id" }),
        JSON.stringify({ id: "fresh-1", title: "Fresh imported item", comments: "single-comment" }),
      ];
      await writeFile(sourcePath, `${lines.join("\n")}\n`, "utf8");

      const result = await runBeadsImport({ file: sourcePath }, { path: context.pmPath });
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(3);
      expect(result.ids).toEqual(["pm-fresh-1"]);
      expect(result.warnings).toEqual([
        "beads_import_invalid_jsonl_line:1",
        "beads_import_missing_title:2",
        `beads_import_item_exists:${existingId}`,
      ]);

      const imported = context.runCli(["get", "pm-fresh-1", "--json"], { expectJson: true });
      expect(imported.code).toBe(0);
      const importedJson = imported.json as {
        item: { comments: Array<{ created_at: string; author: string; text: string }> };
      };
      expect(importedJson.item.comments).toEqual([
        {
          created_at: importedJson.item.comments[0].created_at,
          author: "test-author",
          text: "single-comment",
        },
      ]);
    });
  });

  it("covers fallback conversions for item type, dependencies, and log entries", async () => {
    await withTempPmPath(async (context) => {
      const sourcePath = path.join(context.tempRoot, "conversion-branches.jsonl");
      const lines = beadsConversionFixture.map((record) => JSON.stringify(record));
      await writeFile(sourcePath, `${lines.join("\n")}\n`, "utf8");

      const result = await runBeadsImport({ file: sourcePath, author: "branch-author" }, { path: context.pmPath });
      expect(result.imported).toBe(6);
      expect(result.skipped).toBe(0);
      expect(result.ids.slice(0, 5)).toEqual([
        "pm-typed-epic",
        "pm-typed-task",
        "pm-typed-chore",
        "pm-typed-issue",
        "pm-typed-feature-nullish",
      ]);
      expect(result.ids).toHaveLength(6);
      expect(result.ids[5]).toMatch(/^pm-/);

      const epicResult = context.runCli(["get", "pm-typed-epic", "--json"], { expectJson: true });
      expect(epicResult.code).toBe(0);
      const epicJson = epicResult.json as {
        item: {
          created_at: string;
          updated_at: string;
          type: string;
          priority: number;
          estimated_minutes: number;
          comments?: Array<{ text: string }>;
          dependencies?: Array<{ id: string; kind: string }>;
          notes?: Array<{ text: string; author: string }>;
          learnings?: Array<{ text: string; author: string }>;
        };
      };

      expect(epicJson.item.type).toBe("Epic");
      expect(epicJson.item.priority).toBe(1);
      expect(epicJson.item.estimated_minutes).toBe(30);
      expect(Date.parse(epicJson.item.created_at)).not.toBeNaN();
      expect(Date.parse(epicJson.item.updated_at)).not.toBeNaN();
      expect(epicJson.item.dependencies).toEqual([
        {
          id: "pm-dep-item",
          kind: "related",
          created_at: epicJson.item.created_at,
          source_kind: "unexpected-kind",
        },
      ]);
      expect(epicJson.item.comments).toBeUndefined();
      expect(epicJson.item.notes).toEqual([
        {
          created_at: epicJson.item.created_at,
          author: "branch-author",
          text: "note-comment",
        },
      ]);
      expect(epicJson.item.learnings).toEqual([
        {
          created_at: epicJson.item.created_at,
          author: "branch-author",
          text: "learning-text",
        },
      ]);

      const taskResult = context.runCli(["get", "pm-typed-task", "--json"], { expectJson: true });
      expect(taskResult.code).toBe(0);
      expect((taskResult.json as { item: { type: string } }).item.type).toBe("Task");

      const choreResult = context.runCli(["get", "pm-typed-chore", "--json"], { expectJson: true });
      expect(choreResult.code).toBe(0);
      expect((choreResult.json as { item: { type: string } }).item.type).toBe("Chore");

      const issueResult = context.runCli(["get", "pm-typed-issue", "--json"], { expectJson: true });
      expect(issueResult.code).toBe(0);
      expect((issueResult.json as { item: { type: string } }).item.type).toBe("Issue");

      const featureResult = context.runCli(["get", "pm-typed-feature-nullish", "--json"], { expectJson: true });
      expect(featureResult.code).toBe(0);
      expect((featureResult.json as { item: { type: string } }).item.type).toBe("Feature");

      const generatedIdResult = context.runCli(["get", result.ids[5], "--json"], { expectJson: true });
      expect(generatedIdResult.code).toBe(0);
      expect((generatedIdResult.json as { item: { type: string } }).item.type).toBe("Feature");
    });
  });

  it("skips lock conflicts and invalid record payloads deterministically", async () => {
    await withTempPmPath(async (context) => {
      const lockId = "pm-lock-target";
      const lockPath = path.join(context.pmPath, "locks", `${lockId}.lock`);
      await writeFile(
        lockPath,
        JSON.stringify({
          id: lockId,
          pid: 12345,
          owner: "other-owner",
          created_at: new Date().toISOString(),
          ttl_seconds: 1800,
        }),
        "utf8",
      );

      const sourcePath = path.join(context.tempRoot, "lock-conflict.jsonl");
      const lines = [
        JSON.stringify([]),
        JSON.stringify({ id: "lock-target", title: "Conflicting item" }),
        JSON.stringify({ id: "fresh-after-conflict", title: "Fresh import" }),
      ];
      await writeFile(sourcePath, `${lines.join("\n")}\n`, "utf8");

      const result = await runBeadsImport({ file: sourcePath }, { path: context.pmPath });
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(2);
      expect(result.ids).toEqual(["pm-fresh-after-conflict"]);
      expect(result.warnings).toEqual([
        "beads_import_invalid_record:1",
        "beads_import_lock_conflict:pm-lock-target",
      ]);
    });
  });

  it("rolls back written item bytes when history append fails", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-history-failure";
      await mkdir(path.join(context.pmPath, "history", `${id}.jsonl`), { recursive: true });

      const sourcePath = path.join(context.tempRoot, "history-append-fail.jsonl");
      await writeFile(sourcePath, `${JSON.stringify({ id: "history-failure", title: "History failure case" })}\n`, "utf8");

      await expect(runBeadsImport({ file: sourcePath }, { path: context.pmPath })).rejects.toBeInstanceOf(Error);

      const getResult = context.runCli(["get", id, "--json"]);
      expect(getResult.code).toBe(EXIT_CODE.NOT_FOUND);
    });
  });

  it("uses default relative source path and unknown author fallback deterministically", async () => {
    await withTempPmPath(async (context) => {
      const beadsDir = path.join(context.tempRoot, ".beads");
      await mkdir(beadsDir, { recursive: true });
      await writeFile(
        path.join(beadsDir, "issues.jsonl"),
        `${JSON.stringify({
          title: "Default source import",
          estimated_minutes: "not-a-number",
          dependencies: ["", {}, 123],
          comments: ["", {}, 456],
        })}\n`,
        "utf8",
      );

      const previousCwd = process.cwd();
      const previousAuthor = process.env.PM_AUTHOR;
      process.chdir(context.tempRoot);
      process.env.PM_AUTHOR = "";
      try {
        const result = await runBeadsImport({}, { path: context.pmPath });
        expect(result.ok).toBe(true);
        expect(result.source).toBe(".beads/issues.jsonl");
        expect(result.imported).toBe(1);
        expect(result.skipped).toBe(0);
        expect(result.ids).toHaveLength(1);

        process.chdir(previousCwd);
        const imported = context.runCli(["get", result.ids[0], "--json"], { expectJson: true });
        expect(imported.code).toBe(0);
        const importedJson = imported.json as {
          item: {
            author?: string;
            estimated_minutes?: number;
            dependencies?: Array<unknown>;
            comments?: Array<unknown>;
          };
        };
        expect(importedJson.item.author).toBe("unknown");
        expect(importedJson.item.estimated_minutes).toBeUndefined();
        expect(importedJson.item.dependencies).toBeUndefined();
        expect(importedJson.item.comments).toBeUndefined();
      } finally {
        if (process.cwd() !== previousCwd) {
          process.chdir(previousCwd);
        }
        if (previousAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousAuthor;
        }
      }
    });
  });

  it("auto-discovers a root issues.jsonl source with a deterministic warning", async () => {
    await withTempPmPath(async (context) => {
      await writeFile(
        path.join(context.tempRoot, "issues.jsonl"),
        `${JSON.stringify({ id: "root-auto-discovery", title: "Root auto discovery" })}\n`,
        "utf8",
      );

      const previousCwd = process.cwd();
      process.chdir(context.tempRoot);
      try {
        const result = await runBeadsImport({}, { path: context.pmPath });
        expect(result.source).toBe("issues.jsonl");
        expect(result.ids).toEqual(["pm-root-auto-discovery"]);
        expect(result.warnings).toEqual(["beads_import_source_autodiscovered:issues.jsonl"]);
      } finally {
        process.chdir(previousCwd);
      }
    });
  });

  it("refuses sync_base auto-discovery because it may be partial", async () => {
    await withTempPmPath(async (context) => {
      const beadsDir = path.join(context.tempRoot, ".beads");
      await mkdir(beadsDir, { recursive: true });
      await writeFile(
        path.join(beadsDir, "sync_base.jsonl"),
        `${JSON.stringify({ id: "sync-base", title: "Sync base only" })}\n`,
        "utf8",
      );

      const previousCwd = process.cwd();
      process.chdir(context.tempRoot);
      try {
        await expect(runBeadsImport({}, { path: context.pmPath })).rejects.toMatchObject({
          exitCode: EXIT_CODE.NOT_FOUND,
          message: expect.stringContaining("sync_base snapshots may be partial"),
        });
      } finally {
        process.chdir(previousCwd);
      }
    });
  });

  it("preserves explicit source ids when requested and keeps them addressable in a default-prefix tracker", async () => {
    await withTempPmPath(async (context) => {
      const sourcePath = path.join(context.tempRoot, "preserve-source-ids.jsonl");
      await writeFile(
        sourcePath,
        `${JSON.stringify({
          id: "clawd-01c8",
          title: "Preserve source id",
          dependencies: [{ depends_on_id: "clawd-01c8.1", type: "parent-child" }],
        })}\n${JSON.stringify({
          id: "clawd-01c8.1",
          title: "Preserve source dependency target",
        })}\n`,
        "utf8",
      );

      const result = await runBeadsImport(
        {
          file: sourcePath,
          preserveSourceIds: true,
        },
        { path: context.pmPath },
      );
      expect(result.ids).toEqual(["clawd-01c8", "clawd-01c8.1"]);

      const imported = context.runCli(["get", "clawd-01c8", "--json"], { expectJson: true });
      expect(imported.code).toBe(0);
      expect((imported.json as any).item.id).toBe("clawd-01c8");
      expect((imported.json as any).item.dependencies).toEqual([
        {
          id: "clawd-01c8.1",
          kind: "parent_child",
          created_at: (imported.json as any).item.created_at,
          source_kind: "parent-child",
        },
      ]);
    });
  });

  it("falls back to settings author when explicit and env authors are unset", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { author_default?: string };
      settings.author_default = "settings-author";
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const sourcePath = path.join(context.tempRoot, "settings-author.jsonl");
      await writeFile(sourcePath, `${JSON.stringify({ id: "settings-author-id", title: "Settings fallback import" })}\n`, "utf8");

      const previousAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        const result = await runBeadsImport({ file: sourcePath }, { path: context.pmPath });
        expect(result.imported).toBe(1);
      } finally {
        if (previousAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousAuthor;
        }
      }

      const imported = context.runCli(["get", "pm-settings-author-id", "--json"], { expectJson: true });
      expect(imported.code).toBe(0);
      expect((imported.json as { item: { author: string } }).item.author).toBe("settings-author");
    });
  });

  it("dispatches source and import artifact read/write hooks with warning propagation", async () => {
    await withTempPmPath(async (context) => {
      const sourcePath = path.join(context.tempRoot, "hooked-import.jsonl");
      await writeFile(sourcePath, `${JSON.stringify({ id: "hooked-import", title: "Hooked import" })}\n`, "utf8");

      const hookEvents: string[] = [];
      setActiveExtensionHooks({
        beforeCommand: [],
        afterCommand: [],
        onRead: [
          {
            layer: "project",
            name: "beads-read-hook",
            run: (hookContext) => {
              hookEvents.push(`read:${path.basename(hookContext.path)}`);
            },
          },
          {
            layer: "project",
            name: "beads-read-boom",
            run: () => {
              throw new Error("boom-read");
            },
          },
        ],
        onWrite: [
          {
            layer: "project",
            name: "beads-write-hook",
            run: (hookContext) => {
              hookEvents.push(`write:${hookContext.op}:${path.basename(hookContext.path)}`);
            },
          },
          {
            layer: "project",
            name: "beads-write-boom",
            run: () => {
              throw new Error("boom-write");
            },
          },
        ],
        onIndex: [],
      });

      const result = await runBeadsImport({ file: sourcePath }, { path: context.pmPath });
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.ids).toEqual(["pm-hooked-import"]);
      expect(result.warnings).toEqual([
        "extension_hook_failed:project:beads-read-boom:onRead",
        "extension_hook_failed:project:beads-write-boom:onWrite",
        "extension_hook_failed:project:beads-write-boom:onWrite",
      ]);
      expect(hookEvents).toContain("read:hooked-import.jsonl");
      expect(hookEvents).toContain("write:import:pm-hooked-import.md");
      expect(hookEvents).toContain("write:import:history:pm-hooked-import.jsonl");
    });
  });
});
