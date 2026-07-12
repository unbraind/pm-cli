import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SCALE_TIER_ITEMS,
  buildSyntheticItemDocument,
  createSeededRandom,
  generateSyntheticWorkspace,
  generatorOptionsFromFlags,
  main,
  parsePositiveInteger,
  resolveScaleItemCount,
  scaleItemId,
} from "../../../scripts/bench/scale-workspace.mjs";
import { PmClient } from "../../../src/sdk/runtime.js";
import { withTempDir } from "../../helpers/temp.js";

async function fixtureFiles(pmRoot: string): Promise<Map<string, string>> {
  const names = (await readdir(pmRoot, { recursive: true }))
    .filter((name) => name.endsWith(".toon") || name.endsWith(".jsonl"))
    .sort();
  const entries = await Promise.all(
    names.map(async (name) => [name, await readFile(path.join(pmRoot, name), "utf8")] as const),
  );
  return new Map(entries);
}

describe("scale workspace generator", () => {
  it("resolves named and numeric tiers and rejects invalid positive integers", () => {
    expect(resolveScaleItemCount(undefined)).toBe(SCALE_TIER_ITEMS.ci);
    expect(resolveScaleItemCount("smoke")).toBe(100);
    expect(resolveScaleItemCount("10_000")).toBe(10_000);
    expect(parsePositiveInteger("7", "value")).toBe(7);
    for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parsePositiveInteger(value, "value")).toThrow(/positive safe integer/);
    }
    expect(generatorOptionsFromFlags(new Map(), "/tmp/defaults")).toEqual({
      workspaceRoot: "/tmp/defaults",
      itemCount: "ci",
      seed: 42,
      mode: "direct",
      force: false,
    });
  });

  it("produces stable random values, ids, and rich deterministic documents", () => {
    const left = createSeededRandom(9);
    const right = createSeededRandom(9);
    expect([left(), left(), left()]).toEqual([right(), right(), right()]);
    expect(scaleItemId(35)).toBe("pm-s000000z");

    const epic = buildSyntheticItemDocument(0, 9);
    expect(epic.metadata).toMatchObject({ type: "Epic", status: "open" });
    expect(epic.metadata.parent).toBeUndefined();
    expect(buildSyntheticItemDocument(13, 9).metadata.comments).toHaveLength(1);
    expect(buildSyntheticItemDocument(15, 9).metadata).toMatchObject({ status: "canceled" });
    expect(buildSyntheticItemDocument(17, 9).metadata).toMatchObject({ status: "open" });
    expect(buildSyntheticItemDocument(19, 9).metadata).toMatchObject({ status: "in_progress" });
    expect(buildSyntheticItemDocument(29, 9).metadata.notes).toHaveLength(1);
    expect(buildSyntheticItemDocument(31, 9).metadata.learnings).toHaveLength(1);
    expect(buildSyntheticItemDocument(33, 9).metadata.dependencies).toHaveLength(2);
    expect(buildSyntheticItemDocument(39, 9).metadata).toMatchObject({ status: "blocked" });
    const closed = buildSyntheticItemDocument(1, 9).metadata;
    expect(closed).toMatchObject({
      status: "closed",
      resolution: "Synthetic benchmark work completed",
      expected_result: "Fixture remains queryable and valid",
      actual_result: "Fixture generated deterministically",
    });
  });

  it("generates byte-identical valid item/history layouts through direct and SDK writes", async () => {
    await withTempDir("pm-scale-equivalence-", async (tempRoot) => {
      const directRoot = path.join(tempRoot, "direct");
      const sdkRoot = path.join(tempRoot, "sdk");
      const direct = await generateSyntheticWorkspace({
        workspaceRoot: directRoot,
        itemCount: 40,
        seed: 17,
        mode: "direct",
      });
      const sdk = await generateSyntheticWorkspace({
        workspaceRoot: sdkRoot,
        itemCount: 40,
        seed: 17,
        mode: "sdk",
      });

      expect(direct).toMatchObject({ item_count: 40, history_stream_count: 40, seed: 17, mode: "direct" });
      expect(sdk).toMatchObject({ item_count: 40, history_stream_count: 40, seed: 17, mode: "sdk" });
      expect(await fixtureFiles(direct.pm_root)).toEqual(await fixtureFiles(sdk.pm_root));
      const client = new PmClient({ pmRoot: direct.pm_root, cwd: directRoot, noExtensions: true });
      await expect(client.list({ status: "all", limit: "100" })).resolves.toMatchObject({ count: 40 });
      await expect(client.validate({ checkHistoryDrift: true })).resolves.toMatchObject({ ok: true });
    });
  });

  it("protects repository and non-empty targets, validates modes, and supports forced replacement", async () => {
    await expect(
      generateSyntheticWorkspace({ workspaceRoot: process.cwd(), itemCount: 1, mode: "direct" }),
    ).rejects.toThrow(/inside the repository/);
    await expect(
      generateSyntheticWorkspace({ workspaceRoot: path.join(path.dirname(process.cwd()), "outside"), itemCount: 1, mode: "bad" }),
    ).rejects.toThrow(/direct or sdk/);

    await withTempDir("pm-scale-safety-", async (tempRoot) => {
      const emptyWorkspaceRoot = path.join(tempRoot, "empty-workspace");
      await mkdir(emptyWorkspaceRoot);
      await expect(
        generateSyntheticWorkspace({ workspaceRoot: emptyWorkspaceRoot, itemCount: 1, mode: "direct" }),
      ).resolves.toMatchObject({ item_count: 1 });
      const workspaceRoot = path.join(tempRoot, "workspace");
      await mkdir(workspaceRoot);
      await writeFile(path.join(workspaceRoot, "keep.txt"), "occupied", "utf8");
      await expect(
        generateSyntheticWorkspace({ workspaceRoot, itemCount: 1, mode: "direct" }),
      ).rejects.toThrow(/not empty/);
      await expect(
        generateSyntheticWorkspace({
          workspaceRoot,
          itemCount: 1,
          force: true,
        }),
      ).rejects.toThrow(/non-fixture directory/);

      const replaceableRoot = path.join(tempRoot, "replaceable-fixture");
      await generateSyntheticWorkspace({
        workspaceRoot: replaceableRoot,
        itemCount: 1,
      });
      await writeFile(path.join(replaceableRoot, "stale.txt"), "stale", "utf8");
      await expect(
        generateSyntheticWorkspace({
          workspaceRoot: replaceableRoot,
          itemCount: 2,
          force: true,
        }),
      ).resolves.toMatchObject({ item_count: 2 });
      await expect(readFile(path.join(replaceableRoot, "stale.txt"), "utf8"))
        .rejects.toThrow();
    });
  });

  it("requires an output path in CLI mode and forwards explicit generator flags", async () => {
    await expect(main([])).rejects.toThrow(/--output/);
    await expect(main(["--output"])).rejects.toThrow(/--output/);
    await withTempDir("pm-scale-main-", async (tempRoot) => {
      const manifest = await main([
        "--output",
        path.join(tempRoot, "workspace"),
        "--items",
        "3",
        "--seed",
        "5",
        "--mode",
        "sdk",
        "--force",
      ]);
      expect(manifest).toMatchObject({ item_count: 3, seed: 5, mode: "sdk" });
    });
  });

  it("runs both top-level entrypoint outcomes without leaving generated data", async () => {
    const scriptPath = path.resolve(process.cwd(), "scripts/bench/scale-workspace.mjs");
    const originalArgv = [...process.argv];
    await withTempDir("pm-scale-entrypoint-", async (tempRoot) => {
      const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      process.argv = [process.execPath, scriptPath, "--output", path.join(tempRoot, "workspace"), "--items", "1"];
      vi.resetModules();
      await vi.importActual(scriptPath);
      await vi.waitFor(() => expect(stdoutWrite).toHaveBeenCalled());
      expect(String(stdoutWrite.mock.calls.at(-1)?.[0])).toContain('"item_count": 1');
      stdoutWrite.mockRestore();

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      process.argv = [process.execPath, scriptPath];
      vi.resetModules();
      await vi.importActual(scriptPath);
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--output"));
      process.argv = [process.execPath];
      vi.resetModules();
      await vi.importActual(scriptPath);
    });
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });
});
