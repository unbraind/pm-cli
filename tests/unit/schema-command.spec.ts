import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function typesPath(context: TempPmContext): string {
  return path.join(context.pmPath, "schema", "types.json");
}

function statusesPath(context: TempPmContext): string {
  return path.join(context.pmPath, "schema", "statuses.json");
}

async function readTypes(context: TempPmContext): Promise<{ definitions: Array<Record<string, unknown>> }> {
  return JSON.parse(await readFile(typesPath(context), "utf8"));
}

async function readStatuses(context: TempPmContext): Promise<{ statuses: Array<Record<string, unknown>> }> {
  return JSON.parse(await readFile(statusesPath(context), "utf8"));
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

  it("accepts a custom type name shorthand without requiring add-type flags", async () => {
    await withTempPmPath(async (context) => {
      const add = context.runCli(["schema", "Spike", "--json"], { expectJson: true });
      expect(add.code).toBe(0);
      expect(add.json).toMatchObject({
        action: "add-type",
        type: {
          name: "Spike",
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

      const unknown = context.runCli(["schema", "bogus", "extra"]);
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

describe("schema remove-type command", () => {
  it("removes a custom type definition case-insensitively", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["schema", "add-type", "Spike"]).code).toBe(0);

      const removed = context.runCli(["schema", "remove-type", "spike", "--json"], { expectJson: true });
      expect(removed.code).toBe(0);
      const result = removed.json as { action: string; removed: boolean; type?: { name: string } };
      expect(result.action).toBe("remove-type");
      expect(result.removed).toBe(true);
      expect(result.type?.name).toBe("Spike");

      const types = await readTypes(context);
      expect(types.definitions).toHaveLength(0);

      // The custom type no longer resolves for create.
      const created = context.runCli(["create", "Spike", "x"]);
      expect(created.code).not.toBe(0);
    });
  });

  it("is a no-op for an unknown custom type", async () => {
    await withTempPmPath(async (context) => {
      const removed = context.runCli(["schema", "remove-type", "Ghost", "--json"], { expectJson: true });
      expect(removed.code).toBe(0);
      expect((removed.json as { removed: boolean }).removed).toBe(false);
    });
  });

  it("refuses to remove a built-in type", async () => {
    await withTempPmPath(async (context) => {
      const removed = context.runCli(["schema", "remove-type", "Task"]);
      expect(removed.code).not.toBe(0);
      expect(removed.stderr).toContain('Cannot remove built-in item type "Task"');
    });
  });

  it("warns (without blocking) when open items of the type exist", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["schema", "add-type", "Spike"]).code).toBe(0);
      expect(context.runCli(["create", "Spike", "investigate"]).code).toBe(0);

      const removed = context.runCli(["schema", "remove-type", "Spike", "--json"], { expectJson: true });
      expect(removed.code).toBe(0);
      const result = removed.json as { removed: boolean; warnings: string[] };
      expect(result.removed).toBe(true);
      expect(result.warnings).toContain("items_using_type:1");
    });
  });
});

