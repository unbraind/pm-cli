/** @module tests/unit/sdk/history/attestation */
import fs, { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHistoryEntry } from "../../../../src/core/history/history.js";
import { historyEntriesToRaw } from "../../../../src/core/history/replay.js";
import { historyDigest } from "../../../../src/core/history/digest.js";
import { stableStringify } from "../../../../src/core/shared/serialization.js";
import { exportAttestation, parseHistoryAttestation, verifyAttestation } from "../../../../src/sdk/history/attestation.js";
import type { ItemDocument } from "../../../../src/types.js";

describe("portable history attestation", () => {
  it("verifies a bare history copy without creating locks or derived state and names every changed stream", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-attestation-"));
    try {
      await mkdir(path.join(pmRoot, "history"));
      const empty = { metadata: {}, body: "" } as ItemDocument;
      const item = { metadata: { id: "pm-proof", title: "Proof", description: "fixture", type: "Task", status: "open", priority: 2, tags: [] }, body: "" } as ItemDocument;
      const entry = createHistoryEntry({ nowIso: "2026-09-10T00:00:00.000Z", author: "fixture", op: "create", before: empty, after: item, hashAlgorithm: "sha512" });
      const streamPath = path.join(pmRoot, "history", "pm-proof.jsonl");
      await writeFile(streamPath, historyEntriesToRaw([entry]));
      const bundle = await exportAttestation({ pmRoot });
      for (const invalid of [null, [], {}, { ...bundle, hash_algorithm: "unknown" }, { ...bundle, generated_at: "yesterday" }, { ...bundle, extra: true }]) {
        expect(() => parseHistoryAttestation(invalid)).toThrow();
      }
      for (const changes of [
        { latest_after_hash: 42 }, { latest_record_hash: "invalid" }, { latest_hash_algorithm: "unknown" },
        { checkpoint_digest: 42 }, { rewrite_count: -1 }, { bytes: 1.5 }, { id: "../escape" },
        { entries: 0 }, { last_maintenance: {} }, { last_maintenance: { op: "history_repair", ts: "yesterday", record_hash: null } },
        { last_maintenance: { op: "history_repair", ts: bundle.generated_at, record_hash: "bad" } },
        { extra: "unvalidated" },
      ]) {
        const { workspace_digest: _, ...payload } = { ...bundle, streams: [{ ...bundle.streams[0], ...changes }] };
        const invalid = { ...payload, workspace_digest: historyDigest(stableStringify(payload), bundle.hash_algorithm) };
        expect(() => parseHistoryAttestation(invalid)).toThrow("stream");
      }
      expect(() => parseHistoryAttestation({ ...bundle, streams: [bundle.streams[0], bundle.streams[0]] })).toThrow("stream order");
      expect(bundle.streams).toHaveLength(1);
      expect(JSON.stringify(bundle)).not.toContain("fixture");
      expect(await verifyAttestation(bundle, { pmRoot })).toMatchObject({ ok: true, streams_checked: 1 });
      expect(await readdir(pmRoot)).toEqual(["history"]);
      const initialRaw = await readFile(streamPath, "utf8");
      await writeFile(streamPath, initialRaw.replace('"fixture"', '"tampered"'));
      expect(await verifyAttestation(bundle, { pmRoot })).toMatchObject({ ok: false, changed_streams: ["pm-proof"], invalid_streams: ["pm-proof"] });
      await writeFile(streamPath, initialRaw);
      await writeFile(path.join(pmRoot, "history", "_workspace.jsonl"), "");
      expect(await verifyAttestation(bundle, { pmRoot })).toMatchObject({ ok: false, added_streams: ["_workspace"] });
      const sha512 = await exportAttestation({ pmRoot, hashAlgorithm: "sha512", generatedAt: bundle.generated_at });
      expect(sha512.workspace_digest).toHaveLength(128);
      expect(await verifyAttestation(sha512, { pmRoot })).toMatchObject({ ok: true });
      await rm(streamPath);
      expect(await verifyAttestation(bundle, { pmRoot })).toMatchObject({ ok: false, missing_streams: ["pm-proof"] });
      await expect(verifyAttestation({ ...bundle, workspace_digest: "0".repeat(64) }, { pmRoot })).rejects.toThrow("attestation");
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });
  it("rejects malformed retained files instead of producing a partial proof", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-attestation-invalid-"));
    try {
      const empty = await exportAttestation({ pmRoot });
      expect(empty.streams).toEqual([]);
      await expect(exportAttestation({ pmRoot, generatedAt: "yesterday" })).rejects.toThrow("timestamp");
      await mkdir(path.join(pmRoot, "history"));
      const filename = path.join(pmRoot, "history", "pm-invalid.jsonl");
      for (const raw of ["{", "null", "[]", "{}", Buffer.from([0xff])]) {
        await writeFile(filename, raw);
        await expect(exportAttestation({ pmRoot })).rejects.toThrow("invalid streams pm-invalid");
        expect(await verifyAttestation(empty, { pmRoot })).toMatchObject({ ok: false, invalid_streams: ["pm-invalid"] });
      }
      await expect(exportAttestation({ pmRoot: filename })).rejects.toThrow("directory");
      await rm(filename);
      await symlink(path.join(pmRoot, "missing"), filename);
      await expect(exportAttestation({ pmRoot })).rejects.toThrow("invalid streams");
      await rm(filename);
      await writeFile(path.join(pmRoot, "history", "invalid name.jsonl"), "");
      await expect(exportAttestation({ pmRoot })).rejects.toThrow("invalid streams");
      await rm(path.join(pmRoot, "history"), { recursive: true });
      await writeFile(path.join(pmRoot, "history"), "not a directory");
      await expect(exportAttestation({ pmRoot })).rejects.toThrow();
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("rejects real inventory and byte changes that occur during a file read", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-attestation-race-"));
    try {
      const directory = path.join(pmRoot, "history");
      await mkdir(directory);
      const filename = path.join(directory, "pm-race.jsonl");
      await writeFile(filename, "");
      const read = fs.readFile.bind(fs);
      for (const change of ["inventory", "bytes"]) {
        const hook = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
          const bytes = await read(...args);
          if (args[0] === filename) {
            if (change === "inventory") await writeFile(path.join(directory, "pm-added.jsonl"), "");
            else await writeFile(filename, "\n");
          }
          return bytes;
        });
        try {
          await expect(exportAttestation({ pmRoot })).rejects.toThrow(
            change === "inventory" ? "inventory changed" : "stream changed",
          );
        } finally {
          hook.mockRestore();
        }
      }
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("exports legacy maintenance markers without whole-record seals", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-attestation-legacy-"));
    try {
      await mkdir(path.join(pmRoot, "history"));
      const empty = { metadata: {}, body: "" } as ItemDocument;
      const entry = createHistoryEntry({ nowIso: "2026-09-10T00:00:00.000Z", author: "fixture", op: "history_repair", before: empty, after: empty });
      delete entry.record_hash;
      delete entry.record_hash_version;
      delete entry.hash_algorithm;
      await writeFile(path.join(pmRoot, "history", "_workspace.jsonl"), historyEntriesToRaw([entry]));
      const bundle = await exportAttestation({ pmRoot });
      expect(bundle.streams[0]).toMatchObject({ latest_hash_algorithm: "sha256", latest_record_hash: null, last_maintenance: { op: "history_repair", record_hash: null } });
      expect(await verifyAttestation(bundle, { pmRoot })).toMatchObject({ ok: true });
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

});
