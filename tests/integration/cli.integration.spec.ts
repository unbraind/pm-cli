import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { splitFrontMatter } from "../../src/core/item/item-format.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

function distCliPath(): string {
  return path.resolve(process.cwd(), "dist/cli.js");
}

interface JsonErrorEnvelope {
  type: string;
  code: string;
  title: string;
  detail: string;
  required: string;
  exit_code: number;
  why?: string;
  examples?: string[];
  next_steps?: string[];
}

function parseJsonErrorEnvelope(stderr: string): JsonErrorEnvelope {
  return JSON.parse(stderr) as JsonErrorEnvelope;
}

describe("CLI integration (sandboxed PM_PATH)", () => {
  it("accepts --ac as create alias for acceptance criteria", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Alias contract item",
          "--description",
          "Validate create acceptance criteria alias",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,contract",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "15",
          "--ac",
          "Alias flag is accepted",
          "--author",
          "integration-test",
          "--message",
          "Create with ac alias",
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

      expect(createResult.code).toBe(0);
      expect((createResult.json as { item: { acceptance_criteria: string } }).item.acceptance_criteria).toBe(
        "Alias flag is accepted",
      );
    });
  });

  it("renders sparse non-json list output without command-aware envelope", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Sparse toon output item",
          "--description",
          "Seed item for sparse TOON output assertions",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,output",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "10",
          "--ac",
          "Sparse TOON output is verified",
          "--author",
          "integration-test",
          "--message",
          "Seed for sparse TOON integration assertions",
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
      expect(createResult.code).toBe(0);

      const listResult = context.runCli(["list-open", "--limit", "10"]);
      expect(listResult.code).toBe(0);
      expect(listResult.stdout).toContain("items:");
      expect(listResult.stdout).toContain("filters:");
      expect(listResult.stdout).toContain('status: "open"');
      expect(listResult.stdout).not.toContain("summary:");
      expect(listResult.stdout).not.toContain("highlights:");
      expect(listResult.stdout).not.toContain("next_steps:");
      expect(listResult.stdout).not.toContain("result:");
      expect(listResult.stdout).not.toContain("type: null");
      expect(listResult.stdout).not.toContain("tag: null");
      expect(listResult.stdout).not.toContain("include_body: null");
    });
  });

  it("supports list JSON stream mode with offset pagination and enforces --json", async () => {
    await withTempPmPath(async (context) => {
      const createArgs = [
        "create",
        "--json",
        "--title",
        "Stream list seed item",
        "--description",
        "Seed item for list stream mode assertions",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--tags",
        "integration,stream",
        "--body",
        "",
        "--deadline",
        "none",
        "--estimate",
        "10",
        "--ac",
        "List stream mode is verified",
        "--author",
        "integration-test",
        "--message",
        "Seed for list stream assertions",
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
      ];
      const createResult = context.runCli(createArgs, { expectJson: true });
      expect(createResult.code).toBe(0);

      const streamResult = context.runCli(["list-open", "--json", "--stream", "--offset", "0", "--limit", "1"]);
      expect(streamResult.code).toBe(0);
      const lines = streamResult.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { type: string; [key: string]: unknown });
      expect(lines.length).toBeGreaterThanOrEqual(3);
      expect(lines[0]?.type).toBe("meta");
      expect(lines[0]?.filters).toMatchObject({
        status: "open",
        limit: "1",
        offset: "0",
      });
      expect(lines.some((entry) => entry.type === "item")).toBe(true);
      expect(lines.at(-1)?.type).toBe("end");

      const invalidStreamResult = context.runCli(["list-open", "--stream"]);
      expect(invalidStreamResult.code).toBe(2);
      expect(invalidStreamResult.stderr).toContain("--stream requires --json output mode.");
    });
  });

  it("supports close validation modes and standalone validate command", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Validate command integration seed",
          "--description",
          "Seed item for close validate and pm validate assertions",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,validate",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "10",
          "--ac",
          "Validate command integration is verified",
          "--author",
          "integration-test",
          "--message",
          "Create validate integration seed",
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
      expect(createResult.code).toBe(0);
      const id = (createResult.json as { item: { id: string } }).item.id;

      const strictClose = context.runCli(["close", id, "done", "--validate-close", "strict"]);
      expect(strictClose.code).toBe(2);
      expect(strictClose.stderr).toContain("Cannot close item");

      const warnClose = context.runCli(["close", id, "done", "--validate-close", "--json"], { expectJson: true });
      expect(warnClose.code).toBe(0);
      expect((warnClose.json as { warnings: string[] }).warnings).toContain(
        `close_validation_missing_fields:${id}:resolution,expected_result,actual_result`,
      );

      const validateResult = context.runCli(["validate", "--check-resolution", "--json"], { expectJson: true });
      expect(validateResult.code).toBe(0);
      const payload = validateResult.json as {
        ok: boolean;
        warnings: string[];
        checks: Array<{ name: string; status: string; details: { missing_resolution_items?: number } }>;
      };
      expect(payload.ok).toBe(false);
      expect(payload.warnings).toContain("validate_resolution_missing_fields:1");
      const resolutionCheck = payload.checks.find((check) => check.name === "resolution");
      expect(resolutionCheck?.status).toBe("warn");
      expect(resolutionCheck?.details.missing_resolution_items).toBe(1);
    });
  });

  it("manages local extensions through install explore manage activate deactivate and uninstall actions", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "local-extension-source");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, "manifest.json"),
        JSON.stringify(
          {
            name: "integration-local-ext",
            version: "1.0.0",
            entry: "index.js",
            capabilities: ["commands"],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(path.join(sourceDir, "index.js"), "export default { activate() {} };", "utf8");

      const install = context.runCli(["extension", "--install", sourceDir, "--project", "--json"], { expectJson: true });
      expect(install.code).toBe(0);
      expect(install.json).toMatchObject({
        action: "install",
        scope: "project",
        details: {
          extension: {
            name: "integration-local-ext",
            version: "1.0.0",
          },
          activated: true,
        },
      });

      const explore = context.runCli(["extension", "--explore", "--project", "--json"], { expectJson: true });
      expect(explore.code).toBe(0);
      expect(explore.json).toMatchObject({
        action: "explore",
        details: {
          total: 1,
          managed_total: 1,
          active_total: 1,
          extensions: [expect.objectContaining({ name: "integration-local-ext", managed: true, active: true })],
        },
      });

      const deactivate = context.runCli(["extension", "--deactivate", "integration-local-ext", "--project", "--json"], {
        expectJson: true,
      });
      expect(deactivate.code).toBe(0);
      const settingsAfterDeactivate = JSON.parse(await readFile(path.join(context.pmPath, "settings.json"), "utf8")) as {
        extensions: { disabled: string[] };
      };
      expect(settingsAfterDeactivate.extensions.disabled).toContain("integration-local-ext");

      const activate = context.runCli(["extension", "--activate", "integration-local-ext", "--project", "--json"], {
        expectJson: true,
      });
      expect(activate.code).toBe(0);
      const settingsAfterActivate = JSON.parse(await readFile(path.join(context.pmPath, "settings.json"), "utf8")) as {
        extensions: { disabled: string[] };
      };
      expect(settingsAfterActivate.extensions.disabled).not.toContain("integration-local-ext");

      const manage = context.runCli(["extension", "--manage", "--project", "--json"], { expectJson: true });
      expect(manage.code).toBe(0);
      expect(manage.json).toMatchObject({
        action: "manage",
        details: {
          total: 1,
          managed_total: 1,
          extensions: [expect.objectContaining({ name: "integration-local-ext", managed: true })],
        },
      });

      const uninstall = context.runCli(["extension", "--uninstall", "integration-local-ext", "--project", "--json"], {
        expectJson: true,
      });
      expect(uninstall.code).toBe(0);
      expect(uninstall.json).toMatchObject({
        action: "uninstall",
        details: {
          removed: true,
        },
      });

      const exploreAfterUninstall = context.runCli(["extension", "--explore", "--project", "--json"], { expectJson: true });
      expect(exploreAfterUninstall.code).toBe(0);
      expect(exploreAfterUninstall.json).toMatchObject({
        action: "explore",
        details: {
          total: 0,
          managed_total: 0,
        },
      });
    });
  });

  it("accepts --ac as update alias for acceptance criteria", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Update alias contract item",
          "--description",
          "Validate update acceptance criteria alias seed",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,contract",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "15",
          "--ac",
          "Seed flag",
          "--author",
          "integration-test",
          "--message",
          "Create seed",
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
      expect(createResult.code).toBe(0);
      const id = (createResult.json as { item: { id: string } }).item.id;

      const updateResult = context.runCli(
        [
          "update",
          id,
          "--json",
          "--ac",
          "Alias flag is updated via ac",
          "--author",
          "integration-test",
          "--message",
          "Update with ac alias",
        ],
        { expectJson: true },
      );
      expect(updateResult.code).toBe(0);
      expect((updateResult.json as { item: { acceptance_criteria: string } }).item.acceptance_criteria).toBe(
        "Alias flag is updated via ac",
      );
    });
  });

  it("supports update body replacement via --body and -b", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Update body contract item",
          "--description",
          "Validate update body option behavior",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,body",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "20",
          "--ac",
          "Update body support is available",
          "--author",
          "integration-test",
          "--message",
          "Create update body seed",
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
      expect(createResult.code).toBe(0);
      const id = (createResult.json as { item: { id: string } }).item.id;

      const setBodyResult = context.runCli(
        [
          "update",
          id,
          "--json",
          "--body",
          "Backfilled body content",
          "--author",
          "integration-test",
          "--message",
          "Set body through update",
        ],
        { expectJson: true },
      );
      expect(setBodyResult.code).toBe(0);
      expect((setBodyResult.json as { changed_fields: string[] }).changed_fields).toContain("body");

      const getAfterSet = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(getAfterSet.code).toBe(0);
      expect((getAfterSet.json as { body: string }).body).toBe("Backfilled body content");

      const clearBodyResult = context.runCli(
        [
          "update",
          id,
          "--json",
          "-b",
          "",
          "--author",
          "integration-test",
          "--message",
          "Clear body through short alias",
        ],
        { expectJson: true },
      );
      expect(clearBodyResult.code).toBe(0);

      const getAfterClear = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(getAfterClear.code).toBe(0);
      expect((getAfterClear.json as { body: string }).body).toBe("");
    });
  });

  it("accepts snake_case create aliases for estimate and acceptance criteria", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Snake case create alias item",
          "--description",
          "Validate create snake_case aliases",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,contract",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimated_minutes",
          "27",
          "--acceptance_criteria",
          "Snake case aliases are accepted for create",
          "--author",
          "integration-test",
          "--message",
          "Create with snake_case aliases",
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

      expect(createResult.code).toBe(0);
      const item = (createResult.json as { item: { estimated_minutes: number; acceptance_criteria: string } }).item;
      expect(item.estimated_minutes).toBe(27);
      expect(item.acceptance_criteria).toBe("Snake case aliases are accepted for create");
    });
  });

  it("accepts snake_case update aliases for estimate and acceptance criteria", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Snake case update alias item",
          "--description",
          "Validate update snake_case aliases seed",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,contract",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "15",
          "--acceptance-criteria",
          "Seed flag",
          "--author",
          "integration-test",
          "--message",
          "Create seed for snake_case update aliases",
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
      expect(createResult.code).toBe(0);
      const id = (createResult.json as { item: { id: string } }).item.id;

      const updateResult = context.runCli(
        [
          "update",
          id,
          "--json",
          "--estimated_minutes",
          "41",
          "--acceptance_criteria",
          "Snake case aliases are accepted for update",
          "--author",
          "integration-test",
          "--message",
          "Update with snake_case aliases",
        ],
        { expectJson: true },
      );
      expect(updateResult.code).toBe(0);
      const item = (updateResult.json as { item: { estimated_minutes: number; acceptance_criteria: string } }).item;
      expect(item.estimated_minutes).toBe(41);
      expect(item.acceptance_criteria).toBe("Snake case aliases are accepted for update");
    });
  });

  it("supports calendar views, markdown default output, and reminder events", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Calendar integration item",
          "--description",
          "Validate calendar and reminder flows",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,calendar",
          "--body",
          "",
          "--deadline",
          "2026-04-02T12:00:00.000Z",
          "--estimate",
          "25",
          "--acceptance-criteria",
          "Calendar command renders reminder and deadline events",
          "--author",
          "integration-test",
          "--message",
          "Create calendar integration item",
          "--assignee",
          "none",
          "--reminder",
          "at=2026-04-02T09:30:00.000Z,text=calendar reminder",
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
      expect(createResult.code).toBe(0);

      const calendarJson = context.runCli(
        ["calendar", "--json", "--view", "agenda", "--date", "2026-04-02T00:00:00.000Z", "--limit", "10"],
        { expectJson: true },
      );
      expect(calendarJson.code).toBe(0);
      const payload = calendarJson.json as {
        view: string;
        summary: { events: number; deadlines: number; reminders: number };
        events: Array<{ kind: string; reminder_text: string | null }>;
      };
      expect(payload.view).toBe("agenda");
      expect(payload.summary.events).toBe(2);
      expect(payload.summary.deadlines).toBe(1);
      expect(payload.summary.reminders).toBe(1);
      expect(payload.events.map((entry) => entry.kind)).toEqual(["reminder", "deadline"]);
      expect(payload.events[0]?.reminder_text).toBe("calendar reminder");

      const markdownCalendar = context.runCli(["calendar", "--view", "agenda", "--date", "2026-04-02T00:00:00.000Z", "--limit", "10"]);
      expect(markdownCalendar.code).toBe(0);
      expect(markdownCalendar.stdout).toContain("# pm calendar (agenda)");
      expect(markdownCalendar.stdout).toContain("[reminder]");
      expect(markdownCalendar.stdout).toContain("[deadline]");

      const aliasCalendar = context.runCli(["cal", "--json", "--view", "day", "--date", "2026-04-02T00:00:00.000Z", "--past"], {
        expectJson: true,
      });
      expect(aliasCalendar.code).toBe(0);
      const aliasPayload = aliasCalendar.json as { view: string; summary: { events: number } };
      expect(aliasPayload.view).toBe("day");
      expect(aliasPayload.summary.events).toBe(2);
    });
  });

  it("supports context command and ctx alias with active focus projection", async () => {
    await withTempPmPath(async (context) => {
      const createBaseArgs = (title: string, type: string, status: string, priority: string, deadline: string) => [
        "create",
        "--json",
        "--title",
        title,
        "--description",
        `${title} description`,
        "--type",
        type,
        "--status",
        status,
        "--priority",
        priority,
        "--tags",
        "integration,context",
        "--body",
        "",
        "--deadline",
        deadline,
        "--estimate",
        "20",
        "--acceptance-criteria",
        `${title} acceptance`,
        "--author",
        "integration-test",
        "--message",
        `Create ${title}`,
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
      ];

      expect(
        context.runCli(createBaseArgs("Context Feature Open", "Feature", "open", "1", "2026-04-03T12:00:00.000Z"), {
          expectJson: true,
        }).code,
      ).toBe(0);

      const createTask = context.runCli(
        [
          ...createBaseArgs("Context Task In Progress", "Task", "in-progress", "0", "2026-04-03T10:00:00.000Z"),
          "--reminder",
          "at=2026-04-03T09:00:00.000Z,text=context reminder",
        ],
        { expectJson: true },
      );
      expect(createTask.code).toBe(0);

      const contextJson = context.runCli(
        ["context", "--json", "--from", "2026-04-03T00:00:00.000Z", "--to", "2026-04-04T00:00:00.000Z", "--limit", "10"],
        { expectJson: true },
      );
      expect(contextJson.code).toBe(0);
      const payload = contextJson.json as {
        output_default: string;
        summary: { active_items: number; blocked_fallback_used: boolean };
        high_level: Array<{ type: string }>;
        low_level: Array<{ type: string }>;
        agenda: { summary: { reminders: number } };
      };
      expect(payload.output_default).toBe("toon");
      expect(payload.summary.active_items).toBe(2);
      expect(payload.summary.blocked_fallback_used).toBe(false);
      expect(payload.high_level.map((entry) => entry.type)).toEqual(["Feature"]);
      expect(payload.low_level.map((entry) => entry.type)).toEqual(["Task"]);
      expect(payload.agenda.summary.reminders).toBe(1);

      const contextAlias = context.runCli(
        ["ctx", "--json", "--from", "2026-04-03T00:00:00.000Z", "--to", "2026-04-04T00:00:00.000Z", "--limit", "10"],
        { expectJson: true },
      );
      expect(contextAlias.code).toBe(0);
      const aliasPayload = contextAlias.json as { summary: { active_items: number } };
      expect(aliasPayload.summary.active_items).toBe(2);
    });
  });

  it("uses blocked fallback in context command when no open or in-progress items exist", async () => {
    await withTempPmPath(async (context) => {
      const createBlocked = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Context Blocked Item",
          "--description",
          "Context blocked fallback seed",
          "--type",
          "Task",
          "--status",
          "blocked",
          "--priority",
          "1",
          "--tags",
          "integration,context",
          "--body",
          "",
          "--deadline",
          "2026-04-06T10:00:00.000Z",
          "--estimate",
          "15",
          "--acceptance-criteria",
          "Blocked fallback is shown",
          "--author",
          "integration-test",
          "--message",
          "Create blocked context seed",
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
      expect(createBlocked.code).toBe(0);

      const contextJson = context.runCli(
        ["context", "--json", "--from", "2026-04-06T00:00:00.000Z", "--to", "2026-04-07T00:00:00.000Z", "--limit", "10"],
        { expectJson: true },
      );
      expect(contextJson.code).toBe(0);
      const payload = contextJson.json as {
        summary: { active_items: number; blocked_fallback_used: boolean };
        blocked_fallback: Array<{ status: string }>;
      };
      expect(payload.summary.active_items).toBe(0);
      expect(payload.summary.blocked_fallback_used).toBe(true);
      expect(payload.blocked_fallback.map((entry) => entry.status)).toEqual(["blocked"]);
    });
  });

  it("accepts extended optional field flags for create/update including blocked aliases", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Extended optional create item",
          "--description",
          "Validate create/update optional scalar field flags",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,contract,extended",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "20",
          "--acceptance-criteria",
          "Extended optional fields are accepted",
          "--definition_of_ready",
          "Ready after scope review",
          "--rank",
          "5",
          "--goal",
          "goal-create",
          "--objective",
          "objective-create",
          "--value",
          "value-create",
          "--impact",
          "impact-create",
          "--outcome",
          "outcome-create",
          "--why_now",
          "why-now-create",
          "--author",
          "integration-test",
          "--message",
          "Create with extended optional fields",
          "--assignee",
          "none",
          "--parent",
          "pm-parent-create",
          "--reviewer",
          "reviewer-create",
          "--risk",
          "medium",
          "--confidence",
          "low",
          "--sprint",
          "sprint-create",
          "--release",
          "release-create",
          "--blocked_by",
          "pm-block-create",
          "--blocked_reason",
          "blocked reason create",
          "--unblock_note",
          "unblocked note create",
          "--reporter",
          "reporter-create",
          "--severity",
          "med",
          "--environment",
          "linux-create",
          "--repro_steps",
          "create repro steps",
          "--resolution",
          "create resolution summary",
          "--expected_result",
          "expected create behavior",
          "--actual_result",
          "actual create behavior",
          "--affected_version",
          "0.1.0",
          "--fixed_version",
          "0.1.1",
          "--component",
          "cli/create",
          "--regression",
          "true",
          "--customer_impact",
          "create impact summary",
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
      expect(createResult.code).toBe(0);
      const createdItem = (createResult.json as {
        item: {
          id: string;
          parent: string;
          reviewer: string;
          risk: string;
          confidence: string;
          sprint: string;
          release: string;
          definition_of_ready: string;
          order: number;
          goal: string;
          objective: string;
          value: string;
          impact: string;
          outcome: string;
          why_now: string;
          blocked_by: string;
          blocked_reason: string;
          unblock_note: string;
          reporter: string;
          severity: string;
          environment: string;
          repro_steps: string;
          resolution: string;
          expected_result: string;
          actual_result: string;
          affected_version: string;
          fixed_version: string;
          component: string;
          regression: boolean;
          customer_impact: string;
        };
      }).item;
      expect(createdItem.parent).toBe("pm-parent-create");
      expect(createdItem.reviewer).toBe("reviewer-create");
      expect(createdItem.risk).toBe("medium");
      expect(createdItem.confidence).toBe("low");
      expect(createdItem.sprint).toBe("sprint-create");
      expect(createdItem.release).toBe("release-create");
      expect(createdItem.definition_of_ready).toBe("Ready after scope review");
      expect(createdItem.order).toBe(5);
      expect(createdItem.goal).toBe("goal-create");
      expect(createdItem.objective).toBe("objective-create");
      expect(createdItem.value).toBe("value-create");
      expect(createdItem.impact).toBe("impact-create");
      expect(createdItem.outcome).toBe("outcome-create");
      expect(createdItem.why_now).toBe("why-now-create");
      expect(createdItem.blocked_by).toBe("pm-block-create");
      expect(createdItem.blocked_reason).toBe("blocked reason create");
      expect(createdItem.unblock_note).toBe("unblocked note create");
      expect(createdItem.reporter).toBe("reporter-create");
      expect(createdItem.severity).toBe("medium");
      expect(createdItem.environment).toBe("linux-create");
      expect(createdItem.repro_steps).toBe("create repro steps");
      expect(createdItem.resolution).toBe("create resolution summary");
      expect(createdItem.expected_result).toBe("expected create behavior");
      expect(createdItem.actual_result).toBe("actual create behavior");
      expect(createdItem.affected_version).toBe("0.1.0");
      expect(createdItem.fixed_version).toBe("0.1.1");
      expect(createdItem.component).toBe("cli/create");
      expect(createdItem.regression).toBe(true);
      expect(createdItem.customer_impact).toBe("create impact summary");

      const updateResult = context.runCli(
        [
          "update",
          createdItem.id,
          "--json",
          "--parent",
          "pm-parent-update",
          "--reviewer",
          "reviewer-update",
          "--risk",
          "med",
          "--confidence",
          "73",
          "--sprint",
          "sprint-update",
          "--release",
          "release-update",
          "--definition-of-ready",
          "Ready after update",
          "--order",
          "3",
          "--goal",
          "goal-update",
          "--objective",
          "objective-update",
          "--value",
          "value-update",
          "--impact",
          "impact-update",
          "--outcome",
          "outcome-update",
          "--why-now",
          "why-now-update",
          "--blocked-by",
          "pm-block-update",
          "--blocked-reason",
          "blocked reason update",
          "--unblock-note",
          "unblocked note update",
          "--reporter",
          "reporter-update",
          "--severity",
          "high",
          "--environment",
          "linux-update",
          "--repro-steps",
          "update repro steps",
          "--resolution",
          "update resolution summary",
          "--expected-result",
          "expected update behavior",
          "--actual-result",
          "actual update behavior",
          "--affected-version",
          "0.1.1",
          "--fixed-version",
          "0.1.2",
          "--component",
          "cli/update",
          "--regression",
          "false",
          "--customer-impact",
          "update impact summary",
          "--author",
          "integration-test",
          "--message",
          "Update with extended optional fields",
        ],
        { expectJson: true },
      );
      expect(updateResult.code).toBe(0);
      const updatedItem = (updateResult.json as {
        item: {
          parent: string;
          reviewer: string;
          risk: string;
          confidence: number;
          sprint: string;
          release: string;
          definition_of_ready: string;
          order: number;
          goal: string;
          objective: string;
          value: string;
          impact: string;
          outcome: string;
          why_now: string;
          blocked_by: string;
          blocked_reason: string;
          unblock_note: string;
          reporter: string;
          severity: string;
          environment: string;
          repro_steps: string;
          resolution: string;
          expected_result: string;
          actual_result: string;
          affected_version: string;
          fixed_version: string;
          component: string;
          regression: boolean;
          customer_impact: string;
        };
      }).item;
      expect(updatedItem.parent).toBe("pm-parent-update");
      expect(updatedItem.reviewer).toBe("reviewer-update");
      expect(updatedItem.risk).toBe("medium");
      expect(updatedItem.confidence).toBe(73);
      expect(updatedItem.sprint).toBe("sprint-update");
      expect(updatedItem.release).toBe("release-update");
      expect(updatedItem.definition_of_ready).toBe("Ready after update");
      expect(updatedItem.order).toBe(3);
      expect(updatedItem.goal).toBe("goal-update");
      expect(updatedItem.objective).toBe("objective-update");
      expect(updatedItem.value).toBe("value-update");
      expect(updatedItem.impact).toBe("impact-update");
      expect(updatedItem.outcome).toBe("outcome-update");
      expect(updatedItem.why_now).toBe("why-now-update");
      expect(updatedItem.blocked_by).toBe("pm-block-update");
      expect(updatedItem.blocked_reason).toBe("blocked reason update");
      expect(updatedItem.unblock_note).toBe("unblocked note update");
      expect(updatedItem.reporter).toBe("reporter-update");
      expect(updatedItem.severity).toBe("high");
      expect(updatedItem.environment).toBe("linux-update");
      expect(updatedItem.repro_steps).toBe("update repro steps");
      expect(updatedItem.resolution).toBe("update resolution summary");
      expect(updatedItem.expected_result).toBe("expected update behavior");
      expect(updatedItem.actual_result).toBe("actual update behavior");
      expect(updatedItem.affected_version).toBe("0.1.1");
      expect(updatedItem.fixed_version).toBe("0.1.2");
      expect(updatedItem.component).toBe("cli/update");
      expect(updatedItem.regression).toBe(false);
      expect(updatedItem.customer_impact).toBe("update impact summary");

      const unsetResult = context.runCli(
        [
          "update",
          createdItem.id,
          "--json",
          "--parent",
          "none",
          "--reviewer",
          "none",
          "--risk",
          "none",
          "--confidence",
          "none",
          "--sprint",
          "none",
          "--release",
          "none",
          "--definition_of_ready",
          "none",
          "--rank",
          "none",
          "--goal",
          "none",
          "--objective",
          "none",
          "--value",
          "none",
          "--impact",
          "none",
          "--outcome",
          "none",
          "--why_now",
          "none",
          "--blocked_by",
          "none",
          "--blocked_reason",
          "none",
          "--unblock_note",
          "none",
          "--reporter",
          "none",
          "--severity",
          "none",
          "--environment",
          "none",
          "--repro_steps",
          "none",
          "--resolution",
          "none",
          "--expected_result",
          "none",
          "--actual_result",
          "none",
          "--affected_version",
          "none",
          "--fixed_version",
          "none",
          "--component",
          "none",
          "--regression",
          "none",
          "--customer_impact",
          "none",
          "--author",
          "integration-test",
          "--message",
          "Unset extended optional fields",
        ],
        { expectJson: true },
      );
      expect(unsetResult.code).toBe(0);
      const unsetItem = (unsetResult.json as {
        item: {
          parent?: string;
          reviewer?: string;
          risk?: string;
          confidence?: number | string;
          sprint?: string;
          release?: string;
          definition_of_ready?: string;
          order?: number;
          goal?: string;
          objective?: string;
          value?: string;
          impact?: string;
          outcome?: string;
          why_now?: string;
          blocked_by?: string;
          blocked_reason?: string;
          unblock_note?: string;
          reporter?: string;
          severity?: string;
          environment?: string;
          repro_steps?: string;
          resolution?: string;
          expected_result?: string;
          actual_result?: string;
          affected_version?: string;
          fixed_version?: string;
          component?: string;
          regression?: boolean;
          customer_impact?: string;
        };
      }).item;
      expect(unsetItem.parent).toBeUndefined();
      expect(unsetItem.reviewer).toBeUndefined();
      expect(unsetItem.risk).toBeUndefined();
      expect(unsetItem.confidence).toBeUndefined();
      expect(unsetItem.sprint).toBeUndefined();
      expect(unsetItem.release).toBeUndefined();
      expect(unsetItem.definition_of_ready).toBeUndefined();
      expect(unsetItem.order).toBeUndefined();
      expect(unsetItem.goal).toBeUndefined();
      expect(unsetItem.objective).toBeUndefined();
      expect(unsetItem.value).toBeUndefined();
      expect(unsetItem.impact).toBeUndefined();
      expect(unsetItem.outcome).toBeUndefined();
      expect(unsetItem.why_now).toBeUndefined();
      expect(unsetItem.blocked_by).toBeUndefined();
      expect(unsetItem.blocked_reason).toBeUndefined();
      expect(unsetItem.unblock_note).toBeUndefined();
      expect(unsetItem.reporter).toBeUndefined();
      expect(unsetItem.severity).toBeUndefined();
      expect(unsetItem.environment).toBeUndefined();
      expect(unsetItem.repro_steps).toBeUndefined();
      expect(unsetItem.resolution).toBeUndefined();
      expect(unsetItem.expected_result).toBeUndefined();
      expect(unsetItem.actual_result).toBeUndefined();
      expect(unsetItem.affected_version).toBeUndefined();
      expect(unsetItem.fixed_version).toBeUndefined();
      expect(unsetItem.component).toBeUndefined();
      expect(unsetItem.regression).toBeUndefined();
      expect(unsetItem.customer_impact).toBeUndefined();
    });
  });

  it("requires explicit repeatable seed flags for create contract parity", async () => {
    await withTempPmPath(async (context) => {
      const createWithoutRepeatables = context.runCli([
        "create",
        "--json",
        "--title",
        "Missing repeatable options",
        "--description",
        "Validate required create repeatable flag parity.",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--tags",
        "integration,contract",
        "--body",
        "",
        "--deadline",
        "none",
        "--estimate",
        "15",
        "--acceptance-criteria",
        "Create rejects missing repeatable options",
        "--author",
        "integration-test",
        "--message",
        "Create missing repeatable option",
        "--assignee",
        "none",
      ]);

      expect(createWithoutRepeatables.code).toBe(2);
      expect(createWithoutRepeatables.stderr).toContain("--dep");
    });
  });

  it("supports dependency add/remove mutations through update flags", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Dependency mutation item",
          "--description",
          "Validate update dependency add/remove flows",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,dependencies",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "20",
          "--acceptance-criteria",
          "Dependency update flags mutate existing items",
          "--author",
          "integration-test",
          "--message",
          "Create dependency mutation seed",
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
      expect(createResult.code).toBe(0);
      const createdId = (createResult.json as { item: { id: string } }).item.id;

      const addResult = context.runCli(
        [
          "update",
          createdId,
          "--json",
          "--dep",
          "id=dep-alpha,kind=blocks,created_at=2026-03-01T00:00:00.000Z",
          "--dep",
          "id=dep-beta,kind=related,source_kind=imported,created_at=2026-03-02T00:00:00.000Z",
          "--author",
          "integration-test",
          "--message",
          "Add dependencies",
        ],
        { expectJson: true },
      );
      expect(addResult.code).toBe(0);
      const addedDependencies = (addResult.json as { item: { dependencies?: Array<Record<string, unknown>> } }).item
        .dependencies;
      expect(addedDependencies).toEqual([
        {
          id: "pm-dep-alpha",
          kind: "blocks",
          created_at: "2026-03-01T00:00:00.000Z",
        },
        {
          id: "pm-dep-beta",
          kind: "related",
          created_at: "2026-03-02T00:00:00.000Z",
          source_kind: "imported",
        },
      ]);

      const removeResult = context.runCli(
        [
          "update",
          createdId,
          "--json",
          "--dep-remove",
          "dep-alpha",
          "--author",
          "integration-test",
          "--message",
          "Remove one dependency",
        ],
        { expectJson: true },
      );
      expect(removeResult.code).toBe(0);
      const remainingDependencies = (removeResult.json as { item: { dependencies?: Array<Record<string, unknown>> } }).item
        .dependencies;
      expect(remainingDependencies).toEqual([
        {
          id: "pm-dep-beta",
          kind: "related",
          created_at: "2026-03-02T00:00:00.000Z",
          source_kind: "imported",
        },
      ]);

      const clearResult = context.runCli(
        [
          "update",
          createdId,
          "--json",
          "--dep",
          "none",
          "--author",
          "integration-test",
          "--message",
          "Clear dependencies",
        ],
        { expectJson: true },
      );
      expect(clearResult.code).toBe(0);
      expect((clearResult.json as { item: { dependencies?: Array<Record<string, unknown>> } }).item.dependencies).toBeUndefined();
    });
  });

  it("requires explicit --assignee for create contract parity", async () => {
    await withTempPmPath(async (context) => {
      const createWithoutAssignee = context.runCli([
        "create",
        "--json",
        "--title",
        "Missing assignee option",
        "--description",
        "Validate required create flag parity.",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--tags",
        "integration,contract",
        "--body",
        "",
        "--deadline",
        "none",
        "--estimate",
        "15",
        "--acceptance-criteria",
        "Create rejects missing assigned option",
        "--author",
        "integration-test",
        "--message",
        "Create missing assigned option",
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
      ]);

      expect(createWithoutAssignee.code).toBe(2);
      expect(createWithoutAssignee.stderr).toContain("--assignee");
    });
  });

  it("runs the core lifecycle without touching repo .agents/pm", async () => {
    await withTempPmPath(async (context) => {
      const initAgain = context.runCli(["init", "--json"], { expectJson: true });
      expect(initAgain.code).toBe(0);

      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Integration Flow Item",
          "--description",
          "End-to-end test item",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,smoke",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "25",
          "--acceptance-criteria",
          "Lifecycle succeeds in sandbox",
          "--author",
          "integration-test",
          "--message",
          "Create integration item",
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
      expect(createResult.code).toBe(0);
      const createJson = createResult.json as { item: { id: string } };
      const id = createJson.item.id;

      const historyAfterCreate = context.runCli(["history", id, "--json"], { expectJson: true });
      expect(historyAfterCreate.code).toBe(0);
      const historyAfterCreateJson = historyAfterCreate.json as { count: number; history: Array<{ op: string }> };
      expect(historyAfterCreateJson.count).toBeGreaterThanOrEqual(1);
      expect(historyAfterCreateJson.history.some((entry) => entry.op === "create")).toBe(true);

      const listOpen = context.runCli(["list-open", "--type", "Task", "--limit", "5", "--json"], { expectJson: true });
      expect(listOpen.code).toBe(0);

      const getResult = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(getResult.code).toBe(0);

      const searchResult = context.runCli(["search", "integration", "--json", "--limit", "5"], { expectJson: true });
      expect(searchResult.code).toBe(0);
      const searchJson = searchResult.json as { mode: string; items: Array<{ item: { id: string } }> };
      expect(searchJson.mode).toBe("keyword");
      expect(searchJson.items.some((entry) => entry.item.id === id)).toBe(true);

      const reindexResult = context.runCli(["reindex", "--json"], { expectJson: true });
      expect(reindexResult.code).toBe(0);
      const reindexJson = reindexResult.json as {
        ok: boolean;
        mode: string;
        total_items: number;
        artifacts: { manifest: string; embeddings: string };
      };
      expect(reindexJson.ok).toBe(true);
      expect(reindexJson.mode).toBe("keyword");
      expect(reindexJson.total_items).toBeGreaterThanOrEqual(1);
      expect(reindexJson.artifacts).toEqual({
        manifest: "index/manifest.json",
        embeddings: "search/embeddings.jsonl",
      });
      const manifestPath = path.join(context.pmPath, "index", "manifest.json");
      const embeddingsPath = path.join(context.pmPath, "search", "embeddings.jsonl");
      const manifestContents = await readFile(manifestPath, "utf8");
      expect(manifestContents).toContain('"mode": "keyword"');
      expect(await readFile(embeddingsPath, "utf8")).toContain(id);

      const claimResult = context.runCli(["claim", id, "--json", "--author", "integration-test"], { expectJson: true });
      expect(claimResult.code).toBe(0);
      await expect(readFile(manifestPath, "utf8")).rejects.toBeDefined();
      await expect(readFile(embeddingsPath, "utf8")).rejects.toBeDefined();

      const updateResult = context.runCli(
        [
          "update",
          id,
          "--json",
          "--status",
          "in_progress",
          "--priority",
          "0",
          "--type",
          "Task",
          "--tags",
          "integration,smoke,updated",
          "--description",
          "Updated description",
          "--deadline",
          "none",
          "--estimate",
          "30",
          "--acceptance-criteria",
          "Still deterministic",
          "--author",
          "integration-test",
          "--message",
          "Move to in_progress",
        ],
        { expectJson: true },
      );
      expect(updateResult.code).toBe(0);

      const appendResult = context.runCli(
        ["append", id, "--json", "--body", "Appended integration notes", "--author", "integration-test", "--message", "Append body"],
        { expectJson: true },
      );
      expect(appendResult.code).toBe(0);

      const addComment = context.runCli(
        ["comments", id, "--json", "--add", "Integration comment", "--author", "integration-test", "--message", "Add comment"],
        { expectJson: true },
      );
      expect(addComment.code).toBe(0);
      const addCommentPositional = context.runCli(
        ["comments", id, "Integration shorthand comment", "--json", "--author", "integration-test"],
        {
          expectJson: true,
        },
      );
      expect(addCommentPositional.code).toBe(0);
      const addCommentPositionalJson = addCommentPositional.json as { comments: Array<{ text: string; author: string }> };
      expect(addCommentPositionalJson.comments.at(-1)?.text).toBe("Integration shorthand comment");
      expect(addCommentPositionalJson.comments.at(-1)?.author).toBe("integration-test");

      const conflictingCommentArgs = context.runCli(["comments", id, "positional comment", "--add", "flag comment"]);
      expect(conflictingCommentArgs.code).toBe(2);
      expect(conflictingCommentArgs.stderr).toContain("Specify comment text either as positional [text] or with --add, not both");

      const listComments = context.runCli(["comments", id, "--json", "--limit", "1"], { expectJson: true });
      expect(listComments.code).toBe(0);

      const addNote = context.runCli(
        ["notes", id, "--json", "--add", "Integration note", "--author", "integration-test", "--message", "Add note"],
        { expectJson: true },
      );
      expect(addNote.code).toBe(0);
      const addNotePositional = context.runCli(["notes", id, "Integration shorthand note", "--json", "--author", "integration-test"], {
        expectJson: true,
      });
      expect(addNotePositional.code).toBe(0);
      const addNotePositionalJson = addNotePositional.json as { notes: Array<{ text: string; author: string }> };
      expect(addNotePositionalJson.notes.at(-1)?.text).toBe("Integration shorthand note");
      expect(addNotePositionalJson.notes.at(-1)?.author).toBe("integration-test");
      const conflictingNoteArgs = context.runCli(["notes", id, "positional note", "--add", "flag note"]);
      expect(conflictingNoteArgs.code).toBe(2);
      expect(conflictingNoteArgs.stderr).toContain("Specify note text either as positional [text] or with --add, not both");

      const addLearning = context.runCli(
        ["learnings", id, "--json", "--add", "Integration learning", "--author", "integration-test", "--message", "Add learning"],
        { expectJson: true },
      );
      expect(addLearning.code).toBe(0);
      const addLearningPositional = context.runCli(
        ["learnings", id, "Integration shorthand learning", "--json", "--author", "integration-test"],
        { expectJson: true },
      );
      expect(addLearningPositional.code).toBe(0);
      const addLearningPositionalJson = addLearningPositional.json as { learnings: Array<{ text: string; author: string }> };
      expect(addLearningPositionalJson.learnings.at(-1)?.text).toBe("Integration shorthand learning");
      expect(addLearningPositionalJson.learnings.at(-1)?.author).toBe("integration-test");
      const conflictingLearningArgs = context.runCli(["learnings", id, "positional learning", "--add", "flag learning"]);
      expect(conflictingLearningArgs.code).toBe(2);
      expect(conflictingLearningArgs.stderr).toContain("Specify learning text either as positional [text] or with --add, not both");

      const addFile = context.runCli(
        ["files", id, "--json", "--add", "path=src/cli/main.ts,scope=project,note=integration", "--author", "integration-test", "--message", "Add file link"],
        { expectJson: true },
      );
      expect(addFile.code).toBe(0);
      const removeFile = context.runCli(
        ["files", id, "--json", "--remove", "src/cli/main.ts", "--author", "integration-test", "--message", "Remove file link"],
        { expectJson: true },
      );
      expect(removeFile.code).toBe(0);
      const listFiles = context.runCli(["files", id, "--json"], { expectJson: true });
      expect(listFiles.code).toBe(0);

      const addDoc = context.runCli(
        ["docs", id, "--json", "--add", "path=README.md,scope=project,note=integration", "--author", "integration-test", "--message", "Add doc link"],
        { expectJson: true },
      );
      expect(addDoc.code).toBe(0);
      const removeDoc = context.runCli(
        ["docs", id, "--json", "--remove", "README.md", "--author", "integration-test", "--message", "Remove doc link"],
        { expectJson: true },
      );
      expect(removeDoc.code).toBe(0);
      const listDocs = context.runCli(["docs", id, "--json"], { expectJson: true });
      expect(listDocs.code).toBe(0);

      const addTests = context.runCli(
        [
          "test",
          id,
          "--json",
          "--add",
          "command=node --version,scope=project,timeout=30,note=pass",
          "--add",
          "command=node --help,path=tests/example.spec.ts,scope=project,note=path-metadata",
          "--author",
          "integration-test",
          "--message",
          "Add linked tests",
        ],
        { expectJson: true },
      );
      expect(addTests.code).toBe(0);
      const addTestsJson = addTests.json as { tests: Array<{ command?: string; timeout_seconds?: number }> };
      expect(addTestsJson.tests.some((entry) => entry.command === "node --version" && entry.timeout_seconds === 30)).toBe(
        true,
      );

      const runTests = context.runCli(["test", id, "--json", "--run", "--timeout", "30"], { expectJson: true });
      expect(runTests.code).toBe(0);
      const runTestsJson = runTests.json as { run_results: Array<{ status: string }> };
      expect(runTestsJson.run_results.some((entry) => entry.status === "passed")).toBe(true);

      const historyLatest = context.runCli(["history", id, "--json", "--limit", "1"], { expectJson: true });
      expect(historyLatest.code).toBe(0);
      const historyLatestJson = historyLatest.json as { count: number };
      expect(historyLatestJson.count).toBe(1);

      const activity = context.runCli(["activity", "--json", "--limit", "10"], { expectJson: true });
      expect(activity.code).toBe(0);
      const activityJson = activity.json as { activity: Array<{ id: string }> };
      expect(activityJson.activity.some((entry) => entry.id === id)).toBe(true);

      const stats = context.runCli(["stats", "--json"], { expectJson: true });
      expect(stats.code).toBe(0);
      const statsJson = stats.json as {
        totals: { items: number; history_streams: number; history_entries: number };
        by_type: { Task: number };
      };
      expect(statsJson.totals.items).toBeGreaterThanOrEqual(1);
      expect(statsJson.totals.history_streams).toBeGreaterThanOrEqual(1);
      expect(statsJson.totals.history_entries).toBeGreaterThanOrEqual(1);
      expect(statsJson.by_type.Task).toBeGreaterThanOrEqual(1);

      const configSet = context.runCli(
        [
          "config",
          "project",
          "set",
          "definition-of-done",
          "--json",
          "--criterion",
          "tests pass",
          "--criterion",
          "linked files/tests/docs present",
        ],
        { expectJson: true },
      );
      expect(configSet.code).toBe(0);
      const configSetJson = configSet.json as { criteria: string[]; changed: boolean };
      expect(configSetJson.criteria).toEqual(["linked files/tests/docs present", "tests pass"]);
      expect(configSetJson.changed).toBe(true);

      const configGet = context.runCli(["config", "project", "get", "definition-of-done", "--json"], { expectJson: true });
      expect(configGet.code).toBe(0);
      const configGetJson = configGet.json as { criteria: string[]; changed: boolean };
      expect(configGetJson.criteria).toEqual(["linked files/tests/docs present", "tests pass"]);
      expect(configGetJson.changed).toBe(false);

      const sprintReleasePolicySet = context.runCli(
        ["config", "project", "set", "sprint-release-format-policy", "--policy", "strict_error", "--json"],
        { expectJson: true },
      );
      expect(sprintReleasePolicySet.code).toBe(0);
      const sprintReleasePolicySetJson = sprintReleasePolicySet.json as {
        key: string;
        policy: string;
        changed: boolean;
      };
      expect(sprintReleasePolicySetJson.key).toBe("sprint_release_format_policy");
      expect(sprintReleasePolicySetJson.policy).toBe("strict_error");
      expect(sprintReleasePolicySetJson.changed).toBe(true);

      const sprintReleasePolicyGet = context.runCli(
        ["config", "project", "get", "sprint-release-format-policy", "--json"],
        { expectJson: true },
      );
      expect(sprintReleasePolicyGet.code).toBe(0);
      const sprintReleasePolicyGetJson = sprintReleasePolicyGet.json as { policy: string; changed: boolean };
      expect(sprintReleasePolicyGetJson.policy).toBe("strict_error");
      expect(sprintReleasePolicyGetJson.changed).toBe(false);

      const previousDisableAutoDefaults = process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS;
      process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS = "1";
      const health = context.runCli(["health", "--json"], { expectJson: true });
      if (previousDisableAutoDefaults === undefined) {
        delete process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS;
      } else {
        process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS = previousDisableAutoDefaults;
      }
      expect(health.code).toBe(0);
      const healthJson = health.json as {
        ok: boolean;
        checks: Array<{ name: string }>;
        warnings: string[];
      };
      expect(typeof healthJson.ok).toBe("boolean");
      expect(Array.isArray(healthJson.warnings)).toBe(true);
      expect(healthJson.checks.map((check) => check.name)).toEqual([
        "settings",
        "directories",
        "settings_values",
        "extensions",
        "storage",
        "integrity",
        "history_drift",
        "vectorization",
      ]);

      await writeFile(path.join(context.pmPath, "index", "manifest.json"), '{"seed":true}\n', "utf8");
      await writeFile(path.join(context.pmPath, "search", "embeddings.jsonl"), '{"id":"seed"}\n', "utf8");
      const gc = context.runCli(["gc", "--json"], { expectJson: true });
      expect(gc.code).toBe(0);
      const gcJson = gc.json as {
        ok: boolean;
        removed: string[];
        retained: string[];
        warnings: string[];
      };
      expect(gcJson.ok).toBe(true);
      expect(gcJson.removed).toEqual(["index/manifest.json", "search/embeddings.jsonl"]);
      expect(gcJson.retained).toEqual([]);
      expect(gcJson.warnings).toEqual([]);

      const testAll = context.runCli(["test-all", "--json", "--status", "in_progress"], { expectJson: true });
      expect(testAll.code).toBe(0);

      const closeResult = context.runCli(
        ["close", id, "Integration flow complete", "--json", "--author", "integration-test", "--message", "Close integration item"],
        { expectJson: true },
      );
      expect(closeResult.code).toBe(0);
      const closeJson = closeResult.json as { item: { status: string; close_reason: string; assignee?: string }; changed_fields: string[] };
      expect(closeJson.item.status).toBe("closed");
      expect(closeJson.item.close_reason).toBe("Integration flow complete");
      expect(closeJson.item.assignee).toBeUndefined();
      expect(closeJson.changed_fields).toEqual(expect.arrayContaining(["status", "close_reason"]));

      const reopenResult = context.runCli(
        [
          "update",
          id,
          "--json",
          "--status",
          "open",
          "--author",
          "integration-test",
          "--message",
          "Reopen integration item",
        ],
        { expectJson: true },
      );
      expect(reopenResult.code).toBe(0);
      const reopenJson = reopenResult.json as {
        item: { status: string; close_reason?: string };
        changed_fields: string[];
      };
      expect(reopenJson.item.status).toBe("open");
      expect(reopenJson.item.close_reason).toBeUndefined();
      expect(reopenJson.changed_fields).toEqual(expect.arrayContaining(["status", "close_reason"]));

      const setCloseReasonResult = context.runCli(
        [
          "update",
          id,
          "--json",
          "--close-reason",
          "Explicit lifecycle note",
          "--author",
          "integration-test",
          "--message",
          "Set close reason explicitly",
        ],
        { expectJson: true },
      );
      expect(setCloseReasonResult.code).toBe(0);
      const setCloseReasonJson = setCloseReasonResult.json as {
        item: { close_reason?: string };
        changed_fields: string[];
      };
      expect(setCloseReasonJson.item.close_reason).toBe("Explicit lifecycle note");
      expect(setCloseReasonJson.changed_fields).toContain("close_reason");

      const clearCloseReasonResult = context.runCli(
        [
          "update",
          id,
          "--json",
          "--close-reason",
          "none",
          "--author",
          "integration-test",
          "--message",
          "Clear close reason explicitly",
        ],
        { expectJson: true },
      );
      expect(clearCloseReasonResult.code).toBe(0);
      const clearCloseReasonJson = clearCloseReasonResult.json as {
        item: { close_reason?: string };
        changed_fields: string[];
      };
      expect(clearCloseReasonJson.item.close_reason).toBeUndefined();
      expect(clearCloseReasonJson.changed_fields).toContain("close_reason");

      const releaseResult = context.runCli(["release", id, "--json"], { expectJson: true });
      expect(releaseResult.code).toBe(0);
    });
  }, 60_000);

  it("deletes an item through CLI and keeps history retrievable", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Delete Integration Item",
          "--description",
          "Validate delete command behavior in CLI flow",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,delete",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "20",
          "--acceptance-criteria",
          "Delete removes active item while preserving history",
          "--author",
          "integration-test",
          "--message",
          "Create delete integration item",
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
      expect(createResult.code).toBe(0);
      const id = (createResult.json as { item: { id: string } }).item.id;

      const deleteResult = context.runCli(
        ["delete", id, "--json", "--author", "integration-test", "--message", "Delete integration item"],
        { expectJson: true },
      );
      expect(deleteResult.code).toBe(0);
      const deleteJson = deleteResult.json as {
        item: { id: string };
        changed_fields: string[];
      };
      expect(deleteJson.item.id).toBe(id);
      expect(deleteJson.changed_fields).toEqual(["deleted"]);

      const getDeleted = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(getDeleted.code).toBe(3);

      const listAll = context.runCli(["list-all", "--json"], { expectJson: true });
      expect(listAll.code).toBe(0);
      const listAllJson = listAll.json as { items: Array<{ id: string }> };
      expect(listAllJson.items.some((item) => item.id === id)).toBe(false);

      const history = context.runCli(["history", id, "--json"], { expectJson: true });
      expect(history.code).toBe(0);
      const historyJson = history.json as { history: Array<{ op: string }> };
      expect(historyJson.history.at(-1)?.op).toBe("delete");
    });
  });

  it("keeps repeated files/docs add flows stable across subsequent commands", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Repeated linked artifact stability item",
          "--description",
          "Regression seed for repeated files/docs add flows",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,files-docs,stability",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "20",
          "--acceptance-criteria",
          "Repeated add flows remain stable",
          "--author",
          "integration-test",
          "--message",
          "Create repeated add stability seed",
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
      expect(createResult.code).toBe(0);
      const id = (createResult.json as { item: { id: string } }).item.id;

      const addFileFirst = context.runCli(
        [
          "files",
          id,
          "--json",
          "--add",
          "path=src/cli/main.ts,scope=project,note=first add",
          "--author",
          "integration-test",
          "--message",
          "Add file first",
          "--force",
        ],
        { expectJson: true },
      );
      expect(addFileFirst.code).toBe(0);
      const afterFileFirst = context.runCli(["list-open", "--json", "--limit", "5"], { expectJson: true });
      expect(afterFileFirst.code).toBe(0);

      const addFileSecond = context.runCli(
        [
          "files",
          id,
          "--json",
          "--add",
          "path=src/cli/help-content.ts,scope=project,note=second add",
          "--author",
          "integration-test",
          "--message",
          "Add file second",
          "--force",
        ],
        { expectJson: true },
      );
      expect(addFileSecond.code).toBe(0);
      const addFileDuplicate = context.runCli(
        [
          "files",
          id,
          "--json",
          "--add",
          "path=src/cli/main.ts,scope=project,note=duplicate add",
          "--author",
          "integration-test",
          "--message",
          "Add file duplicate",
          "--force",
        ],
        { expectJson: true },
      );
      expect(addFileDuplicate.code).toBe(0);
      const filesList = context.runCli(["files", id, "--json"], { expectJson: true });
      expect(filesList.code).toBe(0);
      const filesListJson = filesList.json as { files: Array<{ path: string }> };
      expect(filesListJson.files.map((entry) => entry.path).sort()).toEqual(["src/cli/help-content.ts", "src/cli/main.ts"]);
      const afterFilesSequence = context.runCli(["history", id, "--json", "--limit", "1"], { expectJson: true });
      expect(afterFilesSequence.code).toBe(0);

      const addDocFirst = context.runCli(
        [
          "docs",
          id,
          "--json",
          "--add",
          "path=README.md,scope=project,note=first add",
          "--author",
          "integration-test",
          "--message",
          "Add doc first",
          "--force",
        ],
        { expectJson: true },
      );
      expect(addDocFirst.code).toBe(0);
      const afterDocFirst = context.runCli(["stats", "--json"], { expectJson: true });
      expect(afterDocFirst.code).toBe(0);

      const addDocSecond = context.runCli(
        [
          "docs",
          id,
          "--json",
          "--add",
          "path=docs/ARCHITECTURE.md,scope=project,note=second add",
          "--author",
          "integration-test",
          "--message",
          "Add doc second",
          "--force",
        ],
        { expectJson: true },
      );
      expect(addDocSecond.code).toBe(0);
      const addDocDuplicate = context.runCli(
        [
          "docs",
          id,
          "--json",
          "--add",
          "path=README.md,scope=project,note=duplicate add",
          "--author",
          "integration-test",
          "--message",
          "Add doc duplicate",
          "--force",
        ],
        { expectJson: true },
      );
      expect(addDocDuplicate.code).toBe(0);
      const docsList = context.runCli(["docs", id, "--json"], { expectJson: true });
      expect(docsList.code).toBe(0);
      const docsListJson = docsList.json as { docs: Array<{ path: string }> };
      expect(docsListJson.docs.map((entry) => entry.path).sort()).toEqual(["README.md", "docs/ARCHITECTURE.md"]);

      const postDocsCommand = context.runCli(["comments", id, "--json", "--add", "post-docs stability check"], { expectJson: true });
      expect(postDocsCommand.code).toBe(0);
    });
  });

  it("guides users to files/docs commands for update --file/--doc usage", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Update linked artifact guidance seed",
          "--description",
          "Seed item for update unknown-option guidance",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,update,guidance",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "10",
          "--acceptance-criteria",
          "Unknown option guidance is actionable",
          "--author",
          "integration-test",
          "--message",
          "Create update guidance seed",
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
      expect(createResult.code).toBe(0);
      const id = (createResult.json as { item: { id: string } }).item.id;

      const updateWithFile = context.runCli(["update", id, "--file", "path=src/cli/main.ts"]);
      expect(updateWithFile.code).toBe(2);
      expect(updateWithFile.stderr).toContain("Unsupported option --file for update");
      expect(updateWithFile.stderr).toContain("pm files");
      expect(updateWithFile.stderr).toContain("pm docs");

      const updateWithDoc = context.runCli(["update", id, "--doc", "path=README.md"]);
      expect(updateWithDoc.code).toBe(2);
      expect(updateWithDoc.stderr).toContain("Unsupported option --doc for update");
      expect(updateWithDoc.stderr).toContain("pm files");
      expect(updateWithDoc.stderr).toContain("pm docs");
    });
  });

  it("filters list/list-* status commands across lifecycle states", async () => {
    await withTempPmPath(async (context) => {
      const createItem = (title: string, status: string, priority: string) =>
        context.runCli(
          [
            "create",
            "--json",
            "--title",
            title,
            "--description",
            `Seed ${title}`,
            "--type",
            "Task",
            "--status",
            status,
            "--priority",
            priority,
            "--tags",
            "integration,list-status",
            "--body",
            `Body for ${title}`,
            "--deadline",
            "none",
            "--estimate",
            "10",
            "--acceptance-criteria",
            `List command coverage for ${status}`,
            "--author",
            "integration-test",
            "--message",
            `Create ${title}`,
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

      expect(createItem("List Open Priority One", "open", "1").code).toBe(0);
      expect(createItem("List Open Priority Zero", "open", "0").code).toBe(0);
      expect(createItem("List Draft", "draft", "4").code).toBe(0);
      expect(createItem("List In Progress", "in-progress", "2").code).toBe(0);
      expect(createItem("List Blocked", "blocked", "3").code).toBe(0);
      expect(createItem("List Closed", "closed", "1").code).toBe(0);
      expect(createItem("List Canceled", "canceled", "2").code).toBe(0);

      const listDraft = context.runCli(["list-draft", "--json", "--type", "Task"], { expectJson: true });
      expect(listDraft.code).toBe(0);
      const listDraftJson = listDraft.json as { count: number; items: Array<{ status: string }> };
      expect(listDraftJson.count).toBe(1);
      expect(listDraftJson.items.map((item) => item.status)).toEqual(["draft"]);

      const listOpen = context.runCli(["list-open", "--json", "--type", "Task"], { expectJson: true });
      expect(listOpen.code).toBe(0);
      const listOpenJson = listOpen.json as {
        count: number;
        items: Array<{ status: string; priority: number }>;
        filters: { status: string | null; include_body: boolean | null };
      };
      expect(listOpenJson.filters.status).toBe("open");
      expect(listOpenJson.filters.include_body).toBeNull();
      expect(listOpenJson.count).toBe(2);
      expect(listOpenJson.items.map((item) => item.status)).toEqual(["open", "open"]);
      expect(listOpenJson.items.map((item) => item.priority)).toEqual([0, 1]);
      expect(listOpenJson.items[0]).not.toHaveProperty("body");

      const listInProgress = context.runCli(["list-in-progress", "--json", "--type", "Task"], { expectJson: true });
      expect(listInProgress.code).toBe(0);
      const listInProgressJson = listInProgress.json as { count: number; items: Array<{ status: string }> };
      expect(listInProgressJson.count).toBe(1);
      expect(listInProgressJson.items.map((item) => item.status)).toEqual(["in_progress"]);

      const listBlocked = context.runCli(["list-blocked", "--json", "--type", "Task"], { expectJson: true });
      expect(listBlocked.code).toBe(0);
      const listBlockedJson = listBlocked.json as { count: number; items: Array<{ status: string }> };
      expect(listBlockedJson.count).toBe(1);
      expect(listBlockedJson.items.map((item) => item.status)).toEqual(["blocked"]);

      const listClosed = context.runCli(["list-closed", "--json", "--type", "Task"], { expectJson: true });
      expect(listClosed.code).toBe(0);
      const listClosedJson = listClosed.json as { count: number; items: Array<{ status: string }> };
      expect(listClosedJson.count).toBe(1);
      expect(listClosedJson.items.map((item) => item.status)).toEqual(["closed"]);

      const listCanceled = context.runCli(["list-canceled", "--json", "--type", "Task"], { expectJson: true });
      expect(listCanceled.code).toBe(0);
      const listCanceledJson = listCanceled.json as { count: number; items: Array<{ status: string }> };
      expect(listCanceledJson.count).toBe(1);
      expect(listCanceledJson.items.map((item) => item.status)).toEqual(["canceled"]);

      const listAll = context.runCli(["list-all", "--json", "--type", "Task"], { expectJson: true });
      expect(listAll.code).toBe(0);
      const listAllJson = listAll.json as { count: number; items: Array<{ status: string }> };
      expect(listAllJson.count).toBe(7);
      const allStatuses = listAllJson.items.map((item) => item.status);
      const firstTerminalIndex = allStatuses.findIndex((status) => status === "closed" || status === "canceled");
      expect(firstTerminalIndex).toBeGreaterThan(0);
      expect(allStatuses.slice(0, firstTerminalIndex).every((status) => status !== "closed" && status !== "canceled")).toBe(
        true,
      );
      expect(allStatuses.slice(firstTerminalIndex).every((status) => status === "closed" || status === "canceled")).toBe(
        true,
      );

      // pm list (bare command) excludes terminal statuses by default
      const listActive = context.runCli(["list", "--json", "--type", "Task"], { expectJson: true });
      expect(listActive.code).toBe(0);
      const listActiveJson = listActive.json as { count: number; items: Array<{ status: string }> };
      expect(listActiveJson.count).toBe(5);
      const activeStatuses = listActiveJson.items.map((item) => item.status);
      expect(activeStatuses).not.toContain("closed");
      expect(activeStatuses).not.toContain("canceled");
      expect(activeStatuses).toContain("draft");
      expect(activeStatuses).toContain("open");
      expect(activeStatuses).toContain("in_progress");
      expect(activeStatuses).toContain("blocked");

      const listCommandsWithBody = [
        "list",
        "list-all",
        "list-draft",
        "list-open",
        "list-in-progress",
        "list-blocked",
        "list-closed",
        "list-canceled",
      ] as const;

      for (const commandName of listCommandsWithBody) {
        const withBodyResult = context.runCli([commandName, "--json", "--type", "Task", "--include-body"], {
          expectJson: true,
        });
        expect(withBodyResult.code).toBe(0);
        const withBodyJson = withBodyResult.json as {
          items: Array<{ body?: string }>;
          filters: { include_body: boolean | null };
        };
        expect(withBodyJson.filters.include_body).toBe(true);
        expect(withBodyJson.items.every((item) => typeof item.body === "string")).toBe(true);
      }
    });
  });

  it("runs extension before/after command hooks with failure containment", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "hook-ext");
      const hookLogPath = path.join(context.tempRoot, "hook-events.log");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "hook-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["hooks"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "import fs from 'node:fs';",
          "export default {",
          "  activate(api) {",
          "    api.hooks.beforeCommand(() => {",
          "      throw new Error('before-hook-boom');",
          "    });",
          String.raw`    api.hooks.beforeCommand((event) => { fs.appendFileSync(${JSON.stringify(hookLogPath)}, 'before:' + event.command + '\n', 'utf8'); });`,
          String.raw`    api.hooks.afterCommand((event) => { fs.appendFileSync(${JSON.stringify(hookLogPath)}, 'after:' + event.command + '\n', 'utf8'); });`,
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const listOpen = context.runCli(["--profile", "list-open", "--json", "--limit", "1"], { expectJson: true });
      expect(listOpen.code).toBe(0);
      expect(listOpen.stderr).toContain("extension_hook_failed:project:hook-ext:beforeCommand");

      const hookLog = await readFile(hookLogPath, "utf8");
      expect(hookLog.trim().split("\n")).toEqual(["before:list-open", "after:list-open"]);
    });
  });

  it("runs extension afterCommand hooks for failed commands", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "hook-failure-ext");
      const hookLogPath = path.join(context.tempRoot, "hook-failure-events.log");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "hook-failure-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["hooks"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "import fs from 'node:fs';",
          "export default {",
          "  activate(api) {",
          String.raw`    api.hooks.afterCommand((event) => { fs.appendFileSync(${JSON.stringify(hookLogPath)}, 'after:' + event.command + ':ok=' + String(event.ok) + ':error=' + String(event.error ?? '') + '\n', 'utf8'); });`,
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const missingGet = context.runCli(["get", "pm-missing", "--json"]);
      expect(missingGet.code).toBe(3);
      const missingGetEnvelope = parseJsonErrorEnvelope(missingGet.stderr);
      expect(missingGetEnvelope).toMatchObject({
        code: "item_not_found",
        exit_code: 3,
      });
      expect(missingGetEnvelope.detail).toContain("pm-missing");

      const hookLog = await readFile(hookLogPath, "utf8");
      expect(hookLog.trim()).toContain("after:get:ok=false:error=Item pm-missing not found");
    });
  });

  it("blocks mutating commands for unresolved mandatory migrations and supports force bypass where available", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "migration-gate-ext");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "migration-gate-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["schema"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerMigration({ id: 'required-schema', mandatory: true, status: 'pending' });",
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const blockedCreate = context.runCli([
        "create",
        "--json",
        "--title",
        "Blocked by migration gate",
        "--description",
        "create should be blocked",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--tags",
        "integration,migration-gate",
        "--body",
        "",
        "--deadline",
        "none",
        "--estimate",
        "20",
        "--acceptance-criteria",
        "Create is blocked",
        "--author",
        "integration-test",
        "--message",
        "Attempt blocked create",
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
      ]);
      expect(blockedCreate.code).toBe(4);
      const blockedCreateEnvelope = parseJsonErrorEnvelope(blockedCreate.stderr);
      expect(blockedCreateEnvelope).toMatchObject({
        code: "command_failed",
        exit_code: 4,
      });
      expect(blockedCreateEnvelope.detail).toContain(
        'Write command "create" blocked by unresolved mandatory extension migrations',
      );
      expect(blockedCreateEnvelope.detail).toContain(
        "extension_migration_blocking:project:migration-gate-ext:required-schema:pending",
      );
      expect(blockedCreateEnvelope.detail).toContain("does not support --force bypass");

      const seedCreate = context.runCli(
        [
          "--no-extensions",
          "create",
          "--json",
          "--title",
          "Seed item for update gate",
          "--description",
          "Created without extensions to seed update test",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,migration-gate",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "20",
          "--acceptance-criteria",
          "Seed item exists",
          "--author",
          "integration-test",
          "--message",
          "Seed create without extensions",
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
      expect(seedCreate.code).toBe(0);
      const seededId = (seedCreate.json as { item: { id: string } }).item.id;

      const blockedUpdate = context.runCli([
        "update",
        seededId,
        "--json",
        "--status",
        "in_progress",
        "--author",
        "integration-test",
        "--message",
        "Attempt blocked update",
      ]);
      expect(blockedUpdate.code).toBe(4);
      const blockedUpdateEnvelope = parseJsonErrorEnvelope(blockedUpdate.stderr);
      expect(blockedUpdateEnvelope).toMatchObject({
        code: "command_failed",
        exit_code: 4,
      });
      expect(blockedUpdateEnvelope.detail).toContain(
        'Write command "update" blocked by unresolved mandatory extension migrations',
      );
      expect(blockedUpdateEnvelope.detail).toContain("Re-run this command with --force to bypass");

      const forcedUpdate = context.runCli(
        [
          "update",
          seededId,
          "--json",
          "--status",
          "in-progress",
          "--author",
          "integration-test",
          "--message",
          "Force update with unresolved mandatory migration",
          "--force",
        ],
        { expectJson: true },
      );
      expect(forcedUpdate.code).toBe(0);

      const getUpdated = context.runCli(["get", seededId, "--json"], { expectJson: true });
      expect(getUpdated.code).toBe(0);
      const getUpdatedJson = getUpdated.json as { item: { status: string } };
      expect(getUpdatedJson.item.status).toBe("in_progress");
    });
  });

  it("treats case-insensitive applied mandatory migration status as resolved", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "migration-applied-ext");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "migration-applied-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["schema"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerMigration({ id: 'already-applied', mandatory: true, status: 'ApPlIeD' });",
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Applied migration does not block",
          "--description",
          "Create should succeed when mandatory migration status is applied",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,migration-gate",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "20",
          "--acceptance-criteria",
          "Create succeeds",
          "--author",
          "integration-test",
          "--message",
          "Create with resolved mandatory migration",
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
      expect(createResult.code).toBe(0);
    });
  });

  it("blocks item mutations when legacy settings omit item_format until explicit config selection is set", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      delete settings.item_format;
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const blockedCreate = context.runCli([
        "create",
        "--json",
        "--title",
        "Blocked legacy mutation",
        "--description",
        "Requires explicit item format selection first",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--tags",
        "integration,item-format",
        "--body",
        "",
        "--deadline",
        "none",
        "--estimate",
        "20",
        "--acceptance-criteria",
        "Mutation blocks until format is explicitly selected",
        "--author",
        "integration-test",
        "--message",
        "Attempt blocked create",
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
      ]);
      expect(blockedCreate.code).toBe(4);
      expect(blockedCreate.stderr).toContain("requires explicit item format selection before mutations");

      const setFormat = context.runCli(
        ["config", "project", "set", "item-format", "--format", "toon", "--json"],
        { expectJson: true },
      );
      expect(setFormat.code).toBe(0);
      const setFormatJson = setFormat.json as { key: string; format: string; changed: boolean };
      expect(setFormatJson.key).toBe("item_format");
      expect(setFormatJson.format).toBe("toon");
      expect(setFormatJson.changed).toBe(true);

      const allowedCreate = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Allowed after explicit format set",
          "--description",
          "Mutation should proceed after config selection",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,item-format",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "20",
          "--acceptance-criteria",
          "Mutation succeeds once explicit format is selected",
          "--author",
          "integration-test",
          "--message",
          "Create after format set",
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
      expect(allowedCreate.code).toBe(0);
    });
  });

  it("allows preflight overrides to bypass legacy item-format mutation gate", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      delete settings.item_format;
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const extensionDir = path.join(context.pmPath, "extensions", "preflight-bypass-ext");
      await mkdir(extensionDir, { recursive: true });
      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "preflight-bypass-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["preflight"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerPreflight(() => ({",
          "      enforce_item_format_gate: false,",
          "      run_preflight_item_format_sync: false,",
          "    }));",
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Bypassed legacy mutation gate",
          "--description",
          "Preflight extension disables legacy format gate for this test",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,preflight",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "20",
          "--acceptance-criteria",
          "Preflight override bypasses explicit format gate",
          "--author",
          "integration-test",
          "--message",
          "Create with preflight override",
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
      expect(createResult.code).toBe(0);
      const created = createResult.json as { item: { id: string } };
      expect(created.item.id.startsWith("pm-")).toBe(true);
    });
  });

  it("auto-migrates item files before mutation when settings item_format is manually changed", async () => {
    await withTempPmPath(async (context) => {
      const setMarkdown = context.runCli(
        ["config", "project", "set", "item-format", "--format", "json_markdown", "--json"],
        { expectJson: true },
      );
      expect(setMarkdown.code).toBe(0);

      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Manual settings migration preflight",
          "--description",
          "Verify pre-mutation item format sync",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,item-format",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "20",
          "--acceptance-criteria",
          "Mutation preflight migrates item format",
          "--author",
          "integration-test",
          "--message",
          "Create markdown item",
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
      expect(createResult.code).toBe(0);
      const createdId = (createResult.json as { item: { id: string } }).item.id;
      const markdownPath = path.join(context.pmPath, "tasks", `${createdId}.md`);
      const toonPath = path.join(context.pmPath, "tasks", `${createdId}.toon`);
      await expect(readFile(markdownPath, "utf8")).resolves.toContain(createdId);

      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      settings.item_format = "toon";
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const updateResult = context.runCli(
        [
          "update",
          createdId,
          "--status",
          "in_progress",
          "--author",
          "integration-test",
          "--message",
          "Update after manual item_format switch",
          "--json",
        ],
        { expectJson: true },
      );
      expect(updateResult.code).toBe(0);
      await expect(readFile(toonPath, "utf8")).resolves.toContain(createdId);
      await expect(readFile(markdownPath, "utf8")).rejects.toBeDefined();
    });
  });

  it("runs extension read/write/index hooks for item-store, history/activity, and reindex flows", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "rw-index-hook-ext");
      const hookLogPath = path.join(context.tempRoot, "rw-index-events.log");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "rw-index-hook-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["hooks"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "import fs from 'node:fs';",
          String.raw`const basename = (value) => value.split(/[\/\\]/).at(-1) ?? value;`,
          "export default {",
          "  activate(api) {",
          String.raw`    api.hooks.onRead((event) => { fs.appendFileSync(${JSON.stringify(hookLogPath)}, 'read:' + basename(event.path) + '\n', 'utf8'); });`,
          String.raw`    api.hooks.onWrite((event) => { fs.appendFileSync(${JSON.stringify(hookLogPath)}, 'write:' + event.op + ':' + basename(event.path) + '\n', 'utf8'); });`,
          String.raw`    api.hooks.onIndex((event) => { fs.appendFileSync(${JSON.stringify(hookLogPath)}, 'index:' + event.mode + ':' + String(event.total_items ?? '') + '\n', 'utf8'); });`,
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Hook IO Item",
          "--description",
          "Validate read/write/index hook call sites",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,hooks",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "10",
          "--acceptance-criteria",
          "Read/write/index hooks are dispatched",
          "--author",
          "integration-test",
          "--message",
          "Create hook IO item",
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
      expect(createResult.code).toBe(0);
      const id = (createResult.json as { item: { id: string } }).item.id;

      const updateResult = context.runCli(
        ["update", id, "--json", "--status", "in_progress", "--author", "integration-test", "--message", "Trigger write hook"],
        { expectJson: true },
      );
      expect(updateResult.code).toBe(0);

      const getResult = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(getResult.code).toBe(0);

      const historyResult = context.runCli(["history", id, "--json"], { expectJson: true });
      expect(historyResult.code).toBe(0);

      const activityResult = context.runCli(["activity", "--json"], { expectJson: true });
      expect(activityResult.code).toBe(0);

      const reindexResult = context.runCli(["reindex", "--json"], { expectJson: true });
      expect(reindexResult.code).toBe(0);

      const initRewriteResult = context.runCli(["init", "zz-", "--json"], { expectJson: true });
      expect(initRewriteResult.code).toBe(0);

      const hookLog = await readFile(hookLogPath, "utf8");
      const lines = hookLog
        .trim()
        .split("\n")
        .filter((entry) => entry.length > 0);
      expect(lines.some((line) => line.startsWith("write:update:") && line.endsWith(".toon"))).toBe(true);
      expect(lines.includes(`read:${id}.toon`)).toBe(true);
      expect(lines.filter((line) => line === `read:${id}.jsonl`).length).toBeGreaterThanOrEqual(2);
      expect(lines).toContain("read:settings.json");
      expect(lines).toContain("write:settings:write:settings.json");
      expect(lines).toContain("write:reindex:manifest:manifest.json");
      expect(lines).toContain("write:reindex:embeddings:embeddings.jsonl");
      expect(lines.some((line) => /^index:keyword:\d+$/.test(line))).toBe(true);
    });
  });

  it("runs extension command-result and renderer overrides with safe fallback", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "command-renderer-ext");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "command-renderer-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["commands", "renderers"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand('list-open', (context) => ({ ...context.result, override_marker: true }));",
          "    api.registerCommand('list-all', () => { throw new Error('command-override-boom'); });",
          "    api.registerRenderer('json', (context) => JSON.stringify({ rendered_by: 'command-renderer-ext', payload: context.result }));",
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const listOpen = context.runCli(["list-open", "--json", "--limit", "1"], { expectJson: true });
      expect(listOpen.code).toBe(0);
      const openJson = listOpen.json as {
        rendered_by: string;
        payload: {
          items: unknown[];
          count: number;
          override_marker?: boolean;
        };
      };
      expect(openJson.rendered_by).toBe("command-renderer-ext");
      expect(openJson.payload.override_marker).toBe(true);

      const listAll = context.runCli(["list-all", "--json", "--limit", "1"], { expectJson: true });
      expect(listAll.code).toBe(0);
      const allJson = listAll.json as {
        rendered_by: string;
        payload: {
          items: unknown[];
          count: number;
          override_marker?: boolean;
        };
      };
      expect(allJson.rendered_by).toBe("command-renderer-ext");
      expect(Array.isArray(allJson.payload.items)).toBe(true);
      expect(typeof allJson.payload.count).toBe("number");
      expect(allJson.payload.override_marker).toBeUndefined();
    });
  });

  it("dispatches declared command paths through extension command handlers", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "beads-command-handler-ext");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "beads-command-handler-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["commands"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'beads import',",
          "      run: () => ({ ok: true, source: 'beads-command-handler-ext', imported: 0, skipped: 0, ids: [], warnings: [] })",
          "    });",
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const imported = context.runCli(["beads", "import", "--json", "--file", path.join(context.tempRoot, "missing.jsonl")], {
        expectJson: true,
      });
      expect(imported.code).toBe(0);
      const importedJson = imported.json as {
        ok: boolean;
        source: string;
        imported: number;
        skipped: number;
        ids: string[];
        warnings: string[];
      };
      expect(importedJson).toEqual({
        ok: true,
        source: "beads-command-handler-ext",
        imported: 0,
        skipped: 0,
        ids: [],
        warnings: [],
      });
    });
  });

  it("dispatches extension-defined non-core command paths through dynamically surfaced handlers", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "acme-sync-handler-ext");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "acme-sync-handler-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["commands"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'acme sync',",
          "      run: (context) => ({",
          "        ok: true,",
          "        source: 'acme-sync-handler-ext',",
          "        command: context.command,",
          "        args: context.args,",
          "        options: context.options,",
          "      })",
          "    });",
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const dispatched = context.runCli(
        ["acme", "sync", "--json", "--dry-run", "--limit", "2", "--tag", "alpha", "--tag", "beta", "artifact-A"],
        { expectJson: true },
      );
      expect(dispatched.code).toBe(0);

      const dispatchedJson = dispatched.json as {
        ok: boolean;
        source: string;
        command: string;
        args: string[];
        options: {
          dryRun: boolean;
          limit: string;
          tag: string[];
        };
      };

      expect(dispatchedJson.ok).toBe(true);
      expect(dispatchedJson.source).toBe("acme-sync-handler-ext");
      expect(dispatchedJson.command).toBe("acme sync");
      expect(dispatchedJson.args).toEqual(["--dry-run", "--limit", "2", "--tag", "alpha", "--tag", "beta", "artifact-A"]);
      expect(dispatchedJson.options).toEqual({
        dryRun: true,
        limit: "2",
        tag: ["alpha", "beta"],
      });
    });
  });

  it("surfaces registerFlags metadata in dynamic command help without changing loose option parsing", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "acme-sync-flag-help-ext");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "acme-sync-flag-help-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["commands", "schema"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerFlags(' acme   sync ', [",
          "      { long: '--dry-run', short: '-d', description: 'Run without side effects' },",
          "      { long: '--limit', value_name: 'count' },",
          "      { long: '--required-flag', required: true },",
          "      { long: '--disabled-flag', enabled: false },",
          "      { long: '--hidden-flag', visible: false, description: 'Hidden by policy' },",
          "      { long: 'invalid-long', description: 'Ignored invalid long flag' }",
          "    ]);",
          "    api.registerCommand({",
          "      name: 'acme sync',",
          "      run: (context) => ({",
          "        ok: true,",
          "        source: 'acme-sync-flag-help-ext',",
          "        args: context.args,",
          "        options: context.options,",
          "      })",
          "    });",
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const helpResult = context.runCli(["acme", "sync", "--help"]);
      expect(helpResult.code).toBe(0);
      expect(helpResult.stdout).toContain("Extension-provided flags:");
      expect(helpResult.stdout).toContain("-d, --dry-run  Run without side effects");
      expect(helpResult.stdout).toContain("--limit <count>  Extension-provided option.");
      expect(helpResult.stdout).toContain("--required-flag  Extension-provided option. [required]");
      expect(helpResult.stdout).toContain("--disabled-flag  Extension-provided option. [disabled]");
      expect(helpResult.stdout).not.toContain("--hidden-flag");
      expect(helpResult.stdout).not.toContain("Ignored invalid long flag");

      const dispatched = context.runCli(["acme", "sync", "--json", "--dry-run", "--limit", "2", "artifact-Z"], {
        expectJson: true,
      });
      expect(dispatched.code).toBe(0);
      const dispatchedJson = dispatched.json as {
        ok: boolean;
        source: string;
        args: string[];
        options: {
          dryRun: boolean;
          limit: string;
        };
      };
      expect(dispatchedJson.ok).toBe(true);
      expect(dispatchedJson.source).toBe("acme-sync-flag-help-ext");
      expect(dispatchedJson.args).toEqual(["--dry-run", "--limit", "2", "artifact-Z"]);
      expect(dispatchedJson.options).toEqual({
        dryRun: true,
        limit: "2",
      });
    });
  });

  it("applies parser and service overrides for dynamic extension commands", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "acme-parser-service-ext");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "acme-parser-service-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["commands", "parser", "services"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerParser('acme sync', (context) => ({",
          "      options: {",
          "        ...context.options,",
          "        limit: Number(context.options.limit),",
          "      },",
          "    }));",
          "    api.registerService('output_format', (context) => JSON.stringify({",
          "      service: 'acme-parser-service-ext',",
          "      payload: context.payload.result,",
          "    }));",
          "    api.registerCommand({",
          "      name: 'acme sync',",
          "      run: (context) => ({",
          "        ok: true,",
          "        command: context.command,",
          "        options: context.options,",
          "      }),",
          "    });",
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const dispatched = context.runCli(["acme", "sync", "--json", "--limit", "7"], { expectJson: true });
      expect(dispatched.code).toBe(0);
      const payload = dispatched.json as {
        service: string;
        payload: {
          ok: boolean;
          command: string;
          options: { limit: number };
        };
      };
      expect(payload.service).toBe("acme-parser-service-ext");
      expect(payload.payload.ok).toBe(true);
      expect(payload.payload.command).toBe("acme sync");
      expect(payload.payload.options.limit).toBe(7);
    });
  });

  it("applies history append service overrides during item mutations", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "history-service-ext");
      await mkdir(extensionDir, { recursive: true });
      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "history-service-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["services"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerService('history_append', (context) => ({",
          "      line: JSON.stringify({",
          "        override: true,",
          "        op: context.payload.entry.op,",
          "      }),",
          "    }));",
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const created = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "History service override",
          "--description",
          "Validate history append service hooks",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,services",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "20",
          "--acceptance-criteria",
          "History append override writes custom line",
          "--author",
          "integration-test",
          "--message",
          "Create history service test item",
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
      const createdId = (created.json as { item: { id: string } }).item.id;
      const historyRaw = await readFile(path.join(context.pmPath, "history", `${createdId}.jsonl`), "utf8");
      const parsed = JSON.parse(historyRaw.trim()) as { override: boolean; op: string };
      expect(parsed).toEqual({
        override: true,
        op: "create",
      });
    });
  });

  it("applies lock acquire/release service overrides during updates", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "lock-service-ext");
      const lockLogPath = path.join(context.tempRoot, "lock-service.log");
      await mkdir(extensionDir, { recursive: true });
      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "lock-service-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["services"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "import fs from 'node:fs';",
          "export default {",
          "  activate(api) {",
          "    api.registerService('lock_acquire', () => ({",
          String.raw`      release: () => { fs.appendFileSync(${JSON.stringify(lockLogPath)}, 'release-callback\n', 'utf8'); },`,
          "    }));",
          String.raw`    api.registerService('lock_release', () => { fs.appendFileSync(${JSON.stringify(lockLogPath)}, 'release-service\n', 'utf8'); });`,
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const created = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Lock service override seed item",
          "--description",
          "Create seed item for lock override update",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,services",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "20",
          "--acceptance-criteria",
          "Update runs through lock service override",
          "--author",
          "integration-test",
          "--message",
          "Create lock service seed item",
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
      const createdId = (created.json as { item: { id: string } }).item.id;

      const updated = context.runCli(
        [
          "update",
          createdId,
          "--json",
          "--status",
          "in_progress",
          "--author",
          "integration-test",
          "--message",
          "Update through lock service override",
        ],
        { expectJson: true },
      );
      expect(updated.code).toBe(0);

      const lockLog = await readFile(lockLogPath, "utf8");
      expect(lockLog).toContain("release-callback");
      expect(lockLog).toContain("release-service");
    });
  });

  it("returns generic failure when a matched extension command handler throws", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "beads-command-handler-fail-ext");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "beads-command-handler-fail-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["commands"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'beads import',",
          "      run: () => { throw new Error('handler-boom'); }",
          "    });",
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const imported = context.runCli(["beads", "import", "--json", "--file", path.join(context.tempRoot, "missing.jsonl")]);
      expect(imported.code).toBe(1);
      const importedEnvelope = parseJsonErrorEnvelope(imported.stderr);
      expect(importedEnvelope).toMatchObject({
        code: "command_failed",
        exit_code: 1,
      });
      expect(importedEnvelope.detail).toContain('Command "beads import" failed in extension handler');
      expect(importedEnvelope.detail).toContain(
        "extension_command_handler_failed:project:beads-command-handler-fail-ext:beads import",
      );
    });
  });

  it("hides beads command paths when extensions are disabled", async () => {
    await withTempPmPath(async (context) => {
      const install = context.runCli(["extension", "--install", "beads", "--project", "--json"], { expectJson: true });
      expect(install.code).toBe(0);
      const sourcePath = path.join(context.tempRoot, "beads-extension-only.jsonl");
      await writeFile(
        sourcePath,
        `${JSON.stringify({
          id: "beads-extension-only",
          title: "Beads Extension Only",
          issue_type: "task",
          status: "open",
          priority: 2,
        })}\n`,
        "utf8",
      );

      const disabled = context.runCli(["--no-extensions", "beads", "import", "--json", "--file", sourcePath]);
      expect(disabled.code).toBe(2);
      const disabledEnvelope = parseJsonErrorEnvelope(disabled.stderr);
      expect(disabledEnvelope).toMatchObject({
        code: "unknown_command",
        exit_code: 2,
      });
    });
  });

  it("hides todos command paths when extensions are disabled", async () => {
    await withTempPmPath(async (context) => {
      const install = context.runCli(["extension", "--install", "todos", "--project", "--json"], { expectJson: true });
      expect(install.code).toBe(0);
      const todosFolder = path.join(context.tempRoot, "todos-extension-only");
      await mkdir(todosFolder, { recursive: true });

      const importDisabled = context.runCli(["--no-extensions", "todos", "import", "--json", "--folder", todosFolder]);
      expect(importDisabled.code).toBe(2);
      const importDisabledEnvelope = parseJsonErrorEnvelope(importDisabled.stderr);
      expect(importDisabledEnvelope).toMatchObject({
        code: "unknown_command",
        exit_code: 2,
      });

      const exportDisabled = context.runCli(["--no-extensions", "todos", "export", "--json", "--folder", todosFolder]);
      expect(exportDisabled.code).toBe(2);
      const exportDisabledEnvelope = parseJsonErrorEnvelope(exportDisabled.stderr);
      expect(exportDisabledEnvelope).toMatchObject({
        code: "unknown_command",
        exit_code: 2,
      });
    });
  });

  it("imports and exports todos markdown through bundled extension commands", async () => {
    await withTempPmPath(async (context) => {
      const install = context.runCli(["extension", "--install", "todos", "--project", "--json"], { expectJson: true });
      expect(install.code).toBe(0);

      const sourceFolder = path.join(context.tempRoot, "todos-cli-source");
      await mkdir(sourceFolder, { recursive: true });

      await writeFile(
        path.join(sourceFolder, "todo-cli-one.md"),
        `${JSON.stringify(
          {
            id: "todo-cli-one",
            title: "Todos CLI One",
            status: "open",
            tags: ["todos", "cli"],
            created_at: "2026-02-02T00:00:00.000Z",
          },
          null,
          2,
        )}\n\nTodos CLI body.\n`,
        "utf8",
      );
      await writeFile(
        path.join(sourceFolder, "todo-cli-missing-title.md"),
        `${JSON.stringify({ id: "todo-cli-missing-title", status: "open", tags: ["todos"] }, null, 2)}\n\nskip\n`,
        "utf8",
      );

      const imported = context.runCli(
        [
          "todos",
          "import",
          "--json",
          "--folder",
          sourceFolder,
          "--author",
          "integration-test",
          "--message",
          "Integration todos import",
        ],
        { expectJson: true },
      );
      expect(imported.code).toBe(0);
      const importedJson = imported.json as {
        ok: boolean;
        folder: string;
        imported: number;
        skipped: number;
        ids: string[];
        warnings: string[];
      };
      expect(importedJson.ok).toBe(true);
      expect(importedJson.folder).toBe(sourceFolder);
      expect(importedJson.imported).toBe(1);
      expect(importedJson.skipped).toBe(1);
      expect(importedJson.ids).toEqual(["pm-todo-cli-one"]);
      expect(importedJson.warnings).toContain("todos_import_missing_title:todo-cli-missing-title.md");

      const importedItem = context.runCli(["get", "pm-todo-cli-one", "--json"], { expectJson: true });
      expect(importedItem.code).toBe(0);
      const importedItemJson = importedItem.json as {
        item: { type: string; status: string; priority: number; description: string };
        body: string;
      };
      expect(importedItemJson.item.type).toBe("Task");
      expect(importedItemJson.item.status).toBe("open");
      expect(importedItemJson.item.priority).toBe(2);
      expect(importedItemJson.item.description).toBe("");
      expect(importedItemJson.body).toBe("Todos CLI body.");

      const destinationFolder = path.join(context.tempRoot, "todos-cli-export");
      const exported = context.runCli(["todos", "export", "--json", "--folder", destinationFolder], { expectJson: true });
      expect(exported.code).toBe(0);
      const exportedJson = exported.json as {
        ok: boolean;
        folder: string;
        exported: number;
        ids: string[];
        warnings: string[];
      };
      expect(exportedJson.ok).toBe(true);
      expect(exportedJson.folder).toBe(destinationFolder);
      expect(exportedJson.exported).toBeGreaterThanOrEqual(1);
      expect(exportedJson.ids).toContain("pm-todo-cli-one");
      expect(exportedJson.warnings).toEqual([]);

      const exportedRaw = await readFile(path.join(destinationFolder, "pm-todo-cli-one.md"), "utf8");
      const exportedDoc = splitFrontMatter(exportedRaw);
      const exportedFrontMatter = JSON.parse(exportedDoc.frontMatter) as Record<string, unknown>;
      expect(exportedFrontMatter).toMatchObject({
        id: "pm-todo-cli-one",
        title: "Todos CLI One",
        status: "open",
      });
      expect(exportedFrontMatter.tags).toEqual(["cli", "todos"]);
      expect(typeof exportedFrontMatter.created_at).toBe("string");
      expect(exportedDoc.body.trim()).toBe("Todos CLI body.");
    });
  });

  it("preserves hierarchical IDs through the todos import CLI command", async () => {
    await withTempPmPath(async (context) => {
      const install = context.runCli(["extension", "--install", "todos", "--project", "--json"], { expectJson: true });
      expect(install.code).toBe(0);

      const sourceFolder = path.join(context.tempRoot, "todos-cli-hierarchical-source");
      await mkdir(sourceFolder, { recursive: true });

      await writeFile(
        path.join(sourceFolder, "pm-legacy.1.2.md"),
        `${JSON.stringify(
          {
            id: "pm-legacy.1.2",
            title: "Hierarchical CLI Todo",
            status: "open",
            tags: ["todos", "hierarchical"],
          },
          null,
          2,
        )}\n\nHierarchical CLI body.\n`,
        "utf8",
      );

      const imported = context.runCli(["todos", "import", "--json", "--folder", sourceFolder], { expectJson: true });
      expect(imported.code).toBe(0);
      const importedJson = imported.json as { imported: number; skipped: number; ids: string[] };
      expect(importedJson.imported).toBe(1);
      expect(importedJson.skipped).toBe(0);
      expect(importedJson.ids).toEqual(["pm-legacy.1.2"]);

      const item = context.runCli(["get", "pm-legacy.1.2", "--json"], { expectJson: true });
      expect(item.code).toBe(0);
      const itemJson = item.json as { item: { id: string }; body: string };
      expect(itemJson.item.id).toBe("pm-legacy.1.2");
      expect(itemJson.body).toBe("Hierarchical CLI body.");
    });
  });

  it("enforces ownership conflicts across assignees", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Ownership Conflict Item",
          "--description",
          "Conflict flow",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,conflict",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "20",
          "--acceptance-criteria",
          "Conflict is enforced",
          "--author",
          "integration-test",
          "--message",
          "Create conflict item",
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
      expect(createResult.code).toBe(0);
      const id = (createResult.json as { item: { id: string } }).item.id;

      const claim = context.runCli(["claim", id, "--json"], { expectJson: true });
      expect(claim.code).toBe(0);

      const otherAssignee = spawnSync(
        process.execPath,
        [distCliPath(), "update", id, "--json", "--status", "blocked", "--author", "other", "--message", "Try update"],
        {
          cwd: process.cwd(),
          env: context.env,
          encoding: "utf8",
        },
      );
      expect(otherAssignee.status).toBe(4);
      expect(otherAssignee.stderr).toContain("assigned to");
    });
  });

  it("allows claim takeover of non-terminal assigned items without force", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Claim takeover seed item",
          "--description",
          "Verify non-terminal claim takeover semantics",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,claim,takeover",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "20",
          "--acceptance-criteria",
          "Claim takeover succeeds without force",
          "--author",
          "integration-test",
          "--message",
          "Create claim takeover seed",
          "--assignee",
          "owner-a",
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
      expect(createResult.code).toBe(0);
      const id = (createResult.json as { item: { id: string } }).item.id;

      const takeover = context.runCli(["claim", id, "--json", "--author", "owner-b"], { expectJson: true });
      expect(takeover.code).toBe(0);
      const takeoverJson = takeover.json as {
        item: { assignee?: string; status: string };
        previous_assignee: string | null;
        forced: boolean;
      };
      expect(takeoverJson.item.status).toBe("open");
      expect(takeoverJson.item.assignee).toBe("owner-b");
      expect(takeoverJson.previous_assignee).toBe("owner-a");
      expect(takeoverJson.forced).toBe(false);
    });
  });

  it("imports Beads JSONL records through the beads import CLI command", async () => {
    await withTempPmPath(async (context) => {
      const install = context.runCli(["extension", "--install", "beads", "--project", "--json"], { expectJson: true });
      expect(install.code).toBe(0);

      const sourcePath = path.join(context.tempRoot, "beads-integration.jsonl");
      const lines = [
        JSON.stringify({
          id: "beads-integration-1",
          title: "Beads Integration One",
          issue_type: "task",
          status: "open",
          priority: 1,
          tags: ["beads", "integration"],
          description: "Imported from integration fixture",
          body: "integration-body-1",
          comments: [{ text: "seed-comment", author: "integration-test", created_at: "2026-02-01T00:00:00.000Z" }],
        }),
        JSON.stringify({
          id: "beads-integration-2",
          title: "Beads Integration Two",
          issue_type: "feature",
          status: "blocked",
          priority: 0,
          tags: "beads,imported",
          body: "integration-body-2",
        }),
      ];
      await writeFile(sourcePath, `${lines.join("\n")}\n`, "utf8");

      const imported = context.runCli(
        ["beads", "import", "--json", "--file", sourcePath, "--author", "integration-test", "--message", "Integration beads import"],
        { expectJson: true },
      );
      expect(imported.code).toBe(0);
      const importedJson = imported.json as {
        ok: boolean;
        source: string;
        imported: number;
        skipped: number;
        ids: string[];
        warnings: string[];
      };
      expect(importedJson.ok).toBe(true);
      expect(importedJson.source).toBe(sourcePath);
      expect(importedJson.imported).toBe(2);
      expect(importedJson.skipped).toBe(0);
      expect(importedJson.ids).toEqual(["pm-beads-integration-1", "pm-beads-integration-2"]);
      expect(importedJson.warnings).toEqual([]);

      const first = context.runCli(["get", "pm-beads-integration-1", "--json"], { expectJson: true });
      expect(first.code).toBe(0);
      const firstJson = first.json as { item: { type: string; status: string }; body: string };
      expect(firstJson.item.type).toBe("Task");
      expect(firstJson.item.status).toBe("open");
      expect(firstJson.body).toBe("integration-body-1");

      const second = context.runCli(["get", "pm-beads-integration-2", "--json"], { expectJson: true });
      expect(second.code).toBe(0);
      const secondJson = second.json as { item: { type: string; status: string; priority: number } };
      expect(secondJson.item.type).toBe("Feature");
      expect(secondJson.item.status).toBe("blocked");
      expect(secondJson.item.priority).toBe(0);

      const history = context.runCli(["history", "pm-beads-integration-1", "--json"], { expectJson: true });
      expect(history.code).toBe(0);
      const historyJson = history.json as { history: Array<{ op: string }> };
      expect(historyJson.history.some((entry) => entry.op === "import")).toBe(true);
    });
  });

  it("returns dependency-failed exit code when any linked test fails", async () => {
    await withTempPmPath(async (context) => {
      const createFailing = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Failing test-all item",
          "--description",
          "Used to validate dependency-failed exit code",
          "--type",
          "Task",
          "--status",
          "in_progress",
          "--priority",
          "1",
          "--tags",
          "integration,test-all",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "10",
          "--acceptance-criteria",
          "test-all exits with dependency failed when this test fails",
          "--author",
          "integration-test",
          "--message",
          "Create failing item for test-all",
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
          "command=node --this-flag-does-not-exist,scope=project,timeout=30",
          "--doc",
          "none",
        ],
        { expectJson: true },
      );
      expect(createFailing.code).toBe(0);
      const createFailingJson = createFailing.json as { item: { tests?: Array<{ timeout_seconds?: number }> } };
      expect(createFailingJson.item.tests?.[0]?.timeout_seconds).toBe(30);

      const createPassing = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Passing test-all item",
          "--description",
          "Companion item to ensure mixed pass/fail aggregation",
          "--type",
          "Task",
          "--status",
          "in_progress",
          "--priority",
          "1",
          "--tags",
          "integration,test-all",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "10",
          "--acceptance-criteria",
          "One linked test passes",
          "--author",
          "integration-test",
          "--message",
          "Create passing item for test-all",
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
          "command=node --version,scope=project",
          "--doc",
          "none",
        ],
        { expectJson: true },
      );
      expect(createPassing.code).toBe(0);

      const testAll = context.runCli(["test-all", "--json", "--status", "in-progress", "--timeout", "30"], {
        expectJson: true,
      });
      expect(testAll.code).toBe(5);

      const testAllJson = testAll.json as {
        failed: number;
        totals: { items: number; linked_tests: number; failed: number };
        results: Array<{ failed: number; run_results: Array<{ status: string }> }>;
      };

      expect(testAllJson.totals.items).toBe(2);
      expect(testAllJson.totals.linked_tests).toBe(2);
      expect(testAllJson.failed).toBeGreaterThanOrEqual(1);
      expect(testAllJson.totals.failed).toBeGreaterThanOrEqual(1);
      expect(testAllJson.results.some((entry) => entry.failed > 0)).toBe(true);
      expect(testAllJson.results.some((entry) => entry.run_results.some((result) => result.status === "failed"))).toBe(true);
    });
  });

  it("returns generic-failure exit code for unexpected init filesystem errors", async () => {
    await withTempPmPath(async (context) => {
      const blockedRoot = path.join(context.tempRoot, "blocked-pm-root");
      await writeFile(blockedRoot, "not-a-directory", "utf8");

      const init = context.runCli(["init", "--path", blockedRoot, "--json"]);
      expect(init.code).toBe(1);
      expect(init.stderr.trim().length).toBeGreaterThan(0);
    });
  });

  it("rejects linked test entries that invoke test-all recursively", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Reject Recursive test-all Link",
          "--description",
          "Ensure test command blocks recursive test-all links",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,test-all",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "10",
          "--acceptance-criteria",
          "test command rejects recursive test-all links",
          "--author",
          "integration-test",
          "--message",
          "Create item for recursion guard",
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
      expect(create.code).toBe(0);
      const id = (create.json as { item: { id: string } }).item.id;

      const addRecursiveLink = context.runCli(
        ["test", id, "--json", "--add", "command=node dist/cli.js test-all --json,scope=project"],
        { expectJson: true },
      );
      expect(addRecursiveLink.code).toBe(2);
      expect(addRecursiveLink.stderr).toContain("must not invoke");
    });
  });

