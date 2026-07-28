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
    expect(() =>
      defineWorkspaceRecipe({ ...RECIPE, clock: "not-a-clock" }),
    ).toThrow("Invalid reproducible workspace clock");
    expect(() => defineWorkspaceRecipe({ ...RECIPE, tickMs: -1 })).toThrow(
      "tickMs must be a non-negative integer",
    );
    expect(() => defineWorkspaceRecipe({ ...RECIPE, tickMs: 0.5 })).toThrow(
      "tickMs must be a non-negative integer",
    );
    expect(() => defineWorkspaceRecipe({ ...RECIPE, seed: "" })).toThrow(
      "seed must not be empty",
    );
  });

  it("deeply detaches, validates, and freezes portable JSON operation input", () => {
    const nested = {
      values: [null, true, 1, "value", { nested: "original" }],
      nullPrototype: Object.assign(Object.create(null) as Record<string, string>, {
        value: "portable",
      }),
    };
    const defined = defineWorkspaceRecipe({
      ...RECIPE,
      operations: [{ action: "portable", input: nested }],
    });
    (nested.values[4] as { nested: string }).nested = "mutated";

    expect(defined.operations[0]?.input).toEqual({
      values: [null, true, 1, "value", { nested: "original" }],
      nullPrototype: { value: "portable" },
    });
    expect(Object.isFrozen(defined.operations[0]?.input)).toBe(true);
    expect(
      Object.isFrozen(
        (defined.operations[0]!.input.values as readonly unknown[])[4],
      ),
    ).toBe(true);

    for (const invalid of [Number.NaN, undefined, () => undefined, new Date()]) {
      expect(() =>
        defineWorkspaceRecipe({
          ...RECIPE,
          operations: [
            {
              action: "invalid",
              input: { invalid } as never,
            },
          ],
        }),
      ).toThrow(/JSON/);
    }
  });

  it("isolates concurrent deterministic scopes and validates token lengths", async () => {
    const run = (seed: string, clock: string) =>
      runWithWorkspaceRecipe(
        { ...RECIPE, seed, clock, operations: [] },
        async () => {
          await Promise.resolve();
          return {
            first: nextReproducibleToken(8),
            timestamp: nowIso(),
            second: nextReproducibleToken(8),
            empty: nextReproducibleToken(0),
          };
        },
      );
    const [first, second] = await Promise.all([
      run("concurrent-first", "2026-07-28T11:00:00.000Z"),
      run("concurrent-second", "2026-07-28T12:00:00.000Z"),
    ]);

    expect(first.timestamp).toBe("2026-07-28T11:00:00.000Z");
    expect(second.timestamp).toBe("2026-07-28T12:00:00.000Z");
    expect(first.first).not.toBe(second.first);
    expect(first.empty).toBe("");
    await runWithWorkspaceRecipe(RECIPE, async () => {
      for (const length of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5, 1_025]) {
        expect(() => nextReproducibleToken(length)).toThrow(
          "must be an integer between 0 and 1024",
        );
      }
    });
  });

  it("enforces the unannotated recipe schema and exact top-level contract", () => {
    const compileOnly = () => {
      defineWorkspaceRecipe({
        // @ts-expect-error unsupported recipe schemas fail at the call site
        schema: "unsupported",
        seed: "seed",
        clock: "2026-07-28T10:00:00.000Z",
        tickMs: 0,
        operations: [],
      });
      defineWorkspaceRecipe({
        schema: PM_WORKSPACE_RECIPE_SCHEMA,
        seed: "seed",
        clock: "2026-07-28T10:00:00.000Z",
        tickMs: 0,
        operations: [],
        // @ts-expect-error undeclared top-level recipe keys are rejected
        undeclared: true,
      });
    };
    expect(compileOnly).toBeTypeOf("function");
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
