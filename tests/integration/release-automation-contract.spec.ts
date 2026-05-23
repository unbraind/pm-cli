import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function runNodeScript(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
}

describe("release automation contract", () => {
  it("keeps package scripts aligned with local release parity workflow", async () => {
    const packageJsonRaw = await readFile(path.join(repoRoot, "package.json"), "utf8");
    const packageJson = JSON.parse(packageJsonRaw) as {
      scripts?: Record<string, string | undefined>;
    };
    expect(packageJson.scripts).toBeDefined();
    expect(packageJson.scripts?.build).toBe(
      "node scripts/prepare-build-cache.mjs && tsc -p tsconfig.json && node scripts/finalize-build.mjs",
    );
    expect(packageJson.scripts?.["quality:static"]).toBe("node scripts/release/static-quality-gate.mjs");
    expect(packageJson.scripts?.typecheck).toBe("tsc --noEmit -p tsconfig.json && tsc -p tsconfig.packages.json");
    expect(packageJson.scripts?.["quality:docs-skills"]).toBe("node scripts/release/docs-skills-gate.mjs");
    expect(packageJson.scripts?.["release:changelog"]).toBe("node scripts/release/changelog-promote.mjs");
    expect(packageJson.scripts?.["release:gates"]).toBe("node scripts/release/run-gates.mjs --telemetry-mode best-effort");
    expect(packageJson.scripts?.["release:pipeline"]).toBe("node scripts/release/run-release-pipeline.mjs");
    expect(packageJson.scripts?.["release:pipeline:dry-run"]).toBe(
      "node scripts/release/run-release-pipeline.mjs --dry-run",
    );
    expect(packageJson.scripts?.["release:verify-published"]).toBe(
      "node scripts/release/verify-published-release.mjs",
    );
  });

  it("keeps auto-release workflow aligned with one-per-day and manual override controls", async () => {
    const workflow = await readFile(path.join(repoRoot, ".github/workflows/auto-release.yml"), "utf8");
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("allow_same_day_release:");
    expect(workflow).toContain("dry_run:");
    expect(workflow).toContain("push:");
    expect(workflow).toContain('default: "off"');
    expect(workflow).toContain('- "off"');
    expect(workflow).toContain("--allow-same-day-release");
    expect(workflow).toContain("--dry-run");
    expect(workflow).toContain("--push");
    expect(workflow).toContain("node scripts/release/run-release-pipeline.mjs");
    expect(workflow).toContain("actions: write");
    expect(workflow).toContain("gh workflow run release.yml --ref main -f tag=\"${NEW_TAG}\"");
    expect(workflow).toContain("gh run watch \"${RELEASE_RUN_ID}\" --compact --exit-status --interval 30");
    expect(workflow).toContain("SENTRY_AUTH_TOKEN");
    expect(workflow).toContain("SENTRY_PERSONAL_ADMIN_TOKEN");
  });

  it("allows the external Sentry gate to be disabled in unauthenticated automation", () => {
    const env = { ...process.env };
    delete env.SENTRY_AUTH_TOKEN;
    delete env.SENTRY_ORG_TOKEN;
    delete env.SENTRY_PERSONAL_ADMIN_TOKEN;

    const result = runNodeScript([
      "scripts/release/sentry-telemetry-gate.mjs",
      "--json",
      "--telemetry-mode",
      "off",
    ], env);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      sentry: { checked: boolean; warning: string | null; access_ok: boolean };
      telemetry: { checked: boolean; mode: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.sentry.checked).toBe(false);
    expect(payload.sentry.warning).toBe("missing_sentry_auth_token");
    expect(payload.sentry.access_ok).toBe(true);
    expect(payload.telemetry.checked).toBe(false);
    expect(payload.telemetry.mode).toBe("off");
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

  it("fails empty changelog skips when releasable code changed", async () => {
    const pipelineModule = (await import(
      pathToFileURL(path.join(repoRoot, "scripts/release/run-release-pipeline.mjs")).href
    )) as {
      buildEmptyChangelogResult(input: {
        lastTag: string;
        commitsSinceLastTag: number;
        releaseRelevantFiles: string[];
      }): {
        ok: boolean;
        skipped: boolean;
        reason: string;
        release_relevant_files: string[];
        changelog_required_files?: string[];
        warnings?: string[];
      };
      isChangelogRequiredPath(filePath: string): boolean;
    };

    expect(pipelineModule.isChangelogRequiredPath("src/cli/main.ts")).toBe(true);
    expect(pipelineModule.isChangelogRequiredPath("packages/pm-todos/package.json")).toBe(true);
    expect(pipelineModule.isChangelogRequiredPath("scripts/dogfood-package-first.mjs")).toBe(true);
    expect(pipelineModule.isChangelogRequiredPath("docs/README.md")).toBe(false);

    const result = pipelineModule.buildEmptyChangelogResult({
      lastTag: "v2026.5.22",
      commitsSinceLastTag: 3,
      releaseRelevantFiles: ["docs/README.md", "src/cli/main.ts"],
    });

    expect(result).toMatchObject({
      ok: false,
      skipped: true,
      reason: "changelog_unreleased_empty",
      changelog_required_files: ["src/cli/main.ts"],
      warnings: ["release_changelog_required:source_or_package_changes_without_unreleased_entry"],
    });
  });

  it("keeps empty changelog skips clean for non-releasable docs-only changes", async () => {
    const pipelineModule = (await import(
      pathToFileURL(path.join(repoRoot, "scripts/release/run-release-pipeline.mjs")).href
    )) as {
      buildEmptyChangelogResult(input: {
        lastTag: string;
        commitsSinceLastTag: number;
        releaseRelevantFiles: string[];
      }): {
        ok: boolean;
        skipped: boolean;
        reason: string;
        changelog_required_files?: string[];
        warnings?: string[];
      };
    };

    const result = pipelineModule.buildEmptyChangelogResult({
      lastTag: "v2026.5.22",
      commitsSinceLastTag: 1,
      releaseRelevantFiles: ["docs/README.md"],
    });

    expect(result).toMatchObject({
      ok: true,
      skipped: true,
      reason: "changelog_unreleased_empty",
    });
    expect(result.changelog_required_files).toBeUndefined();
    expect(result.warnings).toBeUndefined();
  });

  it("keeps tracker-only changes outside release relevance", async () => {
    const pipelineModule = (await import(
      pathToFileURL(path.join(repoRoot, "scripts/release/run-release-pipeline.mjs")).href
    )) as {
      isReleaseRelevantPath(filePath: string): boolean;
    };

    expect(pipelineModule.isReleaseRelevantPath(".agents/pm/tasks/pm-example.md")).toBe(false);
    expect(pipelineModule.isReleaseRelevantPath("src/cli/main.ts")).toBe(true);
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

    const docsSkillsHelp = runNodeScript(["scripts/release/docs-skills-gate.mjs", "--help"]);
    expect(docsSkillsHelp.status).toBe(0);
    expect(docsSkillsHelp.stdout).toContain("docs and .agents/skills freshness");

    const verifyPublishedHelp = runNodeScript(["scripts/release/verify-published-release.mjs", "--help"]);
    expect(verifyPublishedHelp.status).toBe(0);
    expect(verifyPublishedHelp.stdout).toContain("--skip-github-release");
    expect(verifyPublishedHelp.stdout).toContain("npm registry metadata");
  });

  it("keeps release workflow public verification delegated to the local script", async () => {
    const workflow = await readFile(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");
    expect(workflow).toContain("node scripts/release/verify-published-release.mjs --tag \"${RELEASE_TAG}\" --skip-github-release --json");
    expect(workflow).toContain("node scripts/release/verify-published-release.mjs --tag \"${RELEASE_TAG}\" --skip-package --json");
    expect(workflow).toContain("--max-critical 10 --max-high 20");
  });
});
