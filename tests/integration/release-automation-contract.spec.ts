import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function runNodeScript(args: string[]) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("release automation contract", () => {
  it("keeps package scripts aligned with local release parity workflow", async () => {
    const packageJsonRaw = await readFile(path.join(repoRoot, "package.json"), "utf8");
    const packageJson = JSON.parse(packageJsonRaw) as {
      scripts?: Record<string, string | undefined>;
    };
    expect(packageJson.scripts).toBeDefined();
    expect(packageJson.scripts?.["quality:static"]).toBe("node scripts/release/static-quality-gate.mjs");
    expect(packageJson.scripts?.["release:changelog"]).toBe("node scripts/release/changelog-promote.mjs");
    expect(packageJson.scripts?.["release:gates"]).toBe("node scripts/release/run-gates.mjs --telemetry-mode best-effort");
    expect(packageJson.scripts?.["release:pipeline"]).toBe("node scripts/release/run-release-pipeline.mjs");
    expect(packageJson.scripts?.["release:pipeline:dry-run"]).toBe(
      "node scripts/release/run-release-pipeline.mjs --dry-run",
    );
  });

  it("keeps auto-release workflow aligned with one-per-day and manual override controls", async () => {
    const workflow = await readFile(path.join(repoRoot, ".github/workflows/auto-release.yml"), "utf8");
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("allow_same_day_release:");
    expect(workflow).toContain("dry_run:");
    expect(workflow).toContain("push:");
    expect(workflow).toContain("--allow-same-day-release");
    expect(workflow).toContain("--dry-run");
    expect(workflow).toContain("--push");
    expect(workflow).toContain("node scripts/release/run-release-pipeline.mjs");
  });

  it("promotes changelog unreleased content into a versioned section", async () => {
    const source = `# Changelog

## [Unreleased]

### Added
- New CLI release gate.

## [2026.5.3] - 2026-05-03

### Changed
- Existing item.
`;
    const tempRoot = await mkdtemp(path.join(tmpdir(), "pm-release-contract-"));
    const changelogPath = path.join(tempRoot, "CHANGELOG.md");
    await writeFile(changelogPath, source, "utf8");
    try {
      const result = runNodeScript([
        "scripts/release/changelog-promote.mjs",
        "--version",
        "2026.5.4",
        "--date",
        "2026-05-04",
        "--file",
        changelogPath,
      ]);
      expect(result.status).toBe(0);
      const promoted = await readFile(changelogPath, "utf8");
      expect(promoted).toContain("## [Unreleased]");
      expect(promoted).toContain("## [2026.5.4] - 2026-05-04");
      expect(promoted).toContain("- New CLI release gate.");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps release pipeline and gate scripts discoverable through help output", () => {
    const pipelineHelp = runNodeScript(["scripts/release/run-release-pipeline.mjs", "--help"]);
    expect(pipelineHelp.status).toBe(0);
    expect(pipelineHelp.stdout).toContain("--allow-same-day-release");
    expect(pipelineHelp.stdout).toContain("--dry-run");
    expect(pipelineHelp.stdout).toContain("--push");
    expect(pipelineHelp.stdout).toContain("--telemetry-mode");
    expect(pipelineHelp.stdout).toContain(".agents/pm tracker state");

    const gatesHelp = runNodeScript(["scripts/release/run-gates.mjs", "--help"]);
    expect(gatesHelp.status).toBe(0);
    expect(gatesHelp.stdout).toContain("--skip-compatibility");
    expect(gatesHelp.stdout).toContain("--skip-telemetry-sentry");
  });
});
