/** @module tests/integration/dependencies/registered-kind-mutations */
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetActiveExtensionRuntimeState, setActiveExtensionRegistrations } from "../../../src/core/extensions/index.js";
import { runCreate } from "../../../src/sdk/lifecycle/create.js";
import { runUpdate } from "../../../src/sdk/lifecycle/update.js";
import { runUpdateMany } from "../../../src/sdk/lifecycle/update-many.js";
import { assembleWorkspaceRelationshipGraph } from "../../../src/sdk/graph/assembly.js";
import { activateExtensionForTest } from "../../../src/sdk/testing.js";
import type { RelationshipKindDefinition } from "../../../src/sdk/relationships.js";
import { writeTestExtension } from "../../helpers/extensions.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

const orderingKind: RelationshipKindDefinition = {
  kind: "ships_before", aliases: ["precedes_ship"], direction: "directed",
  ordering: true, precedence: "source_before_target", hierarchy: false,
  outgoing: "many", incoming: "many", lifecycle: "persistent",
  compatibilityVersion: 1, allowSelf: false,
};

/** Capture authoritative bytes, including the history stream, before refusal. */
async function itemBytes(context: TempPmContext, id: string): Promise<string[]> {
  return Promise.all([
    readFile(path.join(context.pmPath, "tasks", `${id}.toon`), "utf8"),
    readFile(path.join(context.pmPath, "history", `${id}.jsonl`), "utf8"),
  ]);
}

afterEach(() => resetActiveExtensionRuntimeState());

