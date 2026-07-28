import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateItemId } from "../../../src/core/item/id.js";
import { nextReproducibleToken } from "../../../src/core/reproducibility/context.js";
import { nowIso } from "../../../src/core/shared/time.js";
import {
  PM_WORKSPACE_RECIPE_SCHEMA,
  create as createItem,
  createWorkspaceSnapshot,
  defineWorkspaceRecipe,
  executeWorkspaceRecipe,
  runWithWorkspaceRecipe,
  type WorkspaceRecipe,
} from "../../../src/sdk/index.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const RECIPE: WorkspaceRecipe = {
  schema: PM_WORKSPACE_RECIPE_SCHEMA,
  seed: "reproducible-spec-seed",
  clock: "2026-07-28T10:00:00.000Z",
  tickMs: 5,
  operations: [
    { action: "create", input: { title: "First" } },
    { action: "create", input: { title: "Second" } },
  ],
};

describe("workspace recipes", () => {
  it("replays deterministic identifiers, time, and declared operation order", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const replay = async () =>
        executeWorkspaceRecipe(RECIPE, async (operation, index) => ({
          action: operation.action,
          title: operation.input.title,
          id: await generateItemId(pmPath, "pm-", { probeExisting: false }),
          timestamp: nowIso(),
          index,
        }));

      expect(await replay()).toEqual(await replay());
      expect((await replay()).map((entry) => entry.timestamp)).toEqual([
        "2026-07-28T10:00:00.000Z",
        "2026-07-28T10:00:00.005Z",
      ]);
    });
  });

  it("keeps deterministic execution isolated and validates portable recipes", async () => {
    expect(nextReproducibleToken(8)).toBeUndefined();
    const outside = nowIso();
    const inside = await runWithWorkspaceRecipe(RECIPE, async () => nowIso());
    expect(inside).toBe(RECIPE.clock);
    expect(nowIso()).not.toBe(inside);
    expect(Date.parse(outside)).toBeLessThanOrEqual(Date.now());

    expect(defineWorkspaceRecipe(RECIPE)).toEqual(RECIPE);
    expect(() =>
      defineWorkspaceRecipe({ ...RECIPE, schema: "unsupported" as WorkspaceRecipe["schema"] }),
    ).toThrow("Unsupported workspace recipe schema");
    expect(() =>
      defineWorkspaceRecipe({
        ...RECIPE,
        operations: [{ action: " ", input: {} }],
      }),
    ).toThrow("require an action");
    await expect(
      runWithWorkspaceRecipe({ ...RECIPE, clock: "not-a-clock" }, async () => undefined),
    ).rejects.toThrow("Invalid reproducible workspace clock");
    await expect(
      runWithWorkspaceRecipe({ ...RECIPE, tickMs: -1 }, async () => undefined),
    ).rejects.toThrow("tickMs must be a non-negative integer");
    await expect(
      runWithWorkspaceRecipe({ ...RECIPE, tickMs: 0.5 }, async () => undefined),
    ).rejects.toThrow("tickMs must be a non-negative integer");
    await expect(
      runWithWorkspaceRecipe({ ...RECIPE, seed: "" }, async () => undefined),
    ).rejects.toThrow("seed must not be empty");
  });

  it("produces byte-identical caller-owned artifacts across isolated roots", async () => {
    await withTempPmPath(async (first) => {
      await withTempPmPath(async (second) => {
        const render = async (pmPath: string) =>
          runWithWorkspaceRecipe(RECIPE, async () => {
            const artifact = {
              id: await generateItemId(pmPath, "pm-", { probeExisting: false }),
              created_at: nowIso(),
              updated_at: nowIso(),
            };
            const target = path.join(pmPath, "recipe-artifact.json");
            await writeFile(target, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
            return readFile(target);
          });
        expect(await render(first.pmPath)).toEqual(await render(second.pmPath));
      });
    });
  });

  it("constructs byte-identical authoritative workspaces through real SDK mutations", async () => {
    await withTempPmPath(async (first) => {
      await withTempPmPath(async (second) => {
        const construct = async (pmPath: string, cwd: string) => {
          await executeWorkspaceRecipe(RECIPE, async (operation) =>
            createItem(
              {
                title: String(operation.input.title),
                type: "Task",
                status: "open",
                createMode: "progressive",
              },
              {
                pmRoot: pmPath,
                cwd,
                author: "workspace-recipe-test",
                noExtensions: true,
              },
            ),
          );
          return (await createWorkspaceSnapshot(pmPath)).manifest.fingerprint;
        };

        expect(await construct(first.pmPath, first.tempRoot)).toBe(
          await construct(second.pmPath, second.tempRoot),
        );
      });
    });
  });
});
