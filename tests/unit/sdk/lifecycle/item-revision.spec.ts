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
  bindExpectedItemRevisions,
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
  throwFirstItemRevisionConflict,
  withExpectedItemRevisions,
} from "../../../../src/sdk/lifecycle/item-revision.js";
import { PmClient, runAction } from "../../../../src/sdk/runtime.js";
import { commitWorkspaceTransaction } from "../../../../src/sdk/workspace-transaction.js";
import type { ItemDocument } from "../../../../src/types/index.js";
import { pmToolActionParameterKeys, resolvePmToolCustomFieldCollision } from "../../../../src/sdk/cli-contracts/tool-schema.js";
import { splitExpectHashInput } from "../../../../src/sdk/runtime/expect-hash-input.js";
import { verifyHistoryRewriteNoDrift } from "../../../../src/core/history/history-rewrite.js";
import { readSettings } from "../../../../src/core/store/settings.js";
import { resolveItemTypeRegistry } from "../../../../src/core/item/type-registry.js";
import { readFile, writeFile } from "node:fs/promises";
import { writeTestExtension } from "../../../helpers/extensions.js";
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

  it("refuses a supplied but empty value instead of dropping the guard", () => {
    for (const empty of ["", "   ", " , ,", [HASH_A, ""]]) {
      expect(() => parseExpectHashSpecs(empty)).toThrow(
        expect.objectContaining({ context: expect.objectContaining({ code: "expect_hash_invalid" }) }),
      );
    }
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

  it("discloses earlier committed writes even when they returned the item to its declared revision", async () => {
    const tombstone = { metadata: { id: "pm-a" }, body: "" } as unknown as ItemDocument;
    const restored = { metadata: { id: "pm-a", title: "Restored" }, body: "" } as unknown as ItemDocument;
    const scope = createItemRevisionScope();
    bindItemRevisionScope(scope, "/tracker", [{ id: "pm-a", itemHash: hashDocument(tombstone) }]);
    await runWithItemRevisionScope(scope, async () => {
      expect(() => assertItemMutationPreconditions("/tracker", restored)).toThrow(/Nothing was written to this item/u);
      // Restore, then delete: the expectation is back at the declared tombstone, yet two writes committed.
      advanceItemMutationPreconditions("/tracker", restored);
      advanceItemMutationPreconditions("/tracker", tombstone);
      expect(() => assertItemMutationPreconditions("/tracker", restored)).toThrow(/Earlier writes by this same invocation already committed/u);
    });
  });

  it("matches a write reached through another spelling of the same item", async () => {
    const document = { metadata: { id: "pm-a", title: "A" }, body: "" } as unknown as ItemDocument;
    const scope = createItemRevisionScope();
    bindItemRevisionScope(scope, "/tracker", [{ id: "pm-a", itemHash: HASH_A }]);
    await runWithItemRevisionScope(scope, async () => {
      // A case-insensitive filesystem locks the probe spelling PM-A; the embedded id still matches.
      expect(() => assertItemMutationPreconditions("/tracker", document, "PM-A")).toThrow(expect.objectContaining({ context: expect.objectContaining({ code: "item_revision_conflict" }) }));
    });
    expect(itemRevisionScopeReceipt(scope).checked).toEqual(["pm-a"]);
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

  it("keeps item.item_hash projecting a custom metadata field of that name while bare item_hash selects the revision", async () => {
    await withTempPmPath(async (context) => {
      const added = context.runCli(["schema", "add-field", "item_hash", "--type", "string", "--commands", "create,update", "--cli-flag", "--business-hash", "--json"], { expectJson: true });
      expect(added.code, added.stderr).toBe(0);
      const created = context.runCli(["create", "--title", "Custom hash field", "--type", "Task", "--description", "d", "--business-hash", "business-value", "--json"], { expectJson: true });
      expect(created.code, created.stderr).toBe(0);
      const id = String((created.json as { item: { id: string } }).item.id);
      const pm = client(context);
      const revision = (await pm.readItemRevision(id)).item_hash;
      const qualified = await pm.get(id, { fields: ["id", "item.item_hash"] });
      expect(qualified.item).toMatchObject({ id, item_hash: "business-value" });
      expect(qualified.item_hash).toBeUndefined();
      const bare = await pm.get(id, { fields: ["id", "item_hash"] });
      expect(bare.item_hash).toBe(revision);
      expect(bare.item).not.toHaveProperty("item_hash");
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

  it("recognizes a revision conflict raised through another SDK bundle's error class", () => {
    const foreign = Object.assign(new Error("stale"), { name: "PmCliError", exitCode: EXIT_CODE.CONFLICT, context: { code: "item_revision_conflict" } });
    expect(foreign).not.toBeInstanceOf(PmCliError);
    expect(isItemRevisionConflict(foreign)).toBe(true);
    expect(isItemRevisionConflict(Object.assign(new Error("other"), { name: "PmCliError", exitCode: 4, context: { code: "stale_revision" } }))).toBe(false);
    expect(isItemRevisionConflict(new Error("plain"))).toBe(false);
  });

  it("re-raises the first revision conflict a best-effort batch collected, and nothing otherwise", () => {
    const first = Object.assign(new Error("stale a"), { name: "PmCliError", exitCode: EXIT_CODE.CONFLICT, context: { code: "item_revision_conflict" } });
    const second = Object.assign(new Error("stale b"), { name: "PmCliError", exitCode: EXIT_CODE.CONFLICT, context: { code: "item_revision_conflict" } });
    expect(() => throwFirstItemRevisionConflict([new Error("io"), first, second])).toThrow(first);
    expect(() => throwFirstItemRevisionConflict([new Error("io"), "string failure"])).not.toThrow();
    expect(() => throwFirstItemRevisionConflict([])).not.toThrow();
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
      // Bindings use the embedded identity, whatever spelling located the file.
      expect(await resolveExpectedItemRevisions(context.pmPath, [{ itemHash: HASH_A }], id.toUpperCase())).toEqual([{ id, itemHash: HASH_A }]);
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

describe("pm-gh1576 guarded writes beyond the item store", () => {
  it("guards history maintenance at its lock and advances past its own rewrite", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Redact guard", description: "contains token-abc" });
      const pm = client(context);
      const stale = (await pm.readItemRevision(id)).item_hash;
      await pm.update(id, { title: "Redact guard, edited by a peer" });
      await expect(withExpectedItemRevisions([{ id, itemHash: stale }], () => pm.run("history-redact", { id, options: { literal: ["token-abc"] } }), { pmRoot: context.pmPath }))
        .rejects.toMatchObject({ context: { code: "item_revision_conflict" } });
      const fresh = (await pm.readItemRevision(id)).item_hash;
      const redacted = await withExpectedItemRevisions([{ id, itemHash: fresh }], async () => {
        await pm.run("history-redact", { id, options: { literal: ["token-abc"] } });
        return pm.update(id, { priority: "3" });
      }, { pmRoot: context.pmPath });
      expect(redacted).toMatchObject({ checked: [id], unchecked: [] });
    });
  });

  it("judges restore of a deleted item under its own id and lets one scope delete then restore", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Tombstone guard" });
      const pm = client(context);
      const peer = new PmClient({ pmRoot: context.pmPath, noExtensions: true, author: "peer-agent" });
      const decided = (await pm.readItemRevision(id)).item_hash;
      const peerDelete = AsyncResource.bind(() => peer.run("delete", { id, force: true }));
      await expect(withExpectedItemRevisions([{ id, itemHash: decided }], async () => {
        await peerDelete();
        return pm.run("restore", { id, target: "1", force: true });
      }, { pmRoot: context.pmPath })).rejects.toMatchObject({ context: { code: "item_revision_conflict", item_id: id } });
      await pm.run("restore", { id, target: "1", force: true });
      const restored = (await pm.readItemRevision(id)).item_hash;
      const cycle = await withExpectedItemRevisions([{ id, itemHash: restored }], async () => {
        await pm.run("delete", { id, force: true });
        return pm.run("restore", { id, target: "1", force: true });
      }, { pmRoot: context.pmPath });
      expect(cycle.checked).toEqual([id]);
    });
  });

  it("keeps the typed conflict on stale bulk rows", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Bulk stale" });
      const pm = client(context);
      const stale = (await pm.readItemRevision(id)).item_hash;
      await pm.update(id, { title: "Bulk stale, edited by a peer" });
      const current = (await pm.readItemRevision(id)).item_hash;
      const common = { path: context.pmPath, noExtensions: true, author: "bulk-agent", expectHash: `${id}=${stale}` };
      const updated = await runAction({ ...common, action: "update-many", options: { ids: id, priority: "3" } }) as { rows: Array<Record<string, unknown>> };
      expect(updated.rows).toEqual([expect.objectContaining({
        id, status: "failed", error_code: "item_revision_conflict", expected_revision: stale, current_revision: current,
        details: expect.objectContaining({ expected_revision_recorded: true, changes_since: [expect.objectContaining({ op: "update" })] }),
      })]);
      const closed = await runAction({ ...common, action: "close-many", options: { ids: id, reason: "bulk" } }) as { rows: Array<Record<string, unknown>> };
      expect(closed.rows).toEqual([expect.objectContaining({ id, status: "failed", error_code: "item_revision_conflict", current_revision: current })]);
    });
  });

  it("keeps the typed conflict on stale bulk rollback rows", async () => {
    await withTempPmPath(async (context) => {
      const [updatedId, closedId] = [createTestItemId(context, { title: "Rollback update" }), createTestItemId(context, { title: "Rollback close" })];
      const pm = client(context);
      const common = { path: context.pmPath, noExtensions: true, author: "bulk-agent" };
      const updated = await runAction({ ...common, action: "update-many", options: { ids: updatedId, priority: "3" } }) as { checkpoint: { id: string } };
      const closed = await runAction({ ...common, action: "close-many", options: { ids: closedId, reason: "bulk" } }) as { checkpoint: { id: string } };
      const stale = new Map<string, string>();
      for (const id of [updatedId, closedId]) {
        stale.set(id, (await pm.readItemRevision(id)).item_hash);
        await pm.update(id, { title: `${id}, edited by a peer` });
      }
      for (const [action, id, checkpoint] of [["update-many", updatedId, updated.checkpoint.id], ["close-many", closedId, closed.checkpoint.id]] as const) {
        const current = (await pm.readItemRevision(id)).item_hash;
        const rolled = await runAction({ ...common, expectHash: `${id}=${stale.get(id)!}`, action, options: { rollback: checkpoint } }) as { rows: Array<Record<string, unknown>> };
        expect(rolled.rows).toEqual([expect.objectContaining({
          id, status: "failed", error_code: "item_revision_conflict", expected_revision: stale.get(id), current_revision: current,
          details: expect.objectContaining({ changes_since: [expect.objectContaining({ op: "update" })] }),
        })]);
      }
    });
  });

  it("refuses typed after close's auto-unblock fan-out reaches stale guarded dependents, disclosing the committed close", async () => {
    await withTempPmPath(async (context) => {
      const blocker = createTestItemId(context, { title: "Fan-out blocker" });
      const dependents = [createTestItemId(context, { title: "Dependent one" }), createTestItemId(context, { title: "Dependent two" })].sort((left, right) => left.localeCompare(right));
      for (const id of dependents) {
        const blocked = context.runCli(["update", id, "--status", "blocked", "--blocked-by", blocker, "--blocked-reason", "waiting", "--json"], { expectJson: true });
        expect(blocked.code, blocked.stderr).toBe(0);
      }
      const pm = client(context);
      const stale = [];
      for (const id of dependents) {
        stale.push({ id, itemHash: (await pm.readItemRevision(id)).item_hash });
        await pm.update(id, { title: `${id}, edited by a peer` });
      }
      const refusal = await captureError(() => pm.withExpectedItemRevisions(stale, () => pm.close(blocker, "Delivered")));
      expect(refusal).toMatchObject({ exitCode: EXIT_CODE.CONFLICT, context: { code: "item_revision_conflict", item_id: dependents[0] } });
      expect(refusal.message).toContain(`${blocker} was closed, but auto-unblocking ${dependents[0]} was refused.`);
      expect(refusal.context.side_effects).toEqual([{ path: `history/${blocker}.jsonl`, op: "close" }]);
      expect((await pm.get(blocker)).item.status).toBe("closed");
      for (const id of dependents) expect((await pm.get(id)).item.status).toBe("blocked");
    });
  });

  it("reports close-many's committed close and the refused dependent apart", async () => {
    await withTempPmPath(async (context) => {
      const blocker = createTestItemId(context, { title: "Bulk fan-out blocker" });
      const dependent = createTestItemId(context, { title: "Bulk dependent" });
      const blocked = context.runCli(["update", dependent, "--status", "blocked", "--blocked-by", blocker, "--blocked-reason", "waiting", "--json"], { expectJson: true });
      expect(blocked.code, blocked.stderr).toBe(0);
      const pm = client(context);
      const stale = (await pm.readItemRevision(dependent)).item_hash;
      await pm.update(dependent, { title: "Bulk dependent, edited by a peer" });
      const current = (await pm.readItemRevision(dependent)).item_hash;
      const closed = await runAction({ path: context.pmPath, noExtensions: true, author: "bulk-agent", expectHash: `${dependent}=${stale}`, action: "close-many", options: { ids: blocker, reason: "bulk" } }) as {
        rows: Array<Record<string, unknown>>; ids: string[];
      };
      expect(closed.ids).toEqual([blocker]);
      expect(closed.rows).toEqual([expect.objectContaining({
        id: blocker, status: "closed", warnings: [`auto_unblock_refused:${dependent}:item_revision_conflict`],
        dependent_revision_conflict: expect.objectContaining({ item_id: dependent, error_code: "item_revision_conflict", expected_revision: stale, current_revision: current }),
      })]);
      expect((await pm.get(blocker)).item.status).toBe("closed");
      expect((await pm.get(dependent)).item.status).toBe("blocked");
    });
  });

  it("refuses a guarded restore over an unreadable live item, while an unguarded restore still recovers it", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Corrupted live item" });
      const pm = client(context);
      const decided = (await pm.readItemRevision(id)).item_hash;
      const itemPath = path.join(context.pmPath, "tasks", `${id}.toon`);
      // A peer corrupts the item after the guard bound its revision.
      const refusal = await captureError(() => withExpectedItemRevisions([{ id, itemHash: decided }], async () => {
        await writeFile(itemPath, "this is not a toon document: [\n");
        return pm.run("restore", { id, target: "1", force: true });
      }, { pmRoot: context.pmPath }));
      expect(refusal).toMatchObject({ exitCode: EXIT_CODE.CONFLICT, context: { code: "item_revision_conflict", item_id: id, expected_revision: decided } });
      expect(refusal.message).toContain("its live document cannot be read");
      expect(refusal.context.required).toContain(`pm restore ${id} <version>`);
      expect(await readFile(itemPath, "utf8")).toBe("this is not a toon document: [\n");
      await expect(pm.run("restore", { id, target: "1", force: true })).resolves.toBeDefined();
      expect((await pm.get(id)).item.title).toBe("Corrupted live item");
    });
  });

  it("resolves client revisions inside the workspace's extension context", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeTestExtension({
        root: path.join(pmPath, "extensions", "run-types"),
        name: "run-types",
        manifestOverrides: { capabilities: ["schema"] },
        entrySource: "export default { activate(api) { api.registerItemTypes([{ name: 'Run', folder: 'runs' }]); } };\n",
      });
      const pm = new PmClient({ pmRoot: pmPath });
      const id = (await pm.create({ id: "seed-run", title: "seed-run", type: "Run", status: "open" })).item.id;
      const revision = await pm.readItemRevision(id);
      expect(revision.item_hash).toBe((await pm.get(id)).item_hash);
      await expect(pm.withExpectedItemRevisions([{ id, itemHash: revision.item_hash }], () => pm.update(id, { priority: "2" }))).resolves.toMatchObject({ checked: [id] });
    });
  });

  it("hydrates file-backed schema types before reading a client revision", async () => {
    await withTempPmPath(async (context) => {
      const added = context.runCli(["schema", "add-type", "Run", "--folder", "runs", "--json"], { expectJson: true });
      expect(added.code, added.stderr).toBe(0);
      const pm = client(context);
      const id = (await pm.create({ title: "File-backed run", type: "Run", description: "d" })).item.id;
      const revision = await pm.readItemRevision(id);
      expect(revision.item_hash).toBe((await pm.get(id)).item_hash);
      expect(revision.item_hash).toBe((await readItemRevision(id, { pmRoot: context.pmPath })).item_hash);
    });
  });

  it("dispatches extension commands inside a client revision scope", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeTestExtension({
        root: path.join(pmPath, "extensions", "greet"),
        name: "greet",
        manifestOverrides: { capabilities: ["commands"] },
        entrySource: "export default { activate(api) { api.registerCommand({ name: 'greet hello', action: 'greet-hello', run: async () => ({ greeting: 'hi' }) }); } };\n",
      });
      const pm = new PmClient({ pmRoot: pmPath });
      const id = (await pm.create({ title: "Scoped extension", type: "Task", description: "d" })).item.id;
      const { item_hash } = await pm.readItemRevision(id);
      await expect(pm.withExpectedItemRevisions([{ id, itemHash: item_hash }], () => pm.run("greet-hello", {}))).resolves.toEqual({
        result: { greeting: "hi" },
        checked: [],
        unchecked: [id],
      });
    });
  });

  it("binds deleted items through retained history and judges history maintenance as their tombstone", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Deleted subject", description: "contains token-xyz" });
      const pm = client(context);
      const peer = new PmClient({ pmRoot: context.pmPath, noExtensions: true, author: "peer-agent" });
      const live = (await pm.readItemRevision(id)).item_hash;
      const peerDelete = AsyncResource.bind(() => peer.run("delete", { id, force: true }));
      await expect(withExpectedItemRevisions([{ id, itemHash: live }], async () => {
        await peerDelete();
        return pm.run("history-redact", { id, options: { literal: ["token-xyz"] } });
      }, { pmRoot: context.pmPath })).rejects.toMatchObject({ context: { code: "item_revision_conflict", item_id: id } });
      const tombstone = await readItemRevision(id, { pmRoot: context.pmPath });
      expect(tombstone).toMatchObject({ id });
      const history = context.runCli(["history", id, "--full", "--json"], { expectJson: true }).json as { history: Array<{ op: string; after_hash: string }> };
      expect(history.history.at(-1)).toMatchObject({ op: "delete", after_hash: tombstone.item_hash });
      const redacted = await withExpectedItemRevisions([{ id, itemHash: tombstone.item_hash }], () => pm.run("history-redact", { id, options: { literal: ["token-xyz"] } }), { pmRoot: context.pmPath });
      expect(redacted.checked).toEqual([id]);
      const restored = await withExpectedItemRevisions([{ id, itemHash: tombstone.item_hash }], () => pm.run("restore", { id, target: "1", force: true }), { pmRoot: context.pmPath });
      expect(restored.checked).toEqual([id]);
    });
  });

  it("guards restoring an item whose file vanished with the tombstone revision it reports", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Vanished file" });
      await rm(path.join(context.pmPath, "tasks", `${id}.toon`));
      const vanished = await readItemRevision(id, { pmRoot: context.pmPath });
      const restored = await withExpectedItemRevisions([{ id, itemHash: vanished.item_hash }], () => client(context).run("restore", { id, target: "1", force: true }), { pmRoot: context.pmPath });
      expect(restored.checked).toEqual([id]);
    });
  });

  it("admits the native reopen action and refuses a supplied null", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Reopen guard", status: "closed" });
      const common = { path: context.pmPath, noExtensions: true, author: "reopen-agent" };
      const fresh = (await readItemRevision(id, { pmRoot: context.pmPath })).item_hash;
      await expect(runAction({ ...common, action: "item-reopen", id, reason: "Recurred", expectHash: fresh })).resolves.toBeDefined();
      await expect(runAction({ ...common, action: "update", id, options: { priority: "3" }, expectHash: null })).rejects.toMatchObject({
        context: { code: "expect_hash_invalid", value: "null" },
      });
    });
  });

  it("reports the typed conflict, not generic drift, when a peer wrote during the lock wait", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Drift guard" });
      const pm = client(context);
      const settings = await readSettings(context.pmPath);
      const typeRegistry = resolveItemTypeRegistry(settings);
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const decided = (await pm.readItemRevision(id)).item_hash;
      const historyBefore = await readFile(historyPath, "utf8");
      const itemPath = path.join(context.pmPath, "tasks", `${id}.toon`);
      const itemBefore = await readFile(itemPath, "utf8");
      await pm.update(id, { title: "Drift guard, edited by a peer" });
      const verify = (overrides: Partial<Parameters<typeof verifyHistoryRewriteNoDrift>[0]> = {}) => verifyHistoryRewriteNoDrift({
        pmRoot: context.pmPath, subject: { id, historyPath }, settings, typeRegistry,
        historyRawBeforeLock: historyBefore, currentItemRawBeforeLock: itemBefore, operation: "history-redact", ...overrides,
      });
      const guarded = (expected: string, overrides?: Partial<Parameters<typeof verifyHistoryRewriteNoDrift>[0]>) =>
        withExpectedItemRevisions([{ id, itemHash: expected }], () => verify(overrides), { pmRoot: context.pmPath });
      // History drift and item drift both surface the declared revision's typed conflict.
      await expect(guarded(decided)).rejects.toMatchObject({ context: { code: "item_revision_conflict", item_id: id } });
      const historyNow = await readFile(historyPath, "utf8");
      await expect(guarded(decided, { historyRawBeforeLock: historyNow })).rejects.toMatchObject({ context: { code: "item_revision_conflict" } });
      // A matching revision, or no expectation, keeps the generic drift refusal.
      const current = (await pm.readItemRevision(id)).item_hash;
      await expect(guarded(current)).rejects.toThrow("changed while waiting for lock");
      await expect(verify()).rejects.toThrow("changed while waiting for lock");
      // An item that became unreadable after binding cannot be judged, so the history drift refusal stands.
      const bound = await bindExpectedItemRevisions([{ id, itemHash: decided }], { pmRoot: context.pmPath });
      await writeFile(itemPath, "not a pm item\n");
      await expect(runWithBoundItemRevisionScope(bound, () => verify())).rejects.toThrow(`History for ${id} changed while waiting for lock`);
      // Binding refuses an item it cannot read, since its embedded identity is unknown.
      await expect(bindExpectedItemRevisions([{ id, itemHash: decided }], { pmRoot: context.pmPath })).rejects.toThrow("Cannot read");
      await writeFile(itemPath, itemBefore);
      // A deleted subject is judged as its tombstone.
      await pm.run("delete", { id, force: true });
      await expect(guarded(current, { historyRawBeforeLock: historyNow })).rejects.toMatchObject({ context: { code: "item_revision_conflict" } });
    });
  });

  it("enforces a guard supplied inside nested options", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Nested guard" });
      const common = { path: context.pmPath, noExtensions: true, author: "nested-agent" };
      const stale = (await readItemRevision(id, { pmRoot: context.pmPath })).item_hash;
      await runAction({ ...common, action: "update", id, options: { title: "Peer retitle" } });
      await expect(runAction({ ...common, action: "update", id, options: { priority: "3", expectHash: stale } })).rejects.toMatchObject({ context: { code: "item_revision_conflict" } });
      await expect(runAction({ ...common, action: "update", id, options: { priority: "3", expect_hash: null } })).rejects.toMatchObject({ context: { code: "expect_hash_invalid" } });
      expect(splitExpectHashInput({ id, options: "raw" })).toEqual({ expectHash: undefined, dispatchArgs: { id, options: "raw" } });
      expect(splitExpectHashInput({ id, expectHash: HASH_A, options: "raw" })).toEqual({ expectHash: HASH_A, dispatchArgs: { id, options: "raw" } });
      // Every placement is merged, so a guard in a second placement is never dropped.
      expect(splitExpectHashInput({ id, expectHash: HASH_A, options: { expectHash: [`pm-b=${HASH_B}`], expect_hash: `pm-c=${HASH_B}` } })).toEqual({
        expectHash: [HASH_A, `pm-b=${HASH_B}`, `pm-c=${HASH_B}`],
        dispatchArgs: { id, options: {} },
      });
      const other = createTestItemId(context, { title: "Second placement" });
      const otherStale = (await readItemRevision(other, { pmRoot: context.pmPath })).item_hash;
      const fresh = (await readItemRevision(id, { pmRoot: context.pmPath })).item_hash;
      await runAction({ ...common, action: "update", id: other, options: { title: "Peer retitle of the other item" } });
      await expect(runAction({ ...common, action: "update", id: other, expectHash: `${id}=${fresh}`, options: { priority: "3", expectHash: otherStale } }))
        .rejects.toMatchObject({ context: { code: "item_revision_conflict", item_id: other } });
      const untouched = { id, options: { priority: "1" } };
      expect(splitExpectHashInput(untouched).dispatchArgs).toBe(untouched);
      expect(splitExpectHashInput({ id, options: { priority: "1", expectHash: undefined } })).toEqual({ expectHash: undefined, dispatchArgs: { id, options: { priority: "1" } } });
      // An undefined optional guard behaves like an omitted one at both placements.
      await expect(runAction({ ...common, action: "update", id, expectHash: undefined, options: { priority: "2" } })).resolves.toMatchObject({ id });
      await expect(runAction({ ...common, action: "update", id, options: { priority: "3", expect_hash: undefined } })).resolves.toMatchObject({ id });
    });
  });

  it("advances past a history rewrite that moves the item to another folder", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Moving redact" });
      const pm = client(context);
      const fresh = (await pm.readItemRevision(id)).item_hash;
      const moved = await withExpectedItemRevisions([{ id, itemHash: fresh }], async () => {
        await pm.run("history-redact", { id, options: { literal: ["Task"], replacement: "Issue" } });
        return pm.update(id, { priority: "3" });
      }, { pmRoot: context.pmPath });
      expect(moved.checked).toEqual([id]);
      expect((await pm.get(id)).item).toMatchObject({ type: "Issue", priority: 3 });
    });
  });

  it("refuses a guard on background test workers, which run in another process", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Background guard" });
      const run = async () => "ran";
      for (const params of [
        { action: "test", background: true },
        { action: "test-all", options: { background: true } },
      ]) {
        await expect(dispatchWithExpectedItemRevisions({ ...params, expectHash: HASH_A, defaultId: id, pmRoot: context.pmPath, run })).rejects.toMatchObject({
          context: { code: "expect_hash_background_unsupported" },
        });
      }
      expect(await dispatchWithExpectedItemRevisions({ action: "test", options: { background: false }, expectHash: HASH_A, defaultId: id, pmRoot: context.pmPath, run })).toBe("ran");
    });
  });

  it("keeps the CLI mutation-input marker when stripping a nested guard", async () => {
    const { isCliMutationInput, markCliMutationInput } = await import("../../../../src/core/item/literal-mutation-input.js");
    const options = { assignee: "none", expectHash: HASH_A };
    markCliMutationInput(options);
    const { dispatchArgs } = splitExpectHashInput({ id: "pm-a", options });
    expect(dispatchArgs.options).toEqual({ assignee: "none" });
    expect(isCliMutationInput(dispatchArgs.options as object)).toBe(true);
  });

  it("anchors change evidence on a before_hash when the matching state used another digest", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Digest anchor" });
      const pm = client(context);
      const decided = (await pm.readItemRevision(id)).item_hash;
      await pm.update(id, { title: "Digest anchor, edited by a peer" });
      // Simulate a SHA-512 create anchor: its after_hash no longer equals the SHA-256 item_hash.
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const lines = (await readFile(historyPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      lines[0] = { ...lines[0], after_hash: "f".repeat(128) };
      await writeFile(historyPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
      const changes = await describeItemRevisionChanges(context.pmPath, id, decided);
      expect(changes).toMatchObject({ expected_revision_recorded: true, changes_since: [expect.objectContaining({ op: "update", fields: expect.arrayContaining(["title"]) })] });
    });
  });

  it("never mutates the action result it decorates with unchecked warnings", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Frozen result" });
      const frozen = Object.freeze({ warnings: Object.freeze(["kept"]) });
      const decorated = await dispatchWithExpectedItemRevisions({ action: "comments", expectHash: HASH_A, defaultId: id, pmRoot: context.pmPath, run: async () => frozen });
      expect(decorated).toEqual({ warnings: ["kept", `expect_hash_unchecked:${id}:no_locked_write_reached_this_item`] });
      expect(frozen.warnings).toEqual(["kept"]);
    });
  });

  it("routes an expect_hash custom field through the field option, since options.expectHash is a guard", () => {
    expect(resolvePmToolCustomFieldCollision("expect_hash")).toMatchObject({ property: "expectHash", nested_path: "options.field (expect_hash=<value>)" });
    expect(resolvePmToolCustomFieldCollision("author")).toMatchObject({ property: "author", nested_path: "options.author" });
  });

  it("binds a bare guard to the nested options.id that lifecycle dispatch accepts", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Nested id guard" });
      const common = { path: context.pmPath, noExtensions: true, author: "nested-id-agent" };
      const stale = (await readItemRevision(id, { pmRoot: context.pmPath })).item_hash;
      await runAction({ ...common, action: "update", id, options: { title: "Peer retitle" } });
      await expect(runAction({ ...common, action: "claim", options: { id, expectHash: stale } })).rejects.toMatchObject({ context: { code: "item_revision_conflict", item_id: id } });
      const fresh = (await readItemRevision(id, { pmRoot: context.pmPath })).item_hash;
      await expect(runAction({ ...common, action: "claim", options: { id, expectHash: fresh } })).resolves.toBeDefined();
    });
  });

  it("declares expectHash on plan, linked-test persistence and history maintenance contracts", () => {
    for (const action of ["plan", "test-all", "history-redact", "history-repair", "history-compact", "validate", "update", "comments"]) {
      expect(pmToolActionParameterKeys(action)).toContain("expectHash");
    }
    for (const action of ["get", "create", "copy", "list"]) {
      expect(pmToolActionParameterKeys(action)).not.toContain("expectHash");
    }
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