describe("schema add-status / remove-status commands", () => {
  it("registers a custom status with roles and aliases, surfaced by schema list", async () => {
    await withTempPmPath(async (context) => {
      const added = context.runCli(
        ["schema", "add-status", "review", "--role", "active", "--alias", "in_review", "--description", "needs eyes", "--json"],
        { expectJson: true },
      );
      expect(added.code).toBe(0);
      const result = added.json as {
        action: string;
        registered: boolean;
        replaced: boolean;
        status: { id: string; roles?: string[]; aliases?: string[]; description?: string };
        file: { statuses: number };
      };
      expect(result.action).toBe("add-status");
      expect(result.registered).toBe(true);
      expect(result.replaced).toBe(false);
      expect(result.status).toMatchObject({ id: "review", roles: ["active"], aliases: ["in_review"], description: "needs eyes" });

      const statuses = await readStatuses(context);
      expect(statuses.statuses).toContainEqual(expect.objectContaining({ id: "review" }));

      const listed = context.runCli(["schema", "list", "--json"], { expectJson: true });
      expect(listed.code).toBe(0);
      const listResult = listed.json as {
        statuses: { builtin: Array<{ id: string }>; custom: Array<{ id: string; roles: string[] }>; counts: { builtin: number; custom: number; total: number } };
      };
      expect(listResult.statuses.builtin.map((s) => s.id)).toContain("open");
      expect(listResult.statuses.custom).toContainEqual(expect.objectContaining({ id: "review", roles: ["active"] }));
      expect(listResult.statuses.counts.total).toBe(
        listResult.statuses.counts.builtin + listResult.statuses.counts.custom,
      );
    });
  });

  it("shows one status definition by id or alias", async () => {
    await withTempPmPath(async (context) => {
      const added = context.runCli(
        ["schema", "add-status", "review", "--role", "active", "--alias", "in_review", "--description", "needs eyes", "--order", "25"],
      );
      expect(added.code).toBe(0);

      const custom = context.runCli(["schema", "show-status", "review", "--json"], { expectJson: true });
      expect(custom.code).toBe(0);
      expect(custom.json).toMatchObject({
        action: "show-status",
        status: {
          id: "review",
          source: "custom",
          roles: ["active"],
          aliases: ["in_review"],
          description: "needs eyes",
          order: 25,
        },
      });

      const alias = context.runCli(["schema", "show-status", "in_review", "--json"], { expectJson: true });
      expect(alias.code).toBe(0);
      expect(alias.json).toMatchObject({
        action: "show-status",
        status: {
          id: "review",
          source: "custom",
        },
      });

      const builtin = context.runCli(["schema", "show-status", "open", "--json"], { expectJson: true });
      expect(builtin.code).toBe(0);
      expect(builtin.json).toMatchObject({
        action: "show-status",
        status: {
          id: "open",
          source: "builtin",
        },
      });
    });
  });

  it("errors for show-status when status id is missing or unknown", async () => {
    await withTempPmPath(async (context) => {
      const missing = context.runCli(["schema", "show-status"]);
      expect(missing.code).not.toBe(0);
      expect(missing.stderr).toContain("Status id must not be empty");

      const unknown = context.runCli(["schema", "show-status", "review"]);
      expect(unknown.code).not.toBe(0);
      expect(unknown.stderr).toContain('Unknown status "review"');
      expect(unknown.stderr).toContain("pm schema add-status \"review\"");
    });
  });

  it("is an idempotent upsert that replaces roles on re-add", async () => {
    await withTempPmPath(async (context) => {
      const first = context.runCli(["schema", "add-status", "review", "--role", "active", "--json"], { expectJson: true });
      expect(first.code).toBe(0);
      expect((first.json as { replaced: boolean }).replaced).toBe(false);

      const second = context.runCli(["schema", "add-status", "review", "--role", "blocked", "--json"], { expectJson: true });
      expect(second.code).toBe(0);
      const secondResult = second.json as { replaced: boolean; status: { roles?: string[] } };
      expect(secondResult.replaced).toBe(true);
      expect(secondResult.status.roles).toEqual(["blocked"]);

      const statuses = await readStatuses(context);
      expect(statuses.statuses.filter((s) => s.id === "review")).toHaveLength(1);
    });
  });

  it("rejects an invalid role", async () => {
    await withTempPmPath(async (context) => {
      const added = context.runCli(["schema", "add-status", "review", "--role", "bogus"]);
      expect(added.code).not.toBe(0);
      expect(added.stderr).toContain('Invalid status role "bogus"');
    });
  });

  it("emits a concise human line when not using --json", async () => {
    await withTempPmPath(async (context) => {
      const added = context.runCli(["schema", "add-status", "review", "--role", "active", "--alias", "in_review"]);
      expect(added.code).toBe(0);
      expect(added.stdout).toContain('Registered status "review"');
      expect(added.stdout).toContain("roles: active");
      expect(added.stdout).toContain("aliases: in_review");
    });
  });

  it("removes a custom status and refuses built-ins", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["schema", "add-status", "review", "--role", "active"]).code).toBe(0);

      const removed = context.runCli(["schema", "remove-status", "review", "--json"], { expectJson: true });
      expect(removed.code).toBe(0);
      const result = removed.json as { action: string; removed: boolean; status?: { id: string } };
      expect(result.action).toBe("remove-status");
      expect(result.removed).toBe(true);
      expect(result.status?.id).toBe("review");

      const refuse = context.runCli(["schema", "remove-status", "open"]);
      expect(refuse.code).not.toBe(0);
      expect(refuse.stderr).toContain('Cannot remove built-in status "open"');
    });
  });

  it("warns (without blocking) when items currently use the removed status", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["schema", "add-status", "review", "--role", "active"]).code).toBe(0);
      const created = context.runCli(["create", "Task", "look", "--json"], { expectJson: true });
      expect(created.code).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;
      expect(context.runCli(["update", id, "--status", "review"]).code).toBe(0);

      const removed = context.runCli(["schema", "remove-status", "review", "--json"], { expectJson: true });
      expect(removed.code).toBe(0);
      const result = removed.json as { removed: boolean; warnings: string[] };
      expect(result.removed).toBe(true);
      expect(result.warnings).toContain("items_using_status:1");
    });
  });

  it("lists the new subcommands in the missing-subcommand error", async () => {
    await withTempPmPath(async (context) => {
      const none = context.runCli(["schema"]);
      expect(none.code).not.toBe(0);
      expect(none.stderr).toContain("remove-type");
      expect(none.stderr).toContain("show-status");
      expect(none.stderr).toContain("add-status");
      expect(none.stderr).toContain("remove-status");
    });
  });
});
