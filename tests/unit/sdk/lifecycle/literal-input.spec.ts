import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PmClient, PmCliError, withCliMutationInput, withLiteralMutationInput } from "../../../../src/sdk/runtime.js";
import { runCreate } from "../../../../src/sdk/lifecycle/create.js";
import { runReopenUpdate, runUpdate } from "../../../../src/sdk/lifecycle/update.js";
import { runReopen } from "../../../../src/sdk/lifecycle/reopen.js";
import { runAppend } from "../../../../src/sdk/lifecycle/append.js";
import { runUpdateMany } from "../../../../src/sdk/lifecycle/update-many.js";
import { itemDocumentToMutationOptions } from "../../../../src/sdk/structured-mutations.js";
import { normalizeCreateOptions, normalizeUpdateOptions } from "../../../../src/sdk/cli-contracts/registration-helpers.js";
import { runDirectDistCli } from "../../../helpers/cliRunner.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

/** Capture the complete authoritative item/history inventory, including unexpected new records. */
async function mutationBytes(pmPath: string) {
  return Promise.all(["tasks", "history"].map(async (folder) => Promise.all(
    (await readdir(path.join(pmPath, folder))).sort().map(async (file) => [path.join(folder, file), await readFile(path.join(pmPath, folder, file), "utf8")]),
  )));
}

