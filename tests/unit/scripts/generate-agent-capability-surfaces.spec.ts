import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../../scripts/generate-agent-capability-surfaces.mjs";

describe("generate agent capability surfaces", () => {
  it("writes the generated contract and accepts an exact check", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "pm-agent-capability-surface-"),
    );
    try {
      await main(root, []);
      const outputPath = path.join(
        root,
        "docs",
        "generated",
        "AGENT_COMMAND_SURFACE.md",
      );
      const generated = await readFile(outputPath, "utf8");
      expect(generated).toContain("PM_COMMAND_CAPABILITY_CONTRACTS");
      expect(
        await readFile(
          path.join(root, "docs", "generated", "FLAG_LEXICON_BUDGETS.md"),
          "utf8",
        ),
      ).toContain("listPmFlagLexicon()");
      await expect(main(root, ["--check"])).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the generated contract is missing or stale", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "pm-agent-capability-stale-"),
    );
    try {
      await expect(main(root, ["--check"])).rejects.toThrow(
        "agent capability surface AGENT_COMMAND_SURFACE.md is stale",
      );
      const outputPath = path.join(
        root,
        "docs",
        "generated",
        "AGENT_COMMAND_SURFACE.md",
      );
      await main(root, []);
      await writeFile(outputPath, "stale\n", "utf8");
      await expect(main(root, ["--check"])).rejects.toThrow(
        "agent capability surface AGENT_COMMAND_SURFACE.md is stale",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