describe("registered relationship mutation admission", () => {
  it("admits at most one of two real writers targeting a single incoming slot", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"), directory: "single-shipping-domain",
        manifest: { name: "single-shipping-domain", version: "1.0.0", entry: "index.mjs", capabilities: ["schema"] },
        entryFilename: "index.mjs",
        entrySource: `export default { activate(api) { api.registerRelationshipKinds([${JSON.stringify({ ...orderingKind, incoming: "one" })}]); } };`,
      });
      const create = (id: string) => context.runCli(["create", "--id", id, "--title", id, "--type", "Task", "--create-mode", "progressive", "--json"], { expectJson: true });
      for (const id of ["pm-one-slot", "pm-writer-a", "pm-writer-b"]) expect(create(id).code).toBe(0);
      const execute = promisify(execFile);
      const results = await Promise.allSettled(["pm-writer-a", "pm-writer-b"].map((id) => execute(process.execPath,
        [path.resolve("dist/cli.js"), "update", id, "--dep", "id=pm-one-slot,kind=ships_before", "--json"],
        { cwd: context.tempRoot, env: context.env, timeout: 20_000 },
      )));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const stored = ["pm-writer-a", "pm-writer-b"].map((id) => context.runCli(["get", id, "--full", "--json"], { expectJson: true }));
      expect(stored.every((result) => result.code === 0)).toBe(true);
      expect(stored.flatMap((result) => (result.json as { item: { dependencies?: unknown[] } }).item.dependencies ?? [])).toHaveLength(1);
    });
  });
  it("enforces non-hierarchy outgoing and incoming cardinality atomically", async () => {
    await withTempPmPath(async (context) => {
      const activation = await activateExtensionForTest(
        { activate: (api) => api.registerRelationshipKinds([{ ...orderingKind, outgoing: "one", incoming: "one" }]) },
        { name: "single-shipping-domain", capabilities: ["schema"] },
      );
      setActiveExtensionRegistrations(activation.registrations);
      const global = { path: context.pmPath };
      const create = (title: string) => runCreate({ title, type: "Task", createMode: "progressive" }, global);
      const first = await create("First target");
      const second = await create("Second target");
      const source = await create("Single source");
      await runUpdate(source.item.id, { dep: [`id=${first.item.id},kind=precedes_ship`] }, global);
      const before = await itemBytes(context, source.item.id);
      await expect(runUpdate(source.item.id, { dep: [`id=${second.item.id},kind=ships_before`] }, global)).rejects.toMatchObject({ code: "dependency_cardinality_created" });
      expect(await itemBytes(context, source.item.id)).toEqual(before);
      const other = await create("Other source");
      const otherBefore = await itemBytes(context, other.item.id);
      await expect(runUpdate(other.item.id, { dep: [`id=${first.item.id},kind=ships_before`] }, global)).rejects.toMatchObject({ code: "dependency_cardinality_created" });
      expect(await itemBytes(context, other.item.id)).toEqual(otherBefore);
      await expect(runCreate({ title: "Invalid two targets", type: "Task", createMode: "progressive", dep: [
        `id=${first.item.id},kind=ships_before`, `id=${second.item.id},kind=ships_before`,
      ] }, global)).rejects.toMatchObject({ code: "dependency_cardinality_created" });
      const replaced = await runUpdate(source.item.id, { depRemove: [`id=${first.item.id},kind=ships_before`], dep: [`id=${second.item.id},kind=precedes_ship`] }, global);
      expect(replaced.item.dependencies).toMatchObject([{ id: second.item.id, kind: "ships_before" }]);
    });
  });
  it("uses active aliases for SDK create, update, bulk mutation, removal and cycle advice", async () => {
    await withTempPmPath(async (context) => {
      const activation = await activateExtensionForTest(
        { activate: (api) => api.registerRelationshipKinds([orderingKind]) },
        { name: "shipping-domain", capabilities: ["schema"] },
      );
      expect(activation.failed).toEqual([]);
      setActiveExtensionRegistrations(activation.registrations);
      const global = { path: context.pmPath };
      const target = await runCreate({ title: "Ship target", type: "Task", createMode: "progressive" }, global);
      const source = await runCreate({
        title: "Ship source", type: "Task", createMode: "progressive",
        dep: [`id=${target.item.id},type=PRECEDES-SHIP`],
      }, global);
      expect(source.item.dependencies).toMatchObject([{ id: target.item.id, kind: "ships_before" }]);
      await expect(runUpdate(source.item.id, { dep: [`id=${target.item.id},kind=missing_kind`] }, global)).rejects.toMatchObject({
        context: { recovery: { allowed_values: expect.arrayContaining(["ships_before", "precedes_ship"]) } },
      });
      const graph = assembleWorkspaceRelationshipGraph([source.item, target.item]);
      expect(graph.graph.adjacency(source.item.id, { kinds: ["precedes_ship"] }).value).toEqual([target.item.id]);
      const cycled = await runUpdate(target.item.id, { dep: [`id=${source.item.id},kind=ships_before`] }, global);
      expect(cycled.warnings).toContainEqual(expect.stringContaining("ordering_cycle_created:"));
      await runUpdate(target.item.id, { depRemove: [`id=${source.item.id},kind=PRECEDES-SHIP`] }, global);
      const bulk = await runUpdateMany({ list: { ids: [target.item.id] }, update: { dep: [`id=${source.item.id},kind=precedes_ship`] } }, global);
      expect(bulk.updated_count).toBe(1);
      const before = await itemBytes(context, source.item.id);
      resetActiveExtensionRuntimeState();
      await expect(runUpdate(source.item.id, { dep: [`id=${target.item.id},kind=ships_before`] }, global)).rejects.toMatchObject({
        context: expect.objectContaining({ field: "kind", value: "ships_before" }),
      });
      expect(await itemBytes(context, source.item.id)).toEqual(before);
    });
  });

  it("loads a real schema extension for CLI writes and refuses suppressed registration without changing bytes", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"), directory: "shipping-domain",
        manifest: { name: "shipping-domain", version: "1.0.0", entry: "index.mjs", capabilities: ["schema"] },
        entryFilename: "index.mjs",
        entrySource: `export default { activate(api) { api.registerRelationshipKinds([${JSON.stringify(orderingKind)}]); } };`,
      });
      const create = (id: string, extra: string[] = []) => context.runCli([
        "create", "--id", id, "--title", id, "--type", "Task", "--create-mode", "progressive", "--json", ...extra,
      ], { expectJson: true });
      expect(create("pm-ship-target").code).toBe(0);
      const source = create("pm-ship-source", ["--dep", "id=pm-ship-target,kind=precedes_ship"]);
      expect(source.code, source.stderr).toBe(0);
      expect(source.json).toMatchObject({ item: { dependencies: [{ kind: "ships_before" }] } });
      const updated = context.runCli(["update", "pm-ship-target", "--dep", "id=pm-ship-source,kind=ships_before", "--json"], { expectJson: true });
      expect(updated.code, updated.stderr).toBe(0);
      const before = await itemBytes(context, "pm-ship-source");
      const refused = context.runCli(["--no-extensions", "update", "pm-ship-source", "--dep", "id=pm-ship-target,kind=ships_before", "--json"], { expectJson: true });
      expect(refused.code).not.toBe(0);
      expect(await itemBytes(context, "pm-ship-source")).toEqual(before);
    });
  });

  it("enforces registered hierarchy cardinality before persistence", async () => {
    await withTempPmPath(async (context) => {
      const activation = await activateExtensionForTest(
        { activate: (api) => api.registerRelationshipKinds([{ ...orderingKind,
          kind: "belongs_to", aliases: [], ordering: false, precedence: undefined,
          hierarchy: true, hierarchyDirection: "target_parent", outgoing: "one",
        }]) }, { name: "hierarchy-domain", capabilities: ["schema"] },
      );
      setActiveExtensionRegistrations(activation.registrations);
      const global = { path: context.pmPath };
      const create = (title: string) => runCreate({ title, type: "Task", createMode: "progressive" }, global);
      const first = await create("First parent");
      const second = await create("Second parent");
      const child = await create("Child");
      await runUpdate(child.item.id, { dep: [`id=${first.item.id},kind=belongs_to`] }, global);
      const before = await itemBytes(context, child.item.id);
      await expect(runUpdate(child.item.id, { dep: [`id=${second.item.id},kind=belongs_to`] }, global)).rejects.toMatchObject({ code: "hierarchy_cardinality_created" });
      expect(await itemBytes(context, child.item.id)).toEqual(before);
    });
  });
});
