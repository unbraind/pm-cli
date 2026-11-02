import { AsyncResource } from "node:async_hooks";
import { appendFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hashDocument } from "../../../../src/core/history/history.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import {
  advanceItemMutationPreconditions,
  assertItemMutationPreconditions,
} from "../../../../src/core/store/item-mutation-precondition.js";
import {
  bindItemRevisionScope,
  createItemRevisionScope,
  describeItemRevisionChanges,
  dispatchWithExpectedItemRevisions,
  enrichItemRevisionConflict,
  isItemRevisionConflict,
  ITEM_REVISION_CONFLICT_CHANGE_LIMIT,
  itemRevisionScopeReceipt,
  normalizeExpectedItemHash,
  parseExpectHashSpecs,
  readItemRevision,
  resolveExpectedItemRevisions,
  runWithBoundItemRevisionScope,
  runWithItemRevisionScope,
  withExpectedItemRevisions,
} from "../../../../src/sdk/lifecycle/item-revision.js";
import { PmClient, runAction } from "../../../../src/sdk/runtime.js";
import { commitWorkspaceTransaction } from "../../../../src/sdk/workspace-transaction.js";
import type { ItemDocument } from "../../../../src/types/index.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";
import { withTempPmPath, type TempPmContext } from "../../../helpers/withTempPmPath.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function client(context: TempPmContext): PmClient {
  return new PmClient({ pmRoot: context.pmPath, noExtensions: true, author: "revision-agent" });
}

async function captureError(run: () => Promise<unknown>): Promise<PmCliError> {
  try {
    await run();
  } catch (error) {
    return error as PmCliError;
  }
  throw new Error("expected a refusal");
}

describe("pm-gh1576 expected-revision token grammar", () => {
  it("parses bare, targeted and comma-separated tokens and normalizes case", () => {
    expect(parseExpectHashSpecs(undefined)).toEqual([]);
    expect(parseExpectHashSpecs([])).toEqual([]);
    expect(parseExpectHashSpecs(HASH_A.toUpperCase())).toEqual([{ itemHash: HASH_A }]);
    expect(parseExpectHashSpecs([`pm-a=${HASH_A}, pm-b=${HASH_B}`, ` ${HASH_B} `])).toEqual([
      { id: "pm-a", itemHash: HASH_A },
      { id: "pm-b", itemHash: HASH_B },
      { itemHash: HASH_B },
    ]);
    expect(normalizeExpectedItemHash(` ${HASH_B.toUpperCase()} `)).toBe(HASH_B);
  });

  it("refuses malformed tokens with a typed usage error naming the input", () => {
    for (const bad of ["abc", `=${HASH_A}`, `pm-a=${HASH_A.slice(1)}`]) {
      expect(() => parseExpectHashSpecs(bad)).toThrow(
        expect.objectContaining({ exitCode: EXIT_CODE.USAGE, context: expect.objectContaining({ code: "expect_hash_invalid" }) }),
      );
    }
    expect(() => parseExpectHashSpecs([7 as unknown as string])).toThrow(
      expect.objectContaining({ context: expect.objectContaining({ code: "expect_hash_invalid", value: "7" }) }),
    );
    expect(() => normalizeExpectedItemHash(undefined)).toThrow(expect.objectContaining({ context: expect.objectContaining({ code: "expect_hash_invalid" }) }));
  });
});

