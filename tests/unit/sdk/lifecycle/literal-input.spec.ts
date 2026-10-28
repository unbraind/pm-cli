import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PmClient, PmCliError, withCliMutationInput, withLiteralMutationInput } from "../../../../src/sdk/runtime.js";
import { runCreate } from "../../../../src/sdk/lifecycle/create.js";
import { runUpdate } from "../../../../src/sdk/lifecycle/update.js";
import { runAppend } from "../../../../src/sdk/lifecycle/append.js";
import { runUpdateMany } from "../../../../src/sdk/lifecycle/update-many.js";
import { runDirectDistCli } from "../../../helpers/cliRunner.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

/** Capture the complete authoritative item/history inventory, including unexpected new records. */
async function mutationBytes(pmPath: string) {
  return Promise.all(["tasks", "history"].map(async (folder) => Promise.all(
    (await readdir(path.join(pmPath, folder))).sort().map(async (file) => [path.join(folder, file), await readFile(path.join(pmPath, folder, file), "utf8")]),
  )));
}

describe("literal SDK mutation inputs (pm-gh1614, pm-gh1606)", () => {
  it("round-trips free text sentinels through native create, update and append without reading stdin", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const stdin = vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => {
        throw new Error("Implicit SDK stdin read");
      });
      try {
        for (const value of ["-", "none", "null", "@missing-file"]) {
          const { item } = await client.create({ type: "Task", title: value, description: value, body: value, assignee: value, goal: value, createMode: "progressive" });
          expect(item).toMatchObject({ title: value, description: value, assignee: value, goal: value });
          const updated = await client.update(item.id, { description: value, body: value, assignee: value, goal: value });
          expect(updated.item).toMatchObject({ description: value, assignee: value, goal: value });
          expect((await client.append(item.id, value)).appended).toBe(value);
          expect((await client.get(item.id)).item.body).toContain(value);
        }
        expect(stdin).not.toHaveBeenCalled();
      } finally {
        stdin.mockRestore();
      }
    });
  });

  it("retains literal collection entries, generic SDK dispatch and explicit unset", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const { item } = await client.create({ type: "Task", title: "Literal collections", comment: ["none"], note: ["null"], learning: ["-"], createMode: "progressive" });
      expect((await client.get(item.id, { full: true })).item).toMatchObject({ comments: [expect.objectContaining({ text: "none" })], notes: [expect.objectContaining({ text: "null" })], learnings: [expect.objectContaining({ text: "-" })] });
      await client.run("update", { id: item.id, options: { assignee: "none", description: "-", comment: "null" } });
      expect((await client.get(item.id)).item).toMatchObject({ assignee: "none", description: "-" });
      expect((await client.get(item.id, { full: true })).item.comments).toEqual(expect.arrayContaining([expect.objectContaining({ text: "null" })]));
      await client.update(item.id, { unset: ["assignee"] });
      expect((await client.get(item.id)).item.assignee).toBeUndefined();
      const raw = { assignee: "none" };
      const cli = withCliMutationInput(raw);
      expect(cli).not.toBe(raw);
      await client.update(item.id, cli);
      expect((await client.get(item.id)).item.assignee).toBeUndefined();
      await client.update(item.id, withLiteralMutationInput(cli));
      expect((await client.get(item.id)).item.assignee).toBe("none");
      expect(raw).toEqual({ assignee: "none" });
    });
  });

  it("refuses malformed runtime operands with typed usage errors and no document or history writes", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const { item } = await client.create({ type: "Task", title: "Runtime values", createMode: "progressive" });
      const document = await client.get(item.id);
      const bytes = await mutationBytes(pmPath);
      const historyPath = path.join(pmPath, "history", `${item.id}.jsonl`);
      const history = await readFile(historyPath, "utf8");
      const fixtures = [
        { action: "append", field: "body", call: () => client.append(item.id, { text: "wrong shape" } as never) },
        { action: "update", field: "estimatedMinutes", call: () => client.update(item.id, { estimatedMinutes: 2 as never }) },
        { action: "create", field: "title", call: () => client.create({ type: "Task", title: {} as never }) },
        { action: "update", field: "description", call: () => client.update(item.id, { description: {} as never }) },
        { action: "update", field: "force", call: () => client.run("update", { id: item.id, options: { force: "false", title: "Changed" } }) },
        { action: "update", field: "comment", call: () => client.update(item.id, { comment: [1] as never }) },
        { action: "update", field: "acceptanceCriteria", call: () => client.update(item.id, { acceptanceCriteria: ["wrong shape"] as never }) },
        { action: "append", field: "force", call: () => client.append(item.id, "unchanged", { force: "false" as never }) },
        { action: "append", field: "id", call: () => client.append({ id: item.id } as never, "unchanged") },
        { action: "create", field: "options", call: () => runCreate(null as never, { path: pmPath }) },
        { action: "create", field: "options", call: () => runCreate([] as never, { path: pmPath }) },
        { action: "create", field: "options", call: () => runCreate(7 as never, { path: pmPath }) },
        { action: "update", field: "priority", call: () => client.update(item.id, { priority: Number.NaN }) },
        { action: "update", field: "priority", call: () => client.update(item.id, { priority: {} as never }) },
        { action: "update", field: "comment", call: () => client.update(item.id, { comment: new Array<string>(1) }) },
        { action: "append", field: "options", call: () => client.append(item.id, "unchanged", null as never) },
        { action: "update", field: "id", call: () => runUpdate({ id: item.id } as never, { title: "unchanged" }, { path: pmPath }) },
        { action: "create", field: "comment", call: () => runCreate({ type: "Task", title: "unchanged", comment: "scalar" as never }, { path: pmPath }) },
        { action: "create", field: "comment", call: () => runCreate({ type: "Task", title: "unchanged", comment: [1] as never }, { path: pmPath }) },
      ];
      for (const { action, field, call } of fixtures) {
        const error: unknown = await call().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(PmCliError);
        expect(error).toMatchObject({ exitCode: 2, code: "invalid_argument_value", context: { field, changed: false } });
        expect((error as Error).message).toContain(action);
        expect((error as PmCliError).context.required).toBeTruthy();
        expect(await mutationBytes(pmPath)).toEqual(bytes);
      }
      expect(await client.get(item.id)).toEqual(document);
      expect(await readFile(historyPath, "utf8")).toBe(history);
      expect((await client.update(item.id, { estimatedMinutes: "2", priority: 2 })).item).toMatchObject({ estimated_minutes: 2, priority: 2 });
      expect((await client.append(item.id, "valid body")).appended).toBe("valid body");
    });
  });

  it("keeps direct SDK operations literal while real CLI stdin and legacy clear directives still decode", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot, env }) => {
      const global = { path: pmPath };
      const { item } = await runCreate({ type: "Task", title: "Direct SDK", description: "-", assignee: "none", createMode: "progressive" }, global);
      expect(item).toMatchObject({ description: "-", assignee: "none" });
      expect((await runUpdate(item.id, { assignee: "null", body: "-" }, global)).item.assignee).toBe("null");
      expect((await runAppend(item.id, { body: "-" }, global)).appended).toBe("-");
      await runUpdateMany({ list: { ids: item.id }, update: { assignee: "none", description: "-" } }, global);
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      expect((await client.get(item.id)).item).toMatchObject({ assignee: "none", description: "-" });
      const cli = (args: string[], input?: string) => runDirectDistCli([...args, "--json", "--no-extensions"], { cwd: tempRoot, env, input, expectJson: true });
      expect(cli(["update", item.id, "--description", "-"], "piped description").code).toBe(0);
      expect(cli(["append", item.id, "-"], "piped body").code).toBe(0);
      expect(cli(["update-many", "--ids", item.id, "--assignee", "none"]).code).toBe(0);
      expect((await client.get(item.id)).item).toMatchObject({ description: "piped description", body: expect.stringContaining("piped body") });
      expect((await client.get(item.id)).item.assignee).toBeUndefined();
      const created = cli(["create", "--stdin-json", "--create-mode", "progressive"], JSON.stringify({ type: "Task", title: "JSON values", description: "-", body: "-", assignee: "none", goal: "null" }));
      expect(created.code, created.stderr).toBe(0);
      const payload = JSON.parse(created.stdout);
      const jsonId = payload.id ?? payload.item.id;
      expect((await client.get(jsonId)).item).toMatchObject({ description: "-", assignee: "none", goal: "null" });
      const updated = cli(["update", jsonId, "--stdin-json"], JSON.stringify({ description: "-", assignee: "null" }));
      expect(updated.code, updated.stderr).toBe(0);
      expect((await client.get(jsonId)).item).toMatchObject({ description: "-", assignee: "null" });
    });
  });
});
