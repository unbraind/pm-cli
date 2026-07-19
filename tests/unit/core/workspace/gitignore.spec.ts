import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensurePmGitignore,
  getPmGitignoreBlock,
} from "../../../../src/sdk/workspace.js";

describe("ensurePmGitignore", () => {
  it("creates, repairs, and then preserves the canonical fenced block", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-gitignore-"));
    try {
      const first = await ensurePmGitignore(root);
      expect(first.changed).toBe(true);
      expect(await readFile(first.path, "utf8")).toBe(`${getPmGitignoreBlock()}\n`);
      expect(getPmGitignoreBlock()).toContain(".agents/pm/locks/");

      await writeFile(
        first.path,
        `node_modules/\n\n# pm-cli:runtime-cache:start\n.agents/pm/search/.agents/pm/runtime/\n# pm-cli:runtime-cache:end\n`,
        "utf8",
      );
      expect((await ensurePmGitignore(root)).changed).toBe(true);
      const repaired = await readFile(first.path, "utf8");
      expect(repaired).toBe(`node_modules/\n\n${getPmGitignoreBlock()}\n`);
      expect((await ensurePmGitignore(root)).changed).toBe(false);
      expect((await ensurePmGitignore(root, { pmRoot: root })).changed).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("propagates unexpected read failures without replacing the target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-gitignore-error-"));
    try {
      await mkdir(path.join(root, ".gitignore"));
      await expect(ensurePmGitignore(root)).rejects.toMatchObject({
        code: expect.stringMatching(/^(EISDIR|EACCES)$/),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not write ignore rules for a tracker outside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-gitignore-external-"));
    const external = await mkdtemp(path.join(os.tmpdir(), "pm-gitignore-tracker-"));
    try {
      expect(await ensurePmGitignore(root, { pmRoot: external })).toEqual({
        path: path.join(root, ".gitignore"),
        changed: false,
      });
      await expect(readFile(path.join(root, ".gitignore"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(external, { recursive: true, force: true }),
      ]);
    }
  });
});
