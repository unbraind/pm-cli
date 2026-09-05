import { describe, expect, it } from "vitest";
import { runCreate } from "../../../../src/sdk/lifecycle/create.js";
import { runUpdate } from "../../../../src/sdk/lifecycle/update.js";
import { normalizeDependencySeedId } from "../../../../src/sdk/dependency-provenance.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("canonical relationship references", () => {
  it("preserves explicit remote locators without requiring provenance to prevent prefix corruption", () => {
    for (const id of [
      "https://Example.org/Case#42",
      "github:Org/Repo#42",
      "jira:PROJ-123",
      "linear:Team/Case",
    ]) {
      expect(normalizeDependencySeedId(id, "pm-", undefined)).toBe(id);
    }
    expect(normalizeDependencySeedId(" OTHER-Case ", "pm-", "external")).toBe(
      "OTHER-Case",
    );
    expect(normalizeDependencySeedId(" #ABC ", "team-", undefined)).toBe(
      "team-abc",
    );
  });

  it("persists the same canonical local parent on create and update, while preserving remote parents", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      const parent = await runCreate(
        {
          title: "Canonical parent",
          type: "Feature",
          createMode: "progressive",
        },
        global,
      );
      const parentId = String(parent.item.id);
      const child = await runCreate(
        {
          title: "Child",
          type: "Task",
          createMode: "progressive",
          parent: parentId.slice(3).toUpperCase(),
        },
        global,
      );
      expect(child.item.parent).toBe(parentId);
      const childId = String(child.item.id);
      const remote = "https://Example.org/Projects/Root#Case";
      const remoteChild = await runCreate(
        {
          title: "Remote child",
          type: "Task",
          createMode: "progressive",
          parent: remote,
        },
        global,
      );
      expect(remoteChild.item.parent).toBe(remote);
      expect(remoteChild.warnings).not.toContainEqual(
        expect.stringContaining("parent_reference_missing"),
      );
      const changed = await runUpdate(childId, { parent: remote }, global);
      expect(changed.item.parent).toBe(remote);
      expect(changed.warnings).not.toContainEqual(
        expect.stringContaining("parent_reference_missing"),
      );
      const restored = await runUpdate(
        childId,
        { parent: `#${parentId.slice(3)}` },
        global,
      );
      expect(restored.item.parent).toBe(parentId);
      await expect(
        runUpdate(childId, { parent: childId.slice(3) }, global),
      ).rejects.toThrow(/same as item/);
    });
  });
});
