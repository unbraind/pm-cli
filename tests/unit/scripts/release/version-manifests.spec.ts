import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { distributionManifestPaths } from "../../../../scripts/release/version-manifests.mjs";
import { createScriptHarness } from "../../../helpers/scriptModule";

const harness = createScriptHarness();

/** Initialize independent release fixtures with deterministic identity and line endings. */
function initializeGit(root: string) {
  const options = { cwd: root, encoding: "utf8" as const };
  execFileSync("git", ["init", "--quiet"], options);
  execFileSync("git", ["config", "user.name", "Release fixture"], options);
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], options);
  execFileSync("git", ["config", "core.autocrlf", "false"], options);
  execFileSync("git", ["config", "core.eol", "lf"], options);
  execFileSync("git", ["add", "."], options);
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Analyzed fixture"], options);
  return options;
}

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
    const options = initializeGit(root);
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

  it.each(["valid", "legacy", "omitted", "modified"])("verifies immutable release provenance with %s runtime manifests", async (scenario) => {
    const root = await harness.createTempRoot("pm-release-provenance-");
    mkdirSync(path.join(root, "packages/example"), { recursive: true });
    writeFileSync(path.join(root, "packages/example/package.json"), "{}");
    const manifests = ["package.json", ...distributionManifestPaths(root)]
      .filter((file) => scenario !== "legacy" || !file.startsWith("plugins/") || !file.endsWith("/package.json"));
    for (const file of manifests) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), `${JSON.stringify({ version: "2026.9.25", dependencies: { "@unbrained/pm-cli": "2026.9.25" } }, null, 2)}\n`);
    }
    writeFileSync(path.join(root, "CHANGELOG.md"), "## Unreleased\n\n- Verified release.\n");
    const options = initializeGit(root);
    const parent = execFileSync("git", ["rev-parse", "HEAD"], options).trim();
    for (const file of manifests) {
      if (scenario === "omitted" && file === "plugins/pm-codex/package.json") continue;
      let content = readFileSync(path.join(root, file), "utf8").replaceAll('"2026.9.25"', '"2026.9.26"');
      if (scenario === "modified" && file === "plugins/pm-claude/package.json") {
        content = content.replace('"@unbrained/pm-cli": "2026.9.26"', '"@unbrained/pm-cli": "2026.1.1"');
      }
      writeFileSync(path.join(root, file), content);
    }
    writeFileSync(path.join(root, "CHANGELOG.md"), "## 2026.9.26\n\n- Verified release.\n");
    execFileSync("git", ["add", "."], options);
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "chore(release): cut 2026.9.26", "-m", "Automate daily release preparation with strict quality, compatibility, and reliability gates."], options);
    const sha = execFileSync("git", ["rev-parse", "HEAD"], options).trim();
    execFileSync("git", ["-c", "tag.gpgsign=false", "tag", "v2026.9.26"], options);
    const responses = new Map<string, unknown>([
      [`commits/${sha}/status`, { statuses: [] }],
      [`commits/${sha}/check-runs?per_page=100`, { check_runs: [] }],
      [`commits/${sha}/pulls?per_page=100`, []],
      [`commits/${parent}/status`, { statuses: [{ context: "DeepScan", state: "success", description: "0 new issues" }] }],
      [`commits/${parent}/check-runs?per_page=100`, { check_runs: [{ name: "CodeFactor", status: "completed", conclusion: "success", output: { title: "No issues found.", annotations_count: 0 } }] }],
      ["branches/main/protection", { required_status_checks: { strict: true, contexts: ["DeepScan", "CodeFactor"] } }],
    ]);
    vi.doMock("node:child_process", () => ({
      spawnSync: (command: string, args: string[]) => {
        const binary = command.replace(/\.cmd$/, "");
        if (binary === "git") return spawnSync(binary, args, options);
        const key = args[1].replace("repos/fixture/repository/", "");
        if (binary !== "gh" || !responses.has(key)) throw new Error(`Unexpected analyzer request: ${command} ${args.join(" ")}`);
        return { status: 0, stdout: JSON.stringify(responses.get(key)), stderr: "" };
      },
    }));
    process.argv = ["node", "hosted-analysis-gate.mjs", "--repo", "fixture/repository", "--sha", sha, "--json"];
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await harness.importModule("scripts/release/hosted-analysis-gate.mjs");
    const payload = JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(""));
    const accepted = scenario === "valid" || scenario === "legacy";
    expect(payload.ok).toBe(accepted);
    expect(process.exitCode).toBe(accepted ? 0 : 1);
    if (accepted) expect(payload.analysis_source).toBe("deterministic_release_transform");
  });
});
