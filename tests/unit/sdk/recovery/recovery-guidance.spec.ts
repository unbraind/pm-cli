import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  _testOnly as agentGuidance,
  resolveProjectTestCommand,
} from "../../../../src/sdk/init-agent-guidance.js";
import {
  formatVectorIndexRecoveryWarnings,
  resolveVectorIndexRecovery,
} from "../../../../src/sdk/query/search.js";

describe("executable recovery guidance", () => {
  it("renders the target repository's declared test command", async () => {
    const projectRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-agent-guidance-command-"),
    );
    try {
      await writeFile(
        path.join(projectRoot, "package.json"),
        JSON.stringify({
          packageManager: "pnpm@11.10.0",
          scripts: { test: "vitest run" },
        }),
        "utf8",
      );
      expect(await resolveProjectTestCommand(projectRoot)).toBe("pnpm test");
      const guidance = agentGuidance.buildAgentGuidanceBlock("\n", "pnpm test");
      expect(guidance).toContain('pm test <id> --add command="pnpm test"');
      const contextCommand = "pm context --limit 10 --for orient";
      const mutationGuard = "before item mutation";
      const inProgressCommand = "pm list --status in_progress --limit 20";
      expect(guidance).toContain(contextCommand);
      expect(guidance).toContain(mutationGuard);
      expect(guidance).toContain(inProgressCommand);
      expect(guidance.indexOf(contextCommand)).toBeLessThan(
        guidance.indexOf(mutationGuard),
      );
      expect(guidance.indexOf(mutationGuard)).toBeLessThan(
        guidance.indexOf(inProgressCommand),
      );
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("uses an explicit placeholder when the target has no executable test contract", async () => {
    const projectRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-agent-guidance-placeholder-"),
    );
    try {
      expect(await resolveProjectTestCommand(projectRoot)).toBe(
        "<your project test command>",
      );
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("detects every supported target test runner and rejects malformed manifests", async () => {
    const projectRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-agent-guidance-runners-"),
    );
    try {
      await mkdir(path.join(projectRoot, "scripts"));
      await writeFile(path.join(projectRoot, "scripts", "run-tests.mjs"), "");
      expect(await resolveProjectTestCommand(projectRoot)).toBe(
        "node scripts/run-tests.mjs test",
      );
      await rm(path.join(projectRoot, "scripts"), { recursive: true });

      const malformedManifests: unknown[] = [
        "invalid",
        null,
        {},
        { scripts: "invalid" },
        { scripts: null },
        { scripts: {} },
        { scripts: { test: 1 } },
        { scripts: { test: " " } },
      ];
      for (const manifest of malformedManifests) {
        await writeFile(
          path.join(projectRoot, "package.json"),
          JSON.stringify(manifest),
        );
        expect(await resolveProjectTestCommand(projectRoot)).toBe(
          "<your project test command>",
        );
      }
      await writeFile(path.join(projectRoot, "package.json"), "{");
      expect(await resolveProjectTestCommand(projectRoot)).toBe(
        "<your project test command>",
      );

      await writeFile(
        path.join(projectRoot, "package.json"),
        JSON.stringify({ scripts: { test: "vitest" } }),
      );
      await writeFile(path.join(projectRoot, "pnpm-lock.yaml"), "");
      expect(await resolveProjectTestCommand(projectRoot)).toBe("pnpm test");
      await writeFile(
        path.join(projectRoot, "package.json"),
        JSON.stringify({
          packageManager: "yarn@4.5.0",
          scripts: { test: "vitest" },
        }),
      );
      expect(await resolveProjectTestCommand(projectRoot)).toBe("yarn test");
      await writeFile(
        path.join(projectRoot, "package.json"),
        JSON.stringify({
          packageManager: "npm@11.5.2",
          scripts: { test: "vitest" },
        }),
      );
      expect(await resolveProjectTestCommand(projectRoot)).toBe("npm test");
      await writeFile(
        path.join(projectRoot, "package.json"),
        JSON.stringify({ scripts: { test: "vitest" } }),
      );
      await rm(path.join(projectRoot, "pnpm-lock.yaml"));

      await writeFile(path.join(projectRoot, "bun.lock"), "");
      expect(await resolveProjectTestCommand(projectRoot)).toBe("bun run test");
      await rm(path.join(projectRoot, "bun.lock"));
      await writeFile(path.join(projectRoot, "bun.lockb"), "");
      expect(await resolveProjectTestCommand(projectRoot)).toBe("bun run test");
      await rm(path.join(projectRoot, "bun.lockb"));

      await writeFile(path.join(projectRoot, "yarn.lock"), "");
      expect(await resolveProjectTestCommand(projectRoot)).toBe("yarn test");
      await rm(path.join(projectRoot, "yarn.lock"));
      expect(await resolveProjectTestCommand(projectRoot)).toBe("npm test");
      await writeFile(
        path.join(projectRoot, "package.json"),
        JSON.stringify({ packageManager: 42, scripts: { test: "vitest" } }),
      );
      expect(await resolveProjectTestCommand(projectRoot)).toBe("npm test");

      for (const packageManager of ["bun@1.2.0", "yarn@4.0.0"]) {
        await writeFile(
          path.join(projectRoot, "package.json"),
          JSON.stringify({ packageManager, scripts: { test: "vitest" } }),
        );
        expect(await resolveProjectTestCommand(projectRoot)).toBe(
          packageManager.startsWith("bun") ? "bun run test" : "yarn test",
        );
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("installs search-advanced before reindex when the command is unavailable", () => {
    expect(resolveVectorIndexRecovery({ commands: [] })).toEqual({
      command: "pm install search-advanced --project",
      args: ["install", "search-advanced", "--project"],
      follow_up_command: "pm reindex --mode hybrid",
      follow_up_args: ["reindex", "--mode", "hybrid"],
    });
  });

  it("reindexes directly when search-advanced registered the command", () => {
    expect(
      resolveVectorIndexRecovery({
        commands: [{ command: "reindex" }],
      }),
    ).toEqual({
      command: "pm reindex --mode hybrid",
      args: ["reindex", "--mode", "hybrid"],
    });
  });

  it("formats direct and two-step vector recovery warnings", () => {
    expect(
      formatVectorIndexRecoveryWarnings(2, {
        command: "pm reindex --mode hybrid",
        args: ["reindex", "--mode", "hybrid"],
      }),
    ).toEqual([
      "vector_index_stale:2",
      "vector_index_recovery:reindex --mode hybrid",
    ]);
    const warnings = formatVectorIndexRecoveryWarnings(1, {
      command: "pm install search-advanced --project",
      args: ["install", "search-advanced", "--project"],
      follow_up_command: "pm reindex --mode hybrid",
      follow_up_args: ["reindex", "--mode", "hybrid"],
    });
    expect(warnings).toContain(
      "vector_index_recovery:install search-advanced --project",
    );
    expect(warnings).toContain(
      "vector_index_recovery_follow_up:reindex --mode hybrid",
    );
  });
});
