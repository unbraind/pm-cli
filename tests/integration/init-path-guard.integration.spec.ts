import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectJsonErrorEnvelope } from "../helpers/jsonErrorEnvelope.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("init tracker-path guardrails", () => {
  it("treats path-like init positionals as target tracker paths without mutating the caller tracker", async () => {
    await withTempPmPath(async (context) => {
      const projectRoot = path.join(context.tempRoot, "caller-project");
      const callerPmPath = path.join(projectRoot, ".agents", "pm");
      const targetPmPath = path.join(context.tempRoot, "target-pm");
      await mkdir(projectRoot, { recursive: true });

      const callerInit = context.runCli(["--pm-path", callerPmPath, "init", "pm", "--json", "--yes"], {
        expectJson: true,
        cwd: projectRoot,
      });
      expect(callerInit.code).toBe(0);
      const callerSettingsBefore = await readFile(path.join(callerPmPath, "settings.json"), "utf8");

      const targetInit = context.runCli(["init", targetPmPath, "--json", "--yes", "--author", "sandbox-agent"], {
        expectJson: true,
        cwd: projectRoot,
      });
      expect(targetInit.code).toBe(0);
      expect(targetInit.json.path).toBe(targetPmPath);

      const callerSettingsAfter = await readFile(path.join(callerPmPath, "settings.json"), "utf8");
      const targetSettings = JSON.parse(await readFile(path.join(targetPmPath, "settings.json"), "utf8")) as {
        id_prefix?: string;
        author_default?: string;
      };
      expect(callerSettingsAfter).toBe(callerSettingsBefore);
      expect(targetSettings.id_prefix).toBe("pm-");
      expect(targetSettings.author_default).toBe("sandbox-agent");
    });
  });

  it("guards explicit --pm-path values that point at a workspace root", async () => {
    await withTempPmPath(async (context) => {
      const workspaceRoot = path.join(context.tempRoot, "workspace-root-path-trap");
      await mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
      await mkdir(path.join(workspaceRoot, ".agents", "pm"), { recursive: true });
      await writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "path-trap" }), "utf8");

      const guarded = context.runCli(["--pm-path", workspaceRoot, "init", "--json"]);
      expect(guarded.code).toBe(2);
      const envelope = expectJsonErrorEnvelope(guarded.stderr, {
        type: "urn:pm-cli:error:workspace_root_pm_path",
        code: "workspace_root_pm_path",
        exit_code: 2,
      });
      expect(envelope.why).toContain("tracker storage directory itself");
      expect(envelope.recovery?.next_best_command).toContain(path.join(workspaceRoot, ".agents", "pm"));

      const rootEntries = await readdir(workspaceRoot);
      expect(rootEntries).not.toContain("history");
      expect(rootEntries).not.toContain("tasks");
      expect(rootEntries).not.toContain("runtime");

      const forced = context.runCli(["--pm-path", workspaceRoot, "init", "--json", "--yes", "--force"], {
        expectJson: true,
      });
      expect(forced.code).toBe(0);
      const forcedEntries = await readdir(workspaceRoot);
      expect(forcedEntries).toContain("history");
      expect(forcedEntries).toContain("tasks");
    });
  });
});
