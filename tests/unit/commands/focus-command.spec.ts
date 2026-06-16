import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCreate } from "../../../src/cli/commands/create.js";
import { runFocus } from "../../../src/cli/commands/focus.js";
import { runDelete } from "../../../src/cli/commands/delete.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { getFocusedItem } from "../../../src/core/session/session-state.js";
import type { TempPmContext } from "../../helpers/withTempPmPath.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

async function seedItem(context: TempPmContext, title = "focus-parent"): Promise<string> {
  const created = await runCreate(
    {
      title,
      description: `${title} description`,
      type: "Epic",
      status: "open",
      priority: "1",
      createMode: "progressive",
    },
    { path: context.pmPath },
  );
  return created.item.id;
}

describe("runFocus", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-focus-not-init-"));
    try {
      await expect(runFocus("pm-missing", {}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("sets focus to an existing item and persists it", async () => {
    await withTempPmPath(async (context) => {
      const id = await seedItem(context);
      const result = await runFocus(id, {}, { path: context.pmPath });
      expect(result.action).toBe("set");
      expect(result.focused_item).toBe(id);
      expect(result.title).toBe("focus-parent");
      expect(result.message).toContain(id);
      expect(result.message).toContain("focus-parent");
      expect(await getFocusedItem(context.pmPath)).toBe(id);
    });
  });

  it("sets focus and omits the title hint when the item has no title", async () => {
    await withTempPmPath(async (context) => {
      const id = await seedItem(context, "");
      const result = await runFocus(id, {}, { path: context.pmPath });
      expect(result.action).toBe("set");
      // An item created with an empty title yields a null title hint.
      expect(result.title).toBeNull();
      // No title, so the "Focused on <id> (title)" suffix is omitted.
      expect(result.message).toContain(`Focused on ${id}. New items`);
    });
  });

  it("shows no focus when nothing is set", async () => {
    await withTempPmPath(async (context) => {
      const result = await runFocus(undefined, {}, { path: context.pmPath });
      expect(result.action).toBe("show");
      expect(result.focused_item).toBeNull();
      expect(result.title).toBeNull();
      expect(result.message).toContain("No focus set");
    });
  });

  it("shows the current focus with its title", async () => {
    await withTempPmPath(async (context) => {
      const id = await seedItem(context);
      await runFocus(id, {}, { path: context.pmPath });
      const result = await runFocus(undefined, {}, { path: context.pmPath });
      expect(result.action).toBe("show");
      expect(result.focused_item).toBe(id);
      expect(result.title).toBe("focus-parent");
      expect(result.message).toContain("(focus-parent)");
    });
  });

  it("shows the current focus with a null title when the focused item has no title", async () => {
    await withTempPmPath(async (context) => {
      const id = await seedItem(context, "");
      await runFocus(id, {}, { path: context.pmPath });
      const result = await runFocus(undefined, {}, { path: context.pmPath });
      expect(result.action).toBe("show");
      expect(result.focused_item).toBe(id);
      expect(result.title).toBeNull();
      expect(result.message).not.toContain("(");
    });
  });

  it("shows the current focus without a title hint when the focused item was deleted", async () => {
    await withTempPmPath(async (context) => {
      const id = await seedItem(context);
      await runFocus(id, {}, { path: context.pmPath });
      await runDelete(id, { force: true }, { path: context.pmPath });
      const result = await runFocus(undefined, {}, { path: context.pmPath });
      expect(result.action).toBe("show");
      expect(result.focused_item).toBe(id);
      expect(result.title).toBeNull();
      expect(result.message).not.toContain("(");
    });
  });

  it("clears the focus", async () => {
    await withTempPmPath(async (context) => {
      const id = await seedItem(context);
      await runFocus(id, {}, { path: context.pmPath });
      const result = await runFocus(undefined, { clear: true }, { path: context.pmPath });
      expect(result.action).toBe("clear");
      expect(result.focused_item).toBeNull();
      expect(result.message).toContain("Focus cleared");
      expect(await getFocusedItem(context.pmPath)).toBeUndefined();
    });
  });

  it("rejects a nonexistent item id with a not-found error", async () => {
    await withTempPmPath(async (context) => {
      await expect(runFocus("pm-zzzz", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("rejects --clear combined with an id as a usage error", async () => {
    await withTempPmPath(async (context) => {
      await expect(runFocus("pm-1234", { clear: true }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });
});

describe("runCreate focus inheritance (GH-161)", () => {
  it("inherits the focused item as the default parent and reports parent_source", async () => {
    await withTempPmPath(async (context) => {
      const parentId = await seedItem(context, "focus-epic");
      await runFocus(parentId, {}, { path: context.pmPath });
      const child = await runCreate(
        {
          title: "child task",
          description: "child task description",
          type: "Task",
          status: "open",
          priority: "2",
          createMode: "progressive",
        },
        { path: context.pmPath },
      );
      expect(child.item.parent).toBe(parentId);
      expect(child.parent_source).toBe("focus");
    });
  });

  it("lets an explicit --parent override the focused item", async () => {
    await withTempPmPath(async (context) => {
      const focusedId = await seedItem(context, "focus-epic");
      const otherId = await seedItem(context, "other-epic");
      await runFocus(focusedId, {}, { path: context.pmPath });
      const child = await runCreate(
        {
          title: "explicit parent task",
          description: "explicit parent description",
          type: "Task",
          status: "open",
          priority: "2",
          createMode: "progressive",
          parent: otherId,
        },
        { path: context.pmPath },
      );
      expect(child.item.parent).toBe(otherId);
      expect(child.parent_source).toBeUndefined();
    });
  });

  it("does not inherit a parent once focus is cleared", async () => {
    await withTempPmPath(async (context) => {
      const parentId = await seedItem(context, "focus-epic");
      await runFocus(parentId, {}, { path: context.pmPath });
      await runFocus(undefined, { clear: true }, { path: context.pmPath });
      const orphan = await runCreate(
        {
          title: "orphan task",
          description: "orphan description",
          type: "Task",
          status: "open",
          priority: "2",
          createMode: "progressive",
        },
        { path: context.pmPath },
      );
      expect(orphan.item.parent).toBeUndefined();
      expect(orphan.parent_source).toBeUndefined();
    });
  });

  it("surfaces the missing-parent error path when the focused item is stale", async () => {
    await withTempPmPath(async (context) => {
      const parentId = await seedItem(context, "focus-epic");
      await runFocus(parentId, {}, { path: context.pmPath });
      await runDelete(parentId, { force: true }, { path: context.pmPath });
      await expect(
        runCreate(
          {
            title: "stale parent task",
            description: "stale parent description",
            type: "Task",
            status: "open",
            priority: "2",
            createMode: "progressive",
          },
          { path: context.pmPath },
        ),
      ).rejects.toBeInstanceOf(PmCliError);
    });
  });
});
