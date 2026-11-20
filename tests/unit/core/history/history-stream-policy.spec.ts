import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fsUtils from "../../../../src/core/fs/fs-utils.js";
import { enforceHistoryStreamPolicyForItems } from "../../../../src/core/history/history-stream-policy.js";
import {
  clearActiveExtensionHooks,
  setActiveExtensionHooks,
} from "../../../../src/core/extensions/index.js";
import { getHistoryPath } from "../../../../src/core/store/paths.js";
import { SETTINGS_DEFAULTS } from "../../../../src/core/shared/constants.js";
import type { PmSettings } from "../../../../src/types/index.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  clearActiveExtensionHooks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function trackerRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-stream-policy-"));
  roots.push(root);
  await mkdir(path.join(root, "history"), { recursive: true });
  return root;
}

function settings(missingStream: "auto_create" | "strict_error"): PmSettings {
  return {
    ...SETTINGS_DEFAULTS,
    history: { ...SETTINGS_DEFAULTS.history, missing_stream: missingStream },
  } as PmSettings;
}

describe("history stream policy probes (GH-1664)", () => {
  it("creates only the streams still missing when their turn comes, in sorted order", async () => {
    const pmRoot = await trackerRoot();
    await writeFile(getHistoryPath(pmRoot, "pm-present"), "");
    const written: string[] = [];
    setActiveExtensionHooks({
      beforeCommand: [],
      afterCommand: [],
      onRead: [],
      onIndex: [],
      onWrite: [
        {
          layer: "project",
          name: "creates-the-next-stream",
          run: async (context) => {
            written.push(path.basename(context.path));
            // An earlier creation's hook creates a later missing stream.
            if (context.path.endsWith("pm-a.jsonl")) await writeFile(getHistoryPath(pmRoot, "pm-b"), "");
          },
        },
      ],
    });
    const result = await enforceHistoryStreamPolicyForItems({
      pmRoot,
      settings: settings("auto_create"),
      itemIds: ["pm-c", "pm-b", "pm-present", "pm-a", " ", "pm-a"],
      commandLabel: "activity",
    });
    expect(result.auto_created_ids).toEqual(["pm-a", "pm-c"]);
    expect(result.warnings).toEqual(["history_stream_auto_created:pm-a", "history_stream_auto_created:pm-c"]);
    expect(written).toEqual(["pm-a.jsonl", "pm-c.jsonl"]);
    await expect(stat(getHistoryPath(pmRoot, "pm-b"))).resolves.toBeTruthy();
  });

  it("recreates a later stream that an earlier creation's write hook removed", async () => {
    const pmRoot = await trackerRoot();
    await writeFile(getHistoryPath(pmRoot, "pm-c"), "");
    setActiveExtensionHooks({
      beforeCommand: [], afterCommand: [], onRead: [], onIndex: [],
      onWrite: [{ layer: "project", name: "removes-a-later-stream", run: async (context) => {
        if (context.path.endsWith("pm-a.jsonl")) await rm(getHistoryPath(pmRoot, "pm-c"));
      } }],
    });
    const result = await enforceHistoryStreamPolicyForItems({ pmRoot, settings: settings("auto_create"), itemIds: ["pm-a", "pm-c"], commandLabel: "stats" });
    expect(result.auto_created_ids).toEqual(["pm-a", "pm-c"]);
    await expect(stat(getHistoryPath(pmRoot, "pm-c"))).resolves.toBeTruthy();
  });

  it("does not report a stream another writer created after the bulk probe", async () => {
    const pmRoot = await trackerRoot();
    const probes = new Map<string, number>();
    const actual = fsUtils.pathExists;
    vi.spyOn(fsUtils, "pathExists").mockImplementation(async (target: string) => {
      const seen = (probes.get(target) ?? 0) + 1;
      probes.set(target, seen);
      // The bulk probe sees pm-b missing; another writer creates it before its turn.
      if (target.endsWith("pm-b.jsonl") && seen === 2) await writeFile(target, "");
      return actual(target);
    });
    const result = await enforceHistoryStreamPolicyForItems({ pmRoot, settings: settings("auto_create"), itemIds: ["pm-a", "pm-b"], commandLabel: "activity" });
    expect(result.auto_created_ids).toEqual(["pm-a"]);
  });

  it("raises an invalid id's error at its own sorted turn, after earlier missing streams", async () => {
    const pmRoot = await trackerRoot();
    const ids = ["pm-a", "pm-z/escape"];
    await expect(enforceHistoryStreamPolicyForItems({ pmRoot, settings: settings("strict_error"), itemIds: ids, commandLabel: "activity" }))
      .rejects.toThrow("Missing history stream for pm-a");
    await expect(enforceHistoryStreamPolicyForItems({ pmRoot, settings: settings("auto_create"), itemIds: ids, commandLabel: "activity" }))
      .rejects.toThrow("Invalid history item id");
    await expect(stat(getHistoryPath(pmRoot, "pm-a"))).resolves.toBeTruthy();
  });

  it("re-probes streams the bulk probe found present once it had to create one", async () => {
    const pmRoot = await trackerRoot();
    await writeFile(getHistoryPath(pmRoot, "pm-c"), "");
    const actual = fsUtils.pathExists;
    let removed = false;
    vi.spyOn(fsUtils, "pathExists").mockImplementation(async (target: string) => {
      // Another process removes pm-c after the bulk probe saw it, while pm-a is created.
      if (!removed && target.endsWith("pm-a.jsonl") && (await actual(getHistoryPath(pmRoot, "pm-c")))) {
        const present = await actual(target);
        if (!present) {
          removed = true;
          await rm(getHistoryPath(pmRoot, "pm-c"));
        }
        return present;
      }
      return actual(target);
    });
    const result = await enforceHistoryStreamPolicyForItems({ pmRoot, settings: settings("auto_create"), itemIds: ["pm-a", "pm-c"], commandLabel: "activity" });
    expect(removed).toBe(true);
    expect(result.auto_created_ids).toEqual(["pm-a", "pm-c"]);
    await expect(stat(getHistoryPath(pmRoot, "pm-c"))).resolves.toBeTruthy();
  });

  it("probes beyond one concurrency chunk and refuses the first missing stream under strict_error", async () => {
    const pmRoot = await trackerRoot();
    const ids = Array.from({ length: 130 }, (_, index) => `pm-${String(index).padStart(3, "0")}`);
    for (const id of ids.filter((_, index) => index !== 70 && index !== 90)) {
      await writeFile(getHistoryPath(pmRoot, id), "");
    }
    await expect(
      enforceHistoryStreamPolicyForItems({ pmRoot, settings: settings("strict_error"), itemIds: ids, commandLabel: "activity" }),
    ).rejects.toThrow("Missing history stream for pm-070");
    const created = await enforceHistoryStreamPolicyForItems({ pmRoot, settings: settings("auto_create"), itemIds: ids, commandLabel: "activity" });
    expect(created.auto_created_ids).toEqual(["pm-070", "pm-090"]);
  });
});
