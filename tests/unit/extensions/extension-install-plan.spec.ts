import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildExtensionInstallPlan, planExtensionDirectoryCopy } from "../../../src/sdk/extension/install-plan.js";

describe("bounded extension copy planning", () => {
  it("measures external snapshots including development files and excludes nested destinations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-copy-plan-"));
    try {
      const source = path.join(root, "source");
      await fs.mkdir(path.join(source, "node_modules"), { recursive: true });
      await fs.writeFile(path.join(source, "index.ts"), "export default {};");
      await fs.writeFile(path.join(source, "node_modules", "dev"), "development");
      const plan = await planExtensionDirectoryCopy(source, path.join(root, "destination"));
      expect(plan).toMatchObject({ copy_scope: "directory_snapshot", files: 2, bytes: 29, complete: true, development_entries: 2 });
      await fs.mkdir(path.join(source, "plugins", ".agents"), { recursive: true });
      await fs.writeFile(path.join(source, "plugins", ".agents", "state.json"), "tracker state");
      const nested = await planExtensionDirectoryCopy(source, path.join(source, ".agents", "pm", "extensions", "sample"));
      expect(nested).toMatchObject({ copy_scope: "nested_filtered_snapshot", files: 1, bytes: 18, complete: true });
      expect(await planExtensionDirectoryCopy(source, source)).toMatchObject({ copy_scope: "in_place", files: 0, bytes: 0, complete: true });
      const limited = await planExtensionDirectoryCopy(source, path.join(root, "destination"), { maxEntries: 1 });
      expect(limited).toMatchObject({ complete: false, scanned_entries: 1, stop_reason: "entry_limit" });
      await expect(fs.stat(path.join(root, "destination"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid budgets and observes cancellation before filesystem reads", async () => {
    for (const maxEntries of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(planExtensionDirectoryCopy("missing", "target", { maxEntries })).rejects.toThrow("maxEntries");
    }
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(planExtensionDirectoryCopy("missing", "target", { signal })).rejects.toThrow("cancelled");
  });

  it("bounds deep trees and counts links without visiting their targets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-copy-depth-"));
    try {
      const source = path.join(root, "source");
      await fs.mkdir(path.join(source, "deep", "deeper"), { recursive: true });
      await fs.writeFile(path.join(source, "deep", "deeper", "payload"), "payload");
      const destination = path.join(root, "destination");
      expect(await planExtensionDirectoryCopy(source, destination, { maxDepth: 2 })).toMatchObject({ complete: false, stop_reason: "depth_limit", directories: 2, files: 0 });
      await fs.symlink(source, path.join(source, "cycle"), process.platform === "win32" ? "junction" : "dir");
      expect(await planExtensionDirectoryCopy(source, destination)).toMatchObject({ complete: true, symlinks: 1, files: 1, bytes: 7 });
      const alias = path.join(root, "alias");
      await fs.symlink(source, alias, process.platform === "win32" ? "junction" : "dir");
      expect(await planExtensionDirectoryCopy(source, alias)).toMatchObject({ copy_scope: "in_place", files: 0, bytes: 0, scanned_entries: 0 });
      expect(await planExtensionDirectoryCopy(alias, path.join(alias, "installed"))).toMatchObject({ copy_scope: "nested_filtered_snapshot", source_directory: await fs.realpath(source) });
      const replacedAlias = path.join(root, "replaced-alias");
      await fs.symlink(path.join(source, "deep"), replacedAlias, process.platform === "win32" ? "junction" : "dir");
      expect(await planExtensionDirectoryCopy(source, replacedAlias)).toMatchObject({ copy_scope: "directory_snapshot", files: 1, bytes: 7 });
      await expect(planExtensionDirectoryCopy(source, destination, { maxDepth: 0 })).rejects.toThrow("maxDepth");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("reports special files separately from logical bytes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-copy-special-"));
    try {
      expect(spawnSync("mkfifo", [path.join(root, "pipe")]).status).toBe(0);
      expect(await planExtensionDirectoryCopy(root, `${root}-destination`)).toMatchObject({ other_entries: 1, files: 0, bytes: 0, complete: true });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("distinguishes source modes and only suggests packing local development snapshots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-copy-modes-"));
    try {
      const source = path.join(root, "source");
      await fs.mkdir(source);
      const destination = path.join(root, "destination");
      const local = { source: { kind: "local", input: source, absolute_path: source }, directory: source } as const;
      expect(await buildExtensionInstallPlan(local, destination, "project")).toMatchObject({ source_mode: "directory", copy: { files: 0 } });
      await fs.mkdir(path.join(source, "dist"));
      expect(await buildExtensionInstallPlan(local, destination, "project")).not.toHaveProperty("packed_alternative");
      await fs.writeFile(path.join(root, "package.json"), "{}");
      expect(await buildExtensionInstallPlan({ ...local, source_root: root }, destination, "global")).toHaveProperty("packed_alternative.install.args", ["package", "install", "<archive-filename>", "--global"]);
      const archive = path.join(root, "archive.tgz");
      await fs.writeFile(archive, "archive bytes");
      expect(await buildExtensionInstallPlan({ ...local, source: { kind: "local", input: archive, absolute_path: archive } }, destination, "project")).toMatchObject({ source_mode: "archive", archive_bytes: 13 });
      expect(await buildExtensionInstallPlan({ directory: source, source: { kind: "npm", input: "npm:demo", spec: "demo" } }, destination, "project")).toHaveProperty("source_mode", "npm");
      expect(await buildExtensionInstallPlan({ directory: source, source: { kind: "github", input: "org/repo", owner: "org", repo: "repo", repository: "https://github.com/org/repo.git" } }, destination, "project")).toHaveProperty("source_mode", "github");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
