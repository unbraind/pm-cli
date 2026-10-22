import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import {
  ensurePmGitignore,
  getPmGitignoreBlock,
} from "../../../../src/sdk/workspace.js";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

describe("ensurePmGitignore", () => {
  it.each(["EACCES", "ENOENT"])("refuses %s physical ancestry failures without writing lexical fallback rules", async (code) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-gitignore-physical-error-"));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const failure = Object.assign(new Error("physical ancestry unavailable"), { code });
    vi.mocked(realpath).mockRejectedValue(failure);
    try {
      await expect(ensurePmGitignore(root, { pmRoot: path.join(root, "tracker") })).rejects.toBe(failure);
      await expect(readFile(path.join(root, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.mocked(realpath).mockImplementation(actual.realpath);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["workspace", "tracker", "missing-tracker"])("resolves physical containment through a %s alias", async (mode) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-gitignore-alias-"));
    try {
      const physicalRoot = await realpath(root);
      const workspace = path.join(physicalRoot, "workspace");
      const alias = path.join(physicalRoot, "alias");
      await mkdir(workspace);
      await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
      const tracker = "sub/t[1]";
      if (mode !== "missing-tracker") await mkdir(path.join(workspace, tracker), { recursive: true });
      const workspacePath = mode === "workspace" ? alias : workspace;
      const trackerPath = path.join(mode === "workspace" ? workspace : alias, tracker);
      expect((await ensurePmGitignore(workspacePath, { pmRoot: trackerPath })).changed).toBe(true);
      expect(await readFile(path.join(workspace, ".gitignore"), "utf8")).toBe(`${getPmGitignoreBlock(tracker)}\n`);
      expect((await ensurePmGitignore(workspacePath, { pmRoot: trackerPath })).changed).toBe(false);

      const external = path.join(physicalRoot, "external");
      await mkdir(external);
      await symlink(external, path.join(workspace, "outside"), process.platform === "win32" ? "junction" : "dir");
      expect((await ensurePmGitignore(workspacePath, { pmRoot: path.join(workspacePath, "outside", "tracker") })).changed).toBe(false);
      expect(await readFile(path.join(workspace, ".gitignore"), "utf8")).toBe(`${getPmGitignoreBlock(tracker)}\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([["./custom///", "custom"], ["/", ""]])("normalizes renderer root %j without changing its scope", (input, expected) => {
    expect(getPmGitignoreBlock(input)).toBe(getPmGitignoreBlock(expected));
  });

  it("bounds normalization work for a long slash run followed by a literal name", () => {
    const tracker = `custom${"/".repeat(80_000)}x`;
    const started = performance.now();
    const rendered = getPmGitignoreBlock(tracker);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(rendered).toContain(`${tracker}/runtime/`);
  });

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
        true,
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

  it.each([false, true])("preserves all tracker scopes and user bytes in either order (nested first: %s)", async (nestedFirst) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-gitignore-scopes-"));
    try {
      const roots = [".agents/pm", "sub/t"];
      if (nestedFirst) roots.reverse();
      const userRules = "node_modules/\n# user content\n";
      await writeFile(path.join(root, ".gitignore"), userRules);
      for (const tracker of roots) await ensurePmGitignore(root, { pmRoot: path.join(root, tracker) });
      const before = await readFile(path.join(root, ".gitignore"), "utf8");
      expect(before.startsWith(userRules)).toBe(true);
      for (const tracker of roots) {
        expect((await ensurePmGitignore(root, { pmRoot: path.join(root, tracker) })).changed).toBe(false);
        expect(before).toContain(`${tracker}/runtime/`);
        expect(before).toContain(`!${tracker}/search/eval-queries.json`);
      }
      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["", "custom[1]", "star*", "question?", "#tracker", "!tracker", "with space", "trailing "])("uses literal, anchored Git rules for tracker root %j", async (tracker) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-gitignore-literal-"));
    try {
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
      execFileSync("git", ["init", "--quiet"], { cwd: root, env });
      await ensurePmGitignore(root, { pmRoot: path.join(root, tracker) });
      const prefix = tracker ? `${tracker}/` : "";
      for (const directory of ["runtime", "search", "locks", "transactions", "checkpoints"]) {
        const candidate = `${prefix}${directory}/cache`;
        const result = spawnSync("git", ["check-ignore", "--no-index", "--", candidate], { cwd: root, env, encoding: "utf8" });
        expect(result.status, candidate + result.stderr).toBe(0);
      }
      for (const candidate of [`${prefix}search/eval-queries.json`, `${prefix}tasks/item.toon`, `other/${prefix}runtime/cache`, "custom1/runtime/cache", "starX/runtime/cache", "questionX/runtime/cache"]) {
        expect(spawnSync("git", ["check-ignore", "--no-index", "--", candidate], { cwd: root, env }).status, candidate).toBe(1);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("consolidates complete legacy fences while retaining CRLF and user suffixes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-gitignore-legacy-"));
    try {
      const content = `# before\r\n${getPmGitignoreBlock().replaceAll("\n", "\r\n")}\r\n${getPmGitignoreBlock("other").replaceAll("\n", "\r\n")}\r\n# after\r\n`;
      await writeFile(path.join(root, ".gitignore"), content);
      await ensurePmGitignore(root);
      const after = await readFile(path.join(root, ".gitignore"), "utf8");
      expect(after.startsWith("# before\r\n")).toBe(true);
      expect(after.endsWith("# after\r\n")).toBe(true);
      expect(after).toContain("other/runtime/\r\n");
      expect(after.replaceAll("\r\n", "")).not.toContain("\n");
      expect((await ensurePmGitignore(root, { pmRoot: path.join(root, "other") })).changed).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["sentinel", "# example: # pm-cli:runtime-cache:start\n", "# pm-cli:runtime-cache:end\n"])("preserves unmatched user content %j", async (content) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-gitignore-user-"));
    try {
      await writeFile(path.join(root, ".gitignore"), content);
      await ensurePmGitignore(root);
      expect((await readFile(path.join(root, ".gitignore"), "utf8")).startsWith(content)).toBe(true);
      expect((await ensurePmGitignore(root)).changed).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves repeated unmatched opening fences and remains idempotent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-gitignore-unmatched-"));
    const prefix = "# pm-cli:runtime-cache:start\n".repeat(4_000);
    try {
      await writeFile(path.join(root, ".gitignore"), prefix);
      await ensurePmGitignore(root);
      const after = await readFile(path.join(root, ".gitignore"), "utf8");
      expect(after.startsWith(prefix)).toBe(true);
      expect((await ensurePmGitignore(root)).changed).toBe(false);
      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(after);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["bad\nroot", "bad\rroot"])("refuses unrepresentable tracker root %j without changing ignore bytes", async (tracker) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-gitignore-linebreak-"));
    try {
      await writeFile(path.join(root, ".gitignore"), "sentinel\n");
      expect(() => getPmGitignoreBlock(tracker)).toThrow(PmCliError);
      await expect(ensurePmGitignore(root, { pmRoot: path.join(root, tracker) })).rejects.toMatchObject({ code: "invalid_argument_value" });
      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe("sentinel\n");
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
          reason: expect.stringMatching(/^(eacces|eperm)$/),
          required: expect.stringContaining("read and write access"),
          nextSteps: expect.arrayContaining([
            expect.stringContaining("read and write access"),
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
