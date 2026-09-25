import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInitAgentGuidance } from "../../../../src/sdk/init-agent-guidance.js";
import { readSettings } from "../../../../src/core/store/settings.js";
import { runHealth } from "../../../../src/sdk/governance/health.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("managed guidance freshness", () => {
  it("diagnoses stale managed blocks read-only and refreshes both files without replacing user prose", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const root = path.dirname(path.dirname(pmPath));
      const settings = await readSettings(pmPath);
      const original = "# User instructions\n\n<!-- pm-cli:agent-guidance:start:v1 -->\npm list-open\n<!-- pm-cli:agent-guidance:end -->\n\nKeep this footer.\n";
      for (const filename of ["AGENTS.md", "CLAUDE.md"]) await writeFile(path.join(root, filename), original);
      const options = { pm_root: pmPath, cwd: root, settings, interactive: false };
      const status = await runInitAgentGuidance({ ...options, mode: "status" });
      expect(status.warnings).toContain("agent_guidance_outdated:AGENTS.md,CLAUDE.md");
      expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(original);
      const health = await runHealth({ path: pmPath, noExtensions: true }, { summary: true, skipVectors: true });
      expect(health.findings).toContainEqual(expect.objectContaining({
        code: "agent_guidance_outdated", severity: "advisory", remediation: "pm init --agent-guidance add",
      }));
      const applied = await runInitAgentGuidance({ ...options, mode: "add" });
      expect(applied.summary.applied).toBe(true);
      expect(applied.warnings.some((warning) => warning.startsWith("agent_guidance_outdated"))).toBe(false);
      for (const filename of ["AGENTS.md", "CLAUDE.md"]) {
        const text = await readFile(path.join(root, filename), "utf8");
        expect(text).toContain("pm claim <id> --start");
        expect(text).toContain("# User instructions");
        expect(text).toContain("Keep this footer.");
      }
      expect((await runInitAgentGuidance({ ...options, mode: "add" })).summary.applied).toBe(false);
      expect((await runHealth({ path: pmPath, noExtensions: true }, { summary: true, skipVectors: true })).findings.some((finding) => finding.code === "agent_guidance_outdated")).toBe(false);
    });
  });
});
