import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensurePmGitignore,
  getPmGitignoreBlock,
} from "../../../../src/core/workspace/gitignore.js";

describe("ensurePmGitignore", () => {
  it("creates, repairs, and then preserves the canonical fenced block", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-gitignore-"));
    try {
      const first = await ensurePmGitignore(root);
      expect(first.changed).toBe(true);
      expect(await readFile(first.path, "utf8")).toBe(`${getPmGitignoreBlock()}\n`);

      await writeFile(
        first.path,
        `node_modules/\n\n# pm-cli:runtime-cache:start\n.agents/pm/search/.agents/pm/runtime/\n# pm-cli:runtime-cache:end\n`,
        "utf8",
      );
      expect((await ensurePmGitignore(root)).changed).toBe(true);
      const repaired = await readFile(first.path, "utf8");
      expect(repaired).toBe(`node_modules/\n\n${getPmGitignoreBlock()}\n`);
      expect((await ensurePmGitignore(root)).changed).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
