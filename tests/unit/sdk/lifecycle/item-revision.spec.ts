import { AsyncResource } from "node:async_hooks";
import { appendFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as lockModule from "../../../../src/core/lock/lock.js";
import { hashDocument } from "../../../../src/core/history/history.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { renderPmCommand } from "../../../../src/core/shared/command-line.js";
import { isPmCliErrorDetails } from "../../../../src/core/shared/error-details.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import {
  advanceItemMutationPreconditions,
  assertItemMutationPreconditions,
  itemRevisionConflictGuidance,
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
  scopeItemRevisionConflict,
  throwFirstItemRevisionConflict,
  withExpectedItemRevisions,
} from "../../../../src/sdk/lifecycle/item-revision.js";
import { PmClient, runAction } from "../../../../src/sdk/runtime.js";
import { commitWorkspaceTransaction } from "../../../../src/sdk/workspace-transaction.js";
import type { ItemDocument } from "../../../../src/types/index.js";
import { pmToolActionParameterKeys, resolvePmToolCustomFieldCollision } from "../../../../src/sdk/cli-contracts/tool-schema.js";
import { splitExpectHashInput } from "../../../../src/sdk/runtime-input.js";
import { resolvePmCommandScopeArgs } from "../../../../src/sdk/command-line.js";
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
      // pm-mrvq8u: the close is complete, so the remedy names only the unblock of every dependent the
      // fan-out left blocked, in the caller's tracker scope, never a close retry.
      const guidance = [refusal.context.required, ...(refusal.context.nextSteps ?? [])].join("\n");
      expect(refusal.context.required).toContain(`The close of ${blocker} is complete; do not retry it. Only unblocking the guarded dependents it refused (${dependents.join(", ")}) remains`);
      const scope = ["--pm-path", context.pmPath, "--no-extensions"];
      // pm-gh1677: the report's examples are scoped too, not the store refusal's unscoped reads.
      expect(refusal.context.examples).toEqual([renderPmCommand([...scope, "get", dependents[0]!, "--fields", "item_hash", "--json"]), renderPmCommand([...scope, "history", dependents[0]!, "--limit", "5", "--json"])]);
      for (const id of dependents) {
        expect(refusal.context.nextSteps).toContain(renderPmCommand([...scope, "get", id, "--json"]));
        expect(refusal.context.nextSteps).toContain(renderPmCommand([...scope, "update", id, "--status", "open", "--unset", "blocked_by", "--unset", "blocked_reason", "--expect-hash", `${id}=<item_hash>`]));
      }
      expect(refusal.context.details).toMatchObject({ pending_unblock: dependents, changes_since: [expect.objectContaining({ op: "update" })] });
      expect(guidance).not.toContain("retry with --expect-hash");
      expect(guidance).not.toMatch(/pm close/u);
      expect((await pm.get(blocker)).item.status).toBe("closed");
      for (const id of dependents) expect((await pm.get(id)).item.status).toBe("blocked");
    });
  });

  it("names a dependent whose unblock failed for another reason apart from the revision conflict", async () => {
    await withTempPmPath(async (context) => {
      const blocker = createTestItemId(context, { title: "Mixed failure blocker" });
      const [guarded, broken] = [createTestItemId(context, { title: "Guarded dependent" }), createTestItemId(context, { title: "Broken dependent" })];
      for (const id of [guarded, broken]) {
        const blocked = context.runCli(["update", id, "--status", "blocked", "--blocked-by", blocker, "--blocked-reason", "waiting", "--json"], { expectJson: true });
        expect(blocked.code, blocked.stderr).toBe(0);
      }
      const pm = client(context);
      const stale = (await pm.readItemRevision(guarded)).item_hash;
      await pm.update(guarded, { title: "Guarded dependent, edited by a peer" });
      const policy = context.runCli(["config", "project", "set", "history-missing-stream-policy", "--policy", "strict_error", "--json"], { expectJson: true });
      expect(policy.code, policy.stderr).toBe(0);
      await rm(path.join(context.pmPath, "history", `${broken}.jsonl`));
      const refusal = await captureError(() => pm.withExpectedItemRevisions([{ id: guarded, itemHash: stale }], () => pm.close(blocker, "Delivered")));
      expect(refusal.context.details).toMatchObject({ pending_unblock: [guarded], auto_unblock_failed: [expect.objectContaining({ id: broken })] });
      expect(refusal.context.required).toContain(`Only unblocking ${guarded} remains`);
      expect(refusal.context.required).toContain(`Auto-unblocking also failed for ${broken}; details.auto_unblock_failed gives the reasons it kept (auto_unblock_failed_omitted counts the rest; their get step shows the item).`);
      const scope = ["--pm-path", context.pmPath, "--no-extensions"];
      expect(refusal.context.nextSteps).toContain(renderPmCommand([...scope, "get", broken, "--json"]));
      expect(refusal.context.nextSteps?.some((step) => step.includes(`update ${broken}`))).toBe(false);
    });
  });

  it("bounds the post-close fan-out report so its details stay renderable", async () => {
    await withTempPmPath(async (context) => {
      const pm = client(context);
      const blocker = createTestItemId(context, { title: "Wide fan-out blocker" });
      const stale = [];
      for (let index = 0; index < 12; index += 1) {
        const { item } = await pm.create({ type: "Task", title: `Wide dependent ${index}`, status: "blocked", blockedBy: blocker, blockedReason: "waiting" });
        stale.push({ id: item.id, itemHash: (await pm.readItemRevision(item.id)).item_hash });
        await pm.update(item.id, { title: `Wide dependent ${index}, edited by a peer` });
      }
      const refusal = await captureError(() => pm.withExpectedItemRevisions(stale, () => pm.close(blocker, "Delivered")));
      const details = refusal.context.details as { pending_unblock: string[]; pending_unblock_omitted: number; auto_unblock_failed: unknown[]; auto_unblock_failed_omitted: number };
      expect(details.pending_unblock).toHaveLength(10);
      expect(details).toMatchObject({ pending_unblock_omitted: 2, auto_unblock_failed: [], auto_unblock_failed_omitted: 0 });
      expect(refusal.context.required).toContain(", and 2 more)");
      expect(refusal.context.required).toContain("This refusal does not list a step for every dependent left blocked; list them with");
      expect(refusal.context.required).toContain("while it reports has_more, continue with --after <next_cursor>.");
      expect(refusal.context.nextSteps).toHaveLength(20);
      expect(refusal.context.nextSteps?.at(-1)).toBe(renderPmCommand(["--pm-path", context.pmPath, "--no-extensions", "list", "--status", "blocked", "--fields", "id,title,blocked_by,dependencies", "--limit", "200"]));
      expect(isPmCliErrorDetails(refusal.context.details)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(refusal.context.details), "utf8")).toBeLessThanOrEqual(4096);
    });
  });

  it("adds the discovery step when the step cap cuts a dependent's step although no id was omitted", async () => {
    await withTempPmPath(async (context) => {
      const pm = client(context);
      const blocker = createTestItemId(context, { title: "Step-cap blocker" });
      const stale = [];
      for (let index = 0; index < 9; index += 1) {
        const { item } = await pm.create({ type: "Task", title: `Guarded dependent ${index}`, status: "blocked", blockedBy: blocker, blockedReason: "waiting" });
        stale.push({ id: item.id, itemHash: (await pm.readItemRevision(item.id)).item_hash });
        await pm.update(item.id, { title: `Guarded dependent ${index}, edited by a peer` });
      }
      const broken = [];
      for (let index = 0; index < 3; index += 1) {
        broken.push((await pm.create({ type: "Task", title: `Broken dependent ${index}`, status: "blocked", blockedBy: blocker, blockedReason: "waiting" })).item.id);
      }
      const policy = context.runCli(["config", "project", "set", "history-missing-stream-policy", "--policy", "strict_error", "--json"], { expectJson: true });
      expect(policy.code, policy.stderr).toBe(0);
      for (const id of broken) await rm(path.join(context.pmPath, "history", `${id}.jsonl`));
      const refusal = await captureError(() => pm.withExpectedItemRevisions(stale, () => pm.close(blocker, "Delivered")));
      expect(refusal.context.details).toMatchObject({ pending_unblock_omitted: 0, auto_unblock_failed_omitted: 0 });
      expect(refusal.context.nextSteps).toHaveLength(20);
      expect(refusal.context.nextSteps?.at(-1)).toContain("list --status blocked");
      expect(refusal.context.required).toContain("This refusal does not list a step for every dependent left blocked");
    });
  });

  it("bounds a report of many non-conflict failures with long reasons", async () => {
    await withTempPmPath(async (context) => {
      const pm = client(context);
      const blocker = createTestItemId(context, { title: "Many failures blocker" });
      const { item: guarded } = await pm.create({ type: "Task", title: "Guarded dependent", status: "blocked", blockedBy: blocker, blockedReason: "waiting" });
      const stale = (await pm.readItemRevision(guarded.id)).item_hash;
      await pm.update(guarded.id, { title: "Guarded dependent, edited by a peer" });
      const broken = [];
      for (let index = 0; index < 12; index += 1) {
        broken.push((await pm.create({ type: "Task", title: `Broken dependent ${index}`, status: "blocked", blockedBy: blocker, blockedReason: "waiting" })).item.id);
      }
      const policy = context.runCli(["config", "project", "set", "history-missing-stream-policy", "--policy", "strict_error", "--json"], { expectJson: true });
      expect(policy.code, policy.stderr).toBe(0);
      for (const id of broken) await rm(path.join(context.pmPath, "history", `${id}.jsonl`));
      const refusal = await captureError(() => pm.withExpectedItemRevisions([{ id: guarded.id, itemHash: stale }], () => pm.close(blocker, "Delivered")));
      const details = refusal.context.details as { pending_unblock: string[]; auto_unblock_failed: Array<{ reason: string }>; auto_unblock_failed_omitted: number };
      expect(details.pending_unblock).toEqual([guarded.id]);
      expect(details.auto_unblock_failed.length).toBeLessThanOrEqual(10);
      expect(details.auto_unblock_failed.length + details.auto_unblock_failed_omitted).toBe(12);
      for (const entry of details.auto_unblock_failed) expect(entry.reason.length).toBeLessThanOrEqual(160);
      expect(isPmCliErrorDetails(refusal.context.details)).toBe(true);
      expect(refusal.context.nextSteps?.length).toBeLessThanOrEqual(20);
      expect(refusal.context.nextSteps?.at(-1)).toContain("list --status blocked");
    });
  });

  it("keeps the typed refusal when malformed history defeats its change evidence", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Malformed history" });
      const pm = client(context);
      const stale = (await pm.readItemRevision(id)).item_hash;
      await pm.update(id, { title: "Malformed history, edited by a peer" });
      await appendFile(path.join(context.pmPath, "history", `${id}.jsonl`), "null\n");
      const refusal = await captureError(() => pm.withExpectedItemRevisions([{ id, itemHash: stale }], () => pm.update(id, { priority: "1" })));
      expect(refusal).toMatchObject({ exitCode: EXIT_CODE.CONFLICT, context: { code: "item_revision_conflict", item_id: id, expected_revision: stale } });
      expect(refusal.context.details).toBeUndefined();
    });
  });

  it("discloses dependents the fan-out already unblocked before a guarded one refused", async () => {
    await withTempPmPath(async (context) => {
      const blocker = createTestItemId(context, { title: "Mixed fan-out blocker" });
      const [fresh, guarded] = [createTestItemId(context, { title: "Fresh dependent" }), createTestItemId(context, { title: "Guarded dependent" })];
      for (const id of [fresh, guarded]) {
        const blocked = context.runCli(["update", id, "--status", "blocked", "--blocked-by", blocker, "--blocked-reason", "waiting", "--json"], { expectJson: true });
        expect(blocked.code, blocked.stderr).toBe(0);
      }
      const pm = client(context);
      const stale = (await pm.readItemRevision(guarded)).item_hash;
      await pm.update(guarded, { title: "Guarded dependent, edited by a peer" });
      const closed = await runAction({ path: context.pmPath, noExtensions: true, author: "bulk-agent", expectHash: `${guarded}=${stale}`, action: "close-many", options: { ids: blocker, reason: "bulk" } }) as { rows: Array<Record<string, unknown>> };
      expect(closed.rows).toEqual([expect.objectContaining({ id: blocker, status: "closed", warnings: [`auto_unblocked:${fresh}`, `auto_unblock_refused:${guarded}:item_revision_conflict`] })]);
      expect((await pm.get(fresh)).item.status).toBe("open");
      expect((await pm.get(guarded)).item.status).toBe("blocked");
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

  it("reports update-many's committed close and the refused dependent apart", async () => {
    await withTempPmPath(async (context) => {
      const blocker = createTestItemId(context, { title: "Status-close blocker" });
      const dependent = createTestItemId(context, { title: "Status-close dependent" });
      const blocked = context.runCli(["update", dependent, "--status", "blocked", "--blocked-by", blocker, "--blocked-reason", "waiting", "--json"], { expectJson: true });
      expect(blocked.code, blocked.stderr).toBe(0);
      const pm = client(context);
      const stale = (await pm.readItemRevision(dependent)).item_hash;
      await pm.update(dependent, { title: "Status-close dependent, edited by a peer" });
      const updated = await runAction({ path: context.pmPath, noExtensions: true, author: "bulk-agent", expectHash: `${dependent}=${stale}`, action: "update-many", options: { ids: blocker, status: "closed", closeReason: "done" } }) as {
        rows: Array<Record<string, unknown>>; ids: string[];
      };
      expect(updated.ids).toEqual([blocker]);
      expect(updated.rows).toEqual([expect.objectContaining({
        id: blocker, status: "updated", warnings: [`auto_unblock_refused:${dependent}:item_revision_conflict`],
        dependent_revision_conflict: expect.objectContaining({ item_id: dependent, error_code: "item_revision_conflict", expected_revision: stale }),
      })]);
      expect((await pm.get(blocker)).item.status).toBe("closed");
    });
  });

  it("guards tail salvage against the live item, an unreadable live file and the tombstone", async () => {
    await withTempPmPath(async (context) => {
      const pm = client(context);
      const damageTail = (id: string) => appendFile(path.join(context.pmPath, "history", `${id}.jsonl`), "\0\0\0");
      const salvage = (id: string, itemHash: string, before?: () => Promise<void>) => withExpectedItemRevisions([{ id, itemHash }], async () => {
        await before?.();
        return pm.run("history-repair", { id, options: { salvageTail: true } });
      }, { pmRoot: context.pmPath });
      const live = createTestItemId(context, { title: "Salvage live" });
      const stale = (await pm.readItemRevision(live)).item_hash;
      await pm.update(live, { title: "Salvage live, edited by a peer" });
      await damageTail(live);
      const historyPath = path.join(context.pmPath, "history", `${live}.jsonl`);
      const damaged = await readFile(historyPath, "utf8");
      await expect(salvage(live, stale)).rejects.toMatchObject({ context: { code: "item_revision_conflict", item_id: live, expected_revision: stale } });
      expect(await readFile(historyPath, "utf8")).toBe(damaged);
      await expect(salvage(live, (await pm.readItemRevision(live)).item_hash)).resolves.toMatchObject({ checked: [live] });
      const unreadable = createTestItemId(context, { title: "Salvage unreadable" });
      const decided = (await pm.readItemRevision(unreadable)).item_hash;
      await damageTail(unreadable);
      const refusal = await captureError(() => salvage(unreadable, decided, () => writeFile(path.join(context.pmPath, "tasks", `${unreadable}.toon`), "not a toon document: [\n")));
      expect(refusal).toMatchObject({ context: { code: "item_revision_conflict", item_id: unreadable } });
      expect(refusal.message).toContain("its live document cannot be read");
      const deleted = createTestItemId(context, { title: "Salvage deleted" });
      await pm.run("delete", { id: deleted, force: true });
      await damageTail(deleted);
      await expect(salvage(deleted, (await readItemRevision(deleted, { pmRoot: context.pmPath })).item_hash)).resolves.toMatchObject({ checked: [deleted] });
    });
  });

  it("judges the live revision when the item moved while tail salvage waited for its lock", async () => {
    await withTempPmPath(async (context) => {
      const pm = client(context);
      const id = createTestItemId(context, { title: "Salvage lock window" });
      await appendFile(path.join(context.pmPath, "history", `${id}.jsonl`), "\0\0\0");
      const itemFile = path.join(context.pmPath, "tasks", `${id}.toon`);
      const acquireLock = lockModule.acquireLock;
      let peerEdits = 0;
      const spy = vi.spyOn(lockModule, "acquireLock").mockImplementation(async (...args) => {
        if (args[1] === id) {
          peerEdits += 1;
          await writeFile(itemFile, (await readFile(itemFile, "utf8")).replace("title: Salvage lock window", `title: Salvage lock window, peer edit ${peerEdits}`));
        }
        return acquireLock(...(args as Parameters<typeof lockModule.acquireLock>));
      });
      try {
        await expect(pm.run("history-repair", { id, options: { salvageTail: true } })).rejects.toThrow(/changed while waiting for salvage lock/u);
        const decided = (await pm.readItemRevision(id)).item_hash;
        await expect(withExpectedItemRevisions([{ id, itemHash: decided }], () => pm.run("history-repair", { id, options: { salvageTail: true } }), { pmRoot: context.pmPath }))
          .rejects.toMatchObject({ context: { code: "item_revision_conflict", item_id: id, expected_revision: decided } });
      } finally {
        spy.mockRestore();
      }
      expect(peerEdits).toBe(2);
    });
  });

  it("binds no revision to an item file whose embedded id names another item", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Identity conflict" });
      const itemFile = path.join(context.pmPath, "tasks", `${id}.toon`);
      const raw = await readFile(itemFile, "utf8");
      expect(raw).toContain(`id: ${id}`);
      await writeFile(itemFile, raw.replace(`id: ${id}`, "id: pm-zzzz"));
      await expect(readItemRevision(id, { pmRoot: context.pmPath })).rejects.toMatchObject({ exitCode: EXIT_CODE.CONFLICT, context: { code: "item_identity_conflict", item_id: id } });
      await expect(withExpectedItemRevisions([{ id, itemHash: HASH_A }], () => Promise.resolve(undefined), { pmRoot: context.pmPath }))
        .rejects.toMatchObject({ context: { code: "item_identity_conflict" } });
      // On a case-sensitive filesystem a case-only difference from the physical file name is a conflict too.
      const cased = createTestItemId(context, { title: "Case conflict" });
      const casedFile = path.join(context.pmPath, "tasks", `${cased}.toon`);
      await writeFile(casedFile, (await readFile(casedFile, "utf8")).replace(`id: ${cased}`, `id: ${cased.toUpperCase()}`));
      await expect(readItemRevision(cased, { pmRoot: context.pmPath })).rejects.toMatchObject({ context: { code: "item_identity_conflict", item_id: cased } });
    });
  });

  it("reads salvage drift from where the item is now, so a peer delete during the wait refuses as drift", async () => {
    await withTempPmPath(async (context) => {
      const pm = client(context);
      const id = createTestItemId(context, { title: "Salvage moved away" });
      await appendFile(path.join(context.pmPath, "history", `${id}.jsonl`), "\0\0\0");
      const acquireLock = lockModule.acquireLock;
      const spy = vi.spyOn(lockModule, "acquireLock").mockImplementation(async (...args) => {
        if (args[1] === id) await rm(path.join(context.pmPath, "tasks", `${id}.toon`), { force: true });
        return acquireLock(...(args as Parameters<typeof lockModule.acquireLock>));
      });
      try {
        await expect(pm.run("history-repair", { id, options: { salvageTail: true } })).rejects.toThrow(/changed while waiting for salvage lock/u);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("keeps the typed conflict on bulk history-compact and history-repair rows", async () => {
    await withTempPmPath(async (context) => {
      const pm = client(context);
      const common = { path: context.pmPath, noExtensions: true, author: "history-agent" };
      const compacted = createTestItemId(context, { title: "Compact stale" });
      for (const priority of ["1", "2", "3"]) await pm.update(compacted, { priority });
      const staleCompact = (await pm.readItemRevision(compacted)).item_hash;
      await pm.update(compacted, { title: "Compact stale, edited by a peer" });
      const compact = await runAction({ ...common, expectHash: `${compacted}=${staleCompact}`, action: "history-compact", options: { ids: compacted } }) as { results: Array<Record<string, unknown>> };
      expect(compact.results).toEqual([expect.objectContaining({ id: compacted, outcome: "errored", error_code: "item_revision_conflict", expected_revision: staleCompact })]);
      const drifted = createTestItemId(context, { title: "Repair stale" });
      const staleRepair = (await pm.readItemRevision(drifted)).item_hash;
      const itemPath = path.join(context.pmPath, "tasks", `${drifted}.toon`);
      await writeFile(itemPath, (await readFile(itemPath, "utf8")).replace("title: Repair stale", "title: Repair stale, hand-edited"));
      const repair = await runAction({ ...common, expectHash: `${drifted}=${staleRepair}`, action: "history-repair", options: { all: true } }) as { streams: Array<Record<string, unknown>> };
      expect(repair.streams).toEqual(expect.arrayContaining([expect.objectContaining({ id: drifted, outcome: "failed", error_code: "item_revision_conflict", expected_revision: staleRepair })]));
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
      // pm-gh1677: an SDK caller that named its tracker gets recovery scoped to that tracker.
      expect(refusal.context.required).toContain(renderPmCommand(["--pm-path", context.pmPath, "restore", id, "<version>"]));
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

describe("pm-gh1677 revision refusal recovery replays the caller's tracker scope", () => {
  const conflict = (context: Record<string, unknown> = {}) =>
    new PmCliError("stale", EXIT_CODE.CONFLICT, { code: "item_revision_conflict", item_id: "pm-one", expected_revision: "a".repeat(64), reason: "revision_changed", ...context });

  it("renders read-only recovery for the invocation's scope and output mode", () => {
    const scope = ["--pm-path", "../target/.agents/pm", "--no-extensions"];
    expect(itemRevisionConflictGuidance("pm-one", false, { scopeArgs: scope, outputArgs: [] })).toEqual({
      required: `Re-read pm-one (${renderPmCommand([...scope, "get", "pm-one"])} reports item_hash), decide again against the current revision, then retry with --expect-hash <item_hash>.`,
      examples: [renderPmCommand([...scope, "get", "pm-one", "--fields", "item_hash"]), renderPmCommand([...scope, "history", "pm-one", "--limit", "5"])],
      nextSteps: [renderPmCommand([...scope, "get", "pm-one"]), renderPmCommand([...scope, "history", "pm-one", "--limit", "5"])],
    });
    // The store-layer default is unscoped JSON, and an unreadable document points at restore.
    expect(itemRevisionConflictGuidance("pm-one", false).nextSteps).toEqual(["pm get pm-one --json", "pm history pm-one --limit 5 --json"]);
    expect(itemRevisionConflictGuidance("pm-one", true, { scopeArgs: scope }).required).toContain(renderPmCommand([...scope, "restore", "pm-one", "<version>"]));
  });

  it("re-renders only the locked-write guard's own refusals", () => {
    const invocation = { scopeArgs: ["--pm-path", "elsewhere"] };
    const scoped = scopeItemRevisionConflict(conflict(), invocation) as PmCliError;
    expect(scoped.context.nextSteps).toEqual([renderPmCommand(["--pm-path", "elsewhere", "get", "pm-one", "--json"]), renderPmCommand(["--pm-path", "elsewhere", "history", "pm-one", "--limit", "5", "--json"])]);
    expect(scoped.message).toBe("stale");
    expect((scopeItemRevisionConflict(conflict({ reason: "document_unreadable" }), invocation) as PmCliError).context.required).toContain("restore pm-one");
    // A rewritten report (close's post-close fan-out), another error, or a missing id or invocation pass through.
    for (const passthrough of [conflict({ reason: "post_close_auto_unblock_refused" }), conflict({ reason: undefined }), conflict({ item_id: 7 }), new Error("plain")]) {
      expect(scopeItemRevisionConflict(passthrough, invocation)).toBe(passthrough);
    }
    const unscoped = conflict();
    expect(scopeItemRevisionConflict(unscoped, undefined)).toBe(unscoped);
  });

  it("scopes SDK recovery to the tracker the caller selected by pmRoot or cwd, and leaves the implicit tracker unscoped", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "SDK recovery scope" });
      const decided = (await readItemRevision(id, { pmRoot: context.pmPath })).item_hash;
      const pm = client(context);
      await pm.update(id, { tags: "peer-edit" });
      const stale = () => pm.update(id, { tags: "stale-edit" });
      const byCwd = await captureError(() => withExpectedItemRevisions([{ id, itemHash: decided }], stale, { cwd: context.tempRoot }));
      expect(byCwd.context.nextSteps?.[0]).toBe(renderPmCommand(["--pm-path", context.pmPath, "get", id, "--json"]));
      const implicit = await captureError(() => withExpectedItemRevisions([{ id, itemHash: decided }], stale));
      expect(implicit.context.nextSteps?.[0]).toBe(renderPmCommand(["get", id, "--json"]));
      // A client's recovery keeps its extension isolation; a default client names only its tracker.
      const viaClient = await captureError(() => pm.withExpectedItemRevisions([{ id, itemHash: decided }], stale));
      expect(viaClient.context.nextSteps?.[0]).toBe(renderPmCommand(["--pm-path", context.pmPath, "--no-extensions", "get", id, "--json"]));
      const plain = new PmClient({ pmRoot: context.pmPath });
      const viaPlain = await captureError(() => plain.withExpectedItemRevisions([{ id, itemHash: decided }], () => plain.update(id, { tags: "plain-edit" })));
      expect(viaPlain.context.nextSteps?.[0]).toBe(renderPmCommand(["--pm-path", context.pmPath, "get", id, "--json"]));
      // A refusal already rendered for its own invocation keeps that rendering in an enclosing scope on the
      // same tracker, so the inner client's extension isolation survives.
      const nested = await captureError(() => withExpectedItemRevisions([{ id, itemHash: decided }], () => pm.withExpectedItemRevisions([{ id, itemHash: decided }], stale), { pmRoot: context.pmPath }));
      expect(nested.context.nextSteps?.[0]).toBe(renderPmCommand(["--pm-path", context.pmPath, "--no-extensions", "get", id, "--json"]));
      expect(scopeItemRevisionConflict(nested, { outputArgs: ["--output-format", "toon"] })).toBe(nested);
      const unscoped = new PmCliError("stale", EXIT_CODE.CONFLICT, { code: "item_revision_conflict", item_id: id, expected_revision: decided, reason: "revision_changed" });
      expect(scopeItemRevisionConflict(unscoped, { outputArgs: ["--output-format", "toon"] }) as PmCliError).toMatchObject({ context: { nextSteps: [`pm get ${id} --output-format toon`, `pm history ${id} --limit 5 --output-format toon`] } });
    });
  });
});

describe("pm-gh1677 nested and dispatched revision recovery", () => {
  it("keeps a nested scope's refusal, evidence and recovery on the tracker that raised it", async () => {
    await withTempPmPath(async (context) => {
      const other = path.join(context.tempRoot, "other", ".agents", "pm");
      expect(context.runCli(["--pm-path", other, "init", "--defaults", "--agent-guidance", "skip", "--json"]).code).toBe(0);
      expect(context.runCli(["--pm-path", other, "create", "Task", "Inner tracker item", "--id", "nested", "--json"]).code).toBe(0);
      const outerId = createTestItemId(context, { title: "Outer tracker item" });
      const outerHash = (await readItemRevision(outerId, { pmRoot: context.pmPath })).item_hash;
      const inner = new PmClient({ pmRoot: other, noExtensions: true, author: "revision-agent" });
      const stale = (await inner.readItemRevision("pm-nested")).item_hash;
      await inner.update("pm-nested", { tags: "peer-edit" });
      const refusal = await captureError(() => withExpectedItemRevisions([{ id: outerId, itemHash: outerHash }], () =>
        inner.withExpectedItemRevisions([{ id: "pm-nested", itemHash: stale }], () => inner.update("pm-nested", { tags: "stale-edit" })),
      { pmRoot: context.pmPath }));
      expect(refusal.context).toMatchObject({ code: "item_revision_conflict", item_id: "pm-nested", details: { expected_revision_recorded: true } });
      expect(refusal.context.nextSteps?.[0]).toBe(renderPmCommand(["--pm-path", other, "--no-extensions", "get", "pm-nested", "--json"]));
      // The ownership record is shared through the global registry, so every SDK bundle graph reads it.
      const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("@unbrained/pm-cli/item-revision-refusal-trackers")];
      expect(registry).toBeInstanceOf(WeakMap);
      // A wrapper that keeps the refusal as its cause (task composition) still belongs to the inner tracker.
      const raw = await captureError(() => inner.withExpectedItemRevisions([{ id: "pm-nested", itemHash: stale }], () => inner.update("pm-nested", { tags: "again" })));
      const wrapped = new PmCliError(raw.message, raw.exitCode, { ...raw.context, details: undefined });
      wrapped.cause = raw;
      expect(await enrichItemRevisionConflict(wrapped, context.pmPath, { scopeArgs: ["--pm-path", "outer"] })).toBe(wrapped);
      // The owning tracker still adds evidence, but keeps the recovery the inner scope already rendered.
      const owned = await enrichItemRevisionConflict(wrapped, other, { scopeArgs: ["--pm-path", "inner"] }) as PmCliError;
      expect(owned.context.nextSteps?.[0]).toBe(renderPmCommand(["--pm-path", other, "--no-extensions", "get", "pm-nested", "--json"]));
      expect(owned.context.details).toMatchObject({ expected_revision_recorded: true });
      // A close retry carries only guards bound to its own tracker, never an enclosing scope's on another.
      const foreign = await captureError(() => withExpectedItemRevisions([{ id: outerId, itemHash: outerHash }], () =>
        inner.close("pm-nested", "Done", { validateClose: "strict" }), { pmRoot: context.pmPath }));
      expect(foreign.context.code).toBe("close_validation_missing_fields");
      expect(foreign.context.recovery?.suggested_retry_args?.some((token) => token.startsWith("--expect-hash"))).toBe(false);
      // A non-error rejection passes through enrichment untouched.
      expect(await enrichItemRevisionConflict("not an error", context.pmPath, { scopeArgs: [] })).toBe("not an error");
    });
  });

  it("renders the resolved tracker for a runAction call with an explicit cwd", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Dispatch cwd scope" });
      const stale = (await readItemRevision(id, { pmRoot: context.pmPath })).item_hash;
      const common = { path: ".agents/pm", cwd: context.tempRoot, noExtensions: true, author: "mcp-agent" };
      await runAction({ ...common, action: "update", id, options: { tags: "peer-edit" } });
      const refusal = await captureError(() => runAction({ ...common, action: "update", id, options: { tags: "stale-edit" }, expectHash: stale }));
      expect(refusal.context.nextSteps?.[0]).toBe(renderPmCommand(["--pm-path", context.pmPath, "--no-extensions", "get", id, "--json"]));
      const implicit = await captureError(() => runAction({ action: "update", id, options: { tags: "stale-again" }, expectHash: stale, cwd: context.tempRoot }));
      expect(implicit.context.nextSteps?.[0]).toBe(renderPmCommand(["--pm-path", context.pmPath, "get", id, "--json"]));
      // An active-extension-host client disables extensions only internally, so its recovery keeps them enabled.
      const host = PmClient.forActiveExtensionHost({ pmRoot: context.pmPath });
      const hosted = await captureError(() => host.run("update", { id, options: { tags: "stale-host" }, expectHash: stale }));
      expect(hosted.context.code).toBe("item_revision_conflict");
      expect(hosted.context.nextSteps?.every((step) => !step.includes("--no-extensions"))).toBe(true);
      // pm-gh1676: an SDK close refused for missing evidence carries the guard it ran under into its CLI retry.
      const fresh = (await readItemRevision(id, { pmRoot: context.pmPath })).item_hash;
      const unguarded = await captureError(() => runAction({ action: "close", id, reason: "Done", path: context.pmPath, expectHash: fresh, options: { validateClose: "strict" } }));
      expect(unguarded.context.code).toBe("close_validation_missing_fields");
      expect(unguarded.context.recovery?.suggested_retry_args).toContain(`--expect-hash=${id}=${fresh}`);
      // Guards on other items (a dependent the close would auto-unblock) are carried too.
      const dependent = createTestItemId(context, { title: "Guarded dependent" });
      const dependentHash = (await readItemRevision(dependent, { pmRoot: context.pmPath })).item_hash;
      const sdk = new PmClient({ pmRoot: context.pmPath });
      const withDependent = await captureError(() => sdk.withExpectedItemRevisions([{ id: dependent, itemHash: dependentHash }], () => sdk.close(id, "Done", { validateClose: "strict" })));
      expect(withDependent.context.recovery?.suggested_retry_args).toContain(`--expect-hash=${dependent}=${dependentHash}`);
      // Nested scopes expecting different revisions of one item cannot be spelled as one invocation's guards.
      const conflicting = await captureError(() => sdk.withExpectedItemRevisions([{ id: dependent, itemHash: dependentHash }], () =>
        withExpectedItemRevisions([{ id: dependent, itemHash: "b".repeat(64) }], () => sdk.close(id, "Done", { validateClose: "strict" }), { pmRoot: context.pmPath })));
      expect(conflicting.context.recovery?.suggested_retry_args).toBeUndefined();
      expect(conflicting.context.required).toContain("nested revision guards expect different revisions of one item");
      // A write inside the guarded operation advances the guard past the declared revision: replaying the
      // caller's own guard would conflict with the advanced one, so no CLI retry is proposed.
      const declared = (await readItemRevision(id, { pmRoot: context.pmPath })).item_hash;
      const advanced = await captureError(() => sdk.withExpectedItemRevisions([{ id, itemHash: declared }], async () => {
        await sdk.update(id, { tags: "advanced-in-scope" });
        return sdk.close(id, "Done", { validateClose: "strict" });
      }));
      expect(advanced.context.code).toBe("close_validation_missing_fields");
      expect(advanced.context.recovery?.suggested_retry_args).toBeUndefined();
      expect(advanced.context.required).toContain("a write in the same operation advanced a guarded revision");
      // An explicitly blank SDK author is attributed unlike an omitted one, and pm close refuses an empty --author.
      const blankAuthor = await captureError(() => sdk.close(id, "Done", { validateClose: "strict", author: "" }));
      expect(blankAuthor.context.code).toBe("close_validation_missing_fields");
      expect(blankAuthor.context.recovery?.suggested_retry_args).toBeUndefined();
      expect(blankAuthor.context.required).toContain("explicitly blank author");
      // Inspecting an unrelated rejection for a refusal never replaces it with its cause accessor's exception.
      const opaque = new Error("unrelated callback failure");
      Object.defineProperty(opaque, "cause", { get() { throw new Error("cause accessor"); } });
      await expect(withExpectedItemRevisions([], async () => { throw opaque; }, { pmRoot: context.pmPath })).rejects.toBe(opaque);
      // An embedded CLI run inside an SDK guard keeps that guard in its argv-based retry.
      const embedded = await sdk.withExpectedItemRevisions([{ id: dependent, itemHash: dependentHash }], () =>
        context.runCliInProcess(["close", id, "Done", "--validate-close", "strict", "--json"], { preserveDefaultMutationOutput: true }));
      const embeddedRetry = (JSON.parse(embedded.result.stderr) as { recovery: { suggested_retry_args: string[] } }).recovery.suggested_retry_args;
      expect(embeddedRetry).toEqual(expect.arrayContaining(["close", id, "Done", `--expect-hash=${dependent}=${dependentHash}`]));
      // A message that equals the guarded hash is not a typed guard: the dependent's guard stays.
      const hashMessage = await sdk.withExpectedItemRevisions([{ id: dependent, itemHash: dependentHash }], () =>
        context.runCliInProcess(["close", id, "Done", `--message=${dependentHash}`, "--validate-close", "strict", "--json"], { preserveDefaultMutationOutput: true }));
      expect((JSON.parse(hashMessage.result.stderr) as { recovery: { suggested_retry_args: string[] } }).recovery.suggested_retry_args).toContain(`--expect-hash=${dependent}=${dependentHash}`);
      // Conflicting nested scopes around an embedded CLI run: the producer withdrew its retry, so the CLI proposes none.
      const embeddedConflict = await sdk.withExpectedItemRevisions([{ id: dependent, itemHash: dependentHash }], () =>
        withExpectedItemRevisions([{ id: dependent, itemHash: "b".repeat(64) }], () =>
          context.runCliInProcess(["close", id, "Done", "--validate-close", "strict", "--json"], { preserveDefaultMutationOutput: true }), { pmRoot: context.pmPath }));
      const conflictRecovery = (JSON.parse(embeddedConflict.result.result.stderr) as { recovery: { suggested_retry_args?: string[]; missing: string[] } }).recovery;
      expect(conflictRecovery.missing.length).toBeGreaterThan(0);
      expect(conflictRecovery.suggested_retry_args).toBeUndefined();
      // A requested output encoding carries into the recovery reads.
      const toon = await captureError(() => runAction({ action: "update", id, options: { tags: "stale-toon" }, expectHash: stale, path: context.pmPath, outputFormat: "toon" }));
      expect(toon.context.nextSteps?.[1]).toMatch(/ history \S+ --limit 5 --output-format toon$/u);
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

describe("pm-gh1677 recovery scope for a blank typed tracker", () => {
  it("names the environment's tracker when the typed tracker is empty or whitespace-only, and keeps an explicit spelling", async () => {
    await withTempPmPath(async (context) => {
      // PM_PATH selects the temp tracker; the caller works in a nested workspace whose implicit tracker differs.
      const workspace = path.join(context.tempRoot, "target");
      expect(context.runCli(["--pm-path", path.join("target", ".agents", "pm"), "init", "--defaults", "--agent-guidance", "skip", "--json"], { cwd: context.tempRoot }).code).toBe(0);
      const environment = ["--pm-path", path.relative(workspace, context.pmPath)];
      // Tracker resolution trims these and defers to PM_PATH, so they are not explicit selections.
      for (const blank of [undefined, "", " ", "\t  "]) expect(resolvePmCommandScopeArgs({ path: blank }, workspace), JSON.stringify(blank)).toEqual(environment);
      expect(resolvePmCommandScopeArgs({ path: " ../tracker ", noExtensions: true }, workspace)).toEqual(["--pm-path", " ../tracker ", "--no-extensions"]);
    });
  });
});
