/** A failed Git identity read must not be mistaken for an unborn repository. */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("node:child_process", async (load) => {
  const actual = await load<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const run = promisify(actual.execFile);
  return { ...actual, execFile: Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: (...args: Parameters<typeof run>) => {
      if (Array.isArray(args[1]) && args[1].includes("--verify")) return Promise.reject(Object.assign(new Error("Git identity read denied"), { code: 13 }));
      return run(...args);
    },
  }) };
});
import { seedLinkedTestWorkspaceSnapshot } from "../../../../src/sdk/test/workspace-snapshot.js";

it("propagates a Git identity failure while retaining the source index", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pm-snapshot-git-fault-"));
  const source = path.join(root, "source");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: source, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    await mkdir(source);
    git("init", "-q");
    await writeFile(path.join(source, "identity.txt"), "source");
    git("add", "identity.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Identity");
    const before = git("ls-files", "--stage");
    await expect(seedLinkedTestWorkspaceSnapshot(source, path.join(root, "snapshot"))).rejects.toMatchObject({ message: "Git identity read denied", code: 13 });
    expect(git("ls-files", "--stage")).toBe(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
