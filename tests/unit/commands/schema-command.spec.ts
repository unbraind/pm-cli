import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _testOnlySchemaCommand, runSchemaShow } from "../../../src/cli/commands/schema.js";
import * as statusDefsFileModule from "../../../src/core/schema/status-defs-file.js";
import {
  clearActiveExtensionHooks,
  setActiveExtensionHooks,
  setActiveExtensionRegistrations,
  setActiveExtensionServices,
  type ExtensionHookRegistry,
} from "../../../src/core/extensions/index.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { readSettings, writeSettings } from "../../../src/core/store/settings.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";
import { runCreate } from "../../../src/cli/commands/create.js";

function typesPath(context: TempPmContext): string {
  return path.join(context.pmPath, "schema", "types.json");
}

function statusesPath(context: TempPmContext): string {
  return path.join(context.pmPath, "schema", "statuses.json");
}

function workflowsPath(context: TempPmContext): string {
  return path.join(context.pmPath, "schema", "workflows.json");
}

async function readTypes(context: TempPmContext): Promise<{ definitions: Array<Record<string, unknown>> }> {
  return JSON.parse(await readFile(typesPath(context), "utf8"));
}

async function readStatuses(context: TempPmContext): Promise<{ statuses: Array<Record<string, unknown>> }> {
  return JSON.parse(await readFile(statusesPath(context), "utf8"));
}

afterEach(() => {
  clearActiveExtensionHooks();
  setActiveExtensionServices(null);
});

