import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PmClient, summarizeInitResult } from "../../../src/sdk/index.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("compact init guidance recovery (GH-1407)", () => {
  it("shows scoped inspection and explicit installation without rewriting user guidance", async () => {
    await withTempPmPath(async (context) => {
      const workspace = path.join(context.tempRoot, "guidance workspace");
      await mkdir(workspace);
      const agentsPath = path.join(workspace, "AGENTS.md");
      const original = "# Team rules\n\nPreserve project-specific guidance.\n";
      await writeFile(agentsPath, original);
      const tracker = path.join(workspace, ".agents", "pm");
      const initial = await context.runCliInProcess(["init", "--workspace", workspace, "--yes"], { cwd: context.tempRoot });
      expect(initial.code).toBe(0);
      expect(initial.stdout).toContain("agent_guidance:missing_non_interactive");
      expect(initial.stdout).toContain("--agent-guidance status");
      expect(initial.stdout).toContain("--agent-guidance add");
      expect(initial.stdout).toContain(JSON.stringify(tracker));
      expect(await readFile(agentsPath, "utf8")).toBe(original);
      const sdkResult = await new PmClient({ pmRoot: tracker, noExtensions: true }).init(undefined, { yes: true });
      expect(sdkResult.warnings).toContain("agent_guidance:missing_non_interactive");
      const display = summarizeInitResult(sdkResult, true);
      expect(display.next_steps).toContainEqual(expect.stringContaining("--agent-guidance status"));
      expect(display.next_steps).toContainEqual(expect.stringContaining("--agent-guidance add"));
      expect(await readFile(agentsPath, "utf8")).toBe(original);
      const status = await context.runCliInProcess(["--pm-path", tracker, "init", "--agent-guidance", "status", "--json"], { cwd: context.tempRoot, expectJson: true });
      expect(status.code).toBe(0);
      expect(status.json).toMatchObject({ path: tracker, agent_guidance: { mode: "status", present: false, target_file: "AGENTS.md", checked_files: ["AGENTS.md", "CLAUDE.md"], files_with_guidance: [], missing_files: ["CLAUDE.md"] } });
      expect(await readFile(agentsPath, "utf8")).toBe(original);
      const added = await context.runCliInProcess(["--pm-path", tracker, "init", "--agent-guidance", "add", "--json"], { cwd: context.tempRoot, expectJson: true });
      expect(added.code).toBe(0);
      expect(await readFile(agentsPath, "utf8")).toContain(original.trim());
      const skipped = await context.runCliInProcess(["init", "--workspace", path.join(context.tempRoot, "skip workspace"), "--yes", "--agent-guidance", "skip"], { cwd: context.tempRoot });
      expect(skipped.code).toBe(0);
      expect(skipped.stdout).not.toContain("--agent-guidance add");
    });
  });
});