describe("pm-gh1576 revision scope", () => {
  it("binds one tracker, refuses conflicting duplicates and reports unchecked entries", () => {
    const scope = createItemRevisionScope();
    bindItemRevisionScope(scope, "/tracker", [{ id: "pm-a", itemHash: HASH_A }, { id: "pm-a", itemHash: HASH_A }]);
    expect(itemRevisionScopeReceipt(scope)).toEqual({ checked: [], unchecked: ["pm-a"] });
    expect(() => bindItemRevisionScope(scope, "/tracker", [{ id: "pm-a", itemHash: HASH_B }])).toThrow(
      expect.objectContaining({ context: expect.objectContaining({ code: "expected_revision_duplicate", item_id: "pm-a" }) }),
    );
    expect(() => bindItemRevisionScope(scope, "/elsewhere", [])).toThrow(
      expect.objectContaining({ context: expect.objectContaining({ code: "expected_revision_scope_conflict" }) }),
    );
  });

  it("only evaluates expectations bound to the written tracker and item", async () => {
    const document = { metadata: { id: "pm-a", title: "A" }, body: "" } as unknown as ItemDocument;
    const current = hashDocument(document);
    const unbound = createItemRevisionScope();
    const other = createItemRevisionScope();
    bindItemRevisionScope(other, "/other", [{ id: "pm-a", itemHash: HASH_A }]);
    const matching = createItemRevisionScope();
    bindItemRevisionScope(matching, "/tracker", [{ id: "pm-a", itemHash: current }, { id: "pm-z", itemHash: HASH_B }]);
    await runWithItemRevisionScope(unbound, () => runWithItemRevisionScope(other, () => runWithItemRevisionScope(matching, async () => {
      assertItemMutationPreconditions("/tracker", document);
      const after = { ...document, metadata: { ...document.metadata, title: "B" } } as ItemDocument;
      advanceItemMutationPreconditions("/tracker", after);
      assertItemMutationPreconditions("/tracker", after);
      expect(() => assertItemMutationPreconditions("/tracker", document)).toThrow(/Earlier writes by this same invocation already committed/u);
    })));
    expect(itemRevisionScopeReceipt(other)).toEqual({ checked: [], unchecked: ["pm-a"] });
    expect(itemRevisionScopeReceipt(matching)).toEqual({ checked: ["pm-a"], unchecked: ["pm-z"] });
    // Outside any scope, writes advance nothing and assert nothing.
    advanceItemMutationPreconditions("/tracker", document);
    assertItemMutationPreconditions("/tracker", document);
  });

  it("passes non-revision failures through an unbound scope unchanged", async () => {
    const failure = new Error("boom");
    await expect(runWithBoundItemRevisionScope(createItemRevisionScope(), () => Promise.reject(failure))).rejects.toBe(failure);
  });
});

