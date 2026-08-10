import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveLinkedTestRunSelection } from "../../src/core/test/run-selectors.js";
import { writeItemTypeDefinitions } from "../helpers/pmWorkspace.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("SDK-first agent command contracts", () => {
  it("accepts one --id spelling across entity reads, annotations, and linked tests", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--create-mode",
          "progressive",
          "--type",
          "Task",
          "--title",
          "shared item address",
          "--json",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;

      const get = context.runCli(["get", "--id", id, "--json"], {
        expectJson: true,
      });
      expect(get.code).toBe(0);
      expect((get.json as { item: { id: string } }).item.id).toBe(id);

      const show = context.runCli(["show", "--id", id, "--json"], {
        expectJson: true,
      });
      expect(show.code).toBe(0);
      expect((show.json as { item: { id: string } }).item.id).toBe(id);

      const comment = context.runCli(
        ["comments", "--id", id, "--add", "addressed uniformly", "--json"],
        { expectJson: true },
      );
      expect(comment.code).toBe(0);

      const linkedTest = context.runCli(
        ["test", "--id", id, "--add", "command=echo ADDRESS", "--json"],
        { expectJson: true },
      );
      expect(linkedTest.code).toBe(0);

      const itemCommands: Array<[string, string[]]> = [
        ["files", ["--add", "path=src/example.ts"]],
        ["docs", ["--add", "path=docs/example.md"]],
        ["notes", ["--add", "address note"]],
        ["learnings", ["--add", "address learning"]],
        ["deps", []],
        ["history", []],
        ["claim", []],
        ["release", []],
      ];
      for (const [command, args] of itemCommands) {
        const result = context.runCli([command, "--id", id, ...args, "--json"]);
        expect(result.code, `${command}: ${result.stderr}`).toBe(0);
      }

      for (const [command, args] of [
        ["update", ["--title", "updated through --id"]],
        ["append", ["--body", "appended through --id"]],
        ["copy", ["--title", "copied through --id"]],
        ["files", ["discover"]],
      ] satisfies Array<[string, string[]]>) {
        const commandPath =
          command === "files"
            ? [command, ...args, "--id", id]
            : [command, "--id", id, ...args];
        const result = context.runCli([...commandPath, "--json"]);
        expect(result.code, `${commandPath.join(" ")}: ${result.stderr}`).toBe(
          0,
        );
      }

      const lifecycle = context.runCli(
        [
          "create",
          "--create-mode",
          "progressive",
          "--type",
          "Task",
          "--title",
          "shared lifecycle address",
          "--json",
        ],
        { expectJson: true },
      );
      const lifecycleId = (lifecycle.json as { item: { id: string } }).item.id;
      for (const [command, args] of [
        ["start-task", []],
        ["pause-task", []],
        ["close", ["closed through --id", "--validate-close", "off"]],
      ] satisfies Array<[string, string[]]>) {
        const result = context.runCli([
          command,
          "--id",
          lifecycleId,
          ...args,
          "--json",
        ]);
        expect(result.code, `${command}: ${result.stderr}`).toBe(0);
      }

      const dryDelete = context.runCli([
        "delete",
        "--id",
        id,
        "--dry-run",
        "--json",
      ]);
      expect(dryDelete.code, dryDelete.stderr).toBe(0);

      const contracts = context.runCli(
        ["contracts", "--command", "get", "--flags-only", "--json"],
        { expectJson: true },
      );
      expect(contracts.code).toBe(0);
      expect(JSON.stringify(contracts.json)).toContain('"--id"');

      for (const command of [
        "append",
        "claim",
        "close",
        "close-task",
        "comments",
        "copy",
        "delete",
        "deps",
        "docs",
        "files",
        "focus",
        "get",
        "history",
        "history-compact",
        "history-redact",
        "history-repair",
        "item complete",
        "learnings",
        "notes",
        "pause-task",
        "release",
        "restore",
        "start-task",
        "test",
        "update",
      ]) {
        const commandContracts = context.runCli(
          ["contracts", "--command", command, "--flags-only", "--json"],
          { expectJson: true },
        );
        expect(
          JSON.stringify(commandContracts.json),
          `${command} contracts`,
        ).toContain('"--id"');
      }

      const conflict = context.runCli(["get", id, "--id", id, "--json"]);
      expect(conflict.code).toBe(2);
      expect(conflict.stderr).toContain(
        "Provide the item id either positionally or with --id, not both",
      );
    });
  });

  it("preserves linked-test append order so --only-last means newest", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--create-mode",
          "progressive",
          "--type",
          "Task",
          "--title",
          "append-stable linked tests",
          "--json",
        ],
        { expectJson: true },
      );
      const id = (created.json as { item: { id: string } }).item.id;
      for (const command of [
        "echo ONE",
        "echo TWO",
        "echo THREE",
        "echo NEWEST",
      ]) {
        const added = context.runCli([
          "test",
          id,
          "--add",
          `command=${command}`,
          "--json",
        ]);
        expect(added.code).toBe(0);
      }

      const listed = context.runCli(["test", id, "--list", "--json"], {
        expectJson: true,
      });
      expect(
        (listed.json as { tests: Array<{ command?: string }> }).tests.map(
          (entry) => entry.command,
        ),
      ).toEqual(["echo ONE", "echo TWO", "echo THREE", "echo NEWEST"]);

      const persistedTests = (
        listed.json as { tests: Array<{ command?: string }> }
      ).tests;
      const selected = resolveLinkedTestRunSelection(persistedTests, {
        onlyLast: true,
      });
      expect(selected.selector).toBe("only-last");
      expect(selected.selected_indexes).toEqual([4]);
      expect(selected.selected.map((entry) => entry.command)).toEqual([
        "echo NEWEST",
      ]);
    });
  });

  it("lets strict policy require explicit relationship consideration without a false edge", async () => {
    await withTempPmPath(async (context) => {
      await writeItemTypeDefinitions(context.pmPath, [
        {
          name: "ContextualIssue",
          folder: "contextual-issues",
          required_create_fields: [],
          required_create_repeatables: ["dep"],
        },
      ]);

      const defaultHelp = context.runCli([
        "create",
        "--help",
        "--type",
        "ContextualIssue",
      ]);
      expect(defaultHelp.code).toBe(0);
      expect(defaultHelp.stdout).toContain("required: --title, --type");
      expect(defaultHelp.stdout).toContain("required in strict mode: --dep");
      expect(defaultHelp.stdout).toContain(
        "explicit empty assertion: --clear-deps",
      );

      const operandHelp = context.runCli([
        "create",
        "--type",
        "ContextualIssue",
        "--help",
        "--",
        "--create-mode",
        "strict",
      ]);
      expect(operandHelp.code).toBe(0);
      expect(operandHelp.stdout).toContain("required: --title, --type");
      expect(operandHelp.stdout).not.toContain(
        "required: --title, --type, --dep",
      );

      const strictCreated = context.runCli(
        [
          "create",
          "--create-mode",
          "strict",
          "--type",
          "ContextualIssue",
          "--title",
          "truthful graph root",
          "--clear-deps",
          "--json",
        ],
        { expectJson: true },
      );
      expect(strictCreated.code).toBe(0);
      expect(
        (strictCreated.json as { item: { dependencies?: unknown[] } }).item
          .dependencies,
      ).toEqual([]);
    });
  });

  it("reports required runtime field names and formats in every create mode", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        schema?: { fields?: Array<Record<string, unknown>> };
      };
      settings.schema = {
        ...settings.schema,
        fields: [
          {
            key: "storyPoints",
            metadata_key: "story_points",
            type: "number",
            cli_flag: "story-points",
            commands: ["create"],
            required_on_create: true,
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

      for (const createMode of ["progressive", "strict"] as const) {
        const result = context.runCli([
          "create",
          "--create-mode",
          createMode,
          "--type",
          "Task",
          "--title",
          `missing custom ${createMode}`,
          "--json",
        ]);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("--story-points");
        expect(result.stderr).toContain("story_points (number)");
        expect(result.stderr).toContain("--story-points <number>");
      }
    });
  });

  it("ranks semantic agent verbs ahead of substring accidents", async () => {
    await withTempPmPath(async (context) => {
      const result = context.runCli(["log", "pm-example"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Did you mean: history, comments, notes");
      expect(result.stderr).not.toContain("Did you mean: extension catalog");
    });
  });
});
