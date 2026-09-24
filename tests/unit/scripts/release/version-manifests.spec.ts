import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { distributionManifestPaths } from "../../../../scripts/release/version-manifests.mjs";
import { createScriptHarness } from "../../../helpers/scriptModule";

const harness = createScriptHarness();

describe("release manifest inventory (pm-t4prek)", () => {
  it("commits synchronized runtime pins and newly discovered packages in a real Git repository", async () => {
    const root = await harness.createTempRoot("pm-release-manifests-");
    for (const directory of ["packages/new-package", "packages/empty", "scripts/release"]) {
      mkdirSync(path.join(root, directory), { recursive: true });
    }
    writeFileSync(path.join(root, "packages/new-package/package.json"), "{}");
    const manifests = distributionManifestPaths(root);
    expect(manifests).toContain(path.join("packages", "new-package", "package.json"));
    expect(manifests).not.toContain(path.join("packages", "empty", "package.json"));
    for (const relative of ["package.json", ...manifests]) {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), JSON.stringify({
        version: "2026.9.23", dependencies: { "@unbrained/pm-cli": "2026.9.23" },
      }));
    }
    for (const script of ["sync-versions.mjs", "release/version-manifests.mjs"]) {
      copyFileSync(path.resolve("scripts", script), path.join(root, "scripts", script));
    }
    const options = { cwd: root, encoding: "utf8" as const };
    execFileSync("git", ["init", "--quiet"], options);
    execFileSync("git", ["config", "user.name", "Release fixture"], options);
    execFileSync("git", ["config", "user.email", "fixture@example.invalid"], options);
    execFileSync("git", ["config", "core.autocrlf", "false"], options);
    execFileSync("git", ["config", "core.eol", "lf"], options);
    execFileSync("git", ["add", "."], options);
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Initial fixture"], options);
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.24" }));
    expect(() => execFileSync(process.execPath, ["scripts/sync-versions.mjs", "check"], { ...options, stdio: "pipe" }))
      .toThrow();
    execFileSync(process.execPath, ["scripts/sync-versions.mjs", "apply"], options);
    execFileSync(process.execPath, ["scripts/sync-versions.mjs", "check"], options);
    writeFileSync(path.join(root, "unrelated.txt"), "must remain untracked");
    execFileSync("git", ["add", "package.json", ...distributionManifestPaths(root)], options);
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Release fixture"], options);
    for (const relative of manifests) {
      const committed = execFileSync("git", ["show", `HEAD:${relative.split(path.sep).join("/")}`], options);
      expect(JSON.parse(committed)).toEqual({
        version: "2026.9.24", dependencies: { "@unbrained/pm-cli": "2026.9.24" },
      });
      expect(committed).toBe(readFileSync(path.join(root, relative), "utf8"));
    }
    expect(execFileSync("git", ["status", "--porcelain"], options).trim()).toBe("?? unrelated.txt");
  });
});
