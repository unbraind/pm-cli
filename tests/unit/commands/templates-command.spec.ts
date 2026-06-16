import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  _testOnly as templatesInternals,
  loadCreateTemplateOptions,
  runTemplatesList,
  runTemplatesSave,
  runTemplatesShow,
} from "../../../src/cli/commands/templates.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { readSettings, writeSettings } from "../../../src/core/store/settings.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("templates command flows", () => {
  it("normalizes template helper edge cases without writing files", () => {
    expect(templatesInternals.normalizeTemplateName(" release.v1 ")).toBe("release.v1");
    expect(() => templatesInternals.normalizeTemplateName("-bad")).toThrow("Invalid template name");

    expect(
      templatesInternals.extractTemplateOptions({
        type: "Task",
        tags: ["one", "two"],
        dep: "id=pm-a,kind=related",
        file: ["path=a.ts", 42],
        ignored: 42,
        missing: undefined,
      }),
    ).toEqual({
      dep: ["id=pm-a,kind=related"],
      file: ["path=a.ts"],
      tags: ["one", "two"],
      type: "Task",
    });
    expect(
      templatesInternals.extractTemplateOptions({
        dep: [1, 2, true],
      } as unknown as Record<string, unknown>),
    ).toEqual({});

    expect(templatesInternals.builtinTemplateDocument("not-built-in")).toBeNull();
    expect(
      templatesInternals.parseStoredTemplateDocument(
        JSON.stringify({
          name: "  stored-name  ",
          created_at: 42,
          updated_at: null,
          options: { " priority ": "2" },
        }),
        "fallback",
      ),
    ).toMatchObject({
      name: "stored-name",
      options: { priority: "2" },
    });
  });

  it("drops repeatable option values that are neither strings nor arrays", () => {
    expect(
      templatesInternals.extractTemplateOptions({
        // `dep` is a repeatable key; a non-string/non-array value is dropped.
        dep: 42,
        tags: ["keep"],
      }),
    ).toEqual({ tags: ["keep"] });
  });

  it("drops repeatable array values when no string entries remain after filtering", () => {
    expect(
      templatesInternals.extractTemplateOptions({
        dep: [1, false, null],
        tags: ["keep"],
      }),
    ).toEqual({ tags: ["keep"] });
  });

  it("falls back to the normalized name when the stored document name is blank", () => {
    expect(
      templatesInternals.parseStoredTemplateDocument(
        JSON.stringify({ name: "   ", options: { type: "Task" } }),
        "fallback-name",
      ),
    ).toMatchObject({ name: "fallback-name", options: { type: "Task" } });
  });

  it("throws NOT_FOUND when reading a missing stored template document directly", async () => {
    await withTempPmPath(async (context) => {
      await expect(templatesInternals.readStoredTemplateDocument(context.pmPath, "missing-template")).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
        message: 'Template "missing-template" not found',
      });
    });
  });

  it("runs templates through the installed first-party package command handlers", async () => {
    await withTempPmPath(async (context) => {
      const install = context.runCli(["install", "templates", "--project", "--json"], { expectJson: true });
      expect(install.code).toBe(0);

      const contracts = context.runCli(
        ["contracts", "--command", "templates save", "--runtime-only", "--availability-only", "--json"],
        { expectJson: true },
      );
      expect(contracts.code).toBe(0);
      expect((contracts.json as { actions?: string[] }).actions).toEqual(["templates-save"]);

      const save = context.runCli(
        ["templates", "save", "package-defaults", "--type", "Task", "--priority", "1", "--tags", "package,templates", "--json"],
        { expectJson: true },
      );
      expect(save.code).toBe(0);
      expect((save.json as { options: Record<string, unknown> }).options).toMatchObject({
        type: "Task",
        priority: "1",
        tags: "package,templates",
      });

      const show = context.runCli(["templates", "show", "package-defaults", "--json"], { expectJson: true });
      expect(show.code).toBe(0);
      expect((show.json as { name?: string }).name).toBe("package-defaults");
    });
  });

  it("saves, lists, and shows create templates", async () => {
    await withTempPmPath(async (context) => {
      const saved = await runTemplatesSave(
        "release-defaults",
        {
          status: "blocked",
          priority: "2",
          tags: "templated,alpha",
          sprint: "release-42",
          dep: ["id=a1b2,kind=related,created_at=now"],
          reminder: ["at=2026-03-10T10:00:00.000Z,text=template reminder"],
        },
        { path: context.pmPath },
      );

      expect(saved.name).toBe("release-defaults");
      expect(saved.options).toEqual(
        expect.objectContaining({
          status: "blocked",
          priority: "2",
          tags: "templated,alpha",
          sprint: "release-42",
          dep: ["id=a1b2,kind=related,created_at=now"],
          reminder: ["at=2026-03-10T10:00:00.000Z,text=template reminder"],
        }),
      );

      const listed = await runTemplatesList({ path: context.pmPath });
      expect(listed.templates).toContain("release-defaults");

      const shown = await runTemplatesShow("release-defaults", { path: context.pmPath });
      expect(shown.name).toBe("release-defaults");
      expect(shown.options).toEqual(saved.options);
    });
  });

  it("sorts user template names deterministically in list output", async () => {
    await withTempPmPath(async (context) => {
      await runTemplatesSave("zeta-template", { type: "Task" }, { path: context.pmPath });
      await runTemplatesSave("alpha-template", { type: "Task" }, { path: context.pmPath });

      const listed = await runTemplatesList({ path: context.pmPath });
      expect(listed.user_templates).toEqual(["alpha-template", "zeta-template"]);
    });
  });

  it("rejects invalid save inputs before writing a user template", async () => {
    await withTempPmPath(async (context) => {
      await expect(runTemplatesSave(" bad name ", { type: "Task" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Invalid template name"),
      });

      await expect(runTemplatesSave("empty-options", { type: undefined }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
        message: "templates save requires at least one create option flag",
      });
    });
  });

  it("preserves the original created_at when overwriting a saved template", async () => {
    await withTempPmPath(async (context) => {
      const first = await runTemplatesSave("overwrite-me", { type: "Task", tags: "first" }, { path: context.pmPath });
      const second = await runTemplatesSave("overwrite-me", { type: "Issue", tags: "second" }, { path: context.pmPath });

      expect(second.created_at).toBe(first.created_at);
      expect(second.updated_at >= first.updated_at).toBe(true);
      expect(second.options).toMatchObject({ type: "Issue", tags: "second" });
    });
  });

  it("surfaces malformed stored template documents with precise errors", async () => {
    await withTempPmPath(async (context) => {
      const templatesDir = path.join(context.pmPath, "templates");
      await mkdir(templatesDir, { recursive: true });

      await writeFile(path.join(templatesDir, "bad-json.json"), "{not-json", "utf8");
      await expect(runTemplatesShow("bad-json", { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
        message: 'Template "bad-json" contains invalid JSON.',
      });

      await writeFile(path.join(templatesDir, "bad-shape.json"), "null\n", "utf8");
      await expect(runTemplatesShow("bad-shape", { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
        message: 'Template "bad-shape" has invalid document shape.',
      });

      await writeFile(path.join(templatesDir, "bad-options.json"), JSON.stringify({ options: [] }), "utf8");
      await expect(loadCreateTemplateOptions(context.pmPath, "bad-options")).rejects.toMatchObject({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
        message: 'Template "bad-options" has invalid options payload.',
      });

      await writeFile(path.join(templatesDir, "empty-key.json"), JSON.stringify({ options: { " ": "x" } }), "utf8");
      await expect(runTemplatesShow("empty-key", { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
        message: 'Template "empty-key" contains an empty option key.',
      });

      await writeFile(path.join(templatesDir, "bad-value.json"), JSON.stringify({ options: { type: 42 } }), "utf8");
      await expect(runTemplatesShow("bad-value", { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
        message: 'Template "bad-value" contains invalid value for option "type".',
      });
    });
  });

  it("lists only builtin templates when no user template directory exists", async () => {
    await withTempPmPath(async (context) => {
      const listed = await runTemplatesList({ path: context.pmPath });

      expect(listed.user_templates).toEqual([]);
      expect(listed.builtin_templates).toEqual(["bug", "chore", "feature", "spike"]);
      expect(listed.templates).toEqual(["bug", "chore", "feature", "spike"]);
      expect(listed.count).toBe(4);
    });
  });

  it("loads and shows builtin templates through the direct helpers", async () => {
    await withTempPmPath(async (context) => {
      const shown = await runTemplatesShow("feature", { path: context.pmPath });
      const loaded = await loadCreateTemplateOptions(context.pmPath, "spike");

      expect(shown).toMatchObject({
        name: "feature",
        source: "builtin",
        created_at: "1970-01-01T00:00:00.000Z",
      });
      expect(shown.options.type).toBe("Feature");
      expect(loaded).toMatchObject({
        type: "Task",
        tags: "spike",
        estimatedMinutes: "120",
      });
    });
  });

  it("throws NOT_FOUND when neither a user nor builtin template exists", async () => {
    await withTempPmPath(async (context) => {
      await expect(runTemplatesShow("totally-unknown", { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
        message: 'Template "totally-unknown" not found',
      });
      await expect(loadCreateTemplateOptions(context.pmPath, "also-unknown")).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
        message: 'Template "also-unknown" not found',
      });
    });
  });

  it("ignores non-json files and invalid-name entries in the templates directory", async () => {
    await withTempPmPath(async (context) => {
      const templatesDir = path.join(context.pmPath, "templates");
      await mkdir(templatesDir, { recursive: true });
      await writeFile(path.join(templatesDir, "valid.json"), JSON.stringify({ options: { type: "Task" } }), "utf8");
      await writeFile(path.join(templatesDir, "README.txt"), "ignore me", "utf8");
      // ".json" suffix but a name that fails TEMPLATE_NAME_PATTERN (leading dot) is filtered out.
      await writeFile(path.join(templatesDir, ".hidden.json"), JSON.stringify({ options: { type: "Task" } }), "utf8");

      const listed = await runTemplatesList({ path: context.pmPath });
      expect(listed.user_templates).toEqual(["valid"]);
    });
  });

  it("rejects templates commands before tracker initialization", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-templates-uninitialized-"));
    try {
      await expect(runTemplatesList({ path: tempRoot })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
        message: expect.stringContaining("Tracker is not initialized"),
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("accepts runtime create field flags when saving templates via CLI", async () => {
    await withTempPmPath(async (context) => {
      const install = context.runCli(["install", "templates", "--project", "--json"], { expectJson: true });
      expect(install.code).toBe(0);

      const settings = await readSettings(context.pmPath);
      settings.schema.fields = [
        ...(settings.schema.fields ?? []),
        {
          key: "customer_segment",
          type: "string",
          commands: ["create"],
        },
      ];
      await writeSettings(context.pmPath, settings, "settings:write");

      const saveResult = context.runCli(
        ["templates", "save", "runtime-template", "--type", "Task", "--customer-segment", "enterprise", "--json"],
        { expectJson: true },
      );
      expect(saveResult.code).toBe(0);
      expect((saveResult.json as { options: Record<string, unknown> }).options.customerSegment).toBe("enterprise");

      const showResult = context.runCli(["templates", "show", "runtime-template", "--json"], { expectJson: true });
      expect(showResult.code).toBe(0);
      expect((showResult.json as { options: Record<string, unknown> }).options.customerSegment).toBe("enterprise");
    });
  });

  it("applies template defaults and lets explicit create flags override deterministically", async () => {
    await withTempPmPath(async (context) => {
      const install = context.runCli(["install", "templates", "--project", "--json"], { expectJson: true });
      expect(install.code).toBe(0);

      const save = context.runCli(
        [
          "templates",
          "save",
          "task-defaults",
          "--type",
          "Task",
          "--status",
          "blocked",
          "--priority",
          "2",
          "--tags",
          "templated,alpha",
          "--body",
          "template body",
          "--deadline",
          "2026-03-20T00:00:00.000Z",
          "--estimate",
          "30",
          "--acceptance-criteria",
          "template acceptance",
          "--author",
          "template-author",
          "--message",
          "template message",
          "--assignee",
          "template-assignee",
          "--comment",
          "author=template-author,text=template comment",
          "--note",
          "author=template-author,text=template note",
          "--learning",
          "author=template-author,text=template learning",
          "--file",
          "path=src/cli/main.ts,scope=project,note=template file",
          "--test",
          "command=node scripts/run-tests.mjs test,scope=project,timeout_seconds=120",
          "--doc",
          "path=README.md,scope=project,note=template doc",
          "--dep",
          "id=dep-alpha,kind=related,created_at=now",
          "--reminder",
          "at=2026-03-10T10:00:00.000Z,text=template reminder",
          "--json",
        ],
        { expectJson: true },
      );
      expect(save.code).toBe(0);

      const created = context.runCli(
        [
          "create",
          "--title",
          "templated item",
          "--description",
          "templated description",
          "--type",
          "Task",
          "--template",
          "task-defaults",
          "--create-mode",
          "progressive",
          "--status",
          "open",
          "--tags",
          "explicit-tag",
          "--author",
          "template-test",
          "--message",
          "create from template",
          "--json",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const createdItem = (created.json as { item: Record<string, unknown> }).item;

      expect(createdItem.status).toBe("open");
      expect(createdItem.priority).toBe(2);
      expect(createdItem.tags).toEqual(["explicit-tag"]);
      expect(createdItem.dependencies).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "pm-dep-alpha", kind: "related" })]),
      );
      expect(createdItem.reminders).toEqual([{ at: "2026-03-10T10:00:00.000Z", text: "template reminder" }]);
    });
  });

  it("supports explicit repeatable overrides when using templates", async () => {
    await withTempPmPath(async (context) => {
      const install = context.runCli(["install", "templates", "--project", "--json"], { expectJson: true });
      expect(install.code).toBe(0);

      const save = context.runCli(
        [
          "templates",
          "save",
          "seeded-dependencies",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "templated",
          "--body",
          "template body",
          "--deadline",
          "2026-03-20T00:00:00.000Z",
          "--estimate",
          "30",
          "--acceptance-criteria",
          "template acceptance",
          "--author",
          "template-author",
          "--message",
          "template message",
          "--assignee",
          "template-assignee",
          "--comment",
          "author=template-author,text=template comment",
          "--note",
          "author=template-author,text=template note",
          "--learning",
          "author=template-author,text=template learning",
          "--file",
          "path=src/cli/main.ts,scope=project,note=template file",
          "--test",
          "command=node scripts/run-tests.mjs test,scope=project,timeout_seconds=120",
          "--doc",
          "path=README.md,scope=project,note=template doc",
          "--dep",
          "id=dep-alpha,kind=related,created_at=now",
          "--json",
        ],
        { expectJson: true },
      );
      expect(save.code).toBe(0);

      const created = context.runCli(
        [
          "create",
          "--title",
          "templated override item",
          "--description",
          "templated override description",
          "--type",
          "Task",
          "--template",
          "seeded-dependencies",
          "--create-mode",
          "progressive",
          "--dep",
          "id=dep-override,kind=blocks,created_at=now",
          "--author",
          "template-test",
          "--message",
          "create with override deps",
          "--json",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const createdItem = (created.json as { item: Record<string, unknown> }).item;

      expect(createdItem.dependencies).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "pm-dep-override", kind: "blocks" })]),
      );
    });
  });

  it("ships builtin starter templates so the catalog is non-empty out of the box", async () => {
    await withTempPmPath(async (context) => {
      const install = context.runCli(["install", "templates", "--project", "--json"], { expectJson: true });
      expect(install.code).toBe(0);

      const list = context.runCli(["templates", "list", "--json"], { expectJson: true });
      expect(list.code).toBe(0);
      const listJson = list.json as { count: number; templates: string[]; builtin_templates: string[]; user_templates: string[] };
      expect(listJson.count).toBeGreaterThan(0);
      expect(listJson.templates).toEqual(expect.arrayContaining(["bug", "chore", "feature", "spike"]));
      expect(listJson.builtin_templates).toEqual(expect.arrayContaining(["bug", "chore", "feature", "spike"]));
      expect(listJson.user_templates).toEqual([]);

      const show = context.runCli(["templates", "show", "bug", "--json"], { expectJson: true });
      expect(show.code).toBe(0);
      const showJson = show.json as { name: string; source: string; options: Record<string, unknown> };
      expect(showJson.name).toBe("bug");
      expect(showJson.source).toBe("builtin");
      expect(showJson.options.type).toBe("Issue");
    });
  });

  it("creates from a builtin template without the user saving it first", async () => {
    await withTempPmPath(async (context) => {
      const install = context.runCli(["install", "templates", "--project", "--json"], { expectJson: true });
      expect(install.code).toBe(0);

      const created = context.runCli(
        [
          "create",
          "--title",
          "builtin templated bug",
          "--description",
          "builtin templated description",
          "--template",
          "bug",
          "--create-mode",
          "progressive",
          "--author",
          "template-test",
          "--message",
          "create from builtin template",
          "--json",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const createdItem = (created.json as { item: Record<string, unknown> }).item;
      expect(createdItem.type).toBe("Issue");
      expect(createdItem.priority).toBe(1);
    });
  });

  it("lets a user-saved template override the builtin of the same name", async () => {
    await withTempPmPath(async (context) => {
      const install = context.runCli(["install", "templates", "--project", "--json"], { expectJson: true });
      expect(install.code).toBe(0);

      const save = context.runCli(
        ["templates", "save", "bug", "--type", "Task", "--priority", "4", "--tags", "override", "--json"],
        { expectJson: true },
      );
      expect(save.code).toBe(0);

      const list = context.runCli(["templates", "list", "--json"], { expectJson: true });
      const listJson = list.json as { builtin_templates: string[]; user_templates: string[]; templates: string[] };
      expect(listJson.user_templates).toContain("bug");
      expect(listJson.builtin_templates).not.toContain("bug");
      // "bug" still appears exactly once in the merged catalog.
      expect(listJson.templates.filter((name) => name === "bug")).toEqual(["bug"]);

      const show = context.runCli(["templates", "show", "bug", "--json"], { expectJson: true });
      const showJson = show.json as { source: string; options: Record<string, unknown> };
      expect(showJson.source).toBe("user");
      expect(showJson.options.type).toBe("Task");
      expect(showJson.options.tags).toBe("override");
    });
  });

  it("fails when template does not exist", async () => {
    await withTempPmPath(async (context) => {
      const install = context.runCli(["install", "templates", "--project", "--json"], { expectJson: true });
      expect(install.code).toBe(0);

      const missingTemplate = context.runCli([
        "create",
        "--title",
        "missing template item",
        "--description",
        "missing template description",
        "--type",
        "Task",
        "--template",
        "does-not-exist",
        "--create-mode",
        "progressive",
        "--author",
        "template-test",
        "--message",
        "missing template",
        "--json",
      ]);
      expect(missingTemplate.code).toBe(EXIT_CODE.NOT_FOUND);
      const parsedError = JSON.parse(missingTemplate.stderr) as { detail?: string };
      expect(parsedError.detail).toContain('Template "does-not-exist" not found');
    });
  });
});
