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

  it("derives the rename prefix from the package name without its scope", () => {
    expect(formatReservedItemFieldWarning("global", "@unbrained/pm-Story.Points", "status")).toBe(
      "extension_item_field_reserved:global:@unbrained/pm-Story.Points:status:rename=pm_story_points_status",
    );
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
