import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function typesPath(context: TempPmContext): string {
  return path.join(context.pmPath, "schema", "types.json");
}

async function readTypes(context: TempPmContext): Promise<{ definitions: Array<Record<string, unknown>> }> {
  return JSON.parse(await readFile(typesPath(context), "utf8"));
}

describe("schema add-type command", () => {
  it("lists built-in and custom types in compact groups", async () => {
    await withTempPmPath(async (context) => {
      const add = context.runCli(["schema", "add-type", "Spike", "--alias", "spike"]);
      expect(add.code).toBe(0);

      const listed = context.runCli(["schema", "list", "--json"], { expectJson: true });
      expect(listed.code).toBe(0);
      const result = listed.json as {
        action: string;
        builtin: Array<{ name: string }>;
        custom: Array<{ name: string; aliases: string[] }>;
        counts: { builtin: number; custom: number; total: number };
      };
      expect(result.action).toBe("list");
      expect(result.builtin.map((entry) => entry.name)).toContain("Task");
      expect(result.custom).toContainEqual(expect.objectContaining({ name: "Spike", aliases: ["spike"] }));
      expect(result.counts.custom).toBe(1);
      expect(result.counts.total).toBe(result.counts.builtin + result.counts.custom);
    });
  });

  it("shows a built-in or custom type definition by name or alias", async () => {
    await withTempPmPath(async (context) => {
      const add = context.runCli(["schema", "add-type", "Spike", "--alias", "spike", "--folder", "spikes"]);
      expect(add.code).toBe(0);

      const builtin = context.runCli(["schema", "show", "Task", "--json"], { expectJson: true });
      expect(builtin.code).toBe(0);
      expect(builtin.json).toMatchObject({
        action: "show",
        type: {
          name: "Task",
          source: "builtin",
          folder: "tasks",
        },
      });

      const custom = context.runCli(["schema", "show", "spike", "--json"], { expectJson: true });
      expect(custom.code).toBe(0);
      expect(custom.json).toMatchObject({
        action: "show",
        type: {
          name: "Spike",
          source: "custom",
          folder: "spikes",
          aliases: ["spike"],
        },
      });
    });
  });

  it("renders human list and show output without dumping full definitions", async () => {
    await withTempPmPath(async (context) => {
      const listed = context.runCli(["schema", "list"]);
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain("Schema types:");
      expect(listed.stdout).toContain("builtin:");
      expect(listed.stdout).toContain("Inspect one: pm schema show <Type>");

      const shown = context.runCli(["schema", "show", "Task"]);
      expect(shown.code).toBe(0);
      expect(shown.stdout).toContain("type: Task");
      expect(shown.stdout).toContain("source: builtin");
      expect(shown.stdout).toContain("folder: tasks");
    });
  });

  it("registers a custom type so pm create succeeds, after a discoverable failure", async () => {
    await withTempPmPath(async (context) => {
      // Before registration, create with an unknown type fails AND points at schema add-type.
      const before = context.runCli(["create", "FooType", "x"]);
      expect(before.code).not.toBe(0);
      expect(before.stderr).toContain('Invalid type value "FooType"');
      expect(before.stderr).toContain('pm schema add-type "FooType"');
      expect(before.stderr).toContain(".agents/pm/schema/types.json");

      // Register the type.
      const add = context.runCli(
        ["schema", "add-type", "FooType", "--description", "demo", "--default-status", "open", "--json"],
        { expectJson: true },
      );
      expect(add.code).toBe(0);
      const addResult = add.json as {
        action: string;
        registered: boolean;
        replaced: boolean;
        type: { name: string; description?: string; default_status?: string };
        file: { path: string; definitions: number };
      };
      expect(addResult.action).toBe("add-type");
      expect(addResult.registered).toBe(true);
      expect(addResult.replaced).toBe(false);
      expect(addResult.type.name).toBe("FooType");
      expect(addResult.type.description).toBe("demo");
      expect(addResult.type.default_status).toBe("open");
      expect(addResult.file.definitions).toBe(1);

      // The file on disk contains the definition.
      const types = await readTypes(context);
      expect(types.definitions).toHaveLength(1);
      expect(types.definitions[0]).toMatchObject({ name: "FooType", description: "demo", default_status: "open" });

      // Now create with the custom type succeeds.
      const created = context.runCli(["create", "FooType", "Investigate", "--json"], { expectJson: true });
      expect(created.code).toBe(0);
      expect((created.json as { item: { type: string } }).item.type).toBe("FooType");
    });
  });

  it("is an idempotent upsert that merges aliases", async () => {
    await withTempPmPath(async (context) => {
      const first = context.runCli(["schema", "add-type", "Spike", "--alias", "spike", "--json"], { expectJson: true });
      expect(first.code).toBe(0);
      expect((first.json as { replaced: boolean }).replaced).toBe(false);

      const second = context.runCli(
        ["schema", "add-type", "spike", "--alias", "research", "--description", "updated", "--json"],
        { expectJson: true },
      );
      expect(second.code).toBe(0);
      const secondResult = second.json as { replaced: boolean; type: { aliases?: string[]; description?: string } };
      expect(secondResult.replaced).toBe(true);
      expect(secondResult.type.description).toBe("updated");
      expect(secondResult.type.aliases).toEqual(["research", "spike"]);

      const types = await readTypes(context);
      expect(types.definitions).toHaveLength(1);
    });
  });

  it("emits a concise human line when not using --json", async () => {
    await withTempPmPath(async (context) => {
      const add = context.runCli(["schema", "add-type", "Spike", "--alias", "spike"]);
      expect(add.code).toBe(0);
      expect(add.stdout).toContain('Registered custom item type "Spike"');
      expect(add.stdout).toContain("aliases: spike");
      expect(add.stdout).toContain('pm create "Spike" "<title>"');
    });
  });

  it("accepts a custom type name shorthand when schema options make add-type intent clear", async () => {
    await withTempPmPath(async (context) => {
      const add = context.runCli(["schema", "Experiment", "--description", "Try a new approach", "--alias", "exp", "--json"], {
        expectJson: true,
      });
      expect(add.code).toBe(0);
      expect(add.json).toMatchObject({
        action: "add-type",
        type: {
          name: "Experiment",
          description: "Try a new approach",
          aliases: ["exp"],
        },
      });
    });
  });

  it("refuses to redefine a built-in type", async () => {
    await withTempPmPath(async (context) => {
      const add = context.runCli(["schema", "add-type", "Task"]);
      expect(add.code).not.toBe(0);
      expect(add.stderr).toContain('Cannot redefine built-in item type "Task"');
    });
  });

  it("rejects an alias that collides with a built-in type", async () => {
    await withTempPmPath(async (context) => {
      const add = context.runCli(["schema", "add-type", "Spike", "--alias", "task"]);
      expect(add.code).not.toBe(0);
      expect(add.stderr).toContain('Alias "task" collides with built-in item type "Task"');
    });
  });

  it("rejects an alias that already maps to another custom type", async () => {
    await withTempPmPath(async (context) => {
      const first = context.runCli(["schema", "add-type", "Gateway", "--alias", "gate"]);
      expect(first.code).toBe(0);
      const clash = context.runCli(["schema", "add-type", "Spike", "--alias", "gate"]);
      expect(clash.code).not.toBe(0);
      expect(clash.stderr).toContain('Alias "gate" already maps to existing item type "Gateway"');
    });
  });

  it("errors with allowed subcommands when no/unknown subcommand is given", async () => {
    await withTempPmPath(async (context) => {
      const none = context.runCli(["schema"]);
      expect(none.code).not.toBe(0);
      expect(none.stderr).toContain("pm schema requires a subcommand");
      expect(none.stderr).toContain("list");
      expect(none.stderr).toContain("show");
      expect(none.stderr).toContain("add-type");

      const unknown = context.runCli(["schema", "bogus"]);
      expect(unknown.code).not.toBe(0);
      expect(unknown.stderr).toContain('Unknown pm schema subcommand "bogus"');
    });
  });

  it("errors when the type name is missing", async () => {
    await withTempPmPath(async (context) => {
      const missing = context.runCli(["schema", "add-type"]);
      expect(missing.code).not.toBe(0);
      expect(missing.stderr).toContain("Type name must not be empty");
    });
  });
});