describe("schema command helper coverage", () => {
  it("normalizes schema mutation authors from option env settings and fallback", () => {
    const previous = process.env.PM_AUTHOR;
    try {
      delete process.env.PM_AUTHOR;
      expect(_testOnlySchemaCommand.toAuthor(" explicit ", "settings-author")).toBe("explicit");
      expect(_testOnlySchemaCommand.toAuthor(undefined, "settings-author")).toBe("settings-author");
      process.env.PM_AUTHOR = " env-author ";
      expect(_testOnlySchemaCommand.toAuthor(undefined, "settings-author")).toBe("env-author");
      expect(_testOnlySchemaCommand.toAuthor("   ", "settings-author")).toBe("unknown");
    } finally {
      if (previous === undefined) {
        delete process.env.PM_AUTHOR;
      } else {
        process.env.PM_AUTHOR = previous;
      }
    }
  });

  it("finds workflow role slots referencing a normalized status id", () => {
    expect(
      _testOnlySchemaCommand.workflowSlotsReferencing(
        {
          draft_status: "draft",
          open_status: "To Do",
          in_progress_status: "in-progress",
          blocked_status: "blocked",
          close_status: "done",
          canceled_status: undefined,
        },
        "in_progress",
      ),
    ).toEqual(["in_progress_status"]);
    expect(_testOnlySchemaCommand.workflowSlotsReferencing({ open_status: "open" }, "closed")).toEqual([]);
  });
});

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

  it("lists extension item types separately and shows provenance", async () => {
    await withTempPmPath(async (context) => {
      const schema = await import("../../../src/cli/commands/schema.js");
      setActiveExtensionRegistrations({
        commands: [],
        flags: [],
        hooks: [],
        importers: [],
        exporters: [],
        item_fields: [],
        item_types: [
          {
            layer: "project",
            name: "schema-ext",
            types: [
              null,
              "bad",
              {
                name: "Incident",
                folder: "incidents",
                aliases: ["incident"],
                default_status: "open",
                description: "escalated production event",
              },
            ],
          },
          {
            layer: "global",
            name: "ignored-ext",
          },
        ],
        migrations: [],
        search_providers: [],
        vector_store_adapters: [],
      } as Parameters<typeof setActiveExtensionRegistrations>[0]);

      const listed = await schema.runSchemaList({ path: context.pmPath });
      expect(listed.extension).toContainEqual(
        expect.objectContaining({
          name: "Incident",
          folder: "incidents",
          aliases: ["incident"],
          default_status: "open",
          description: "escalated production event",
        }),
      );
      expect(listed.counts.extension).toBe(1);
      expect(listed.counts.total).toBe(listed.counts.builtin + listed.counts.custom + listed.counts.extension);

      const shown = await schema.runSchemaShow("incident", { path: context.pmPath });
      expect(shown.type).toMatchObject({
        name: "Incident",
        source: "extension",
        extension: {
          layer: "project",
          name: "schema-ext",
        },
      });
    });
  });

  it("returns direct custom type summaries and hook warnings", async () => {
    await withTempPmPath(async (context) => {
      const schema = await import("../../../src/cli/commands/schema.js");
      const events: string[] = [];
      const hooks: ExtensionHookRegistry = {
        beforeCommand: [],
        afterCommand: [],
        onRead: [],
        onWrite: [
          {
            layer: "project",
            name: "schema-type-write-hook",
            run: (hookContext) => {
              events.push(`${hookContext.op}:${path.basename(hookContext.path)}`);
              throw new Error("schema type hook failure");
            },
          },
        ],
        onIndex: [],
      };
      setActiveExtensionHooks(hooks);

      const added = await schema.runSchemaAddType(
        "Spike",
        { alias: ["spike"], description: "time-boxed investigation", author: "schema-test" },
        { path: context.pmPath },
      );
      expect(added.warnings).toEqual(["extension_hook_failed:project:schema-type-write-hook:onWrite"]);
      expect(events).toEqual([
        "lock:create:schema-types.lock",
        "schema:add-type:types.json",
        "lock:release:schema-types.lock",
      ]);
      expect(schema.formatSchemaAddTypeHuman(added)).toContain('Registered custom item type "Spike" (aliases: spike)');

      clearActiveExtensionHooks();
      const listed = await schema.runSchemaList({ path: context.pmPath });
      expect(listed.custom).toContainEqual(
        expect.objectContaining({
          name: "Spike",
          aliases: ["spike"],
          description: "time-boxed investigation",
        }),
      );
      expect(listed.counts.custom).toBe(1);

      const shown = await schema.runSchemaShow("Spike", { path: context.pmPath });
      expect(shown.type.source).toBe("custom");
    });
  });

  it("uses the default author when add-type omits author input", async () => {
    await withTempPmPath(async (context) => {
      const schema = await import("../../../src/cli/commands/schema.js");
      const settings = await readSettings(context.pmPath);
      await writeSettings(context.pmPath, { ...settings, author_default: "schema-default-author" });
      const lockOwners: string[] = [];
      const previousAuthor = process.env.PM_AUTHOR;
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "schema-lock-capture",
            service: "lock_acquire",
            run: (context) => {
              lockOwners.push(String((context.payload as { owner?: unknown }).owner));
              return async () => undefined;
            },
          },
        ],
      });

      try {
        delete process.env.PM_AUTHOR;
        const added = await schema.runSchemaAddType("DefaultAuthorType", {}, { path: context.pmPath });

        expect(added.registered).toBe(true);
        expect(added.type.name).toBe("DefaultAuthorType");
        expect(lockOwners).toEqual(["schema-default-author"]);
      } finally {
        if (previousAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousAuthor;
        }
      }
    });
  });

  it("falls back to unknown when add-type receives blank author input", async () => {
    await withTempPmPath(async (context) => {
      const schema = await import("../../../src/cli/commands/schema.js");
      const settings = await readSettings(context.pmPath);
      await writeSettings(context.pmPath, { ...settings, author_default: "schema-default-author" });
      const lockOwners: string[] = [];
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "schema-lock-capture",
            service: "lock_acquire",
            run: (context) => {
              lockOwners.push(String((context.payload as { owner?: unknown }).owner));
              return async () => undefined;
            },
          },
        ],
      });

      const added = await schema.runSchemaAddType("BlankAuthorType", { author: "   " }, { path: context.pmPath });

      expect(added.registered).toBe(true);
      expect(added.type.name).toBe("BlankAuthorType");
      expect(lockOwners).toEqual(["unknown"]);
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

  it("GH-248: warns when an upsert recases the existing canonical name", async () => {
    await withTempPmPath(async (context) => {
      const first = context.runCli(["schema", "add-type", "Spike", "--json"], { expectJson: true });
      expect(first.code).toBe(0);

      const recased = context.runCli(["schema", "add-type", "spike", "--json"], { expectJson: true });
      expect(recased.code).toBe(0);
      const result = recased.json as { replaced: boolean; warnings: string[] };
      expect(result.replaced).toBe(true);
      expect(result.warnings).toContain("type_recased:Spike->spike");
    });
  });

  it("GH-248: rejects a distinct type whose folder would collide", async () => {
    await withTempPmPath(async (context) => {
      const first = context.runCli(["schema", "add-type", "Spike"]);
      expect(first.code).toBe(0);
      // "Spikes" slugs to the same "spikes" folder already owned by "Spike".
      const collision = context.runCli(["schema", "add-type", "Spikes"]);
      expect(collision.code).toBe(EXIT_CODE.USAGE);
      expect(collision.stderr).toContain("already belongs to existing item type");
    });
  });

  it("GH-248: rejects a malformed type name with spaces", async () => {
    await withTempPmPath(async (context) => {
      const malformed = context.runCli(["schema", "add-type", "Spike Type"]);
      expect(malformed.code).toBe(EXIT_CODE.USAGE);
      expect(malformed.stderr).toContain("is not a valid identifier");
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

  it("formats add-type output for alias-free register and update paths", async () => {
    await withTempPmPath(async (context) => {
      const add = context.runCli(["schema", "add-type", "Spike"]);
      expect(add.code).toBe(0);
      expect(add.stdout).toContain('Registered custom item type "Spike"');
      expect(add.stdout).not.toContain("aliases:");

      const update = context.runCli(["schema", "add-type", "Spike", "--description", "updated"]);
      expect(update.code).toBe(0);
      expect(update.stdout).toContain('Updated custom item type "Spike"');
      expect(update.stdout).not.toContain("aliases:");
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

  it("errors for show when the type name is missing or unknown", async () => {
    await withTempPmPath(async (context) => {
      const missing = context.runCli(["schema", "show"]);
      expect(missing.code).not.toBe(0);
      expect(missing.stderr).toContain("Type name must not be empty");

      const unknown = context.runCli(["schema", "show", "Ghost"]);
      expect(unknown.code).not.toBe(0);
      expect(unknown.stderr).toContain('Unknown item type "Ghost"');
      expect(unknown.stderr).toContain('pm schema add-type "Ghost"');
    });
  });

  it("fails schema commands when the tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-schema-not-init-"));
    try {
      const missing = await import("../../../src/cli/commands/schema.js");

      await expect(missing.runSchemaList({ path: tempDir })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(missing.runSchemaAddType("Spike", {}, { path: tempDir })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports malformed custom type files as generic schema read failures", async () => {
    await withTempPmPath(async (context) => {
      await writeFile(typesPath(context), '{"definitions": [', "utf8");

      const add = context.runCli(["schema", "add-type", "Spike"]);
      expect(add.code).not.toBe(0);
      expect(add.stderr).toContain("schema/types.json contains invalid JSON");

      const remove = context.runCli(["schema", "remove-type", "Spike"]);
      expect(remove.code).not.toBe(0);
      expect(remove.stderr).toContain("schema/types.json contains invalid JSON");
    });
  });
});

describe("schema show command", () => {
  it("rejects blank and unknown type names", async () => {
    await withTempPmPath(async (context) => {
      await expect(runSchemaShow("   ", { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: "Type name must not be empty.",
      });
      await expect(runSchemaShow("NoSuchType", { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
        message: expect.stringContaining('Unknown item type "NoSuchType"'),
      });
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

  it("directly removes a custom type with lock ownership, item warnings, and hook warnings", async () => {
    await withTempPmPath(async (context) => {
      const schema = await import("../../../src/cli/commands/schema.js");
      const settings = await readSettings(context.pmPath);
      await writeSettings(context.pmPath, { ...settings, author_default: "schema-remove-type-default" });
      const lockOwners: string[] = [];
      const hookOps: string[] = [];
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "schema-type-lock-capture",
            service: "lock_acquire",
            run: (context) => {
              lockOwners.push(String((context.payload as { owner?: unknown }).owner));
              return async () => undefined;
            },
          },
        ],
      });
      setActiveExtensionHooks({
        beforeCommand: [],
        afterCommand: [],
        onRead: [],
        onWrite: [
          {
            layer: "project",
            name: "schema-remove-type-hook",
            run: (hookContext) => {
              hookOps.push(`${hookContext.op}:${path.basename(hookContext.path)}`);
              throw new Error("remove type hook failure");
            },
          },
        ],
        onIndex: [],
      });

      await schema.runSchemaAddType("Spike", { author: "schema-add-agent" }, { path: context.pmPath });
      expect(context.runCli(["create", "Spike", "investigate"]).code).toBe(0);

      const removed = await schema.runSchemaRemoveType(
        "spike",
        { author: "schema-remove-agent" },
        { path: context.pmPath },
      );

      expect(removed.removed).toBe(true);
      expect(removed.type?.name).toBe("Spike");
      expect(removed.warnings).toEqual([
        "extension_hook_failed:project:schema-remove-type-hook:onWrite",
        "items_using_type:1",
      ]);
      expect(lockOwners).toEqual(["schema-add-agent", "schema-remove-agent"]);
      expect(hookOps).toContain("schema:remove-type:types.json");
    });
  });

  it("renders removal human output fallbacks for removed and missing type payloads", async () => {
    const schema = await import("../../../src/cli/commands/schema.js");

    expect(
      schema.formatSchemaRemoveTypeHuman({
        action: "remove-type",
        removed: true,
        file: { path: "/tmp/schema/types.json", definitions: 0 },
        warnings: [],
        generated_at: "2026-06-13T00:00:00.000Z",
      }),
    ).toBe('Removed custom item type "(unknown)" from /tmp/schema/types.json.');

    expect(
      schema.formatSchemaRemoveTypeHuman({
        action: "remove-type",
        removed: false,
        file: { path: "/tmp/schema/types.json", definitions: 0 },
        warnings: [],
        generated_at: "2026-06-13T00:00:00.000Z",
      }),
    ).toBe("No custom item type matched; nothing removed from /tmp/schema/types.json.");
  });

  it("renders rich type and list human output branches", async () => {
    const schema = await import("../../../src/cli/commands/schema.js");

    expect(
      schema.formatSchemaShowHuman({
        action: "show",
        type: {
          name: "Spike",
          source: "custom",
          folder: "spikes",
          default_status: "review",
          aliases: ["spike"],
          description: "time-boxed investigation",
          required_create_fields: ["owner"],
          required_create_repeatables: [],
          options: [{ key: "risk", type: "string" }],
          command_option_policies: [],
        },
        file: { path: "/tmp/schema/types.json" },
        generated_at: "2026-06-13T00:00:00.000Z",
      }),
    ).toBe(
      [
        "type: Spike",
        "source: custom",
        "folder: spikes",
        "default_status: review",
        "aliases: spike",
        "description: time-boxed investigation",
        "options: risk",
      ].join("\n"),
    );

    expect(
      schema.formatSchemaListHuman({
        action: "list",
        builtin: [{ name: "Task", folder: "tasks", aliases: [] }],
        custom: [{ name: "Spike", folder: "spikes", aliases: [] }],
        extension: [{ name: "Incident", folder: "incidents", aliases: [] }],
        counts: { builtin: 1, custom: 1, extension: 1, total: 3 },
        statuses: {
          builtin: [{ id: "open", source: "builtin", roles: ["open"], aliases: [] }],
          custom: [{ id: "review", source: "custom", roles: ["active"], aliases: [] }],
          counts: { builtin: 1, custom: 1, total: 2 },
        },
        fields: {
          custom: [
            {
              key: "owner",
              type: "string",
              commands: ["create", "update"],
              cli_flag: "--owner",
              cli_aliases: [],
              required: false,
              required_on_create: false,
              allow_unset: true,
              required_types: [],
            },
          ],
          counts: { total: 1 },
        },
        file: { path: "/tmp/schema/types.json" },
        generated_at: "2026-06-13T00:00:00.000Z",
      }),
    ).toContain("extension: Incident");
  });

  it("renders empty schema list and minimal show output branches", async () => {
    const schema = await import("../../../src/cli/commands/schema.js");

    expect(
      schema.formatSchemaListHuman({
        action: "list",
        builtin: [],
        custom: [],
        extension: [],
        counts: { builtin: 0, custom: 0, extension: 0, total: 0 },
        statuses: {
          builtin: [],
          custom: [],
          counts: { builtin: 0, custom: 0, total: 0 },
        },
        fields: {
          custom: [],
          counts: { total: 0 },
        },
        file: { path: "/tmp/schema/types.json" },
        generated_at: "2026-06-13T00:00:00.000Z",
      }),
    ).toBe(
      [
        "Schema types: 0 total (0 builtin, 0 custom, 0 extension)",
        "statuses: 0 total (0 builtin, 0 custom)",
        "custom fields: 0 total",
        "Inspect one: pm schema show <Type>",
        "Inspect one status: pm schema show-status <status>",
        "Inspect one field: pm schema show-field <key>",
      ].join("\n"),
    );

    expect(
      schema.formatSchemaShowHuman({
        action: "show",
        type: {
          name: "Task",
          source: "builtin",
          folder: "tasks",
          aliases: [],
          required_create_fields: [],
          required_create_repeatables: [],
          options: [],
          command_option_policies: [],
        },
        file: { path: "/tmp/schema/types.json" },
        generated_at: "2026-06-13T00:00:00.000Z",
      }),
    ).toBe(["type: Task", "source: builtin", "folder: tasks"].join("\n"));
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

  it("resolves type aliases case-insensitively in direct show calls", async () => {
    await withTempPmPath(async (context) => {
      const schema = await import("../../../src/cli/commands/schema.js");
      await schema.runSchemaAddType(
        "Spike",
        { alias: ["SpikeAlias"], author: "schema-test" },
        { path: context.pmPath },
      );

      const shown = await schema.runSchemaShow("spikealias", { path: context.pmPath });
      expect(shown.type.name).toBe("Spike");
      expect(shown.type.aliases.map((alias) => alias.toLowerCase())).toContain("spikealias");
    });
  });

  it("returns direct custom status summaries, alias lookups, and hook warnings", async () => {
    await withTempPmPath(async (context) => {
      const schema = await import("../../../src/cli/commands/schema.js");
      const events: string[] = [];
      const hooks: ExtensionHookRegistry = {
        beforeCommand: [],
        afterCommand: [],
        onRead: [],
        onWrite: [
          {
            layer: "project",
            name: "schema-status-write-hook",
            run: (hookContext) => {
              events.push(`${hookContext.op}:${path.basename(hookContext.path)}`);
              throw new Error("schema status hook failure");
            },
          },
        ],
        onIndex: [],
      };
      setActiveExtensionHooks(hooks);

      const added = await schema.runSchemaAddStatus(
        "review",
        {
          role: ["active"],
          alias: ["in_review"],
          description: "needs eyes",
          order: 25,
          author: "schema-test",
        },
        { path: context.pmPath },
      );
      expect(added.warnings).toEqual(["extension_hook_failed:project:schema-status-write-hook:onWrite"]);
      expect(events).toEqual([
        "lock:create:schema-statuses.lock",
        "schema:add-status:statuses.json",
        "lock:release:schema-statuses.lock",
      ]);
      expect(schema.formatSchemaAddStatusHuman(added)).toContain(
        'Registered status "review" (roles: active) (aliases: in_review)',
      );

      clearActiveExtensionHooks();
      const listed = await schema.runSchemaList({ path: context.pmPath });
      expect(listed.statuses.custom).toContainEqual(
        expect.objectContaining({
          id: "review",
          source: "custom",
          roles: ["active"],
          aliases: ["in_review"],
          description: "needs eyes",
          order: 25,
        }),
      );

      const shown = await schema.runSchemaShowStatus("in_review", { path: context.pmPath });
      expect(shown.status).toMatchObject({ id: "review", source: "custom" });
    });
  });

  it("preserves status metadata defined in settings when re-adding a status id", async () => {
    await withTempPmPath(async (context) => {
      const schema = await import("../../../src/cli/commands/schema.js");
      const settings = await readSettings(context.pmPath);
      await writeSettings(context.pmPath, {
        ...settings,
        schema: {
          ...settings.schema,
          statuses: [
            ...settings.schema.statuses,
            {
              id: "review",
              roles: ["active"],
              aliases: ["in_review"],
              description: "settings-backed review",
              order: 30,
            },
          ],
        },
      });

      const added = await schema.runSchemaAddStatus("review", {}, { path: context.pmPath });

      expect(added.replaced).toBe(true);
      expect(added.status).toMatchObject({
        id: "review",
        roles: ["active"],
        aliases: ["in_review"],
        description: "settings-backed review",
        order: 30,
      });
      expect((await readStatuses(context)).statuses).toContainEqual(
        expect.objectContaining({ id: "review", description: "settings-backed review" }),
      );
    });
  });

  it("falls back to unknown author when add-status receives blank author settings", async () => {
    await withTempPmPath(async (context) => {
      const schema = await import("../../../src/cli/commands/schema.js");
      const settings = await readSettings(context.pmPath);
      await writeSettings(context.pmPath, { ...settings, author_default: "   " });
      const lockOwners: string[] = [];
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "schema-lock-capture",
            service: "lock_acquire",
            run: (context) => {
              lockOwners.push(String((context.payload as { owner?: unknown }).owner));
              return async () => undefined;
            },
          },
        ],
      });

      const added = await schema.runSchemaAddStatus("blank_author_status", { author: "  " }, { path: context.pmPath });

      expect(added.registered).toBe(true);
      expect(lockOwners).toEqual(["unknown"]);
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

  it("throws direct show-status usage and not-found errors", async () => {
    await withTempPmPath(async (context) => {
      const schema = await import("../../../src/cli/commands/schema.js");

      await expect(schema.runSchemaShowStatus(undefined, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(schema.runSchemaShowStatus("review", { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
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

  it("rejects status aliases that collide with the current status file under lock", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["schema", "add-status", "review", "--alias", "in_review"]).code).toBe(0);

      const clash = context.runCli(["schema", "add-status", "triage", "--alias", "in_review"]);

      expect(clash.code).not.toBe(0);
      expect(clash.stderr).toContain("in_review");
    });
  });

  it("wraps non-Error status parser/remover failures as CLI errors", async () => {
    await withTempPmPath(async (context) => {
      const schema = await import("../../../src/cli/commands/schema.js");

      const parseSpy = vi.spyOn(statusDefsFileModule, "parseStatusDefsFile");
      const removeSpy = vi.spyOn(statusDefsFileModule, "removeStatusDef");

      try {
        parseSpy.mockImplementationOnce(() => {
          throw "synthetic-status-parse-failure";
        });
        await expect(
          schema.runSchemaRemoveStatus("review", { author: "schema-test" }, { path: context.pmPath }),
        ).rejects.toMatchObject({
          exitCode: EXIT_CODE.GENERIC_FAILURE,
          message: "synthetic-status-parse-failure",
        });

        parseSpy.mockRestore();
        const parseRaceSpy = vi
          .spyOn(statusDefsFileModule, "parseStatusDefsFile")
          .mockReturnValueOnce({
            statuses: [
              { id: "   ", aliases: [] },
              { id: "review", aliases: ["in_review"] },
            ],
          } as ReturnType<typeof statusDefsFileModule.parseStatusDefsFile>);
        await expect(
          schema.runSchemaAddStatus(
            "triage",
            { alias: ["in_review"], author: "schema-test" },
            { path: context.pmPath },
          ),
        ).rejects.toMatchObject({
          exitCode: EXIT_CODE.USAGE,
          message: expect.stringContaining("in_review"),
        });
        parseRaceSpy.mockRestore();

        const parseRemoveSpy = vi.spyOn(statusDefsFileModule, "parseStatusDefsFile").mockReturnValueOnce({
          statuses: [],
        } as ReturnType<typeof statusDefsFileModule.parseStatusDefsFile>);
        removeSpy.mockImplementationOnce(() => {
          throw "synthetic-remove-failure";
        });
        await expect(
          schema.runSchemaRemoveStatus("review", { author: "schema-test" }, { path: context.pmPath }),
        ).rejects.toMatchObject({
          exitCode: EXIT_CODE.USAGE,
          message: "synthetic-remove-failure",
        });
        parseRemoveSpy.mockRestore();
      } finally {
        parseSpy.mockRestore();
        removeSpy.mockRestore();
      }
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

  it("formats add-status output for metadata-free register and metadata update paths", async () => {
    await withTempPmPath(async (context) => {
      const add = context.runCli(["schema", "add-status", "review"]);
      expect(add.code).toBe(0);
      expect(add.stdout).toContain('Registered status "review"');
      expect(add.stdout).not.toContain("roles:");
      expect(add.stdout).not.toContain("aliases:");

      const update = context.runCli(["schema", "add-status", "review", "--role", "active", "--alias", "in_review"]);
      expect(update.code).toBe(0);
      expect(update.stdout).toContain('Updated status "review"');
      expect(update.stdout).toContain("roles: active");
      expect(update.stdout).toContain("aliases: in_review");
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

  it("renders status show and remove no-op human output", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["schema", "add-status", "review", "--role", "active", "--alias", "in_review"]).code).toBe(0);

      const shown = context.runCli(["schema", "show-status", "review"]);
      expect(shown.code).toBe(0);
      expect(shown.stdout).toContain("status: review");
      expect(shown.stdout).toContain("source: custom");
      expect(shown.stdout).toContain("roles: active");
      expect(shown.stdout).toContain("aliases: in_review");

      const missing = context.runCli(["schema", "remove-status", "missing"]);
      expect(missing.code).toBe(0);
      expect(missing.stdout).toContain("No custom status matched");
    });
  });

  it("renders status removal fallback and full status human output", async () => {
    const schema = await import("../../../src/cli/commands/schema.js");

    expect(
      schema.formatSchemaRemoveStatusHuman({
        action: "remove-status",
        removed: true,
        file: { path: "/tmp/schema/statuses.json", statuses: 0 },
        warnings: [],
        generated_at: "2026-06-13T00:00:00.000Z",
      }),
    ).toBe('Removed custom status "(unknown)" from /tmp/schema/statuses.json.');

    expect(
      schema.formatSchemaShowStatusHuman({
        action: "show-status",
        status: {
          id: "review",
          source: "custom",
          roles: ["active"],
          aliases: ["in_review"],
          description: "needs eyes",
          order: 25,
        },
        file: { path: "/tmp/schema/statuses.json" },
        generated_at: "2026-06-13T00:00:00.000Z",
      }),
    ).toBe(
      ["status: review", "source: custom", "roles: active", "aliases: in_review", "description: needs eyes", "order: 25"].join(
        "\n",
      ),
    );
  });

  it("renders minimal status human output and no-op status removal fallback", async () => {
    const schema = await import("../../../src/cli/commands/schema.js");

    expect(
      schema.formatSchemaRemoveStatusHuman({
        action: "remove-status",
        removed: false,
        file: { path: "/tmp/schema/statuses.json", statuses: 0 },
        warnings: [],
        generated_at: "2026-06-13T00:00:00.000Z",
      }),
    ).toBe("No custom status matched; nothing removed from /tmp/schema/statuses.json.");

    expect(
      schema.formatSchemaShowStatusHuman({
        action: "show-status",
        status: {
          id: "open",
          source: "builtin",
          roles: [],
          aliases: [],
        },
        file: { path: "/tmp/schema/statuses.json" },
        generated_at: "2026-06-13T00:00:00.000Z",
      }),
    ).toBe(["status: open", "source: builtin"].join("\n"));
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

  it("warns when removing a status still referenced by workflow defaults", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["schema", "add-status", "review", "--json"], { expectJson: true }).code).toBe(0);
      await writeFile(
        workflowsPath(context),
        `${JSON.stringify({ workflow: { in_progress_status: "review" } }, null, 2)}\n`,
        "utf8",
      );

      const removed = context.runCli(["schema", "remove-status", "review", "--json"], { expectJson: true });
      expect(removed.code).toBe(0);
      expect((removed.json as { warnings: string[] }).warnings).toContain("status_referenced_by_workflow:in_progress_status");
    });
  });

  it("directly removes a status with lock ownership, item, workflow, and hook warnings", async () => {
    await withTempPmPath(async (context) => {
      const schema = await import("../../../src/cli/commands/schema.js");
      const settings = await readSettings(context.pmPath);
      await writeSettings(context.pmPath, { ...settings, author_default: "schema-remove-default" });
      const lockOwners: string[] = [];
      const hookOps: string[] = [];
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "schema-status-lock-capture",
            service: "lock_acquire",
            run: (context) => {
              lockOwners.push(String((context.payload as { owner?: unknown }).owner));
              return async () => undefined;
            },
          },
        ],
      });
      setActiveExtensionHooks({
        beforeCommand: [],
        afterCommand: [],
        onRead: [],
        onWrite: [
          {
            layer: "project",
            name: "schema-remove-status-hook",
            run: (hookContext) => {
              hookOps.push(`${hookContext.op}:${path.basename(hookContext.path)}`);
              throw new Error("remove status hook failure");
            },
          },
        ],
        onIndex: [],
      });

      await schema.runSchemaAddStatus("review", { role: ["active"] }, { path: context.pmPath });
      const created = context.runCli(["create", "Task", "needs review", "--json"], { expectJson: true });
      expect(created.code).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;
      expect(context.runCli(["update", id, "--status", "review"]).code).toBe(0);
      await writeFile(
        workflowsPath(context),
        `${JSON.stringify({ workflow: { in_progress_status: "review", blocked_status: "review" } }, null, 2)}\n`,
        "utf8",
      );

      const removed = await schema.runSchemaRemoveStatus(
        "review",
        { author: "schema-remove-agent" },
        { path: context.pmPath },
      );

      expect(removed.removed).toBe(true);
      expect(removed.status?.id).toBe("review");
      expect(removed.warnings).toEqual([
        "extension_hook_failed:project:schema-remove-status-hook:onWrite",
        "items_using_status:1",
        "status_referenced_by_workflow:in_progress_status,blocked_status",
      ]);
      expect(lockOwners).toEqual(["test-author", "schema-remove-agent"]);
      expect(hookOps).toContain("schema:remove-status:statuses.json");
    });
  });

  it("reports malformed custom status files as generic schema read failures", async () => {
    await withTempPmPath(async (context) => {
      await writeFile(statusesPath(context), '{"statuses": [', "utf8");

      const add = context.runCli(["schema", "add-status", "review"]);
      expect(add.code).not.toBe(0);
      expect(add.stderr).toContain("schema/statuses.json contains invalid JSON");

      const remove = context.runCli(["schema", "remove-status", "review"]);
      expect(remove.code).not.toBe(0);
      expect(remove.stderr).toContain("schema/statuses.json contains invalid JSON");
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

describe("schema custom field commands (GH-vhbf)", () => {
  it("upserts, lists, shows, and removes a custom field", async () => {
    await withTempPmPath(async (context) => {
      const schema = await import("../../../src/cli/commands/schema.js");

      const added = await schema.runSchemaAddField(
        "severity_level",
        {
          type: "string",
          commands: ["create", "update", "list"],
          description: "Bug severity",
          cliFlag: "--sev",
          alias: ["severity"],
          required: true,
          requiredOnCreate: true,
          allowUnset: false,
          requiredTypes: ["Bug"],
          author: "schema-test",
        },
        { path: context.pmPath },
      );
      expect(added.action).toBe("add-field");
      expect(added.registered).toBe(true);
      expect(added.replaced).toBe(false);
      expect(added.field.key).toBe("severity_level");
      expect(added.file.fields).toBe(1);

      // Idempotent re-run reports replaced; supplying the same flags keeps them.
      const again = await schema.runSchemaAddField(
        "severity_level",
        { type: "string", cliFlag: "--sev", alias: ["severity"] },
        { path: context.pmPath },
      );
      expect(again.replaced).toBe(true);

      const listed = await schema.runSchemaListFields({ path: context.pmPath });
      expect(listed.action).toBe("list-fields");
      expect(listed.counts.total).toBe(1);
      expect(listed.fields[0]).toMatchObject({ key: "severity_level", type: "string", cli_flag: "--sev" });
      expect(listed.fields[0].cli_aliases).toContain("--severity");

      // list also surfaces the fields section.
      const fullList = await schema.runSchemaList({ path: context.pmPath });
      expect(fullList.fields.counts.total).toBe(1);
      expect(fullList.fields.custom[0].key).toBe("severity_level");

      const shown = await schema.runSchemaShowField("Severity-Level", { path: context.pmPath });
      expect(shown.action).toBe("show-field");
      expect(shown.field.key).toBe("severity_level");

      const removed = await schema.runSchemaRemoveField("severity_level", {}, { path: context.pmPath });
      expect(removed.action).toBe("remove-field");
      expect(removed.removed).toBe(true);
      expect(removed.file.fields).toBe(0);

      // Removing a missing field is an idempotent no-op.
      const noop = await schema.runSchemaRemoveField("severity_level", {}, { path: context.pmPath });
      expect(noop.removed).toBe(false);
    });
  });

  it("rejects an invalid add-field key and an empty show-field key", async () => {
    await withTempPmPath(async (context) => {
      const schema = await import("../../../src/cli/commands/schema.js");
      await expect(schema.runSchemaAddField("status", {}, { path: context.pmPath })).rejects.toBeInstanceOf(PmCliError);
      await expect(schema.runSchemaShowField("  ", { path: context.pmPath })).rejects.toThrow(/Field key must not be empty/);
      await expect(schema.runSchemaShowField("missing", { path: context.pmPath })).rejects.toThrow(/Unknown custom field/);
    });
  });

  it("warns when removing a field that items still use", async () => {
    await withTempPmPath(async (context) => {
      const schema = await import("../../../src/cli/commands/schema.js");
      await schema.runSchemaAddField("owner", { type: "string" }, { path: context.pmPath });
      await runCreate({ title: "has owner", owner: "alice" } as never, { path: context.pmPath });
      const removed = await schema.runSchemaRemoveField("owner", {}, { path: context.pmPath });
      expect(removed.removed).toBe(true);
      expect(removed.warnings).toContain("items_using_field:1");
    });
  });
});

describe("schema apply-preset (GH-86ob)", () => {
  it("registers a preset and is idempotent on re-run", async () => {
    await withTempPmPath(async (context) => {
      const schema = await import("../../../src/cli/commands/schema.js");
      const applied = await schema.runSchemaApplyPreset("agile", { author: "schema-test" }, { path: context.pmPath });
      expect(applied.action).toBe("apply-preset");
      expect(applied.preset).toBe("agile");
      expect(applied.registered.sort()).toEqual(["Spike", "Story"]);
      expect(applied.replaced).toEqual([]);

      const again = await schema.runSchemaApplyPreset("agile", {}, { path: context.pmPath });
      expect(again.registered).toEqual([]);
      expect(again.replaced.sort()).toEqual(["Spike", "Story"]);

      const listed = await schema.runSchemaList({ path: context.pmPath });
      expect(listed.custom.map((entry) => entry.name).sort()).toEqual(expect.arrayContaining(["Spike", "Story"]));
    });
  });

  it("rejects a missing/unknown preset", async () => {
    await withTempPmPath(async (context) => {
      const schema = await import("../../../src/cli/commands/schema.js");
      await expect(schema.runSchemaApplyPreset(undefined, {}, { path: context.pmPath })).rejects.toBeInstanceOf(PmCliError);
      await expect(schema.runSchemaApplyPreset("kanban", {}, { path: context.pmPath })).rejects.toThrow(/Invalid type preset/);
    });
  });
});

describe("schema add-type --infer (GH-245)", () => {
  it("previews candidates by default and registers them with apply", async () => {
    await withTempPmPath(async (context) => {
      const schema = await import("../../../src/cli/commands/schema.js");
      for (let i = 0; i < 3; i += 1) {
        await runCreate({ title: `INFRA- provision ${i}` } as never, { path: context.pmPath });
        await runCreate({ title: `SECURITY- finding ${i}` } as never, { path: context.pmPath });
      }
      // Seed a built-in-shadowing prefix to exercise the skip path.
      await runCreate({ title: "TASK- shadow one" } as never, { path: context.pmPath });
      await runCreate({ title: "TASK- shadow two" } as never, { path: context.pmPath });

      const preview = await schema.runSchemaInferTypes({ minCount: 2 }, { path: context.pmPath });
      expect(preview.action).toBe("infer-types");
      expect(preview.applied).toBe(false);
      expect(preview.candidates.map((c) => c.name).sort()).toEqual(["Infra", "Security", "Task"]);
      expect(preview.registered).toEqual([]);

      const applied = await schema.runSchemaInferTypes(
        { minCount: 2, apply: true, author: "schema-test" },
        { path: context.pmPath },
      );
      expect(applied.applied).toBe(true);
      expect(applied.registered.sort()).toEqual(["Infra", "Security"]);
      expect(applied.skipped).toContainEqual({ name: "Task", reason: "shadows_builtin" });
    });
  });

  it("reports no candidates when nothing meets the threshold", async () => {
    await withTempPmPath(async (context) => {
      const schema = await import("../../../src/cli/commands/schema.js");
      await runCreate({ title: "plain title, no prefix" } as never, { path: context.pmPath });
      const result = await schema.runSchemaInferTypes({ minCount: 10 }, { path: context.pmPath });
      expect(result.candidates).toEqual([]);
      expect(result.applied).toBe(false);
    });
  });
});
