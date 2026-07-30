import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listAllItemMetadata,
  listAllItemMetadataLight,
  listAllItemMetadataWithBody,
} from "../../../../src/core/store/item-store.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";

const cleanupRoots: string[] = [];

describe("item metadata tracker-root contract", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      cleanupRoots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("distinguishes a valid empty tracker directory from a missing root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-root-contract-"));
    cleanupRoots.push(root);
    await expect(listAllItemMetadata(root)).resolves.toEqual([]);

    const missing = path.join(root, "missing", ".agents", "pm");
    for (const read of [
      listAllItemMetadata,
      listAllItemMetadataLight,
      listAllItemMetadataWithBody,
    ]) {
      await expect(read(missing)).rejects.toMatchObject({
        name: "PmCliError",
        exitCode: EXIT_CODE.NOT_FOUND,
        code: "tracker_root_missing",
        context: {
          reason: "missing",
        },
      });
    }
  });

  it("rejects a regular file root with a stable typed diagnostic", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-root-contract-"));
    cleanupRoots.push(root);
    const fileRoot = path.join(root, "not-a-directory");
    await fs.writeFile(fileRoot, "not a tracker\n", "utf8");

    await expect(listAllItemMetadata(fileRoot)).rejects.toMatchObject({
      name: "PmCliError",
      exitCode: EXIT_CODE.USAGE,
      code: "tracker_root_not_directory",
      context: {
        reason: "not_a_directory",
      },
    });
    await expect(
      listAllItemMetadata(path.join(fileRoot, "child")),
    ).rejects.toMatchObject({
      name: "PmCliError",
      exitCode: EXIT_CODE.USAGE,
      code: "tracker_root_not_directory",
      context: {
        reason: "not_a_directory",
      },
    });
  });

  it("detects a file ancestor when Windows reports its child as missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-root-contract-"));
    cleanupRoots.push(root);
    const fileRoot = path.join(root, "not-a-directory");
    const nestedRoot = path.join(fileRoot, "child");
    await fs.writeFile(fileRoot, "not a tracker\n", "utf8");
    const realStat = fs.stat.bind(fs);
    vi.spyOn(fs, "stat").mockImplementation(async (target) => {
      if (target === nestedRoot) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return realStat(target);
    });

    await expect(listAllItemMetadata(nestedRoot)).rejects.toMatchObject({
      name: "PmCliError",
      exitCode: EXIT_CODE.USAGE,
      code: "tracker_root_not_directory",
      context: {
        reason: "not_a_directory",
      },
    });
  });

  it("normalizes ancestor ENOTDIR and preserves unrelated ancestor errors", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-root-contract-"));
    cleanupRoots.push(root);
    const nestedRoot = path.join(root, "ancestor", "child");
    const stat = vi.spyOn(fs, "stat");
    stat.mockRejectedValueOnce(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    stat.mockRejectedValueOnce(
      Object.assign(new Error("not a directory"), { code: "ENOTDIR" }),
    );

    await expect(listAllItemMetadata(nestedRoot)).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
      code: "tracker_root_not_directory",
    });

    const permissionFailure = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    stat.mockRejectedValueOnce(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    stat.mockRejectedValueOnce(permissionFailure);
    await expect(listAllItemMetadata(nestedRoot)).rejects.toBe(
      permissionFailure,
    );
  });

  it("keeps a missing filesystem root classified as missing", async () => {
    vi.spyOn(fs, "stat").mockRejectedValueOnce(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );

    await expect(
      listAllItemMetadata(path.parse(path.resolve(".")).root),
    ).rejects.toMatchObject({
      exitCode: EXIT_CODE.NOT_FOUND,
      code: "tracker_root_missing",
    });
  });

  it("preserves non-missing filesystem failures from the root probe", async () => {
    const failure = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    vi.spyOn(fs, "stat").mockRejectedValueOnce(failure);

    await expect(listAllItemMetadata("/unreadable-tracker")).rejects.toBe(
      failure,
    );
  });
});
