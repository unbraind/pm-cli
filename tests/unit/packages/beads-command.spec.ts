import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBeadsImport } from "../../../packages/pm-beads/extensions/beads/runtime.ts";
import {
  clearActiveExtensionHooks,
  setActiveExtensionHooks,
} from "../../../src/core/extensions/index.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import {
  readSettings,
  writeSettings,
} from "../../../src/core/store/settings.js";
import type { TempPmContext } from "../../helpers/withTempPmPath.js";
import { readJsonlFixture } from "../../helpers/fixtures.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

type BeadsFixtureRecord = Record<string, unknown>;
type BeadsDependencyJson = {
  id: string;
  kind: string;
  created_at: string;
  author?: string;
  source_kind?: string;
};
type BeadsItemJson = {
  item: {
    id?: string;
    type?: string;
    source_type?: string;
    tags?: string[];
    status?: string;
    closed_at?: string;
    close_reason?: string;
    resolution?: string;
    expected_result?: string;
    actual_result?: string;
    design?: string;
    external_ref?: string;
    dependencies?: BeadsDependencyJson[];
    created_at: string;
    author?: string;
    body?: string;
    assignee?: string;
    source_owner?: string;
    deadline?: string;
    comments?: Array<{ created_at: string; author: string; text: string }>;
    notes?: Array<{
      created_at: string;
      author: string;
      text: string;
      format?: string;
      event_type?: string;
      data?: Record<string, unknown>;
    }>;
  };
};

const beadsImportRecordsFixture = readJsonlFixture<BeadsFixtureRecord>(
  "beads",
  "import-records.jsonl",
);
const beadsConversionFixture = readJsonlFixture<BeadsFixtureRecord>(
  "beads",
  "conversion-branches.jsonl",
);
const portableBackupFixture = path.resolve(
  "tests",
  "fixtures",
  "beads",
  "backup-v0.62",
);

