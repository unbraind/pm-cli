import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getHistoryPath,
  getItemPath,
  getLockPath,
  getSettingsPath,
  getTypeDirPath,
  resolveGlobalPmRoot,
  resolvePmRoot,
} from "../../src/core/store/paths.js";

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
    expect(getItemPath(pmRoot, "Task", id)).toBe(path.join(pmRoot, "tasks", `${id}.md`));
    expect(getHistoryPath(pmRoot, id)).toBe(path.join(pmRoot, "history", `${id}.jsonl`));
    expect(getLockPath(pmRoot, id)).toBe(path.join(pmRoot, "locks", `${id}.lock`));
  });
});
