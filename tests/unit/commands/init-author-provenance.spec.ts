import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCreate } from "../../../src/cli/commands/create.js";
import { runInit } from "../../../src/cli/commands/init.js";
import { runWithHarnessDetectionSignals } from "../../../src/core/shared/author.js";
import { readSettings } from "../../../src/core/store/settings.js";

const originalPmAuthor = process.env.PM_AUTHOR;

afterEach(() => {
  if (originalPmAuthor === undefined) {
    delete process.env.PM_AUTHOR;
  } else {
    process.env.PM_AUTHOR = originalPmAuthor;
  }
});

describe("initialized workspace author provenance", () => {
  it("keeps detected harness identity invocation-local across agents", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-init-agent-provenance-"),
    );
    delete process.env.PM_AUTHOR;
    try {
      await runWithHarnessDetectionSignals(
        { env: { CODEX_CI: "1", CODEX_MODEL: "gpt-codex" } },
        () =>
          runInit(
            "pm",
            { path: tempRoot },
            { defaults: true, agentGuidance: "skip" },
          ),
      );

      expect((await readSettings(tempRoot)).author_default).toBe("");

      const codexItem = await runWithHarnessDetectionSignals(
        { env: { CODEX_CI: "1", CODEX_MODEL: "gpt-codex" } },
        () =>
          runCreate(
            { title: "Codex-owned work", type: "Task" },
            { path: tempRoot },
          ),
      );
      const claudeItem = await runWithHarnessDetectionSignals(
        { env: { CLAUDE_CODE: "1", CLAUDE_MODEL: "claude-next" } },
        () =>
          runCreate(
            { title: "Claude-owned work", type: "Task" },
            { path: tempRoot },
          ),
      );

      expect(codexItem.item.author).toBe("harness:codex");
      expect(claudeItem.item.author).toBe("harness:claude-code");
      expect((await readSettings(tempRoot)).author_default).toBe("");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
