import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
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
      expect(await readFile(first.path, "utf8")).toBe(
        `${getPmGitignoreBlock()}\n`,
      );
      expect(getPmGitignoreBlock()).toContain(".agents/pm/locks/");
      expect(getPmGitignoreBlock()).toContain(
        "!.agents/pm/search/eval-queries.json",
      );

      await writeFile(
        first.path,
        `node_modules/\n\n# pm-cli:runtime-cache:start\n.agents/pm/search/.agents/pm/runtime/\n# pm-cli:runtime-cache:end\n`,
        "utf8",
      );
      expect((await ensurePmGitignore(root)).changed).toBe(true);
      const repaired = await readFile(first.path, "utf8");
      expect(repaired).toBe(`node_modules/\n\n${getPmGitignoreBlock()}\n`);
      expect((await ensurePmGitignore(root)).changed).toBe(false);
      expect((await ensurePmGitignore(root, { pmRoot: root })).changed).toBe(
        false,
      );

      const dotDotNamedRoot = path.join(root, "..pm");
      await mkdir(dotDotNamedRoot);
      expect(
        (await ensurePmGitignore(root, { pmRoot: dotDotNamedRoot })).changed,
      ).toBe(true);
      expect(await readFile(first.path, "utf8")).toContain("..pm/runtime/");
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

  it("classifies a permission-constrained managed file without replacing its bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-gitignore-permission-"));
    const gitignorePath = path.join(root, ".gitignore");
    try {
      await writeFile(gitignorePath, "sentinel\n", "utf8");
      await chmod(gitignorePath, 0o000);

      const failure = await ensurePmGitignore(root).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PmCliError);
      expect(failure).toMatchObject({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
        code: "init_gitignore_unwritable",
        context: {
          code: "init_gitignore_unwritable",
          reason: "eacces",
          required: expect.stringContaining("write access"),
          nextSteps: expect.arrayContaining([
            expect.stringContaining("writable workspace"),
          ]),
        },
      });
      expect(String((failure as Error).message)).not.toContain(root);

      await chmod(gitignorePath, 0o600);
      expect(await readFile(gitignorePath, "utf8")).toBe("sentinel\n");
    } finally {
      await chmod(gitignorePath, 0o600).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not write ignore rules for a tracker outside the workspace", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "pm-gitignore-external-"),
    );
    const external = await mkdtemp(
      path.join(os.tmpdir(), "pm-gitignore-tracker-"),
    );
    try {
      expect(await ensurePmGitignore(root, { pmRoot: external })).toEqual({
        path: path.join(root, ".gitignore"),
        changed: false,
      });
      await expect(
        readFile(path.join(root, ".gitignore"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(external, { recursive: true, force: true }),
      ]);
    }
  });
});
