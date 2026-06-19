import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getHistoryPath,
  getItemFormatFromPath,
  getItemPath,
  getLockPath,
  getRuntimePath,
  getSettingsPath,
  getTestRunRecordPath,
  getTestRunResultPath,
  getTestRunStderrPath,
  getTestRunStdoutPath,
  getTestRunsPath,
  getTestRunsRecordsPath,
  getTestRunsResultsPath,
  getTestRunsStderrPath,
  getTestRunsStdoutPath,
  getTypeDirPath,
  resolveGlobalPmRoot,
  resolvePmRoot,
} from "../../../../src/core/store/paths.js";

function withEnvVar(name: string, value: string | undefined, run: () => void): void {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

describe("core/store/paths", () => {
  it("resolvePmRoot prefers explicit CLI path, then env, then default", () => {
    const cwd = "/tmp/pm-root-test";

    withEnvVar("PM_PATH", "env-root", () => {
      expect(resolvePmRoot(cwd, " cli-root ")).toBe(path.resolve(cwd, "cli-root"));
    });

    withEnvVar("PM_PATH", " env-root ", () => {
      expect(resolvePmRoot(cwd)).toBe(path.resolve(cwd, "env-root"));
    });

    withEnvVar("PM_PATH", "   ", () => {
      expect(resolvePmRoot(cwd)).toBe(path.resolve(cwd, ".agents/pm"));
    });

    withEnvVar("PM_PATH", undefined, () => {
      expect(resolvePmRoot(cwd)).toBe(path.resolve(cwd, ".agents/pm"));
    });
  });

  it("resolvePmRoot discovers initialized pm root by walking ancestors", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pm-path-discovery-"));
    try {
      const projectRoot = path.join(tempRoot, "project");
      const discoveredPmRoot = path.join(projectRoot, ".agents", "pm");
      const nestedCwd = path.join(projectRoot, "src", "feature", "module");
      mkdirSync(discoveredPmRoot, { recursive: true });
      mkdirSync(nestedCwd, { recursive: true });
      writeFileSync(path.join(discoveredPmRoot, "settings.json"), "{\n  \"output\": { \"default_format\": \"toon\" }\n}\n", "utf8");

      withEnvVar("PM_PATH", undefined, () => {
        expect(resolvePmRoot(nestedCwd)).toBe(path.resolve(discoveredPmRoot));
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("resolvePmRoot ignores ancestor pm directories until initialized", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pm-path-discovery-uninitialized-"));
    try {
      const projectRoot = path.join(tempRoot, "project");
      const uninitializedPmRoot = path.join(projectRoot, ".agents", "pm");
      const nestedCwd = path.join(projectRoot, "src");
      mkdirSync(uninitializedPmRoot, { recursive: true });
      mkdirSync(nestedCwd, { recursive: true });

      withEnvVar("PM_PATH", undefined, () => {
        expect(resolvePmRoot(nestedCwd)).toBe(path.resolve(nestedCwd, ".agents/pm"));
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("resolvePmRoot redirects an explicit project-root path into its initialized .agents/pm", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pm-path-explicit-projectroot-"));
    try {
      const projectRoot = path.join(tempRoot, "project");
      const nestedPmRoot = path.join(projectRoot, ".agents", "pm");
      mkdirSync(nestedPmRoot, { recursive: true });
      writeFileSync(path.join(nestedPmRoot, "settings.json"), "{}\n", "utf8");

      withEnvVar("PM_PATH", undefined, () => {
        // Passing the project root (where `pm init` created `.agents/pm`) must
        // resolve into the tracker instead of hard-failing as "not initialized".
        expect(resolvePmRoot(tempRoot, projectRoot)).toBe(path.resolve(nestedPmRoot));
      });
      // Same redirect honored via PM_PATH.
      withEnvVar("PM_PATH", projectRoot, () => {
        expect(resolvePmRoot(tempRoot)).toBe(path.resolve(nestedPmRoot));
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("resolvePmRoot keeps an explicit path that is already a tracker root verbatim", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pm-path-explicit-trackerroot-"));
    try {
      // `pm init --path <dir>` writes settings.json directly at <dir>.
      writeFileSync(path.join(tempRoot, "settings.json"), "{}\n", "utf8");

      withEnvVar("PM_PATH", undefined, () => {
        expect(resolvePmRoot(tempRoot, tempRoot)).toBe(path.resolve(tempRoot));
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("resolveGlobalPmRoot uses PM_GLOBAL_PATH when present or homedir fallback", () => {
    const cwd = "/tmp/pm-global-test";

    withEnvVar("PM_GLOBAL_PATH", " global-store ", () => {
      expect(resolveGlobalPmRoot(cwd)).toBe(path.resolve(cwd, "global-store"));
    });

    withEnvVar("PM_GLOBAL_PATH", "  ", () => {
      expect(resolveGlobalPmRoot(cwd)).toBe(path.resolve(path.join(os.homedir(), ".pm-cli")));
    });

    withEnvVar("PM_GLOBAL_PATH", undefined, () => {
      expect(resolveGlobalPmRoot(cwd)).toBe(path.resolve(path.join(os.homedir(), ".pm-cli")));
    });
  });

  it("builds deterministic settings, type, item, history, and lock paths", () => {
    const pmRoot = "/tmp/project/.agents/pm";
    const id = "pm-a1b2";

    expect(getSettingsPath(pmRoot)).toBe(path.join(pmRoot, "settings.json"));
    expect(getTypeDirPath(pmRoot, "Task")).toBe(path.join(pmRoot, "tasks"));
    expect(getItemPath(pmRoot, "Task", id)).toBe(path.join(pmRoot, "tasks", `${id}.toon`));
    expect(getItemPath(pmRoot, "Task", id, "toon")).toBe(path.join(pmRoot, "tasks", `${id}.toon`));
    expect(getHistoryPath(pmRoot, id)).toBe(path.join(pmRoot, "history", `${id}.jsonl`));
    expect(getLockPath(pmRoot, id)).toBe(path.join(pmRoot, "locks", `${id}.lock`));
    expect(getItemFormatFromPath(path.join(pmRoot, "tasks", `${id}.md`))).toBe("json_markdown");
    expect(getItemFormatFromPath(path.join(pmRoot, "tasks", `${id}.toon`))).toBe("toon");
    expect(getItemFormatFromPath(path.join(pmRoot, "tasks", `${id}.txt`))).toBeNull();
  });

  it("recognizes item formats from Windows-style tracker paths", () => {
    expect(getItemFormatFromPath(String.raw`C:\repo\.agents\pm\tasks\pm-win.toon`)).toBe("toon");
    expect(getItemFormatFromPath(String.raw`C:\repo\.agents\pm\issues\pm-win.md`)).toBe("json_markdown");
    expect(getItemFormatFromPath(String.raw`C:\repo\.agents\pm\issues\pm-win.json`)).toBeNull();
    expect(getItemFormatFromPath(String.raw`C:\repo.with.dot\.agents\pm\tasks\pm-win`)).toBeNull();
  });

  it("derives deterministic fallback folders for unknown item types", () => {
    const pmRoot = "/tmp/project/.agents/pm";

    expect(getTypeDirPath(pmRoot, "Custom Type")).toBe(path.join(pmRoot, "custom-types"));
    expect(getTypeDirPath(pmRoot, "Metrics")).toBe(path.join(pmRoot, "metrics"));
    expect(getTypeDirPath(pmRoot, "!!!")).toBe(path.join(pmRoot, "items"));
  });

  it("builds deterministic runtime and background test-run paths", () => {
    const pmRoot = "/tmp/project/.agents/pm";
    const runId = "run-1234";

    expect(getRuntimePath(pmRoot)).toBe(path.join(pmRoot, "runtime"));
    expect(getTestRunsPath(pmRoot)).toBe(path.join(pmRoot, "runtime", "test-runs"));
    expect(getTestRunsRecordsPath(pmRoot)).toBe(path.join(pmRoot, "runtime", "test-runs", "runs"));
    expect(getTestRunRecordPath(pmRoot, runId)).toBe(path.join(pmRoot, "runtime", "test-runs", "runs", `${runId}.json`));
    expect(getTestRunsStdoutPath(pmRoot)).toBe(path.join(pmRoot, "runtime", "test-runs", "stdout"));
    expect(getTestRunsStderrPath(pmRoot)).toBe(path.join(pmRoot, "runtime", "test-runs", "stderr"));
    expect(getTestRunStdoutPath(pmRoot, runId)).toBe(path.join(pmRoot, "runtime", "test-runs", "stdout", `${runId}.log`));
    expect(getTestRunStderrPath(pmRoot, runId)).toBe(path.join(pmRoot, "runtime", "test-runs", "stderr", `${runId}.log`));
    expect(getTestRunsResultsPath(pmRoot)).toBe(path.join(pmRoot, "runtime", "test-runs", "results"));
    expect(getTestRunResultPath(pmRoot, runId)).toBe(path.join(pmRoot, "runtime", "test-runs", "results", `${runId}.json`));
  });
});