async function copyPortableBackup(
  tempRoot: string,
  name: string,
): Promise<string> {
  const destination = path.join(tempRoot, name);
  await cp(portableBackupFixture, destination, { recursive: true });
  return destination;
}

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
      await writeFile(
        sourcePath,
        `${JSON.stringify({ title: "Uninitialized import" })}\n`,
        "utf8",
      );
      await expect(
        runBeadsImport({ file: sourcePath }, { path: tempDir }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails when the source JSONL path is missing", async () => {
    await withTempPmPath(async (context) => {
      const missingPath = path.join(context.tempRoot, "missing-beads.jsonl");
      await expect(
        runBeadsImport({ file: missingPath }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("fails when no Beads source can be auto-discovered", async () => {
    await withTempPmPath(async (context) => {
      const previousCwd = process.cwd();
      process.chdir(context.tempRoot);
      try {
        await expect(
          runBeadsImport({}, { path: context.pmPath }),
        ).rejects.toMatchObject({
          exitCode: EXIT_CODE.NOT_FOUND,
          message: expect.stringContaining(
            "Checked .beads/issues.jsonl, issues.jsonl",
          ),
        });
      } finally {
        process.chdir(previousCwd);
      }
    });
  });

  it("reads Beads JSONL from stdin when --file - is requested", async () => {
    await withTempPmPath(async (context) => {
      const stdinStream = new PassThrough();
      stdinStream.end(
        `${JSON.stringify({ id: "stdin-item", title: "STDIN import" })}\n`,
      );
      Object.defineProperty(stdinStream, "isTTY", {
        value: false,
        configurable: true,
      });
      const stdinSpy = vi
        .spyOn(process, "stdin", "get")
        .mockReturnValue(stdinStream as unknown as NodeJS.ReadStream);

      try {
        const result = await runBeadsImport(
          { file: "-" },
          { path: context.pmPath },
        );
        expect(result.source).toBe("-");
        expect(result.ids).toEqual(["pm-stdin-item"]);
      } finally {
        stdinSpy.mockRestore();
      }
    });
  });

  it("fails fast for --file - when stdin is an interactive TTY", async () => {
    await withTempPmPath(async (context) => {
      const stdinStream = new PassThrough();
      Object.defineProperty(stdinStream, "isTTY", {
        value: true,
        configurable: true,
      });
      const stdinSpy = vi
        .spyOn(process, "stdin", "get")
        .mockReturnValue(stdinStream as unknown as NodeJS.ReadStream);

      try {
        await expect(
          runBeadsImport({ file: "-" }, { path: context.pmPath }),
        ).rejects.toMatchObject({
          exitCode: EXIT_CODE.USAGE,
          message: expect.stringContaining("requires piped stdin input"),
        });
      } finally {
        stdinSpy.mockRestore();
      }
    });
  });

  it("imports beads records with deterministic mapping and import history entries", async () => {
    await withTempPmPath(async (context) => {
      const sourcePath = path.join(context.tempRoot, "issues.jsonl");
      const records = beadsImportRecordsFixture;
      const firstRecord = records[0] as {
        created_at: string;
        updated_at: string;
      };
      const createdAt = firstRecord.created_at;
      await writeFile(
        sourcePath,
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
        "utf8",
      );

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

      const first = context.runCli(["get", "pm-legacy.1", "--full", "--json"], {
        expectJson: true,
      });
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
          tests: Array<{
            command?: string;
            path?: string;
            scope: string;
            timeout_seconds?: number;
            note?: string;
          }>;
          docs: Array<{ path: string; scope: string; note?: string }>;
          body: string;
        };
      };
      expect(firstJson.item.type).toBe("Feature");
      expect(firstJson.item.status).toBe("blocked");
      expect(firstJson.item.priority).toBe(0);
      expect(firstJson.item.tags).toEqual(["beads", "import"]);
      expect(firstJson.item.estimated_minutes).toBe(45);
      expect(firstJson.item.acceptance_criteria).toBe("Importer maps fields");
      expect(firstJson.item.dependencies).toEqual([
        {
          id: "pm-dep-1",
          kind: "blocks",
          created_at: createdAt,
          author: "beads",
        },
      ]);
      expect(firstJson.item.comments).toEqual([
        { created_at: createdAt, author: "beads", text: "comment-1" },
      ]);
      expect(firstJson.item.notes).toEqual([
        { created_at: createdAt, author: "unit-beads-author", text: "note-1" },
      ]);
      expect(firstJson.item.learnings).toEqual([
        {
          created_at: createdAt,
          author: "unit-beads-author",
          text: "learning-1",
        },
      ]);
      expect(firstJson.item.files).toEqual([
        { path: "src/foo.ts", scope: "global", note: "global file" },
        { path: "src/bar.ts", scope: "project" },
      ]);
      expect(firstJson.item.tests).toEqual([
        {
          command: "pnpm test",
          scope: "project",
          timeout_seconds: 120,
          note: "run tests",
        },
      ]);
      expect(firstJson.item.docs).toEqual([
        { path: "docs/design.md", scope: "project" },
        { path: "docs/readme.md", scope: "project" },
      ]);
      expect(firstJson.item.body).toBe("beads-body");

      const second = context.runCli(["get", "pm-legacy.2", "--json"], {
        expectJson: true,
      });
      expect(second.code).toBe(0);
      const secondJson = second.json as {
        item: {
          type: string;
          status: string;
          priority: number;
          description: string;
          author: string;
        };
      };
      expect(secondJson.item.type).toBe("Task");
      expect(secondJson.item.status).toBe("open");
      expect(secondJson.item.priority).toBe(2);
      expect(secondJson.item.description).toBe("");
      expect(secondJson.item.author).toBe("source-author");

      const ninth = context.runCli(["get", "pm-legacy.9", "--json"], {
        expectJson: true,
      });
      expect(ninth.code).toBe(0);
      const ninthJson = ninth.json as BeadsItemJson;
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
      expect(ninthJson.item.body).toBe(
        "## Design\n\nThis is the design doc\n\n## External Reference\nJIRA-123",
      );

      const tenth = context.runCli(["get", "pm-legacy.10", "--json"], {
        expectJson: true,
      });
      expect(tenth.code).toBe(0);
      const tenthJson = tenth.json as { item: { body: string } };
      expect(tenthJson.item.body).toBe(
        "Existing body\n\n## Design\n\nDesign details\n\n## External Reference\nEXT-456",
      );

      const eleventh = context.runCli(["get", "pm-legacy.11", "--json"], {
        expectJson: true,
      });
      expect(eleventh.code).toBe(0);
      const eleventhJson = eleventh.json as {
        item: { external_ref: string; body: string };
      };
      expect(eleventhJson.item.external_ref).toBe("EXT-ONLY");
      expect(eleventhJson.item.body).toBe("## External Reference\nEXT-ONLY");

      const twelfth = context.runCli(["get", "pm-legacy.12", "--json"], {
        expectJson: true,
      });
      expect(twelfth.code).toBe(0);
      const twelfthJson = twelfth.json as BeadsItemJson;
      expect(twelfthJson.item.type).toBe("Task");
      expect(twelfthJson.item.source_type).toBe("event");
      expect(twelfthJson.item.assignee).toBe("owner-a");
      expect(twelfthJson.item.source_owner).toBe("owner-a");
      expect(twelfthJson.item.deadline).toBe(
        "2026-03-15T11:18:44.832869327+01:00",
      );
      expect(twelfthJson.item.dependencies).toEqual([
        {
          id: "pm-legacy.1",
          kind: "discovered_from",
          created_at: twelfthJson.item.created_at,
          author: "daemon",
          source_kind: "discovered-from",
        },
      ]);

      const thirteenth = context.runCli(["get", "pm-legacy.13", "--json"], {
        expectJson: true,
      });
      expect(thirteenth.code).toBe(0);
      const thirteenthJson = thirteenth.json as BeadsItemJson;
      expect(thirteenthJson.item.dependencies).toEqual([
        {
          id: "pm-legacy.2",
          kind: "related_to",
          created_at: "2026-01-06T01:02:03.000Z",
          author: "beads",
          source_kind: "relates-to",
        },
      ]);

      const history = context.runCli(
        ["history", "pm-legacy.1", "--json", "--full"],
        { expectJson: true },
      );
      expect(history.code).toBe(0);
      const historyJson = history.json as { history: Array<{ op: string }> };
      expect(historyJson.history.some((entry) => entry.op === "import")).toBe(
        true,
      );
    });
  });

  it("covers specific mapping branches for arrays", async () => {
    await withTempPmPath(async (context) => {
      const sourcePath = path.join(context.tempRoot, "branch-arrays.jsonl");
      const lines = [
        JSON.stringify({
          id: "b1",
          title: "B1",
          docs: "   ",
          tests: "   ",
          files: "   ",
        }),
        JSON.stringify({
          id: "b2",
          title: "B2",
          docs: "doc-str",
          tests: "test-str",
          files: "file-str",
        }),
        JSON.stringify({
          id: "b3",
          title: "B3",
          docs: [" ", {}],
          tests: [" ", {}],
          files: [" ", {}],
        }),
        JSON.stringify({
          id: "b4",
          title: "B4",
          docs: [{ doc: "d", scope: "global" }],
          tests: [{ test: "t", scope: "global" }],
          files: [{ file: "f", scope: "global" }],
        }),
        JSON.stringify({
          id: "b5",
          title: "B5",
          docs: [{ path: "p" }],
          tests: [{ path: "p" }],
          files: [{ path: "p" }],
        }),
      ];
      await writeFile(sourcePath, `${lines.join("\n")}\n`, "utf8");
      const result = await runBeadsImport(
        { file: sourcePath },
        { path: context.pmPath },
      );
      expect(result.imported).toBe(5);

      const commandAlias = context.runCli(
        ["get", "pm-b4", "--full", "--json"],
        { expectJson: true },
      );
      expect(commandAlias.code).toBe(0);
      expect(
        (
          commandAlias.json as {
            item: { tests?: Array<{ command: string; scope: string }> };
          }
        ).item.tests,
      ).toEqual([{ command: "t", scope: "global" }]);

      const pathOnly = context.runCli(["get", "pm-b5", "--full", "--json"], {
        expectJson: true,
      });
      expect(pathOnly.code).toBe(0);
      expect(
        (pathOnly.json as { item: { tests?: unknown } }).item.tests,
      ).toEqual([]);
    });
  });

  it("drops negative numeric linked-test timeouts during import", async () => {
    await withTempPmPath(async (context) => {
      const sourcePath = path.join(context.tempRoot, "negative-timeout.jsonl");
      await writeFile(
        sourcePath,
        `${JSON.stringify({
          id: "negative-timeout",
          title: "Negative timeout import",
          tests: [
            {
              command: "pnpm test",
              timeout_seconds: -5,
              note: "negative timeout must be ignored",
            },
          ],
        })}\n`,
        "utf8",
      );

      const result = await runBeadsImport(
        { file: sourcePath },
        { path: context.pmPath },
      );
      expect(result.imported).toBe(1);

      const imported = context.runCli(
        ["get", "pm-negative-timeout", "--full", "--json"],
        { expectJson: true },
      );
      expect(imported.code).toBe(0);
      expect(
        (
          imported.json as {
            item: { tests?: Array<{ timeout_seconds?: number }> };
          }
        ).item.tests,
      ).toEqual([
        {
          command: "pnpm test",
          scope: "project",
          note: "negative timeout must be ignored",
        },
      ]);
    });
  });

  it("drops zero linked-test timeouts during import", async () => {
    await withTempPmPath(async (context) => {
      const sourcePath = path.join(context.tempRoot, "zero-timeout.jsonl");
      await writeFile(
        sourcePath,
        `${JSON.stringify({
          id: "zero-timeout",
          title: "Zero timeout import",
          tests: [
            {
              command: "pnpm test",
              timeout_seconds: 0,
              note: "zero timeout must be ignored",
            },
          ],
        })}\n`,
        "utf8",
      );

      const result = await runBeadsImport(
        { file: sourcePath },
        { path: context.pmPath },
      );
      expect(result.imported).toBe(1);

      const imported = context.runCli(
        ["get", "pm-zero-timeout", "--full", "--json"],
        { expectJson: true },
      );
      expect(imported.code).toBe(0);
      expect(
        (
          imported.json as {
            item: { tests?: Array<{ timeout_seconds?: number }> };
          }
        ).item.tests,
      ).toEqual([
        {
          command: "pnpm test",
          scope: "project",
          note: "zero timeout must be ignored",
        },
      ]);
    });
  });

  it("drops blank string linked-test timeouts during import", async () => {
    await withTempPmPath(async (context) => {
      const sourcePath = path.join(context.tempRoot, "blank-timeout.jsonl");
      await writeFile(
        sourcePath,
        `${JSON.stringify({
          id: "blank-timeout",
          title: "Blank timeout import",
          tests: [
            {
              command: "pnpm test",
              timeout_seconds: "   ",
              note: "blank timeout must be ignored",
            },
          ],
        })}\n`,
        "utf8",
      );

      const result = await runBeadsImport(
        { file: sourcePath },
        { path: context.pmPath },
      );
      expect(result.imported).toBe(1);

      const imported = context.runCli(
        ["get", "pm-blank-timeout", "--full", "--json"],
        { expectJson: true },
      );
      expect(imported.code).toBe(0);
      expect(
        (
          imported.json as {
            item: { tests?: Array<{ timeout_seconds?: number }> };
          }
        ).item.tests,
      ).toEqual([
        {
          command: "pnpm test",
          scope: "project",
          note: "blank timeout must be ignored",
        },
      ]);
    });
  });

  it("maps additional Beads dependency kind aliases deterministically", async () => {
    await withTempPmPath(async (context) => {
      const sourcePath = path.join(
        context.tempRoot,
        "dependency-aliases.jsonl",
      );
      const lines = [
        JSON.stringify({ id: "dep-target", title: "Dependency target" }),
        JSON.stringify({
          id: "kindless",
          title: "Kindless dependency",
          dependencies: [
            {
              id: "dependency-row-identity",
              item_id: "kindless",
              depends_on_id: "dep-target",
            },
          ],
        }),
        JSON.stringify({
          id: "child-of",
          title: "Child Of dependency",
          dependencies: [{ depends_on_id: "dep-target", type: "child-of" }],
        }),
        JSON.stringify({
          id: "blocked-by",
          title: "Blocked By dependency",
          dependencies: [{ depends_on_id: "dep-target", type: "blocked-by" }],
        }),
        JSON.stringify({
          id: "incident-from",
          title: "Incident From dependency",
          dependencies: [
            { depends_on_id: "dep-target", type: "incident-from" },
          ],
        }),
        JSON.stringify({
          id: "related-to",
          title: "Related To dependency",
          dependencies: [{ depends_on_id: "dep-target", type: "related-to" }],
        }),
      ];
      await writeFile(sourcePath, `${lines.join("\n")}\n`, "utf8");

      await runBeadsImport({ file: sourcePath }, { path: context.pmPath });

      const kindlessJson = context.runCli(["get", "pm-kindless", "--json"], {
        expectJson: true,
      }).json as BeadsItemJson;
      const childOfJson = context.runCli(["get", "pm-child-of", "--json"], {
        expectJson: true,
      }).json as BeadsItemJson;
      const blockedByJson = context.runCli(["get", "pm-blocked-by", "--json"], {
        expectJson: true,
      }).json as BeadsItemJson;
      const incidentFromJson = context.runCli(
        ["get", "pm-incident-from", "--json"],
        { expectJson: true },
      ).json as BeadsItemJson;
      const relatedToJson = context.runCli(["get", "pm-related-to", "--json"], {
        expectJson: true,
      }).json as BeadsItemJson;

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
        JSON.stringify({
          id: "fresh-1",
          title: "Fresh imported item",
          comments: "single-comment",
        }),
      ];
      await writeFile(sourcePath, `${lines.join("\n")}\n`, "utf8");

      const result = await runBeadsImport(
        { file: sourcePath },
        { path: context.pmPath },
      );
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(3);
      expect(result.ids).toEqual(["pm-fresh-1"]);
      expect(result.warnings).toEqual([
        "beads_import_invalid_jsonl_line:1",
        "beads_import_missing_title:2",
        `beads_import_item_exists:${existingId}`,
      ]);

      const imported = context.runCli(
        ["get", "pm-fresh-1", "--full", "--json"],
        { expectJson: true },
      );
      expect(imported.code).toBe(0);
      const importedJson = imported.json as {
        item: {
          comments: Array<{ created_at: string; author: string; text: string }>;
        };
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
      const sourcePath = path.join(
        context.tempRoot,
        "conversion-branches.jsonl",
      );
      const lines = beadsConversionFixture.map((record) =>
        JSON.stringify(record),
      );
      await writeFile(sourcePath, `${lines.join("\n")}\n`, "utf8");

      const result = await runBeadsImport(
        { file: sourcePath, author: "branch-author" },
        { path: context.pmPath },
      );
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

      const epicResult = context.runCli(
        ["get", "pm-typed-epic", "--full", "--json"],
        { expectJson: true },
      );
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
      expect(epicJson.item.comments).toEqual([]);
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

      const taskResult = context.runCli(["get", "pm-typed-task", "--json"], {
        expectJson: true,
      });
      expect(taskResult.code).toBe(0);
      expect((taskResult.json as { item: { type: string } }).item.type).toBe(
        "Task",
      );

      const choreResult = context.runCli(["get", "pm-typed-chore", "--json"], {
        expectJson: true,
      });
      expect(choreResult.code).toBe(0);
      expect((choreResult.json as { item: { type: string } }).item.type).toBe(
        "Chore",
      );

      const issueResult = context.runCli(["get", "pm-typed-issue", "--json"], {
        expectJson: true,
      });
      expect(issueResult.code).toBe(0);
      expect((issueResult.json as { item: { type: string } }).item.type).toBe(
        "Issue",
      );

      const featureResult = context.runCli(
        ["get", "pm-typed-feature-nullish", "--json"],
        { expectJson: true },
      );
      expect(featureResult.code).toBe(0);
      expect((featureResult.json as { item: { type: string } }).item.type).toBe(
        "Feature",
      );

      const generatedIdResult = context.runCli(
        ["get", result.ids[5], "--json"],
        { expectJson: true },
      );
      expect(generatedIdResult.code).toBe(0);
      expect(
        (generatedIdResult.json as { item: { type: string } }).item.type,
      ).toBe("Feature");
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

      const result = await runBeadsImport(
        { file: sourcePath },
        { path: context.pmPath },
      );
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
      await mkdir(path.join(context.pmPath, "history", `${id}.jsonl`), {
        recursive: true,
      });

      const sourcePath = path.join(
        context.tempRoot,
        "history-append-fail.jsonl",
      );
      await writeFile(
        sourcePath,
        `${JSON.stringify({ id: "history-failure", title: "History failure case" })}\n`,
        "utf8",
      );

      await expect(
        runBeadsImport({ file: sourcePath }, { path: context.pmPath }),
      ).rejects.toBeInstanceOf(Error);

      const getResult = context.runCli(["get", id, "--json"]);
      expect(getResult.code).toBe(EXIT_CODE.NOT_FOUND);
    });
  });

  it("uses default relative source path and unknown author fallback deterministically", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      await writeSettings(context.pmPath, { ...settings, author_default: "" });
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
        const imported = context.runCli(["get", result.ids[0], "--json"], {
          expectJson: true,
        });
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
        expect(result.warnings).toEqual([
          "beads_import_source_autodiscovered:issues.jsonl",
        ]);
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
        await expect(
          runBeadsImport({}, { path: context.pmPath }),
        ).rejects.toMatchObject({
          exitCode: EXIT_CODE.NOT_FOUND,
          message: expect.stringContaining(
            "sync_base snapshots may be partial",
          ),
        });
      } finally {
        process.chdir(previousCwd);
      }
    });
  });

  it("preserves explicit source ids when requested and keeps them addressable in a default-prefix tracker", async () => {
    await withTempPmPath(async (context) => {
      const sourcePath = path.join(
        context.tempRoot,
        "preserve-source-ids.jsonl",
      );
      await writeFile(
        sourcePath,
        `${JSON.stringify({
          id: "clawd-01c8",
          title: "Preserve source id",
          dependencies: [
            { depends_on_id: "clawd-01c8.1", type: "parent-child" },
          ],
        })}\n${JSON.stringify({
          id: "clawd-01c8.1",
          title: "Preserve source dependency target",
        })}\n${JSON.stringify({
          title: "Generate an ID while preserving explicit siblings",
          source_events: [null, "invalid", [], {}, { event_type: "" }],
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
      expect(result.ids.slice(0, 2)).toEqual(["clawd-01c8", "clawd-01c8.1"]);
      expect(result.ids).toHaveLength(3);

      const imported = context.runCli(["get", "clawd-01c8", "--json"], {
        expectJson: true,
      });
      expect(imported.code).toBe(0);
      const importedJson = imported.json as BeadsItemJson;
      expect(importedJson.item.id).toBe("clawd-01c8");
      expect(importedJson.item.dependencies).toEqual([
        {
          id: "clawd-01c8.1",
          kind: "parent_child",
          created_at: importedJson.item.created_at,
          source_kind: "parent-child",
        },
      ]);
    });
  });

  it("imports every v0.62 portable-backup relation with exact identity and closure parity", async () => {
    await withTempPmPath(async (context) => {
      const backupDir = portableBackupFixture;
      const result = await runBeadsImport(
        { backupDir, preserveSourceIds: true },
        { path: context.pmPath },
      );

      expect(result).toMatchObject({
        ok: true,
        source: backupDir,
        imported: 3,
        skipped: 0,
        ids: ["Tokenwerk-A1", "Tokenwerk-B2", "Tokenwerk-C3"],
        complete: true,
        source_counts: {
          issues: 3,
          events: 2,
          comments: 1,
          dependencies: 1,
          labels: 2,
        },
        imported_counts: {
          issues: 3,
          events: 2,
          comments: 1,
          dependencies: 1,
          labels: 2,
        },
        id_mapping: [
          { source_id: "Tokenwerk-A1", imported_id: "Tokenwerk-A1" },
          { source_id: "Tokenwerk-B2", imported_id: "Tokenwerk-B2" },
          { source_id: "Tokenwerk-C3", imported_id: "Tokenwerk-C3" },
        ],
      });

      const imported = context.runCli(
        ["get", "Tokenwerk-A1", "--full", "--json"],
        {
          expectJson: true,
        },
      );
      expect(imported.code).toBe(0);
      const importedJson = imported.json as BeadsItemJson;
      expect(importedJson.item).toMatchObject({
        id: "Tokenwerk-A1",
        tags: ["context", "migration"],
        close_reason: "Fixed without losing migration context",
        resolution: "Fixed without losing migration context",
        dependencies: [
          expect.objectContaining({
            id: "Tokenwerk-B2",
            kind: "blocked_by",
          }),
        ],
        comments: [
          {
            created_at: "2026-03-20T11:00:00.000Z",
            author: "source-reviewer",
            text: "Keep this exact discussion body.",
          },
        ],
      });
      expect(importedJson.item.expected_result).toBeUndefined();
      expect(importedJson.item.actual_result).toBeUndefined();
      expect(importedJson.item.notes).toContainEqual({
        created_at: "2026-03-20T12:00:00.000Z",
        author: "source-agent",
        text: "Closure event context",
        format: "json",
        event_type: "beads:status_changed",
        data: {
          source: "beads-portable-backup",
          id: "event-1",
          issue_id: "Tokenwerk-A1",
          event_type: "status_changed",
          actor: "source-agent",
          old_value: "in_progress",
          new_value: "closed",
          comment: "Closure event context",
          created_at: "2026-03-20T12:00:00.000Z",
        },
      });

      const related = context.runCli(
        ["get", "Tokenwerk-B2", "--full", "--json"],
        {
          expectJson: true,
        },
      );
      expect(related.code).toBe(0);
      const relatedJson = related.json as {
        item: {
          parent?: string;
          notes?: Array<{
            created_at: string;
            author: string;
            text: string;
            data?: Record<string, unknown>;
          }>;
        };
      };
      expect(relatedJson.item.parent).toBe("Tokenwerk-A1");
      expect(relatedJson.item.notes).toContainEqual(
        expect.objectContaining({
          created_at: "2026-03-20T09:00:00.000Z",
          author: "test-author",
          text: "metadata_changed",
          data: expect.objectContaining({
            metadata: { attempt: 1, flags: [true, null] },
          }),
        }),
      );

      const outcome = context.runCli(["get", "Tokenwerk-C3", "--json"], {
        expectJson: true,
      });
      expect(outcome.code).toBe(0);
      expect((outcome.json as BeadsItemJson).item).toMatchObject({
        close_reason: "Source closure context",
        resolution: "Explicit source resolution",
        expected_result: "Expected source outcome",
        actual_result: "Actual source outcome",
      });
    });
  });

  it("rejects incomplete or malformed portable backups before any item write", async () => {
    await withTempPmPath(async (context) => {
      const cases: Array<{
        name: string;
        message: string;
        mutate: (backupDir: string) => Promise<void>;
      }> = [
        {
          name: "missing-table",
          message: "comments.jsonl",
          mutate: async (backupDir) => {
            await rm(path.join(backupDir, "comments.jsonl"));
          },
        },
        {
          name: "invalid-jsonl",
          message: "invalid JSON",
          mutate: async (backupDir) => {
            await writeFile(
              path.join(backupDir, "comments.jsonl"),
              "{\n",
              "utf8",
            );
          },
        },
        {
          name: "non-record",
          message: "non-record row",
          mutate: async (backupDir) => {
            await writeFile(
              path.join(backupDir, "comments.jsonl"),
              "[]\n",
              "utf8",
            );
          },
        },
        {
          name: "missing-issue-id",
          message: "issue is missing id",
          mutate: async (backupDir) => {
            await writeFile(
              path.join(backupDir, "issues.jsonl"),
              '{"title":"No ID"}\n',
              "utf8",
            );
          },
        },
        {
          name: "duplicate-issue-id",
          message: "duplicate issue ID",
          mutate: async (backupDir) => {
            await writeFile(
              path.join(backupDir, "issues.jsonl"),
              '{"id":"same","title":"One"}\n{"id":"same","title":"Two"}\n',
              "utf8",
            );
          },
        },
        {
          name: "missing-title",
          message: "missing title",
          mutate: async (backupDir) => {
            await writeFile(
              path.join(backupDir, "issues.jsonl"),
              '{"id":"no-title"}\n',
              "utf8",
            );
          },
        },
        {
          name: "missing-relation-issue",
          message: "missing issue_id",
          mutate: async (backupDir) => {
            await writeFile(
              path.join(backupDir, "comments.jsonl"),
              '{"text":"orphan"}\n',
              "utf8",
            );
          },
        },
        {
          name: "unknown-relation-issue",
          message: "references missing issue",
          mutate: async (backupDir) => {
            await writeFile(
              path.join(backupDir, "comments.jsonl"),
              '{"issue_id":"absent","text":"orphan"}\n',
              "utf8",
            );
          },
        },
        {
          name: "missing-comment-text",
          message: "missing text",
          mutate: async (backupDir) => {
            await writeFile(
              path.join(backupDir, "comments.jsonl"),
              '{"issue_id":"Tokenwerk-A1"}\n',
              "utf8",
            );
          },
        },
        {
          name: "missing-event-type",
          message: "missing event_type",
          mutate: async (backupDir) => {
            await writeFile(
              path.join(backupDir, "events.jsonl"),
              '{"issue_id":"Tokenwerk-A1"}\n',
              "utf8",
            );
          },
        },
        {
          name: "missing-dependency-target",
          message: "missing depends_on_id",
          mutate: async (backupDir) => {
            await writeFile(
              path.join(backupDir, "dependencies.jsonl"),
              '{"issue_id":"Tokenwerk-A1"}\n',
              "utf8",
            );
          },
        },
        {
          name: "unknown-dependency-target",
          message: "references missing target",
          mutate: async (backupDir) => {
            await writeFile(
              path.join(backupDir, "dependencies.jsonl"),
              '{"issue_id":"Tokenwerk-A1","depends_on_id":"absent"}\n',
              "utf8",
            );
          },
        },
        {
          name: "missing-label",
          message: "missing label",
          mutate: async (backupDir) => {
            await writeFile(
              path.join(backupDir, "labels.jsonl"),
              '{"issue_id":"Tokenwerk-A1"}\n',
              "utf8",
            );
          },
        },
        {
          name: "missing-state",
          message: "backup_state.json",
          mutate: async (backupDir) => {
            await rm(path.join(backupDir, "backup_state.json"));
          },
        },
        {
          name: "invalid-state",
          message: "invalid JSON",
          mutate: async (backupDir) => {
            await writeFile(
              path.join(backupDir, "backup_state.json"),
              "{",
              "utf8",
            );
          },
        },
        {
          name: "missing-counts",
          message: "missing counts",
          mutate: async (backupDir) => {
            await writeFile(
              path.join(backupDir, "backup_state.json"),
              "{}\n",
              "utf8",
            );
          },
        },
        {
          name: "count-mismatch",
          message: "count mismatch",
          mutate: async (backupDir) => {
            const statePath = path.join(backupDir, "backup_state.json");
            const state = JSON.parse(await readFile(statePath, "utf8")) as {
              counts: { issues: number };
            };
            state.counts.issues += 1;
            await writeFile(
              statePath,
              `${JSON.stringify(state, null, 2)}\n`,
              "utf8",
            );
          },
        },
      ];

      for (const testCase of cases) {
        const backupDir = await copyPortableBackup(
          context.tempRoot,
          `portable-${testCase.name}`,
        );
        await testCase.mutate(backupDir);
        await expect(
          runBeadsImport(
            { backupDir, preserveSourceIds: true },
            { path: context.pmPath },
          ),
        ).rejects.toThrow(testCase.message);
      }

      expect(context.runCli(["get", "Tokenwerk-A1", "--json"]).code).toBe(
        EXIT_CODE.NOT_FOUND,
      );
    });
  });

  it("rejects conflicting source selection, missing backups, and unsafe preserved IDs", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runBeadsImport(
          { file: "issues.jsonl", backupDir: "backup" },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runBeadsImport(
          { backupDir: path.join(context.tempRoot, "absent") },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.NOT_FOUND });

      const sourcePath = path.join(context.tempRoot, "unsafe-id.jsonl");
      await writeFile(
        sourcePath,
        `${JSON.stringify({ id: " unsafe/id ", title: "Unsafe ID" })}\n`,
        "utf8",
      );
      await expect(
        runBeadsImport(
          { file: sourcePath, preserveSourceIds: true },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("cannot be preserved safely"),
      });
    });
  });

  it("validates every preserved relationship ID before writing any sibling", async () => {
    const cases = [
      { name: "parent", relationship: { parent: " unsafe/parent " } },
      {
        name: "string-dependency",
        relationship: { dependencies: [" unsafe/dependency "] },
      },
      {
        name: "object-dependency",
        relationship: {
          dependencies: [{}, { depends_on_id: " unsafe/dependency " }],
        },
      },
    ];

    for (const testCase of cases) {
      await withTempPmPath(async (context) => {
        const sourcePath = path.join(
          context.tempRoot,
          `unsafe-${testCase.name}.jsonl`,
        );
        await writeFile(
          sourcePath,
          [
            JSON.stringify({ id: "Safe-A1", title: "Safe sibling" }),
            JSON.stringify({
              id: "Unsafe-B2",
              title: "Unsafe relationship",
              ...testCase.relationship,
            }),
          ].join("\n") + "\n",
          "utf8",
        );

        await expect(
          runBeadsImport(
            { file: sourcePath, preserveSourceIds: true },
            { path: context.pmPath },
          ),
        ).rejects.toMatchObject({
          exitCode: EXIT_CODE.USAGE,
          message: expect.stringContaining("cannot be preserved safely"),
        });
        expect(context.runCli(["get", "Safe-A1", "--json"]).code).toBe(
          EXIT_CODE.NOT_FOUND,
        );
      });
    }
  });

  it("rejects preserved IDs that already exist in the target before importing siblings", async () => {
    await withTempPmPath(async (context) => {
      const seedPath = path.join(context.tempRoot, "seed-preserved.jsonl");
      await writeFile(
        seedPath,
        `${JSON.stringify({ id: "Tokenwerk-A1", title: "Existing exact ID" })}\n`,
        "utf8",
      );
      await runBeadsImport(
        { file: seedPath, preserveSourceIds: true },
        { path: context.pmPath },
      );

      await expect(
        runBeadsImport(
          { backupDir: portableBackupFixture, preserveSourceIds: true },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.CONFLICT,
        message: expect.stringContaining("target collision"),
      });
      expect(context.runCli(["get", "Tokenwerk-B2", "--json"]).code).toBe(
        EXIT_CODE.NOT_FOUND,
      );
    });
  });

  it("fails closed before writing current exports that advertise omitted comments", async () => {
    await withTempPmPath(async (context) => {
      const sourcePath = path.join(context.tempRoot, "incomplete-export.jsonl");
      await writeFile(
        sourcePath,
        `${JSON.stringify({
          id: "incomplete-context",
          title: "Incomplete context",
          comment_count: 1,
        })}\n`,
        "utf8",
      );

      await expect(
        runBeadsImport({ file: sourcePath }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--backup-dir"),
      });
      expect(
        context.runCli(["get", "pm-incomplete-context", "--json"]).code,
      ).toBe(EXIT_CODE.NOT_FOUND);
    });
  });

  it("accepts a count-bearing export when every issue advertises zero comments", async () => {
    await withTempPmPath(async (context) => {
      const sourcePath = path.join(context.tempRoot, "empty-comments-export.jsonl");
      await writeFile(
        sourcePath,
        `${JSON.stringify({
          id: "empty-context",
          title: "No source comments",
          comment_count: 0,
        })}\n`,
        "utf8",
      );

      await runBeadsImport({ file: sourcePath }, { path: context.pmPath });

      expect(
        context.runCli(["get", "pm-empty-context", "--json"]).code,
      ).toBe(0);
    });
  });

  it("fails closed before writes when source ids collide case-insensitively", async () => {
    await withTempPmPath(async (context) => {
      const sourcePath = path.join(context.tempRoot, "case-collision.jsonl");
      await writeFile(
        sourcePath,
        `${JSON.stringify({ id: "Tokenwerk-A1", title: "Upper" })}\n${JSON.stringify({ id: "tokenwerk-a1", title: "Lower" })}\n`,
        "utf8",
      );

      await expect(
        runBeadsImport(
          { file: sourcePath, preserveSourceIds: true },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.CONFLICT,
        message: expect.stringContaining("case-insensitive ID collision"),
      });
      expect(context.runCli(["get", "Tokenwerk-A1", "--json"]).code).toBe(
        EXIT_CODE.NOT_FOUND,
      );
    });
  });

  it("falls back to settings author when explicit and env authors are unset", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        author_default?: string;
      };
      settings.author_default = "settings-author";
      await writeFile(
        settingsPath,
        `${JSON.stringify(settings, null, 2)}\n`,
        "utf8",
      );

      const sourcePath = path.join(context.tempRoot, "settings-author.jsonl");
      await writeFile(
        sourcePath,
        `${JSON.stringify({ id: "settings-author-id", title: "Settings fallback import" })}\n`,
        "utf8",
      );

      const previousAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        const result = await runBeadsImport(
          { file: sourcePath },
          { path: context.pmPath },
        );
        expect(result.imported).toBe(1);
      } finally {
        if (previousAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousAuthor;
        }
      }

      const imported = context.runCli(
        ["get", "pm-settings-author-id", "--json"],
        { expectJson: true },
      );
      expect(imported.code).toBe(0);
      expect((imported.json as { item: { author: string } }).item.author).toBe(
        "settings-author",
      );
    });
  });

  it("dispatches source and import artifact read/write hooks with warning propagation", async () => {
    await withTempPmPath(async (context) => {
      const sourcePath = path.join(context.tempRoot, "hooked-import.jsonl");
      await writeFile(
        sourcePath,
        `${JSON.stringify({ id: "hooked-import", title: "Hooked import" })}\n`,
        "utf8",
      );

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
              hookEvents.push(
                `write:${hookContext.op}:${path.basename(hookContext.path)}`,
              );
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

      const result = await runBeadsImport(
        { file: sourcePath },
        { path: context.pmPath },
      );
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.ids).toEqual(["pm-hooked-import"]);
      expect(result.warnings).toEqual([
        "extension_hook_failed:project:beads-read-boom:onRead",
        "extension_hook_failed:project:beads-write-boom:onWrite",
        "extension_hook_failed:project:beads-write-boom:onWrite",
      ]);
      expect(hookEvents).toContain("read:hooked-import.jsonl");
      expect(hookEvents).toContain("write:import:pm-hooked-import.toon");
      expect(hookEvents).toContain(
        "write:import:history:pm-hooked-import.jsonl",
      );
    });
  });
});
