/**
 * pm-dhlij3: an extension item field named after built-in item metadata used
 * to make every create and update exit 2 with an untyped command_failed, and
 * nothing named the package. Activation now drops only that field with a
 * warning that package doctor and health carry, and the write path keeps the
 * typed code of any field refusal it still meets.
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCreate } from "../../../src/cli/commands/lifecycle/create.js";
import { runUpdate } from "../../../src/cli/commands/lifecycle/update.js";
import { setActiveExtensionRegistrations } from "../../../src/core/extensions/index.js";
import {
  applyRegisteredItemFieldDefaultsForWrite,
  findConflictingItemFieldDeclaration,
  formatReservedItemFieldWarning,
} from "../../../src/core/extensions/item-fields.js";
import { createEmptyExtensionRegistrationRegistry } from "../../../src/core/extensions/loader.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { activateSyntheticExtensions, writeTestExtension } from "../../helpers/extensions.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

afterEach(() => {
  setActiveExtensionRegistrations(null);
});

describe("reserved extension item fields at activation", () => {
  it("drops only the reserved field and names the package, the field and a rename", async () => {
    const result = await activateSyntheticExtensions([{
      name: "bad-fields",
      capabilities: ["schema"],
      activate: (api) => {
        api.registerItemFields([{ name: " priority ", type: "string" }, { name: "review_owner", type: "string" }]);
        api.registerItemFields([{ name: "status", type: "string" }]);
      },
    }]);
    expect(result.failed).toEqual([]);
    expect(result.warnings).toEqual([
      "extension_item_field_reserved:project:bad-fields:priority:rename=bad_fields_priority",
      "extension_item_field_reserved:project:bad-fields:status:rename=bad_fields_status",
    ]);
    // Each registration keeps its free fields; one that held only a reserved field stays empty, so the package
    // still counts as using the schema capability it declared.
    expect(result.registrations.item_fields).toEqual([
      { layer: "project", name: "bad-fields", fields: [{ name: "review_owner", type: "string" }] },
      { layer: "project", name: "bad-fields", fields: [] },
    ]);
    expect(result.registration_counts.item_fields).toBe(1);
  });

  it("keeps activating a package whose field name is read through a getter (Codex review)", async () => {
    class GetterField {
      public type = "string";
      get name(): string {
        return "title";
      }
    }
    const result = await activateSyntheticExtensions([{
      name: "getter-fields",
      capabilities: ["schema"],
      activate: (api) => api.registerItemFields([new GetterField() as never, { name: "review_owner", type: "string" }]),
    }]);
    expect(result.failed).toEqual([]);
    expect(result.registrations.item_fields[0]?.fields.map((field) => field.name)).toContain("review_owner");
  });

  it("derives the rename prefix from the package name without its scope", () => {
    expect(formatReservedItemFieldWarning("global", "@unbrained/pm-Story.Points", "status")).toBe(
      "extension_item_field_reserved:global:@unbrained/pm-Story.Points:status:rename=pm_story_points_status",
    );
  });
});

describe("extension item fields that two packages type differently (pm-2ze9nt)", () => {
  it("keeps the first declaration and drops each later one with another type, naming both packages and types", async () => {
    const result = await activateSyntheticExtensions([
      {
        name: "pkg-a",
        capabilities: ["schema"],
        activate: (api) => api.registerItemFields([{ name: "story_points", type: "number" }, { name: "sprint_goal", type: "string" }]),
      },
      {
        name: "pkg-b",
        capabilities: ["schema"],
        activate: (api) => {
          api.registerItemFields([{ name: " story_points ", type: "string" }, { name: "review_owner", type: "string" }]);
          // The same type again is one field, not a conflict; a later conflict inside one package is dropped too.
          api.registerItemFields([{ name: "story_points", type: "number" }, { name: "review_owner", type: "string_array" }]);
        },
      },
    ]);
    expect(result.failed).toEqual([]);
    expect(result.warnings).toEqual([
      "extension_item_field_type_conflict:project:pkg-b:story_points:string:kept=project:pkg-a:number",
      "extension_item_field_type_conflict:project:pkg-b:review_owner:string_array:kept=project:pkg-b:string",
    ]);
    expect(result.registrations.item_fields.map((registration) => registration.fields.map((field) => field.name))).toEqual([
      ["story_points", "sprint_goal"],
      ["review_owner"],
      ["story_points"],
    ]);
    setActiveExtensionRegistrations(result.registrations);
    await withTempPmPath(async (context) => {
      const created = await runCreate({ title: "pointed", type: "Task", field: ["story_points=3", "review_owner=ada"] }, { path: context.pmPath });
      expect(created.item).toMatchObject({ story_points: 3, review_owner: "ada" });
      await expect(runUpdate(created.item.id, { title: "renamed" }, { path: context.pmPath })).resolves.toMatchObject({ item: { title: "renamed" } });
    });
  });

  it("judges only declarations with a usable name and type", () => {
    const admitted = [{ layer: "project", name: "pkg-a", fields: [{ name: 5, type: "number" }, { name: "story_points", type: "bogus" }, { name: "story_points", type: "number" }] }] as never;
    expect(findConflictingItemFieldDeclaration(admitted, { name: "story_points", type: "string" })).toEqual({ layer: "project", name: "pkg-a", type: "number" });
    expect(findConflictingItemFieldDeclaration(admitted, { name: "story_points", type: "number" })).toBeUndefined();
    expect(findConflictingItemFieldDeclaration(admitted, { name: "other", type: "string" })).toBeUndefined();
    expect(findConflictingItemFieldDeclaration(admitted, { name: " ", type: "string" })).toBeUndefined();
    expect(findConflictingItemFieldDeclaration(admitted, { name: "story_points", type: 7 })).toBeUndefined();
  });

  it("keeps create and update working for two installed packages and reports the dropped declaration in doctor and health", async () => {
    await withTempPmPath(async ({ pmPath, runCli }) => {
      for (const [name, type] of [["pkg-a", "number"], ["pkg-b", "string"]] as const) {
        await writeTestExtension({
          root: path.join(pmPath, "extensions", name),
          name,
          manifestOverrides: { capabilities: ["schema"] },
          entrySource: `export default { activate(api) { api.registerItemFields([{ name: "story_points", type: "${type}" }]); } };`,
        });
      }
      const warning = "extension_item_field_type_conflict:project:pkg-b:story_points:string:kept=project:pkg-a:number";
      const created = await runCli(["create", "Task", "--title", "seed", "--field", "story_points=5", "--json"], { expectJson: true });
      expect(created.code, created.stderr).toBe(0);
      const id = (JSON.parse(created.stdout) as { item: { id: string } }).item.id;
      expect((await runCli(["update", id, "--title", "renamed", "--json"], { expectJson: true })).code).toBe(0);
      const item = await runCli(["get", id, "--json"], { expectJson: true });
      expect((JSON.parse(item.stdout) as { item: Record<string, unknown> }).item).toMatchObject({ title: "renamed", story_points: 5 });
      const doctor = await runCli(["package", "doctor", "--json"], { expectJson: true });
      expect((JSON.parse(doctor.stdout) as { warnings: string[] }).warnings).toContain(warning);
      const health = await runCli(["health", "--check-only", "--json"], { expectJson: true });
      expect((JSON.parse(health.stdout) as { warnings: string[] }).warnings).toContain(warning);
    });
  });
});

describe("item field refusals on the write path", () => {
  it("keeps the typed code of a field refusal on create and update, which used to surface as command_failed", async () => {
    await withTempPmPath(async (context) => {
      const created = await runCreate({ title: "seed", type: "Task" }, { path: context.pmPath });
      // Negative control: a hand-built registry bypasses activation, so the reserved field reaches the write path.
      const reserved = createEmptyExtensionRegistrationRegistry();
      reserved.item_fields.push({ layer: "project", name: "bad-fields", fields: [{ name: "priority", type: "string" }] });
      setActiveExtensionRegistrations(reserved);
      await expect(runCreate({ title: "refused", type: "Task" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
        context: { code: "extension_item_field_reserved" },
      });
      await expect(runUpdate(created.item.id, { title: "refused" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
        context: { code: "extension_item_field_reserved" },
      });
      // Two packages that give one field different types are refused with their own code too.
      const conflicting = createEmptyExtensionRegistrationRegistry();
      conflicting.item_fields.push(
        { layer: "project", name: "pkg-a", fields: [{ name: "story_points", type: "number" }] },
        { layer: "project", name: "pkg-b", fields: [{ name: "story_points", type: "string" }] },
      );
      setActiveExtensionRegistrations(conflicting);
      await expect(runUpdate(created.item.id, { title: "refused" }, { path: context.pmPath })).rejects.toMatchObject({
        context: { code: "extension_item_field_type_conflict" },
      });
    });
  });

  it("turns a value that fails its declared type into a usage refusal", () => {
    const registrations = createEmptyExtensionRegistrationRegistry();
    registrations.item_fields.push({ layer: "project", name: "pkg", fields: [{ name: "story_points", type: "number" }] });
    const refusal = (() => {
      try {
        applyRegisteredItemFieldDefaultsForWrite({ story_points: "three" }, registrations);
        return null;
      } catch (error: unknown) {
        return error;
      }
    })();
    expect(refusal).toBeInstanceOf(PmCliError);
    expect(refusal).toMatchObject({ exitCode: EXIT_CODE.USAGE, message: 'Item field "story_points" must be of type number' });
  });
});

describe("an installed package with a reserved field on the built CLI", () => {
  it("keeps create and update working and reports the dropped field in doctor and health", async () => {
    await withTempPmPath(async ({ pmPath, runCli }) => {
      await writeTestExtension({
        root: path.join(pmPath, "extensions", "bad-fields"),
        name: "bad-fields",
        manifestOverrides: { capabilities: ["schema"] },
        entrySource: `export default { activate(api) {
          api.registerItemFields([{ name: "priority", type: "string" }, { name: "review_owner", type: "string" }]);
        } };`,
      });
      const warning = "extension_item_field_reserved:project:bad-fields:priority:rename=bad_fields_priority";
      const created = await runCli(["create", "Task", "--title", "seed", "--field", "review_owner=ada", "--json"], { expectJson: true });
      expect(created.code, created.stderr).toBe(0);
      const id = (JSON.parse(created.stdout) as { item: { id: string } }).item.id;
      const updated = await runCli(["update", id, "--title", "renamed", "--json"], { expectJson: true });
      expect(updated.code, updated.stderr).toBe(0);
      const item = await runCli(["get", id, "--json"], { expectJson: true });
      expect((JSON.parse(item.stdout) as { item: Record<string, unknown> }).item).toMatchObject({ title: "renamed", review_owner: "ada", priority: 2 });
      const doctor = await runCli(["package", "doctor", "--json"], { expectJson: true });
      expect((JSON.parse(doctor.stdout) as { warnings: string[] }).warnings).toContain(warning);
      // The dropped field no longer reaches the MCP input check, which used to be the only diagnostic.
      expect(doctor.stdout).not.toContain("extension_custom_field_mcp_input_collision:project:bad-fields:priority");
      const health = await runCli(["health", "--check-only", "--json"], { expectJson: true });
      expect((JSON.parse(health.stdout) as { warnings: string[] }).warnings).toContain(warning);
    });
  });
});
