import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

/**
 * End-to-end coverage for the schema-customization lifecycle shipped in PR #106:
 * `pm schema add-type` -> create an item of the custom type -> enforce per-type
 * workflow transitions under `governance.workflow_enforcement` -> `pm schema
 * remove-type` (warning when items still reference the type) -> verify the type
 * is gone. Unit tests exercise the individual resolvers; this fills the
 * integration gap recorded in pm-4dtf so the wiring across config, runtime
 * schema files, create/update enforcement, and removal stays correct.
 */
describe("schema customization lifecycle", () => {
  it("adds a custom type, enforces per-type workflows, then removes it with an items warning", async () => {
    await withTempPmPath(async (context) => {
      const addType = context.runCli(
        ["schema", "add-type", "Spike", "--description", "Exploration spike", "--json"],
        { expectJson: true },
      );
      expect(addType.code).toBe(0);
      expect(addType.json).toMatchObject({ action: "add-type", registered: true, type: { name: "Spike" } });

      const create = context.runCli(["create", "Spike", "Investigate caching", "--json"], { expectJson: true });
      expect(create.code).toBe(0);
      const createdId = (create.json as { item: { id: string; type: string; status: string } }).item.id;
      expect((create.json as { item: { type: string; status: string } }).item).toMatchObject({
        type: "Spike",
        status: "open",
      });

      const enforce = context.runCli(["config", "set", "governance-workflow-enforcement", "strict", "--json"], {
        expectJson: true,
      });
      expect(enforce.code).toBe(0);
      expect(enforce.json).toMatchObject({ key: "governance_workflow_enforcement", policy: "strict", changed: true });

      // Per-type workflow: open -> in_progress and in_progress -> done are the
      // only permitted transitions; open -> done must be rejected.
      await writeFile(
        path.join(context.pmPath, "schema", "workflows.json"),
        `${JSON.stringify(
          {
            type_workflows: [
              {
                type: "Spike",
                allowed_transitions: [
                  ["open", "in_progress"],
                  ["in_progress", "done"],
                ],
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const disallowed = context.runCli(["update", createdId, "--status", "done", "--json"]);
      expect(disallowed.code).toBe(2);
      const disallowedError = JSON.parse(disallowed.stderr) as { code: string; detail: string };
      expect(disallowedError.code).toBe("command_failed");
      expect(disallowedError.detail).toContain('Disallowed transition for type "Spike"');
      expect(disallowedError.detail).toContain("open -> done");

      const allowed = context.runCli(["update", createdId, "--status", "in_progress", "--json"], { expectJson: true });
      expect(allowed.code).toBe(0);
      expect((allowed.json as { item: { status: string } }).item.status).toBe("in_progress");

      const rejectedSkip = context.runCli(["create", "Spike", "Second spike", "--json"], { expectJson: true });
      expect(rejectedSkip.code).toBe(0);
      const secondId = (rejectedSkip.json as { item: { id: string } }).item.id;

      const removeType = context.runCli(["schema", "remove-type", "Spike", "--json"], { expectJson: true });
      expect(removeType.code).toBe(0);
      expect(removeType.json).toMatchObject({ action: "remove-type", removed: true });
      // Two Spike items still exist, so removal must warn rather than silently drop the type.
      expect((removeType.json as { warnings: string[] }).warnings).toContain("items_using_type:2");

      const showRemoved = context.runCli(["schema", "show", "Spike", "--json"]);
      expect(showRemoved.code).not.toBe(0);
      expect((JSON.parse(showRemoved.stderr) as { code: string }).code).toBe("unknown_item_type");

      const recreateRejected = context.runCli(["create", "Spike", "Third spike", "--json"]);
      expect(recreateRejected.code).not.toBe(0);
      expect((JSON.parse(recreateRejected.stderr) as { code: string }).code).toBe("invalid_argument_value");

      // Removing a type drops its storage-folder mapping, so the previously
      // created items are no longer resolvable by the store. This is precisely
      // why remove-type emits the `items_using_type` warning above rather than
      // silently dropping the type.
      const orphaned = context.runCli(["get", secondId, "--json"]);
      expect(orphaned.code).toBe(3);
      expect((JSON.parse(orphaned.stderr) as { code: string }).code).toBe("item_not_found");

      const list = context.runCli(["list", "--json"], { expectJson: true });
      expect(list.code).toBe(0);
      expect((list.json as { items: unknown[] }).items).toHaveLength(0);
    });
  });
});