it("enforces strict missing-stream policy across history-touching CLI commands", async () => {
  await withTempPmPath(async (context) => {
    const create = context.runCli(
      [
        "create",
        "--json",
        "--title",
        "Strict policy CLI fixture",
        "--description",
        "Exercise strict missing-stream behavior",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--tags",
        "integration,history,strict",
        "--body",
        "strict-body",
        "--deadline",
        "none",
        "--estimate",
        "10",
        "--acceptance-criteria",
        "Strict mode fails when stream is missing",
        "--author",
        "integration-test",
        "--message",
        "Create strict-mode fixture",
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
    expect(create.code).toBe(0);
    const id = (create.json as { item: { id: string } }).item.id;
    const strictSet = context.runCli(
      ["config", "project", "set", "history-missing-stream-policy", "--policy", "strict_error", "--json"],
      { expectJson: true },
    );
    expect(strictSet.code).toBe(0);
    await rm(path.join(context.pmPath, "history", `${id}.jsonl`), { force: true });

    expect(context.runCli(["history", id, "--json"]).code).toBe(3);
    expect(context.runCli(["activity", "--json"]).code).toBe(3);
    expect(context.runCli(["stats", "--json"]).code).toBe(3);
    expect(context.runCli(["health", "--json"]).code).toBe(3);
    expect(
      context.runCli(["update", id, "--json", "--status", "in_progress", "--author", "integration-test", "--message", "strict update"])
        .code,
    ).toBe(3);
    expect(context.runCli(["restore", id, "1", "--json", "--author", "integration-test"]).code).toBe(3);
  });
}, 120_000);

it("restores a deleted item from history-only state through CLI", async () => {
  await withTempPmPath(async (context) => {
    const create = context.runCli(
      [
        "create",
        "--json",
        "--title",
        "Deleted restore CLI Item",
        "--description",
        "Verify restore recovery when item file is missing",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--tags",
        "integration,restore,history-only",
        "--body",
        "seed-body",
        "--deadline",
        "none",
        "--estimate",
        "10",
        "--acceptance-criteria",
        "Restore recreates deleted item from history",
        "--author",
        "integration-test",
        "--message",
        "Create deleted restore fixture",
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
    expect(create.code).toBe(0);
    const id = (create.json as { item: { id: string } }).item.id;

    const update = context.runCli(
      [
        "update",
        id,
        "--json",
        "--status",
        "in_progress",
        "--description",
        "updated-before-delete",
        "--author",
        "integration-test",
        "--message",
        "Update before delete",
      ],
      { expectJson: true },
    );
    expect(update.code).toBe(0);

    const deleted = context.runCli(
      ["delete", id, "--json", "--author", "integration-test", "--message", "Delete before history-only restore"],
      { expectJson: true },
    );
    expect(deleted.code).toBe(0);

    const restore = context.runCli(
      ["restore", id, "2", "--json", "--author", "integration-test", "--message", "Restore from history-only state"],
      { expectJson: true },
    );
    expect(restore.code).toBe(0);
    const restoreJson = restore.json as {
      item: { status: string };
      restored_from: { kind: string; history_index: number };
    };
    expect(restoreJson.item.status).toBe("in_progress");
    expect(restoreJson.restored_from.kind).toBe("version");
    expect(restoreJson.restored_from.history_index).toBe(2);

    const get = context.runCli(["get", id, "--json"], { expectJson: true });
    expect(get.code).toBe(0);
    const getJson = get.json as { item: { status: string }; body: string };
    expect(getJson.item.status).toBe("in_progress");
    expect(getJson.body).toBe("seed-body");
  });
}, 120_000);

it("supports files/docs add-glob mutations through CLI", async () => {
  await withTempPmPath(async (context) => {
    const create = context.runCli(
      [
        "create",
        "--json",
        "--title",
        "Glob linking fixture",
        "--description",
        "Verify files/docs add-glob integration behavior",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--tags",
        "integration,files,docs,glob",
        "--body",
        "",
        "--deadline",
        "none",
        "--estimate",
        "10",
        "--acceptance-criteria",
        "files/docs add-glob works with deterministic dedup.",
        "--author",
        "integration-test",
        "--message",
        "Create add-glob fixture item",
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
    expect(create.code).toBe(0);
    const id = (create.json as { item: { id: string } }).item.id;

    const fixtureRoot = path.join(context.tempRoot, "glob-workspace");
    await mkdir(path.join(fixtureRoot, "src", "routes"), { recursive: true });
    await mkdir(path.join(fixtureRoot, "docs", "guides"), { recursive: true });
    await writeFile(path.join(fixtureRoot, "src", "routes", "alpha.ts"), "export const alpha = 1;\n", "utf8");
    await writeFile(path.join(fixtureRoot, "src", "routes", "beta.ts"), "export const beta = 2;\n", "utf8");
    await writeFile(path.join(fixtureRoot, "src", "routes", "ignore.md"), "# ignore\n", "utf8");
    await writeFile(path.join(fixtureRoot, "docs", "guides", "alpha.md"), "# alpha\n", "utf8");
    await writeFile(path.join(fixtureRoot, "docs", "guides", "beta.md"), "# beta\n", "utf8");
    await writeFile(path.join(fixtureRoot, "docs", "guides", "ignore.txt"), "ignore\n", "utf8");

    const filesResult = context.runCli(
      ["files", id, "--add-glob", "src/**/*.ts", "--add-glob", "src/routes/*.ts", "--json"],
      { expectJson: true, cwd: fixtureRoot },
    );
    expect(filesResult.code).toBe(0);
    const filesJson = filesResult.json as { files: Array<{ path: string; scope: string }>; count: number };
    expect(filesJson.count).toBe(2);
    expect(filesJson.files.map((entry) => entry.path)).toEqual(["src/routes/alpha.ts", "src/routes/beta.ts"]);
    expect(filesJson.files.every((entry) => entry.scope === "project")).toBe(true);

    const docsResult = context.runCli(
      ["docs", id, "--add-glob", "pattern=docs/**/*.md,scope=global,note=from glob", "--json"],
      { expectJson: true, cwd: fixtureRoot },
    );
    expect(docsResult.code).toBe(0);
    const docsJson = docsResult.json as { docs: Array<{ path: string; scope: string; note?: string }>; count: number };
    expect(docsJson.count).toBe(2);
    expect(docsJson.docs.map((entry) => entry.path)).toEqual(["docs/guides/alpha.md", "docs/guides/beta.md"]);
    expect(docsJson.docs.every((entry) => entry.scope === "global")).toBe(true);
    expect(docsJson.docs.every((entry) => entry.note === "from glob")).toBe(true);
  });
}, 120_000);

it("supports deps command tree and graph formats through CLI", async () => {
  await withTempPmPath(async (context) => {
    const leaf = context.runCli(
      [
        "create",
        "--json",
        "--title",
        "Deps leaf item",
        "--description",
        "Leaf for deps integration",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--tags",
        "integration,deps",
        "--body",
        "",
        "--deadline",
        "none",
        "--estimate",
        "10",
        "--acceptance-criteria",
        "Leaf exists for dependency traversal.",
        "--author",
        "integration-test",
        "--message",
        "Create deps leaf",
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
    expect(leaf.code).toBe(0);
    const leafId = (leaf.json as { item: { id: string } }).item.id;

    const root = context.runCli(
      [
        "create",
        "--json",
        "--title",
        "Deps root item",
        "--description",
        "Root for deps integration",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--tags",
        "integration,deps",
        "--body",
        "",
        "--deadline",
        "none",
        "--estimate",
        "10",
        "--acceptance-criteria",
        "Root dependency tree renders deterministically.",
        "--author",
        "integration-test",
        "--message",
        "Create deps root",
        "--assignee",
        "none",
        "--dep",
        `id=${leafId},kind=blocks,author=integration-test,created_at=now`,
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
    expect(root.code).toBe(0);
    const rootId = (root.json as { item: { id: string } }).item.id;

    const treeResult = context.runCli(["deps", rootId, "--json"], { expectJson: true });
    expect(treeResult.code).toBe(0);
    const treeJson = treeResult.json as {
      id: string;
      format: string;
      tree?: { id: string; dependencies: Array<{ id: string; via?: string }> };
      edge_count: number;
    };
    expect(treeJson.id).toBe(rootId);
    expect(treeJson.format).toBe("tree");
    expect(treeJson.edge_count).toBe(1);
    expect(treeJson.tree?.dependencies).toEqual([expect.objectContaining({ id: leafId, via: "blocks" })]);

    const graphResult = context.runCli(["deps", rootId, "--format", "graph", "--json"], { expectJson: true });
    expect(graphResult.code).toBe(0);
    const graphJson = graphResult.json as {
      format: string;
      graph?: { nodes: Array<{ id: string }>; edges: Array<{ from: string; to: string; kind: string }> };
    };
    expect(graphJson.format).toBe("graph");
    expect(graphJson.graph?.nodes.map((node) => node.id)).toEqual([leafId, rootId].sort((left, right) => left.localeCompare(right)));
    expect(graphJson.graph?.edges).toEqual([{ from: rootId, to: leafId, kind: "blocks" }]);

    const invalid = context.runCli(["deps", rootId, "--format", "diagram"]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("Invalid --format value");
  });
}, 120_000);

it("restores an item by version through CLI", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Restore CLI Item",
          "--description",
          "Verify restore command",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,restore",
          "--body",
          "body-v1",
          "--deadline",
          "none",
          "--estimate",
          "10",
          "--acceptance-criteria",
          "Restore command works",
          "--author",
          "integration-test",
          "--message",
          "Create restore fixture",
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
      expect(create.code).toBe(0);
      const id = (create.json as { item: { id: string } }).item.id;

      const update = context.runCli(
        [
          "update",
          id,
          "--json",
          "--status",
          "in_progress",
          "--description",
          "changed",
          "--author",
          "integration-test",
          "--message",
          "Mutate before restore",
        ],
        { expectJson: true },
      );
      expect(update.code).toBe(0);

      const append = context.runCli(
        ["append", id, "--json", "--body", "body-v2", "--author", "integration-test", "--message", "Append before restore"],
        { expectJson: true },
      );
      expect(append.code).toBe(0);

      const restore = context.runCli(
        ["restore", id, "1", "--json", "--author", "integration-test", "--message", "Restore to v1"],
        { expectJson: true },
      );
      expect(restore.code).toBe(0);
      const restoreJson = restore.json as {
        item: { status: string };
        restored_from: { kind: string; history_index: number };
      };
      expect(restoreJson.item.status).toBe("open");
      expect(restoreJson.restored_from.kind).toBe("version");
      expect(restoreJson.restored_from.history_index).toBe(1);

      const get = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(get.code).toBe(0);
      const getJson = get.json as { item: { status: string }; body: string };
      expect(getJson.item.status).toBe("open");
      expect(getJson.body).toBe("body-v1");

      const history = context.runCli(["history", id, "--json"], { expectJson: true });
      expect(history.code).toBe(0);
      const historyJson = history.json as { history: Array<{ op: string }> };
      expect(historyJson.history.at(-1)?.op).toBe("restore");
    });
  }, 120_000);
});
