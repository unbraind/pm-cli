import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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
      "node scripts/prepare-build-cache.mjs && tsc -p tsconfig.json && node scripts/bundle-cli.mjs && node scripts/finalize-build.mjs",
    );
    expect(packageJson.scripts?.["quality:static"]).toBe("node scripts/release/static-quality-gate.mjs");
    expect(packageJson.scripts?.typecheck).toBe("tsc --noEmit -p tsconfig.json && tsc -p tsconfig.packages.json");
    expect(packageJson.scripts?.["quality:docs-skills"]).toBe("node scripts/release/docs-skills-gate.mjs");
    expect(packageJson.scripts?.["release:gates"]).toBe("node scripts/release/run-gates.mjs --telemetry-mode best-effort");
    expect(packageJson.scripts?.["release:pipeline"]).toBe("node scripts/release/run-release-pipeline.mjs");
    expect(packageJson.scripts?.["release:pipeline:dry-run"]).toBe(
      "node scripts/release/run-release-pipeline.mjs --dry-run",
    );
    expect(packageJson.scripts?.["release:verify-published"]).toBe(
      "node scripts/release/verify-published-release.mjs",
    );
    expect(packageJson.scripts?.["changelog:pm:install"]).toBe(
      "node dist/cli.js install npm:pm-changelog --project",
    );
    expect(packageJson.scripts?.["changelog:pm"]).toContain("changelog:pm:install");
    expect(packageJson.scripts?.["changelog:pm"]).toContain("changelog generate");
    expect(packageJson.scripts?.["changelog:pm"]).toContain("CHANGELOG.md");
    expect(packageJson.scripts?.["changelog:pm"]).toContain("--mode replace");
    expect(packageJson.scripts?.["changelog:pm"]).toContain("--all-release-tags");
    expect(packageJson.scripts?.["changelog:pm"]).toContain("--item-url-base");
    expect(packageJson.scripts?.["changelog:pm:check"]).toContain("changelog:pm:install");
    expect(packageJson.scripts?.["changelog:pm:check"]).toContain("--check");
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

  it("keeps bundle rebuilds safe for concurrent local pm invocations", async () => {
    const bundleScript = await readFile(path.join(repoRoot, "scripts/bundle-cli.mjs"), "utf8");
    expect(bundleScript).not.toContain("rm(outputDir");
    expect(bundleScript).toContain("Do not delete the live bundle before rebuilding");
    expect(bundleScript).toContain("metafile: true");
    expect(bundleScript).toContain("removeStaleBundleFiles");
    expect(bundleScript).toContain("entry.isSymbolicLink()");
    expect(bundleScript).toContain("acquireBundleBuildLock");
    expect(bundleScript).toContain(".cli-bundle-build.lock");
    expect(bundleScript).toContain("rename(lockDir");
    expect(bundleScript).toContain("bundleStaleRetentionMs");
    expect(bundleScript).toContain("if (!lockStats)");
    expect(bundleScript).toContain("await lstat(filePath)");
  });

  it("builds dist before the auto-release pipeline consumes dist/cli.js", async () => {
    const workflow = await readFile(path.join(repoRoot, ".github/workflows/auto-release.yml"), "utf8");
    expect(workflow).toContain("pnpm build");
    const buildIndex = workflow.indexOf("pnpm build");
    const pipelineIndex = workflow.indexOf("scripts/release/run-release-pipeline.mjs");
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(pipelineIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeLessThan(pipelineIndex);
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

  it("keeps telemetry query command execution portable outside shell scripts", async () => {
    const gateSource = await readFile(path.join(repoRoot, "scripts/release/sentry-telemetry-gate.mjs"), "utf8");
    expect(gateSource).toContain('commandFor("sentry")');
    expect(gateSource).toContain("function isExpectedHandledCliIssue");
    expect(gateSource).toContain('issue?.isUnhandled === true');
    expect(gateSource).toContain("const combinedText = issueTextValue(issue).toLowerCase();");
    expect(gateSource).toContain("KNOWN_EXPECTED_HANDLED_CLI_ISSUE_PATTERNS");
    expect(gateSource).toContain('"dependency cycle"');
    expect(gateSource).toContain('"no slack webhook configured"');
    expect(gateSource).toContain('"slack webhook returned http"');
    // Count-agnostic structural-error pattern (replaced the brittle per-count
    // "validation failed: 1/2/3" + "found in" + "preflight" entries) plus the
    // standup-export missing-parent-directory write failure.
    expect(gateSource).toContain('"structural error(s)"');
    expect(gateSource).toContain('"the parent directory does not exist"');
    expect(gateSource).toContain('"tracker_not_initialized"');
    expect(gateSource).toContain('"pm-web exited with code"');
    expect(gateSource).toContain('"github api returned http 422"');
    expect(gateSource).toContain('"drift detected:"');
    expect(gateSource).toContain("ignored_expected_cli_error_total");
    expect(gateSource).toContain("function buildTelemetryCommandInvocation");
    expect(gateSource).toContain('commandPath.endsWith(".sh")');
    expect(gateSource).toContain("telemetryInvocation.command");
    expect(gateSource).toContain('telemetryMode === "required" && !telemetryCommandPath');
    expect(gateSource).toContain("telemetry_query_command_missing");
    expect(gateSource).not.toContain('runCommand(\n          "bash",\n          [telemetryCommandPath');
  });

  it("bounds the Sentry gate query to a configurable recent-activity window (pm-nb08)", async () => {
    const gateSource = await readFile(path.join(repoRoot, "scripts/release/sentry-telemetry-gate.mjs"), "utf8");
    // A stale benign unresolved issue must not block every scheduled release: the
    // query is bounded to a `lastSeen` window unless the window is explicitly 0.
    expect(gateSource).toContain("function buildSentryGateQuery(windowDays)");
    expect(gateSource).toContain("`${baseQuery} lastSeen:-${windowDays}d`");
    expect(gateSource).toContain('"sentry-window-days"');
    expect(gateSource).toContain("buildSentryGateQuery(sentryWindowDays)");
    expect(gateSource).toContain("window_days: sentryWindowDays");

    // The release + auto-release surfaces invoke the gate with an explicit window.
    const releaseWorkflow = await readFile(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");
    expect(releaseWorkflow).toContain("--sentry-window-days 14");
    const gatesSource = await readFile(path.join(repoRoot, "scripts/release/run-gates.mjs"), "utf8");
    expect(gatesSource).toContain('"--sentry-window-days"');
  });

  it("keeps tracker-only changes outside release relevance", async () => {
    const pipelineModule = (await import(
      pathToFileURL(path.join(repoRoot, "scripts/release/release-relevance.mjs")).href
    )) as {
      isReleaseRelevantPath(filePath: string): boolean;
    };

    expect(pipelineModule.isReleaseRelevantPath(".agents/pm/tasks/pm-example.md")).toBe(false);
    expect(pipelineModule.isReleaseRelevantPath(".agents\\pm\\tasks\\pm-example.md")).toBe(false);
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

  it("keeps pm-changelog install and main CHANGELOG.md generation wired into the release pipeline", async () => {
    const pipelineSource = await readFile(
      path.join(repoRoot, "scripts/release/run-release-pipeline.mjs"),
      "utf8",
    );
    expect(pipelineSource).toContain("npm:pm-changelog");
    expect(pipelineSource).toContain("changelog");
    expect(pipelineSource).toContain("CHANGELOG.md");
    expect(pipelineSource).toContain("--item-url-base");
    expect(pipelineSource).toContain("--mode");
    expect(pipelineSource).toContain("replace");
    expect(pipelineSource).toContain("--release-version");
    expect(pipelineSource).toContain("--all-release-tags");
    expect(pipelineSource).toContain("ensureGeneratedReleaseSectionHasContent(targetVersion, generatedChangelogPath)");
    expect(pipelineSource).toContain("empty_generated_changelog_section_for_target_version");
    expect(pipelineSource).toContain('"add", "package.json", "CHANGELOG.md"');
    expect(pipelineSource).not.toContain("CHANGELOG.pm.md");
  });

  it("keeps release workflow pm-changelog verification step present", async () => {
    const workflow = await readFile(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");
    expect(workflow).toContain("pnpm changelog:pm:check");
  });

  it("keeps CI changelog checks on a tag-aware checkout", async () => {
    const workflow = await readFile(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("pnpm changelog:pm:check");
  });

  it("keeps release-note tracker evidence bounded by existing release tags", async () => {
    const releaseNotesSource = await readFile(path.join(repoRoot, "scripts/generate-release-notes.mjs"), "utf8");
    expect(releaseNotesSource).toContain("const currentDate = resolveTagDate(currentTag)");
    expect(releaseNotesSource).toContain("formatPmSummary(items, previousDate, currentDate)");
    expect(releaseNotesSource).toContain("item.closed_at ?? item.updated_at ?? item.created_at");
    expect(releaseNotesSource).toContain('status === "closed"');
    expect(releaseNotesSource).toContain("timestamp > since && timestamp <= until");
  });

  it("keeps release workflow public verification delegated to the local script", async () => {
    const workflow = await readFile(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");
    expect(workflow).toContain("node scripts/release/verify-published-release.mjs --tag \"${RELEASE_TAG}\" --skip-github-release --json");
    expect(workflow).toContain("node scripts/release/verify-published-release.mjs --tag \"${RELEASE_TAG}\" --skip-package --json");
    expect(workflow).toContain("--max-critical 0 --max-high 0");
  });
});
