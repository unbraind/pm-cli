import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  installMergeFence,
  PM_GITATTRIBUTES_END,
  PM_GITATTRIBUTES_START,
  PM_GITATTRIBUTES_V2_END,
  PM_GITATTRIBUTES_V2_START,
} from "../../src/sdk/merge/install.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("merge fence version-skew compatibility", () => {
  it("migrates the legacy fence so older ordinary commands cannot rewrite it", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot }) => {
      execFileSync("git", ["init", "-q"], { cwd: tempRoot });
      const attributesPath = path.join(tempRoot, ".gitattributes");
      await writeFile(
        attributesPath,
        `${PM_GITATTRIBUTES_START}\nlegacy-pattern merge=pm-json\n${PM_GITATTRIBUTES_END}\n`,
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
});