describe("pm-gh1576 read-decide-write through the SDK", () => {
  it("reports item_hash on get, equal to the latest history after_hash and readItemRevision", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Revision source" });
      const pm = client(context);
      const revision = await pm.readItemRevision(id);
      const read = await pm.get(id);
      expect(read.item_hash).toBe(revision.item_hash);
      expect(await readItemRevision(id, { pmRoot: context.pmPath })).toEqual({ id, item_hash: revision.item_hash });
      const history = context.runCli(["history", id, "--full", "--json"], { expectJson: true }).json as {
        history: Array<{ after_hash: string }>;
      };
      expect(history.history.at(-1)?.after_hash).toBe(revision.item_hash);
      expect((await pm.get(id, { fields: ["id", "item_hash"] })).item_hash).toBe(revision.item_hash);
      expect((await pm.get(id, { fields: ["id"] })).item_hash).toBeUndefined();
      expect((await pm.get(id, { at: "1" })).item_hash).toBeUndefined();
      await expect(readItemRevision("pm-missing", { pmRoot: context.pmPath })).rejects.toMatchObject({ context: { code: "item_not_found" } });
    });
  });

  it("refuses a stale close with bounded change evidence and admits the fresh revision", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Close guard" });
      const pm = client(context);
      const decided = (await pm.readItemRevision(id)).item_hash;
      await pm.update(id, { tags: "delivery-pr:2" });
      const refusal = await captureError(() => pm.withExpectedItemRevisions([{ id, itemHash: decided }], () => pm.close(id, "Delivered by PR 1")));
      expect(isItemRevisionConflict(refusal)).toBe(true);
      expect(refusal.exitCode).toBe(EXIT_CODE.CONFLICT);
      expect(refusal.message).toContain("Nothing was written to this item.");
      const current = (await pm.readItemRevision(id)).item_hash;
      expect(refusal.context).toMatchObject({
        item_id: id,
        expected_revision: decided,
        current_revision: current,
        details: {
          expected_revision_recorded: true,
          changes_since: [expect.objectContaining({ op: "update", fields: expect.arrayContaining(["tags"]) })],
          changes_since_omitted: 0,
        },
      });
      expect((await pm.get(id)).item.status).not.toBe("closed");
      const closed = await pm.withExpectedItemRevisions([{ id, itemHash: current }], () => pm.close(id, "Delivered by PR 2"));
      expect(closed).toMatchObject({ checked: [id], unchecked: [], result: { item: { status: "closed" } } });
    });
  });

  it("advances past its own committed writes but refuses an interleaved peer write", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Multi-write" });
      const pm = client(context);
      const peer = new PmClient({ pmRoot: context.pmPath, noExtensions: true, author: "peer-agent" });
      const start = (await pm.readItemRevision(id)).item_hash;
      const outcome = await pm.withExpectedItemRevisions([{ id, itemHash: start }], async () => {
        await pm.claim(id);
        return pm.update(id, { priority: "1" });
      });
      expect(outcome).toMatchObject({ checked: [id], unchecked: [] });
      // Bound outside the scope, the peer write runs without it, like a separate process.
      const peerWrite = AsyncResource.bind(() => peer.update(id, { title: "Peer edit" }));
      const next = (await pm.readItemRevision(id)).item_hash;
      const interleaved = await captureError(() => withExpectedItemRevisions([{ id, itemHash: next }], async () => {
        await pm.update(id, { priority: "2" });
        await peerWrite();
        return pm.update(id, { priority: "3" });
      }, { pmRoot: context.pmPath }));
      expect(interleaved.context.code).toBe("item_revision_conflict");
      expect(interleaved.message).toContain("Earlier writes by this same invocation already committed.");
      expect((await pm.get(id)).item).toMatchObject({ title: "Peer edit", priority: 2 });
    });
  });

  it("reports an unrecorded revision, bounds the change list and tolerates unreadable history", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Change bound" });
      const pm = client(context);
      const decided = (await pm.readItemRevision(id)).item_hash;
      for (let index = 0; index < ITEM_REVISION_CONFLICT_CHANGE_LIMIT + 2; index += 1) {
        await pm.update(id, { priority: String(index % 4) });
      }
      const bounded = await describeItemRevisionChanges(context.pmPath, id, decided);
      expect(bounded?.changes_since).toHaveLength(ITEM_REVISION_CONFLICT_CHANGE_LIMIT);
      expect(bounded?.changes_since_omitted).toBe(2);
      expect(await describeItemRevisionChanges(context.pmPath, id, HASH_A)).toEqual({
        expected_revision_recorded: false,
        changes_since: [],
        changes_since_omitted: 0,
      });
      const unrecorded = await captureError(() => withExpectedItemRevisions([{ id, itemHash: HASH_A }], () => pm.update(id, { priority: "0" }), { pmRoot: context.pmPath }));
      expect(unrecorded.context.details).toMatchObject({ expected_revision_recorded: false });
      await pm.update(id, { body: "Body edited by a peer" });
      expect((await describeItemRevisionChanges(context.pmPath, id, decided))?.changes_since.at(-1)?.fields).toEqual(["body", "updated_at"]);
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const conflict = new PmCliError("stale", EXIT_CODE.CONFLICT, { code: "item_revision_conflict", item_id: id, expected_revision: decided });
      await appendFile(historyPath, "{not json\n");
      expect(await enrichItemRevisionConflict(conflict, context.pmPath)).toBe(conflict);
      expect(await describeItemRevisionChanges(context.pmPath, id, decided)).toBeUndefined();
      await rm(historyPath);
      await mkdir(historyPath);
      expect(await describeItemRevisionChanges(context.pmPath, id, decided)).toBeUndefined();
    });
  });

  it("leaves non-conflict, already-enriched and incomplete refusals untouched", async () => {
    const plain = new Error("plain");
    expect(await enrichItemRevisionConflict(plain, "/tracker")).toBe(plain);
    const enriched = new PmCliError("x", EXIT_CODE.CONFLICT, { code: "item_revision_conflict", item_id: "pm-a", expected_revision: HASH_A, details: { kept: true } });
    expect(await enrichItemRevisionConflict(enriched, "/tracker")).toBe(enriched);
    const incomplete = new PmCliError("x", EXIT_CODE.CONFLICT, { code: "item_revision_conflict" });
    expect(await enrichItemRevisionConflict(incomplete, "/tracker")).toBe(incomplete);
    const missingHistory = new PmCliError("x", EXIT_CODE.CONFLICT, { code: "item_revision_conflict", item_id: "pm-a", expected_revision: HASH_A });
    expect(await enrichItemRevisionConflict(missingHistory, "/nonexistent-tracker")).toMatchObject({
      message: "x",
      context: { details: { expected_revision_recorded: false, changes_since: [] } },
    });
  });

  it("guards annotations, linked artifacts, delete and restore under the same lock", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Every writer" });
      const pm = client(context);
      const stale = (await pm.readItemRevision(id)).item_hash;
      await pm.update(id, { title: "Every writer, edited by a peer" });
      const guarded = (run: () => Promise<unknown>) => captureError(() => withExpectedItemRevisions([{ id, itemHash: stale }], run, { pmRoot: context.pmPath }));
      for (const run of [
        () => pm.run("comments", { id, options: { add: "late evidence" } }),
        () => pm.run("files", { id, options: { add: ["path=src/a.ts,scope=project"] } }),
        () => pm.run("restore", { id, target: "1" }),
        () => pm.run("delete", { id }),
      ]) {
        expect((await guarded(run)).context.code).toBe("item_revision_conflict");
      }
      const kept = await pm.get(id, { full: true });
      expect(kept.item.title).toBe("Every writer, edited by a peer");
      expect(kept.item.collection_counts).toMatchObject({ comments: 0, files: 0 });
      const fresh = (await pm.readItemRevision(id)).item_hash;
      const restored = await withExpectedItemRevisions([{ id, itemHash: fresh }], () => pm.run("restore", { id, target: "1" }), { pmRoot: context.pmPath });
      expect(restored.checked).toEqual([id]);
    });
  });

  it("requires a target for bare tokens and resolves unprefixed ids canonically", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Target binding" });
      await expect(resolveExpectedItemRevisions(context.pmPath, [{ itemHash: HASH_A }])).rejects.toMatchObject({
        context: { code: "expect_hash_target_required" },
      });
      await expect(resolveExpectedItemRevisions(context.pmPath, [{ itemHash: HASH_A }], " ")).rejects.toMatchObject({
        context: { code: "expect_hash_target_required" },
      });
      expect(await resolveExpectedItemRevisions(context.pmPath, [{ itemHash: HASH_A }], id.replace(/^pm-/u, ""))).toEqual([{ id, itemHash: HASH_A }]);
    });
  });
});

