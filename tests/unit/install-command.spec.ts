import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInstall } from "../../src/cli/commands/install.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";

describe("runInstall", () => {
  it("installs pi extension into current project by default and reports overwrite deterministically", async () => {
    const tempProject = await mkdtemp(path.join(os.tmpdir(), "pm-install-project-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(tempProject);
      const first = await runInstall("pi", {}, {});
      expect(first.ok).toBe(true);
      expect(first.target).toBe("pi");
      expect(first.scope).toBe("project");
      expect(first.destination_path).toBe(path.join(tempProject, ".pi", "extensions", "pm-cli", "index.ts"));
      expect(first.overwritten).toBe(false);
      expect(first.warnings).toEqual([]);

      const sourceContent = await readFile(first.source_path, "utf8");
      const destinationContent = await readFile(first.destination_path, "utf8");
      expect(destinationContent).toBe(sourceContent);

      const second = await runInstall("pi", { project: true }, {});
      expect(second.scope).toBe("project");
      expect(second.overwritten).toBe(true);
      expect(second.warnings).toEqual([`overwritten:${second.destination_path}`]);
    } finally {
      process.chdir(previousCwd);
      await rm(tempProject, { recursive: true, force: true });
    }
  });

  it("installs pi extension into PI_CODING_AGENT_DIR when global scope is selected", async () => {
    const tempGlobal = await mkdtemp(path.join(os.tmpdir(), "pm-install-global-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = tempGlobal;
      const result = await runInstall("pi", { global: true }, {});
      expect(result.scope).toBe("global");
      expect(result.destination_path).toBe(path.join(tempGlobal, "extensions", "pm-cli", "index.ts"));
      expect(result.overwritten).toBe(false);
      const destinationContent = await readFile(result.destination_path, "utf8");
      expect(destinationContent.length).toBeGreaterThan(0);
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
      await rm(tempGlobal, { recursive: true, force: true });
    }
  });

  it("installs pi extension into home fallback when PI_CODING_AGENT_DIR is unset", async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "pm-install-home-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousHomeDrive = process.env.HOMEDRIVE;
    const previousHomePath = process.env.HOMEPATH;
    try {
      delete process.env.PI_CODING_AGENT_DIR;
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;
      process.env.HOMEDRIVE = "";
      process.env.HOMEPATH = "";

      const result = await runInstall("pi", { global: true }, {});
      const expectedDestination = path.join(os.homedir(), ".pi", "agent", "extensions", "pm-cli", "index.ts");
      expect(result.scope).toBe("global");
      expect(result.destination_path).toBe(expectedDestination);
      const destinationContent = await readFile(result.destination_path, "utf8");
      expect(destinationContent.length).toBeGreaterThan(0);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousHomeDrive === undefined) delete process.env.HOMEDRIVE;
      else process.env.HOMEDRIVE = previousHomeDrive;
      if (previousHomePath === undefined) delete process.env.HOMEPATH;
      else process.env.HOMEPATH = previousHomePath;
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("rejects unsupported install targets", async () => {
    await expect(runInstall("unknown-target", {}, {})).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
  });

  it("rejects mutually-exclusive scope flags", async () => {
    await expect(runInstall("pi", { project: true, global: true }, {})).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
  });

  it("returns typed usage errors for invalid inputs", async () => {
    try {
      await runInstall("not-pi", {}, {});
      throw new Error("Expected runInstall to throw");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PmCliError);
      expect((error as PmCliError).exitCode).toBe(EXIT_CODE.USAGE);
    }
  });

  it("surfaces read failures with deterministic generic-failure exit code for non-Error throws", async () => {
    await expect(
      runInstall("pi", {}, {}, { readFile: async () => Promise.reject("synthetic-read-failure") }),
    ).rejects.toMatchObject({
      exitCode: EXIT_CODE.GENERIC_FAILURE,
      message: expect.stringContaining("synthetic-read-failure"),
    });
  });
});
