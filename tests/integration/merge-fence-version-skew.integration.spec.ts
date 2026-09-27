import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../../src/cli/commands/workspace/init.js";
import { readSettings } from "../../src/core/store/settings.js";
import { runHealth } from "../../src/sdk/governance/health.js";
import {
  auditMergeAttributeFence,
  buildMergeAttributePatterns,
  installMergeFence,
  PM_GITATTRIBUTES_END,
  PM_GITATTRIBUTES_START,
  PM_GITATTRIBUTES_V2_END,
  PM_GITATTRIBUTES_V2_START,
  refreshMergeAttributeFenceIfInstalled,
  resolveProjectMergeTypeFolders,
} from "../../src/sdk/merge/install.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("merge fence version-skew compatibility", () => {
  it("keeps a child fence inside the parent tracker after reinstalling the parent", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot }) => {
      execFileSync("git", ["init", "-q"], { cwd: tempRoot });
      await installMergeFence({ pmRoot: pmPath, workspaceRoot: tempRoot });
      const childPmPath = path.join(
        pmPath,
        "projects",
        "child",
        ".agents",
        "pm",
      );
      await runInit(
        undefined,
        { path: childPmPath },
        { defaults: true, agentGuidance: "skip" },
      );
      const childExtension = `${path.relative(tempRoot, childPmPath)}/extensions/package/settings.json`;
      const attributesPath = path.join(tempRoot, ".gitattributes");
      expect(
        execFileSync("git", ["check-attr", "merge", "--", childExtension], {
          cwd: tempRoot,
          encoding: "utf8",
        }),
      ).toContain("merge: unset");

      await installMergeFence({ pmRoot: pmPath, workspaceRoot: tempRoot });
      expect(
        (await readFile(attributesPath, "utf8")).match(
          /# pm-cli:merge-drivers:v2:start/g,
        ),
      ).toHaveLength(2);
      expect(
        execFileSync("git", ["check-attr", "merge", "--", childExtension], {
          cwd: tempRoot,
          encoding: "utf8",
        }),
      ).toContain("merge: unset");
      for (const tracker of [pmPath, childPmPath]) {
        expect(
          (
            await auditMergeAttributeFence(
              tracker,
              resolveProjectMergeTypeFolders(await readSettings(tracker)),
            )
          ).status,
        ).toBe("ok");
      }
    });
  });

  it("retains both tracker fences when independent schema refreshes run concurrently", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot }) => {
      execFileSync("git", ["init", "-q"], { cwd: tempRoot });
      await installMergeFence({ pmRoot: pmPath, workspaceRoot: tempRoot });
      const secondPmPath = path.join(tempRoot, "nested", ".agents", "pm");
      await runInit(
        undefined,
        { path: secondPmPath },
        { defaults: true, agentGuidance: "skip" },
      );
      const attributesPath = path.join(tempRoot, ".gitattributes");
      const current = await readFile(attributesPath, "utf8");
      await writeFile(
        attributesPath,
        current
          .replaceAll('".agents/pm/tasks/*.toon" merge=pm-item-toon', "")
          .replaceAll(
            '"nested/.agents/pm/tasks/*.toon" merge=pm-item-toon',
            "",
          ),
      );

      const results = await Promise.all([
        refreshMergeAttributeFenceIfInstalled(pmPath),
        refreshMergeAttributeFenceIfInstalled(secondPmPath),
      ]);
      expect(results.map((result) => result.status)).toEqual([
        "refreshed",
        "refreshed",
      ]);
      for (const tracker of [pmPath, secondPmPath]) {
        expect(
          (
            await auditMergeAttributeFence(
              tracker,
              resolveProjectMergeTypeFolders(await readSettings(tracker)),
            )
          ).status,
        ).toBe("ok");
      }
    });
  });

  it("keeps root and nested tracker mappings after either tracker is reinstalled", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot }) => {
      execFileSync("git", ["init", "-q"], { cwd: tempRoot });
      await installMergeFence({ pmRoot: pmPath, workspaceRoot: tempRoot });
      const nestedPmPath = path.join(tempRoot, "nested", ".agents", "pm");
      await runInit(
        undefined,
        { path: nestedPmPath },
        { defaults: true, agentGuidance: "skip" },
      );
      expect(
        execFileSync(
          "git",
          ["check-attr", "merge", "--", ".agents/pm/tasks/root.toon"],
          { cwd: tempRoot, encoding: "utf8" },
        ),
      ).toContain("merge: pm-item-toon");
      for (const tracker of [pmPath, nestedPmPath, pmPath, nestedPmPath]) {
        await installMergeFence({ pmRoot: tracker, workspaceRoot: tempRoot });
        const relative = path.relative(tempRoot, tracker);
        expect(
          execFileSync(
            "git",
            ["check-attr", "merge", "--", `${relative}/tasks/example.toon`],
            { cwd: tempRoot, encoding: "utf8" },
          ),
        ).toContain("merge: pm-item-toon");
      }
      for (const tracker of [pmPath, nestedPmPath]) {
        expect(
          (
            await auditMergeAttributeFence(
              tracker,
              resolveProjectMergeTypeFolders(await readSettings(tracker)),
            )
          ).status,
        ).toBe("ok");
      }
      expect(
        execFileSync(
          "git",
          ["check-attr", "merge", "--", ".agents/pm/tasks/root.toon"],
          {
            cwd: tempRoot,
            encoding: "utf8",
          },
        ),
      ).toContain("merge: pm-item-toon");
      const attributesPath = path.join(tempRoot, ".gitattributes");
      const attributes = await readFile(attributesPath, "utf8");
      const rootBlock = attributes.match(
        /# pm-cli:merge-drivers:v2:start[\s\S]*?# pm-cli:merge-drivers:v2:end/,
      )?.[0];
      expect(rootBlock).toBeDefined();
      await writeFile(attributesPath, `${attributes}\n${rootBlock}\n`);
      await installMergeFence({ pmRoot: pmPath, workspaceRoot: tempRoot });
      expect(
        (await readFile(attributesPath, "utf8")).match(
          /# pm-cli:merge-drivers:v2:start/g,
        ),
      ).toHaveLength(2);
      await writeFile(
        attributesPath,
        (await readFile(attributesPath, "utf8")).replace(
          /# pm-cli:merge-drivers:v2:start[\s\S]*?# pm-cli:merge-drivers:v2:end\n?/,
          "",
        ),
      );
      const health = await runHealth(
        { path: pmPath },
        { strictExit: true, skipDrift: true, skipVectors: true },
      );
      expect(health.ok).toBe(false);
      expect(health.warnings).toContainEqual(
        expect.stringMatching(/^merge_fence_drift:/),
      );
    });
  });

  it("migrates the legacy fence so older ordinary commands cannot rewrite it", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot }) => {
      execFileSync("git", ["init", "-q"], { cwd: tempRoot });
      const attributesPath = path.join(tempRoot, ".gitattributes");
      await writeFile(
        attributesPath,
        [
          PM_GITATTRIBUTES_START,
          '".agents/pm/tasks/*.toon" merge=pm-item-toon',
          PM_GITATTRIBUTES_END,
          PM_GITATTRIBUTES_V2_START,
          '"nested/.agents/pm/tasks/*.toon" merge=pm-item-toon',
          PM_GITATTRIBUTES_V2_END,
          "",
        ].join("\n"),
      );
      await installMergeFence({
        pmRoot: pmPath,
        workspaceRoot: tempRoot,
        includeExtensions: false,
      });
      const current = await readFile(attributesPath, "utf8");
      expect(current).toContain(PM_GITATTRIBUTES_V2_START);
      expect(current).toContain(PM_GITATTRIBUTES_V2_END);
      expect(current).not.toContain(PM_GITATTRIBUTES_START);
      expect(current).toContain(
        '"nested/.agents/pm/tasks/*.toon" merge=pm-item-toon',
      );

      // Releases through 2026.8.7 only recognize the legacy marker, so their
      // automatic refresh path now leaves the versioned contract unchanged.
      const legacyWouldRewrite = current.includes(PM_GITATTRIBUTES_START);
      if (legacyWouldRewrite) await writeFile(attributesPath, "unexpected\n");
      expect(await readFile(attributesPath, "utf8")).toBe(current);
      expect(current).toContain('".agents/pm/extensions/**" -merge');
      expect(current).toContain(
        '".agents/pm/extensions/.managed-extensions.json" merge=pm-json',
      );
    });
  });

  it("audits a tracker mounted at the Git root", async () => {
    await withTempPmPath(async ({ tempRoot }) => {
      execFileSync("git", ["init", "-q"], { cwd: tempRoot });
      await writeFile(
        path.join(tempRoot, ".gitattributes"),
        [
          PM_GITATTRIBUTES_V2_START,
          ...buildMergeAttributePatterns("", ["tasks"]),
          PM_GITATTRIBUTES_V2_END,
          PM_GITATTRIBUTES_V2_START,
          ...buildMergeAttributePatterns("nested/.agents/pm", ["tasks"]),
          PM_GITATTRIBUTES_V2_END,
          "",
        ].join("\n"),
      );
      expect((await auditMergeAttributeFence(tempRoot, ["tasks"])).status).toBe(
        "ok",
      );
      expect(
        execFileSync("git", ["check-attr", "merge", "--", "tasks/root.toon"], {
          cwd: tempRoot,
          encoding: "utf8",
        }),
      ).toContain("merge: pm-item-toon");
    });
  });

  it("upgrades an ownerless legacy block but preserves a lone nested block", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot }) => {
      execFileSync("git", ["init", "-q"], { cwd: tempRoot });
      const attributesPath = path.join(tempRoot, ".gitattributes");
      await writeFile(
        attributesPath,
        `${PM_GITATTRIBUTES_START}\nlegacy-pattern merge=pm-json\n${PM_GITATTRIBUTES_END}\n`,
      );
      await installMergeFence({ pmRoot: pmPath, workspaceRoot: tempRoot });
      expect(await readFile(attributesPath, "utf8")).not.toContain(
        PM_GITATTRIBUTES_START,
      );

      const nestedBlock = [
        PM_GITATTRIBUTES_V2_START,
        '"nested/.agents/pm/tasks/*.toon" merge=pm-item-toon',
        PM_GITATTRIBUTES_V2_END,
        "",
      ].join("\n");
      await writeFile(attributesPath, nestedBlock);
      await installMergeFence({ pmRoot: pmPath, workspaceRoot: tempRoot });
      const current = await readFile(attributesPath, "utf8");
      expect(current).toContain(nestedBlock.trimEnd());
      expect(current.match(/# pm-cli:merge-drivers:v2:start/g)).toHaveLength(2);
      expect(
        execFileSync(
          "git",
          ["check-attr", "merge", "--", "nested/.agents/pm/tasks/item.toon"],
          { cwd: tempRoot, encoding: "utf8" },
        ),
      ).toContain("merge: pm-item-toon");
    });
  });
});
