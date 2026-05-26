import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkHistoryRewriteOwnership,
  verifyHistoryRewriteNoDrift,
} from "../../src/core/history/history-rewrite.js";
import { writeFileAtomic } from "../../src/core/fs/fs-utils.js";
import { SETTINGS_DEFAULTS } from "../../src/core/shared/constants.js";
import type { ItemTypeRegistry } from "../../src/core/item/type-registry.js";
import { resolveItemTypeRegistry } from "../../src/core/item/type-registry.js";
import { serializeItemDocument } from "../../src/core/item/item-format.js";
import type { ItemDocument, ItemMetadata, PmSettings } from "../../src/types/index.js";

function freshSettings(overrides: Partial<PmSettings> = {}): PmSettings {
  return JSON.parse(JSON.stringify({ ...SETTINGS_DEFAULTS, ...overrides })) as PmSettings;
}

function fullMetadata(overrides: Record<string, unknown> = {}): ItemMetadata {
  return {
    id: "pm-rwt1",
    title: "Sample",
    description: "desc",
    type: "Task",
    status: "open",
    priority: 2,
    tags: [],
    dependencies: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as unknown as ItemMetadata;
}

function makeDocument(overrides: Record<string, unknown> = {}): ItemDocument {
  return { metadata: fullMetadata(overrides), body: "" };
}

describe("checkHistoryRewriteOwnership", () => {
  it("returns no warnings when there is no item document to inspect", () => {
    expect(
      checkHistoryRewriteOwnership({
        itemDocument: null,
        subjectId: "pm-rwt1",
        author: "alice",
        force: false,
        settings: freshSettings(),
      }),
    ).toEqual([]);
  });

  it("returns no warnings when assignee matches the author", () => {
    expect(
      checkHistoryRewriteOwnership({
        itemDocument: makeDocument({ assignee: "alice" }),
        subjectId: "pm-rwt1",
        author: "alice",
        force: false,
        settings: freshSettings(),
      }),
    ).toEqual([]);
  });

  it("returns no warnings when --force is set even with conflicting assignee", () => {
    expect(
      checkHistoryRewriteOwnership({
        itemDocument: makeDocument({ assignee: "bob" }),
        subjectId: "pm-rwt1",
        author: "alice",
        force: true,
        settings: freshSettings({ governance: { ...SETTINGS_DEFAULTS.governance, preset: "custom", ownership_enforcement: "strict" } }),
      }),
    ).toEqual([]);
  });

  it("treats whitespace-only assignees as no conflict", () => {
    expect(
      checkHistoryRewriteOwnership({
        itemDocument: makeDocument({ assignee: "   " }),
        subjectId: "pm-rwt1",
        author: "alice",
        force: false,
        settings: freshSettings({ governance: { ...SETTINGS_DEFAULTS.governance, preset: "custom", ownership_enforcement: "strict" } }),
      }),
    ).toEqual([]);
  });

  it("throws CONFLICT under strict ownership enforcement", () => {
    expect(() =>
      checkHistoryRewriteOwnership({
        itemDocument: makeDocument({ assignee: "bob" }),
        subjectId: "pm-rwt1",
        author: "alice",
        force: false,
        settings: freshSettings({ governance: { ...SETTINGS_DEFAULTS.governance, preset: "custom", ownership_enforcement: "strict" } }),
      }),
    ).toThrow(/assigned to bob.*--force/);
  });

  it("returns an ownership warning under warn enforcement", () => {
    const warnings = checkHistoryRewriteOwnership({
      itemDocument: makeDocument({ assignee: "bob" }),
      subjectId: "pm-rwt1",
      author: "alice",
      force: false,
      settings: freshSettings({
        governance: { ...SETTINGS_DEFAULTS.governance, preset: "custom", ownership_enforcement: "warn" },
      }),
    });
    expect(warnings).toEqual(["ownership_warning:assignee_conflict:pm-rwt1:bob"]);
  });

  it("stays quiet when ownership_enforcement is none", () => {
    expect(
      checkHistoryRewriteOwnership({
        itemDocument: makeDocument({ assignee: "bob" }),
        subjectId: "pm-rwt1",
        author: "alice",
        force: false,
        settings: freshSettings({
          governance: { ...SETTINGS_DEFAULTS.governance, preset: "custom", ownership_enforcement: "none" },
        }),
      }),
    ).toEqual([]);
  });

  it("falls back to undefined force without throwing", () => {
    expect(
      checkHistoryRewriteOwnership({
        itemDocument: makeDocument({ assignee: "alice" }),
        subjectId: "pm-rwt1",
        author: "alice",
        force: undefined,
        settings: freshSettings(),
      }),
    ).toEqual([]);
  });
});

describe("verifyHistoryRewriteNoDrift", () => {
  let tempRoot: string;
  let typeRegistry: ItemTypeRegistry;
  const settings = freshSettings();
  const subjectId = "pm-rwt1";

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-history-rewrite-"));
    typeRegistry = resolveItemTypeRegistry(settings, []);
    const tasksDir = path.join(tempRoot, "tasks");
    const historyDir = path.join(tempRoot, "history");
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.mkdir(historyDir, { recursive: true });
    // Seed item + history files on disk so locateItem can find them.
    const itemPath = path.join(tasksDir, `${subjectId}.toon`);
    const document = makeDocument();
    const raw = serializeItemDocument(document, { format: "toon", schema: settings.schema });
    await writeFileAtomic(itemPath, raw);
    await writeFileAtomic(path.join(historyDir, `${subjectId}.jsonl`), "{}\n");
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("accepts a snapshot that still matches both history and item under lock", async () => {
    const historyPath = path.join(tempRoot, "history", `${subjectId}.jsonl`);
    const raw = await fs.readFile(historyPath, "utf8");
    const itemPath = path.join(tempRoot, "tasks", `${subjectId}.toon`);
    const itemRaw = await fs.readFile(itemPath, "utf8");
    const result = await verifyHistoryRewriteNoDrift({
      pmRoot: tempRoot,
      subject: { id: subjectId, historyPath },
      settings,
      typeRegistry,
      historyRawBeforeLock: raw,
      currentItemRawBeforeLock: itemRaw,
      operation: "history-redact",
    });
    expect(result.historyRawUnderLock).toBe(raw);
    expect(result.locatedUnderLock).not.toBeNull();
    expect(result.loadedItemUnderLock?.raw).toBe(itemRaw);
  });

  it("throws CONFLICT when the history stream was modified during the wait", async () => {
    const historyPath = path.join(tempRoot, "history", `${subjectId}.jsonl`);
    const raw = await fs.readFile(historyPath, "utf8");
    const itemRaw = await fs.readFile(path.join(tempRoot, "tasks", `${subjectId}.toon`), "utf8");
    await writeFileAtomic(historyPath, "{}\n{}\n");
    await expect(
      verifyHistoryRewriteNoDrift({
        pmRoot: tempRoot,
        subject: { id: subjectId, historyPath },
        settings,
        typeRegistry,
        historyRawBeforeLock: raw,
        currentItemRawBeforeLock: itemRaw,
        operation: "history-redact",
      }),
    ).rejects.toThrow(/History for pm-rwt1 changed.*retry history-redact/);
  });

  it("throws CONFLICT when the item file diverged before the lock was held", async () => {
    const historyPath = path.join(tempRoot, "history", `${subjectId}.jsonl`);
    const raw = await fs.readFile(historyPath, "utf8");
    const itemPath = path.join(tempRoot, "tasks", `${subjectId}.toon`);
    const driftedDocument = makeDocument({ status: "in_progress" });
    const driftedRaw = serializeItemDocument(driftedDocument, { format: "toon", schema: settings.schema });
    await writeFileAtomic(itemPath, driftedRaw);
    await expect(
      verifyHistoryRewriteNoDrift({
        pmRoot: tempRoot,
        subject: { id: subjectId, historyPath },
        settings,
        typeRegistry,
        historyRawBeforeLock: raw,
        currentItemRawBeforeLock: "not the on-disk raw",
        operation: "history-repair",
      }),
    ).rejects.toThrow(/Item pm-rwt1 changed.*retry history-repair/);
  });

  it("returns a null located result when the item file no longer exists", async () => {
    const historyPath = path.join(tempRoot, "history", `${subjectId}.jsonl`);
    const raw = await fs.readFile(historyPath, "utf8");
    await fs.rm(path.join(tempRoot, "tasks", `${subjectId}.toon`), { force: true });
    const result = await verifyHistoryRewriteNoDrift({
      pmRoot: tempRoot,
      subject: { id: subjectId, historyPath },
      settings,
      typeRegistry,
      historyRawBeforeLock: raw,
      currentItemRawBeforeLock: null,
      operation: "history-redact",
    });
    expect(result.locatedUnderLock).toBeNull();
    expect(result.loadedItemUnderLock).toBeNull();
  });
});
