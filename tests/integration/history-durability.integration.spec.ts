import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getItemAt,
  readHistoryEntries,
  findHistoryIdentityDiscontinuities,
} from "../../src/sdk/history-read.js";
import { scanHistoryDrift } from "../../src/core/history/drift-scan.js";
import { buildValidateHistoryDriftCheck } from "../../src/sdk/governance/validate-history-drift.js";
import { runHistoryCompact } from "../../src/sdk/history-compact.js";
import { runRestore } from "../../src/sdk/lifecycle/restore.js";
import {
  runHistoryRepair,
  runHistoryRepairAll,
} from "../../src/sdk/history-repair.js";
import { inspectHistoryTail } from "../../src/sdk/history/salvage.js";
import {
  replayHistoryToTarget,
  ensureMaterializedHistoryTarget,
} from "../../src/core/history/projection.js";
import {
  appendHistoryEntry,
  createHistoryEntry,
  hashDocumentForVersion,
  hashDocumentVerificationCandidates,
  sealHistoryRecord,
} from "../../src/core/history/history.js";
import {
  parseItemDocument,
  canonicalDocument,
  serializeItemDocument,
} from "../../src/core/item/item-format.js";
import { historyVersionOffset } from "../../src/core/history/version-address.js";
import { runHistory } from "../../src/sdk/query/history.js";
import { runGet } from "../../src/sdk/query/get.js";
import { generateItemId } from "../../src/core/item/id.js";
import {
  clearActiveExtensionHooks,
  setActiveExtensionHooks,
  setActiveExtensionServices,
} from "../../src/core/extensions/index.js";
import { runWithReproducibleExecution } from "../../src/core/reproducibility/context.js";
import type { ItemDocument, ItemMetadata } from "../../src/types/index.js";
import { createTaskFixture } from "../helpers/createTaskFixture.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("history durability across storage maintenance", () => {
  it("replays every lifecycle version from history alone against independently captured files", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-lifecycle";
      createTaskFixture(context, "pm-parent", "Parent scope");
      createTaskFixture(context, id, "Original state");
      const snapshots: ItemDocument[] = [];
      const operations = [
        [],
        ["update", id, "--title", "Renamed title"],
        ["update", id, "--parent", "pm-parent"],
        ["comments", id, "Decision evidence"],
        ["notes", id, "--add", "Implementation detail"],
        ["learnings", id, "--add", "Reusable finding"],
        ["append", id, "--body", "Durable body"],
        ["update", id, "--type", "Issue"],
        [
          "close",
          id,
          "Verified outcome",
          "--resolution",
          "Delivered",
          "--expected",
          "Replay",
          "--actual",
          "Replay",
        ],
        ["update", id, "--status", "open"],
      ];
      let itemFile = path.join(context.pmPath, "tasks", `${id}.toon`);
      for (const operation of operations) {
        if (operation.length) {
          const result = context.runCli(operation);
          expect(result.code, result.stderr).toBe(0);
        }
        if (operation.includes("Issue"))
          itemFile = path.join(context.pmPath, "issues", `${id}.toon`);
        snapshots.push(
          canonicalDocument(
            parseItemDocument(await readFile(itemFile, "utf8")),
          ),
        );
      }
      const historyFile = path.join(context.pmPath, "history", `${id}.jsonl`);
      const raw = await readFile(historyFile, "utf8");
      const history = await readHistoryEntries(historyFile, id);
      expect(history).toHaveLength(snapshots.length);
      await rm(itemFile);
      for (const [index, expected] of snapshots.entries()) {
        const actual = await getItemAt(id, String(index + 1), {
          pmRoot: context.pmPath,
        });
        expect(
          actual.document,
          `version ${index + 1}: ${history[index]!.op}`,
        ).toEqual(expected);
      }
      expect(await readFile(historyFile, "utf8")).toBe(raw);
      await runRestore(id, "4", {}, { path: context.pmPath });
      const restored = await getItemAt(id, String(snapshots.length + 1), {
        pmRoot: context.pmPath,
      });
      expect(restored.document.metadata.title).toBe(
        snapshots[3]!.metadata.title,
      );
      expect(restored.document.metadata.comments).toEqual(
        snapshots[3]!.metadata.comments,
      );
    });
  });

  it("refuses identity discontinuities even when their patches and hashes are valid", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-discontinuous";
      createTaskFixture(context, id, "First subject");
      const original = (await getItemAt(id, "1", { pmRoot: context.pmPath }))
        .document;
      expect(context.runCli(["delete", id]).code).toBe(0);
      const file = path.join(context.pmPath, "history", `${id}.jsonl`);
      const prior = await readFile(file, "utf8");
      const second = createHistoryEntry({
        nowIso: new Date().toISOString(),
        author: "test-author",
        op: "create",
        before: { metadata: {} as ItemMetadata, body: "" },
        after: {
          ...original,
          metadata: { ...original.metadata, title: "Second subject" },
        },
      });
      await writeFile(file, `${prior}${JSON.stringify(second)}\n`);
      const verified = await runHistory(
        id,
        { verify: true },
        { path: context.pmPath },
      );
      expect(verified.verification).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([
          "verify_failed:duplicate_create:entry_3:prior_1",
        ]),
      });
      await expect(
        getItemAt(id, "3", { pmRoot: context.pmPath }),
      ).rejects.toMatchObject({ context: { code: "history_replay_invalid" } });
      const item = {
        ...original.metadata,
        title: "Second subject",
        body: original.body,
      };
      const expected = [
        {
          item_id: id,
          prior_genesis_index: 1,
          repeated_create_index: 3,
          sequence: "delete_then_create",
        },
      ];
      for (const cacheHitVerification of [
        "content_hash",
        "metadata",
        "metadata",
      ] as const) {
        expect(
          await scanHistoryDrift(context.pmPath, [item], {
            cacheHitVerification,
          }),
        ).toMatchObject({ identityDiscontinuities: expected });
      }
      const validation = await buildValidateHistoryDriftCheck(
        context.pmPath,
        [item],
        true,
      );
      expect(validation.check).toMatchObject({
        status: "error",
        ok: false,
        details: { identity_discontinuities: expected },
      });
      await writeFile(
        path.join(context.pmPath, "tasks", `${id}.toon`),
        serializeItemDocument({
          ...original,
          metadata: { ...original.metadata, title: "Second subject" },
        }),
      );
      const cliValidation = context.runCli([
        "validate",
        "--check-history-drift",
        "--strict-exit",
        "--json",
      ]);
      expect(cliValidation.code).not.toBe(0);
      expect(JSON.parse(cliValidation.stdout)).toMatchObject({
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: "history_drift",
            status: "error",
            details: expect.objectContaining({
              identity_discontinuities: expected,
            }),
          }),
        ]),
      });
      const entries = await readHistoryEntries(file, id);
      expect(
        findHistoryIdentityDiscontinuities([entries[0]!, entries[2]!]),
      ).toEqual([
        {
          prior_genesis_index: 1,
          repeated_create_index: 2,
          sequence: "multiple_creates",
        },
      ]);
      expect(
        findHistoryIdentityDiscontinuities([
          { ...entries[0]!, op: "history_compact_baseline" },
          entries[2]!,
        ]),
      ).toEqual([
        {
          prior_genesis_index: 1,
          repeated_create_index: 2,
          sequence: "checkpoint_then_create",
        },
      ]);
      expect(findHistoryIdentityDiscontinuities([])).toEqual([]);
    });
  });

  it("never remints a deleted identity under the same deterministic seed", async () => {
    await withTempPmPath(async (context) => {
      const execution = {
        seed: "fixed-seed-alpha",
        clock: "2026-09-04T00:00:00Z",
        tickMs: 1,
      };
      const id = await runWithReproducibleExecution(execution, () =>
        generateItemId(context.pmPath, "pm-", { probeExisting: false }),
      );
      createTaskFixture(context, id, "Seeded subject");
      expect(context.runCli(["delete", id]).code).toBe(0);
      const nextId = await runWithReproducibleExecution(execution, () =>
        generateItemId(context.pmPath, "pm-", { probeExisting: false }),
      );
      expect(nextId).not.toBe(id);
    });
  });

  it.each(["string", "entry", "line"])(
    "guards %s service overrides at their effective history destination",
    async (shape) => {
      await withTempPmPath(async (context) => {
        const id = "pm-override-identity";
        createTaskFixture(context, id, "Reserved original");
        const file = path.join(context.pmPath, "history", `${id}.jsonl`);
        const raw = await readFile(file, "utf8");
        const [create] = await readHistoryEntries(file, id);
        const result =
          shape === "string"
            ? JSON.stringify(create)
            : {
                history_path: file,
                ...(shape === "entry"
                  ? { entry: create }
                  : { line: JSON.stringify(create) }),
              };
        setActiveExtensionServices({
          overrides: [
            {
              layer: "project",
              name: "identity-override-fixture",
              service: "history_append",
              run: () => result,
            },
          ],
        });
        try {
          await expect(
            appendHistoryEntry(
              shape === "string"
                ? file
                : path.join(context.pmPath, "history", "pm-other.jsonl"),
              { ...create!, op: "update" },
            ),
          ).rejects.toMatchObject({
            context: { code: "item_identity_reserved" },
          });
          expect(await readFile(file, "utf8")).toBe(raw);
        } finally {
          setActiveExtensionServices({ overrides: [] });
        }
      });
    },
  );

  it("refuses unknown legacy version offsets while allowing timestamp reads", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-legacy-offset";
      createTaskFixture(context, id, "Legacy checkpoint");
      await runHistoryCompact(id, {}, { path: context.pmPath });
      const file = path.join(context.pmPath, "history", `${id}.jsonl`);
      const entries = await readHistoryEntries(file, id);
      entries[0] = sealHistoryRecord({ ...entries[0]!, context: {} });
      await writeFile(
        file,
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      await expect(
        getItemAt(id, "1", { pmRoot: context.pmPath }),
      ).rejects.toMatchObject({
        context: { code: "history_version_mapping_unavailable" },
      });
      expect(
        (await getItemAt(id, entries[0]!.ts, { pmRoot: context.pmPath }))
          .as_of_version,
      ).toBeNull();
      const listed = await runHistory(
        id,
        { compact: true },
        { path: context.pmPath },
      );
      expect(listed.version_addressing).toEqual({
        offset: null,
        first_version: null,
        last_version: null,
      });
      expect(listed.compact_history).toHaveLength(entries.length);
      expect(
        listed.compact_history?.every((entry) => entry.version === null),
      ).toBe(true);
      const provenance = await runHistory(
        id,
        { provenance: true },
        { path: context.pmPath },
      );
      expect(provenance.provenance_history).toHaveLength(entries.length);
      const restored = await runRestore(
        id,
        entries[0]!.ts,
        {},
        { path: context.pmPath },
      );
      expect(restored.restored_from.version).toBeNull();
      for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER, "1"]) {
        const malformed = [
          {
            ...entries[0]!,
            context: { history_compaction: { version_offset: offset } },
          },
          entries[1]!,
        ];
        expect(historyVersionOffset(malformed, true)).toBeNull();
        expect(() => historyVersionOffset(malformed)).toThrow(/version offset/);
      }
    });
  });

  it.each([1, 2] as const)(
    "compacts verified epoch-%i histories without changing retained version states",
    async (epoch) => {
      await withTempPmPath(async (context) => {
        const id = "pm-legacy-compact";
        createTaskFixture(context, id, "Original legacy state");
        const itemFile = path.join(context.pmPath, "tasks", `${id}.toon`);
        const snapshots = [
          canonicalDocument(
            parseItemDocument(await readFile(itemFile, "utf8")),
          ),
        ];
        expect(
          context.runCli([
            "test",
            id,
            "--add",
            "command=node --version,scope=project",
          ]).code,
        ).toBe(0);
        snapshots.push(
          canonicalDocument(
            parseItemDocument(await readFile(itemFile, "utf8")),
          ),
        );
        expect(snapshots[1]!.metadata.tests?.[0]?.provenance).toBeDefined();
        const historyFile = path.join(context.pmPath, "history", `${id}.jsonl`);
        const entries = await readHistoryEntries(historyFile, id);
        const legacy = entries.map((entry, index) =>
          sealHistoryRecord({
            ...entry,
            item_hash_version: epoch,
            before_hash: hashDocumentVerificationCandidates(
              index === 0
                ? { metadata: {} as ItemMetadata, body: "" }
                : snapshots[index - 1]!,
              epoch,
            ).at(-1)!,
            after_hash: hashDocumentVerificationCandidates(
              snapshots[index]!,
              epoch,
            ).at(-1)!,
          }),
        );
        await writeFile(
          historyFile,
          `${legacy.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        );
        expect(
          (await runHistory(id, { verify: true }, { path: context.pmPath }))
            .verification?.ok,
        ).toBe(true);
        await runHistoryCompact(id, { before: "2" }, { path: context.pmPath });
        expect(
          (await getItemAt(id, "2", { pmRoot: context.pmPath })).document,
        ).toEqual(snapshots[1]);
        await runHistoryCompact(id, { before: "3" }, { path: context.pmPath });
        expect(
          (await getItemAt(id, "2", { pmRoot: context.pmPath })).document,
        ).toEqual(snapshots[1]);
      });
    },
  );
  it("salvages only invalid tails, preserves prefix bytes, and records an audit event", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-salvage";
      createTaskFixture(context, id, "Recover from crash padding");
      const file = path.join(context.pmPath, "history", `${id}.jsonl`);
      const original = await readFile(file, "utf8");
      const damaged = `${original}\0\0\0`;
      await writeFile(file, damaged);
      expect(
        await runHistoryRepair(
          id,
          { salvageTail: true, dryRun: true },
          { path: context.pmPath },
        ),
      ).toMatchObject({
        changed: true,
        salvage: { discarded_bytes: 3, retained_entries: 1 },
      });
      expect(await readFile(file, "utf8")).toBe(damaged);
      const result = context.runCli(
        ["history-repair", id, "--salvage-tail", "--json"],
        { expectJson: true },
      );
      expect(result.code, result.stderr).toBe(0);
      const repaired = await readFile(file, "utf8");
      expect(repaired.startsWith(original)).toBe(true);
      expect(repaired).toContain('"op":"history_salvage"');
      expect(
        (await getItemAt(id, "1", { pmRoot: context.pmPath })).document.metadata
          .description,
      ).toBe("Recover from crash padding");
      expect(() => inspectHistoryTail(`${original}\0\n${original}`)).toThrow(
        /interior corruption/,
      );
      expect(() => inspectHistoryTail("\0\0")).toThrow(
        /nonempty verified prefix/,
      );
      expect(() => inspectHistoryTail("<<<<<<< ours\n")).toThrow(
        /merge conflicts/,
      );
      expect(() => inspectHistoryTail("null\n")).toThrow(/interior corruption/);
      expect(inspectHistoryTail(repaired).receipt).toBeNull();
      expect(
        await runHistoryRepair(
          id,
          { salvageTail: true },
          { path: context.pmPath },
        ),
      ).toMatchObject({
        changed: false,
        history: { audit_entry_added: false },
      });
      await writeFile(file, `${repaired}\0\n\0`);
      expect(
        await runHistoryRepair(
          id,
          { salvageTail: true },
          { path: context.pmPath },
        ),
      ).toMatchObject({ changed: true, history: { audit_entry_added: true } });
      expect((await readHistoryEntries(file, id)).at(-1)?.event_class).toBe(
        "maintenance",
      );
      for (const invalid of ["{}", "[]", "false", '{"patch":[]}']) {
        expect(() => inspectHistoryTail(`${original}${invalid}\n`)).toThrow(
          /History salvage/,
        );
      }
      expect(() => inspectHistoryTail(`${original.trimEnd()}\0`)).toThrow(
        /potentially complete record/,
      );
      const brokenHash = (await readHistoryEntries(file, id))[0]!;
      expect(() =>
        inspectHistoryTail(
          `${JSON.stringify({ ...brokenHash, after_hash: "0".repeat(64) })}\n\0`,
        ),
      ).toThrow(/verified prefix/);
    });
  });

  it("retains the detected hash epoch and salvages missing or unreadable item files", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-salvage-legacy";
      createTaskFixture(context, id, "Legacy survivor");
      const original = (await getItemAt(id, "1", { pmRoot: context.pmPath }))
        .document;
      const file = path.join(context.pmPath, "history", `${id}.jsonl`);
      const itemFile = path.join(context.pmPath, "tasks", `${id}.toon`);
      const [entry] = await readHistoryEntries(file, id);
      const legacy = sealHistoryRecord({
        ...entry!,
        item_hash_version: 1,
        before_hash: hashDocumentForVersion(
          { metadata: {} as ItemMetadata, body: "" },
          1,
        ),
        after_hash: hashDocumentForVersion(original, 1),
      });
      await rm(itemFile);
      await writeFile(file, `${JSON.stringify(legacy)}\r\n\0`);
      const result = await runHistoryRepair(
        id,
        { salvageTail: true },
        { path: context.pmPath },
      );
      expect(result).toMatchObject({
        item: { exists: false },
        history: { item_hash_version_before: 1, item_hash_version_after: 1 },
      });
      expect(
        (await runHistory(id, { verify: true }, { path: context.pmPath }))
          .verification?.ok,
      ).toBe(true);
      await writeFile(itemFile, "truncated file");
      await writeFile(file, `${await readFile(file, "utf8")}\0`);
      expect(
        await runHistoryRepair(
          id,
          { salvageTail: true },
          { path: context.pmPath },
        ),
      ).toMatchObject({ changed: true, item: { exists: true } });
      expect(await readFile(itemFile, "utf8")).toBe("truncated file");
      await runRestore(id, "1", {}, { path: context.pmPath });
      expect(
        (await runHistory(id, { verify: true }, { path: context.pmPath }))
          .verification?.ok,
      ).toBe(true);
    });
  });

  it("refuses unsafe salvage selectors, conflicting modes, missing streams and foreign identities", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-salvage-refuse";
      createTaskFixture(context, id, "Guarded recovery");
      const file = path.join(context.pmPath, "history", `${id}.jsonl`);
      const raw = await readFile(file, "utf8");
      await expect(
        runHistoryRepair(
          id,
          { salvageTail: true, normalizeProvenance: true },
          { path: context.pmPath },
        ),
      ).rejects.toThrow(/combined/);
      await expect(
        runHistoryRepairAll({ salvageTail: true }, { path: context.pmPath }),
      ).rejects.toThrow(/one explicit item ID/);
      await writeFile(
        path.join(context.pmPath, "history", "pm-foreign.jsonl"),
        `${raw}\0`,
      );
      await expect(
        runHistoryRepair(
          "pm-foreign",
          { salvageTail: true },
          { path: context.pmPath },
        ),
      ).rejects.toThrow(/another item/);
      await rm(file);
      await expect(
        runHistoryRepair(id, { salvageTail: true }, { path: context.pmPath }),
      ).rejects.toThrow(/No history stream/);
    });
  });

  it("uses physical claim cutoffs but exposes durable versions after checkpointing", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-claim-cutoff";
      createTaskFixture(context, id, "Before claim");
      expect(
        context.runCli(["update", id, "--description", "Ready to claim"]).code,
      ).toBe(0);
      expect(context.runCli(["claim", id]).code).toBe(0);
      expect(context.runCli(["release", id]).code).toBe(0);
      await runHistoryCompact(id, { before: "3" }, { path: context.pmPath });
      const historical = await runGet(
        id,
        { path: context.pmPath },
        { at: "3", fields: "claim_state" },
      );
      expect(historical.claim_state).toMatchObject({
        claimed: true,
        last_release: null,
      });
      const compact = await runHistory(
        id,
        { compact: true },
        { path: context.pmPath },
      );
      expect(compact.version_addressing).toEqual({
        offset: 1,
        first_version: 2,
        last_version: 5,
      });
      expect(
        compact.compact_history?.map(({ index, version }) => [index, version]),
      ).toEqual([
        [1, 2],
        [2, 3],
        [3, 4],
        [4, 5],
      ]);
      const provenance = await runHistory(
        id,
        { provenance: true },
        { path: context.pmPath },
      );
      expect(
        provenance.provenance_history?.map(({ version }) => version),
      ).toEqual([2, 3, 4, 5]);
    });
  });

  it("refuses binary corruption and structural filesystem errors without altering bytes", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-binary-refusal";
      createTaskFixture(context, id, "Preserve exact bytes");
      const historyFile = path.join(context.pmPath, "history", `${id}.jsonl`);
      const itemFile = path.join(context.pmPath, "tasks", `${id}.toon`);
      const originalHistory = await readFile(historyFile);
      const binaryHistory = Buffer.concat([
        originalHistory,
        Buffer.from([0xff]),
      ]);
      await writeFile(historyFile, binaryHistory);
      await expect(
        runHistoryRepair(id, { salvageTail: true }, { path: context.pmPath }),
      ).rejects.toThrow(/UTF-8/);
      expect(await readFile(historyFile)).toEqual(binaryHistory);
      await writeFile(historyFile, originalHistory);
      const binaryItem = Buffer.from([0xff, 0xfe, 0x00]);
      await writeFile(itemFile, binaryItem);
      await expect(
        runRestore(id, "1", {}, { path: context.pmPath }),
      ).rejects.toMatchObject({
        context: { code: "item_document_encoding_invalid" },
      });
      expect(await readFile(itemFile)).toEqual(binaryItem);
      await rm(historyFile);
      await mkdir(historyFile);
      await expect(
        runHistoryRepair(id, { salvageTail: true }, { path: context.pmPath }),
      ).rejects.toMatchObject({ code: "EISDIR" });
    });
  });

  it.each(["item", "history"])(
    "refuses a competing %s write observed after the initial snapshot",
    async (target) => {
      await withTempPmPath(async (context) => {
        const id = "pm-salvage-race";
        createTaskFixture(context, id, "Concurrent writer wins");
        const historyFile = path.join(context.pmPath, "history", `${id}.jsonl`);
        const itemFile = path.join(context.pmPath, "tasks", `${id}.toon`);
        const raw = `${await readFile(historyFile, "utf8")}\0`;
        await writeFile(historyFile, raw);
        const targetFile = target === "item" ? itemFile : historyFile;
        const competingBytes = `${await readFile(targetFile, "utf8")}\n`;
        let writes = 0;
        setActiveExtensionHooks({
          beforeCommand: [],
          afterCommand: [],
          onWrite: [],
          onIndex: [],
          onRead: [
            {
              layer: "project",
              name: "concurrent-writer-fixture",
              run: async (event) => {
                if (event.path === itemFile && writes++ === 0)
                  await writeFile(targetFile, competingBytes);
              },
            },
          ],
        });
        try {
          await expect(
            runHistoryRepair(
              id,
              { salvageTail: true },
              { path: context.pmPath },
            ),
          ).rejects.toThrow(/changed while waiting/);
          expect(await readFile(targetFile, "utf8")).toBe(competingBytes);
          expect(await readFile(historyFile, "utf8")).not.toContain(
            '"op":"history_salvage"',
          );
        } finally {
          clearActiveExtensionHooks();
        }
      });
    },
  );

  it("names a missing baseline before attempting partial-state reconstruction", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-baseline";
      createTaskFixture(context, id, "Original");
      expect(
        context.runCli(["update", id, "--description", "Changed"]).code,
      ).toBe(0);
      const entries = await readHistoryEntries(
        path.join(context.pmPath, "history", `${id}.jsonl`),
        id,
      );
      expect(() => replayHistoryToTarget(entries.slice(1), 0)).toThrow(
        expect.objectContaining({
          context: expect.objectContaining({
            code: "history_baseline_unavailable",
          }),
        }),
      );
      const completeBaseline = sealHistoryRecord({
        ...entries[0]!,
        op: "update",
      });
      expect(replayHistoryToTarget([completeBaseline], 0).metadata.id).toBe(id);
      const incompleteBaseline = sealHistoryRecord({
        ...completeBaseline,
        patch: [{ op: "add", path: "/metadata/title", value: "No identity" }],
      });
      expect(() => replayHistoryToTarget([incompleteBaseline], 0)).toThrow(
        expect.objectContaining({
          context: expect.objectContaining({
            code: "history_baseline_unavailable",
          }),
        }),
      );
      for (const metadata of [{ title: "No identity" }, { id }]) {
        expect(() =>
          ensureMaterializedHistoryTarget(
            { metadata, body: "" },
            { kind: "version", raw: "1", historyIndex: 0 },
          ),
        ).toThrow(
          expect.objectContaining({
            context: expect.objectContaining({
              code: "history_baseline_unavailable",
            }),
          }),
        );
      }
      const itemFile = path.join(context.pmPath, "tasks", `${id}.toon`);
      const conflict =
        "<<<<<<< ours\ntitle: local\n=======\ntitle: incoming\n>>>>>>> theirs\n";
      await writeFile(itemFile, conflict);
      await expect(
        runRestore(id, "1", {}, { path: context.pmPath }),
      ).rejects.toMatchObject({
        context: { code: "merge_conflict_markers_detected" },
      });
      expect(await readFile(itemFile, "utf8")).toBe(conflict);
    });
  });
  it("keeps retained version addresses stable across repeated compactions", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-stable";
      createTaskFixture(context, id, "Version 1");
      const itemFile = path.join(context.pmPath, "tasks", `${id}.toon`);
      const snapshots = [
        canonicalDocument(parseItemDocument(await readFile(itemFile, "utf8"))),
      ];
      for (let version = 2; version <= 8; version += 1) {
        expect(
          context.runCli(["update", id, "--description", `Version ${version}`])
            .code,
        ).toBe(0);
        snapshots.push(
          canonicalDocument(
            parseItemDocument(await readFile(itemFile, "utf8")),
          ),
        );
      }
      const historyFile = path.join(context.pmPath, "history", `${id}.jsonl`);
      const originalEntries = await readHistoryEntries(historyFile, id);
      await runHistoryCompact(id, { before: "5" }, { path: context.pmPath });
      const firstCompacted = await readHistoryEntries(historyFile, id);
      expect(firstCompacted.slice(1, 5)).toEqual(originalEntries.slice(4));
      for (let version = 4; version <= 8; version += 1) {
        expect(
          (await getItemAt(id, String(version), { pmRoot: context.pmPath }))
            .document,
          `${id} original version ${version}`,
        ).toEqual(snapshots[version - 1]);
      }
      await expect(
        getItemAt(id, "3", { pmRoot: context.pmPath }),
      ).rejects.toMatchObject({ context: { code: "history_version_pruned" } });
      await runHistoryCompact(id, { before: "7" }, { path: context.pmPath });
      await rm(itemFile);
      for (let version = 6; version <= 10; version += 1) {
        expect(
          (await getItemAt(id, String(version), { pmRoot: context.pmPath }))
            .document,
          `${id} history-only version ${version}`,
        ).toEqual(snapshots[Math.min(version, 8) - 1]);
      }
      for (let version = 1; version <= 5; version += 1) {
        await expect(
          getItemAt(id, String(version), { pmRoot: context.pmPath }),
        ).rejects.toMatchObject({
          context: { code: "history_version_pruned" },
        });
      }
      const restored = await runRestore(id, "7", {}, { path: context.pmPath });
      expect(restored.item.description).toBe("Version 7");
      const entries = await readHistoryEntries(
        path.join(context.pmPath, "history", `${id}.jsonl`),
        id,
      );
      expect(entries[0]?.context?.history_compaction).toMatchObject({
        version_offset: 5,
      });
    });
  });

  it.each(["", "not an item", "title: truncated"])(
    "restores an unreadable item from verified history: %j",
    async (corrupt) => {
      await withTempPmPath(async (context) => {
        const id = "pm-recover";
        createTaskFixture(context, id, "Recoverable state");
        const file = path.join(context.pmPath, "tasks", `${id}.toon`);
        const original = await readFile(file, "utf8");
        await writeFile(file, corrupt);
        const result = await runRestore(id, "1", {}, { path: context.pmPath });
        expect(result.warnings).toContain("restore_unreadable_item_recovered");
        expect(await readFile(file, "utf8")).toBe(original);
      });
    },
  );

  it("reserves a deleted identity against explicit recreation", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-reserved";
      createTaskFixture(context, id, "Original identity");
      expect(context.runCli(["delete", id]).code).toBe(0);
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const original = await readFile(historyPath, "utf8");
      const recreated = context.runCli(
        [
          "create",
          "Task",
          "Replacement",
          "--id",
          id,
          "--create-mode",
          "progressive",
          "--json",
        ],
        { expectJson: true },
      );
      expect(recreated.code).not.toBe(0);
      expect(JSON.parse(recreated.stderr)).toMatchObject({
        code: "item_identity_reserved",
      });
      expect(await readFile(historyPath, "utf8")).toBe(original);
    });
  });
});