describe("pm-gh1576 generic dispatch (MCP and PmClient.run)", () => {
  it("binds bare hashes to the action id and refuses stale writes through runAction", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Dispatch guard" });
      const common = { path: context.pmPath, noExtensions: true, author: "mcp-agent" };
      const stale = (await readItemRevision(id, { pmRoot: context.pmPath })).item_hash;
      await runAction({ ...common, action: "update", id, options: { title: "Peer retitle" } });
      await expect(runAction({ ...common, action: "update", id, options: { priority: "2" }, expectHash: stale })).rejects.toMatchObject({
        context: { code: "item_revision_conflict", details: { expected_revision_recorded: true } },
      });
      await expect(runAction({ ...common, action: "update", id, options: { priority: "2" }, expect_hash: [`${id}=${stale}`] })).rejects.toMatchObject({
        context: { code: "item_revision_conflict" },
      });
      const fresh = (await readItemRevision(id, { pmRoot: context.pmPath })).item_hash;
      expect(await runAction({ ...common, action: "update", id, options: { priority: "2" }, expectHash: fresh })).toMatchObject({ id });
      await expect(runAction({ ...common, action: "get", id, expectHash: fresh })).rejects.toMatchObject({
        context: { code: "expect_hash_requires_mutation" },
      });
      await expect(runAction({ ...common, action: "update", id, options: { priority: "3" }, expectHash: 5 })).rejects.toMatchObject({
        context: { code: "expect_hash_invalid", value: "5" },
      });
      await expect(runAction({ ...common, action: "update", id, options: { priority: "3" }, expectHash: () => fresh })).rejects.toMatchObject({
        context: { code: "expect_hash_invalid", value: expect.stringContaining("=>") },
      });
      const unchecked = (await runAction({ ...common, action: "comments", id, expectHash: [] }));
      expect(unchecked).toMatchObject({ id });
    });
  });

  it("admits extension actions, preserves non-object results and appends unchecked warnings", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Receipts" });
      const pmRoot = context.pmPath;
      expect(await dispatchWithExpectedItemRevisions({ action: "beads import", expectHash: [], pmRoot, run: async () => 1 })).toBe(1);
      expect(await dispatchWithExpectedItemRevisions({ action: "vendor-sync", expectHash: HASH_A, defaultId: id, pmRoot, run: async () => "done" })).toBe("done");
      expect(await dispatchWithExpectedItemRevisions({ action: "vendor-sync", expectHash: HASH_A, defaultId: id, pmRoot, run: async () => [1] })).toEqual([1]);
      expect(await dispatchWithExpectedItemRevisions({ action: "comments", expectHash: HASH_A, defaultId: id, pmRoot, run: async () => ({ warnings: ["kept"] }) })).toEqual({
        warnings: ["kept", `expect_hash_unchecked:${id}:no_locked_write_reached_this_item`],
      });
      expect(await dispatchWithExpectedItemRevisions({ action: "comments", expectHash: HASH_A, defaultId: id, pmRoot, run: async () => ({}) })).toEqual({
        warnings: [`expect_hash_unchecked:${id}:no_locked_write_reached_this_item`],
      });
    });
  });
});