describe("literal SDK mutation inputs (pm-gh1614, pm-gh1606)", () => {
  it("preserves JSON data while explicit CLI scalar, alias and collection flags still clear", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot, env }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const cli = (args: string[], input: object) => runDirectDistCli([...args, "--stdin-json", "--json", "--no-extensions"], { cwd: tempRoot, env, input: JSON.stringify(input), expectJson: true });
      let id = "";
      for (const token of ["none", "null"]) {
        const created = cli(["create", "--create-mode", "progressive", "--assignee", token], { type: "Task", title: `Mixed JSON ${token}`, goal: token, tags: [token] });
        expect(created.code, created.stderr).toBe(0);
        const payload = JSON.parse(created.stdout);
        id = payload.id ?? payload.item.id;
        expect((await client.get(id)).item).toMatchObject({ goal: token, tags: [token] });
        expect((await client.get(id)).item.assignee).toBeUndefined();
        const updated = cli(["update", id, "--assignee", token], { assignee: "document owner", goal: token });
        expect(updated.code, updated.stderr).toBe(0);
        expect((await client.get(id)).item.assignee).toBeUndefined();
        expect((await client.get(id)).item.goal).toBe(token);
      }
      const alias = cli(["update", id, "--ac", "none"], { acceptance_criteria: "document criteria", assignee: "none" });
      expect(alias.code, alias.stderr).toBe(0);
      expect((await client.get(id)).item).toMatchObject({ assignee: "none" });
      expect((await client.get(id)).item.acceptance_criteria).toBeUndefined();
      const empty = cli(["update", id, "--assignee", "none"], {});
      expect(empty.code, empty.stderr).toBe(0);
      expect((await client.get(id)).item.assignee).toBeUndefined();
      const collection = cli(["create", "--create-mode", "progressive", "--comment", "none"], { type: "Task", title: "Mixed JSON collections", comments: [{ text: "none" }], notes: [{ text: "null" }] });
      expect(collection.code, collection.stderr).toBe(0);
      const payload = JSON.parse(collection.stdout);
      const item = (await client.get(payload.id ?? payload.item.id, { full: true })).item;
      expect(item.comments ?? []).toHaveLength(0);
      expect(item.notes).toEqual([expect.objectContaining({ text: "null" })]);
      await client.update(item.id, { comment: ["snapshot comment"] });
      const document = (await client.get(item.id, { full: true })).item;
      const restored = cli(["update", item.id, "--comment", "none"], document);
      expect(restored.code, restored.stderr).toBe(0);
      const after = (await client.get(item.id, { full: true })).item;
      expect(after.comments ?? []).toHaveLength(0);
      expect(after.notes).toEqual(document.notes);
      const global = { path: pmPath };
      const nativeCreated = await runCreate(withCliMutationInput(normalizeCreateOptions(itemDocumentToMutationOptions(JSON.stringify({ type: "Task", title: "SDK mixed document", description: "-", goal: "none", tags: ["none"], notes: [{ text: "null" }] }), "create", { assignee: "none", createMode: "progressive" }), { requireType: false })), global);
      expect(nativeCreated.item).toMatchObject({ description: "-", goal: "none", tags: ["none"], notes: [expect.objectContaining({ text: "null" })] });
      expect(nativeCreated.item.assignee).toBeUndefined();
      const nativeUpdated = await runUpdate(nativeCreated.item.id, withCliMutationInput(normalizeUpdateOptions(itemDocumentToMutationOptions(JSON.stringify({ assignee: "document owner", goal: "null", tags: ["null"] }), "update", { assignee: "none" }))), global);
      expect(nativeUpdated.item).toMatchObject({ goal: "null", tags: ["null"] });
      expect(nativeUpdated.item.assignee).toBeUndefined();
    });
  });

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
      const shared = ["none"];
      const source = { comment: shared };
      const literal = withLiteralMutationInput(source);
      await client.update(item.id, literal);
      await client.update(item.id, withCliMutationInput({ comment: shared }));
      expect((await client.get(item.id, { full: true })).item.comments ?? []).toHaveLength(0);
      expect(source.comment).toBe(shared);
      expect(literal.comment).not.toBe(shared);
      await client.update(item.id, withCliMutationInput(literal));
      expect((await client.get(item.id, { full: true })).item.comments).toEqual([expect.objectContaining({ text: "none" })]);
      await client.update(item.id, withCliMutationInput({ comment: literal.comment }));
      expect((await client.get(item.id, { full: true })).item.comments ?? []).toHaveLength(0);
      await client.update(item.id, source);
      expect(source.comment).toBe(shared);
      await client.update(item.id, withCliMutationInput(source));
      expect((await client.get(item.id, { full: true })).item.comments ?? []).toHaveLength(0);
      const document = itemDocumentToMutationOptions(JSON.stringify({ comments: [{ text: "seed" }] }), "create");
      const documentValues = document.comment as string[];
      documentValues[0] = "none";
      await client.update(item.id, { comment: ["existing"] });
      await client.update(item.id, withCliMutationInput({ comment: documentValues }));
      expect((await client.get(item.id, { full: true })).item.comments ?? []).toHaveLength(0);
      expect(document.comment).toBe(documentValues);
      const created = await client.create(withCliMutationInput({ type: "Task", title: "Independent collection policy", comment: shared, createMode: "progressive" }));
      expect(created.item.comments ?? []).toHaveLength(0);
      await client.update(item.id, withCliMutationInput({ acceptanceCriteria: "client CLI criteria", ac: ["client CLI criteria"] }));
      expect((await client.get(item.id)).item.acceptance_criteria).toBe("client CLI criteria");
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
        { action: "update", field: "id", call: () => runReopenUpdate({ id: item.id } as never, { status: "open" }, { path: pmPath }, "Invalid ID must not mutate") },
        { action: "update", field: "id", call: () => runReopenUpdate(42 as never, { status: "open" }, { path: pmPath }, "Invalid ID must not mutate") },
        { action: "reopen", field: "reason", call: () => runReopen(item.id, 42 as never, {}, { path: pmPath }) },
        { action: "reopen", field: "options", call: () => runReopen(item.id, "Reason", null as never, { path: pmPath }) },
        { action: "reopen", field: "expectedResult", call: () => runReopen(item.id, "Reason", { expectedResult: 42 as never }, { path: pmPath }) },
        { action: "reopen", field: "status", call: () => runReopen(item.id, "Reason", { status: 42 as never }, { path: pmPath }) },
        { action: "reopen", field: "author", call: () => runReopen(item.id, "Reason", { author: 42 as never }, { path: pmPath }) },
        { action: "reopen", field: "message", call: () => runReopen(item.id, "Reason", { message: 42 as never }, { path: pmPath }) },
        { action: "reopen", field: "force", call: () => runReopen(item.id, "Reason", { force: "false" as never }, { path: pmPath }) },
        { action: "reopen", field: "reason", call: () => runReopenUpdate(item.id, { status: "open" }, { path: pmPath }, undefined as never) },
        { action: "reopen", field: "reason", call: () => client.reopen(item.id, 42 as never) },
        { action: "reopen", field: "id", call: () => client.reopen(42 as never, "Reason") },
        { action: "reopen", field: "force", call: () => client.reopen(item.id, "Reason", { force: "false" as never }) },
        { action: "create", field: "comment", call: () => runCreate({ type: "Task", title: "unchanged", comment: "scalar" as never }, { path: pmPath }) },
        { action: "create", field: "comment", call: () => runCreate({ type: "Task", title: "unchanged", comment: [1] as never }, { path: pmPath }) },
        { action: "create", field: "title", call: () => runCreate(withCliMutationInput({ type: "Task", title: 42 as never }), { path: pmPath }) },
        { action: "update", field: "estimatedMinutes", call: () => runUpdate(item.id, withCliMutationInput({ estimatedMinutes: 2 as never }), { path: pmPath }) },
        { action: "create", field: "ac", call: () => runCreate(withCliMutationInput({ type: "Task", title: "unchanged", ac: [1] }), { path: pmPath }) },
        { action: "update", field: "ac", call: () => client.update(item.id, withCliMutationInput({ acceptanceCriteria: "unchanged", ac: [1] })) },
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
      await expect(client.run("item-reopen", { reason: "Missing ID" })).rejects.toThrow(/id/i);
      await expect(client.run("item-reopen", { id: item.id })).rejects.toThrow(/reason/i);
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
      const bulk = cli(["update-many", "--ids", item.id, "--ac", "bulk criteria"]);
      expect(bulk.code, bulk.stderr + bulk.stdout).toBe(0);
      expect((await client.get(item.id)).item.acceptance_criteria).toBe("bulk criteria");
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
