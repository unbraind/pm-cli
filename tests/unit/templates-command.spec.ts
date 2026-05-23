import { describe, expect, it } from "vitest";
import { runTemplatesList, runTemplatesSave, runTemplatesShow } from "../../src/cli/commands/templates.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { readSettings, writeSettings } from "../../src/core/store/settings.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("templates command flows", () => {
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