describe("GH-1620 workspace transaction isolation", () => {
  it("lets an ordinary writer interleave, and an expected revision turns the lost update into a refusal", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Transaction target" });
      const pm = client(context);
      const peer = new PmClient({ pmRoot: context.pmPath, noExtensions: true, author: "peer-agent" });
      let observed = "";
      const runStep = (guarded: boolean, transactionId: string) => commitWorkspaceTransaction({
        pmRoot: context.pmPath,
        transactionId,
        author: "revision-agent",
        steps: [{
          id: "retitle",
          async inspect() {
            observed = (await pm.readItemRevision(id)).item_hash;
            return { state: "pending" };
          },
          async apply() {
            // A peer outside the transaction commits between inspect() and apply().
            await peer.update(id, { title: `Peer ${transactionId}` });
            const write = () => pm.update(id, { title: `Transaction ${transactionId}` });
            if (guarded) await withExpectedItemRevisions([{ id, itemHash: observed }], write, { pmRoot: context.pmPath });
            else await write();
            return null;
          },
          async compensate() {},
        }],
      });
      // Negative control: without the precondition the transaction silently overwrites the peer.
      await runStep(false, "tx-unguarded");
      expect((await pm.get(id)).item.title).toBe("Transaction tx-unguarded");
      await expect(runStep(true, "tx-guarded")).rejects.toMatchObject({ context: { code: "item_revision_conflict" } });
      expect((await pm.get(id)).item.title).toBe("Peer tx-guarded");
    });
  });
});
