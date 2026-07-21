import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function runNodeScript(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
}

describe("release automation contract", () => {
  it("keeps package scripts aligned with local release parity workflow", async () => {
    const packageJsonRaw = await readFile(
      path.join(repoRoot, "package.json"),
      "utf8",
    );
    const packageJson = JSON.parse(packageJsonRaw) as {
      scripts?: Record<string, string | undefined>;
    };
    expect(packageJson.scripts).toBeDefined();
    expect(packageJson.scripts?.build).toBe(
      "node scripts/prepare-build-cache.mjs && tsc -p tsconfig.json && node scripts/bundle-cli.mjs && node scripts/finalize-build.mjs",
    );
    expect(packageJson.scripts?.["quality:static"]).toBe(
      "pnpm build && pnpm exec tsx scripts/release/static-quality-gate.mts --max-eslint-suppressions 152 --max-coverage-ignore-pragmas 477 --min-docstring-coverage 100 --min-exported-docstring-coverage 100 --min-member-docstring-coverage 100 && node scripts/release/audit-package-boundary.mjs && node scripts/release/token-budget-gate.mjs",
    );
    expect(packageJson.scripts?.["quality:token-budget"]).toBe(
      "node scripts/release/token-budget-gate.mjs",
    );
    expect(packageJson.scripts?.lint).toBe(
      "pnpm lint:eslint && pnpm lint:duplicates && pnpm lint:codefactor",
    );
    expect(packageJson.scripts?.["lint:codefactor"]).toBe(
      "pnpm quality:static",
    );
    expect(packageJson.scripts?.typecheck).toBe(
      "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typetests.json && tsc -p tsconfig.packages.json && tsc -p tsconfig.examples.json",
    );
    expect(packageJson.scripts?.["quality:docs-skills"]).toBe(
      "node scripts/release/docs-skills-gate.mjs",
    );
    expect(packageJson.scripts?.["release:gates"]).toBe(
      "node scripts/release/run-gates.mjs --telemetry-mode best-effort",
    );
    expect(packageJson.scripts?.["release:pipeline"]).toBe(
      "node scripts/release/run-release-pipeline.mjs",
    );
    expect(packageJson.scripts?.["release:pipeline:dry-run"]).toBe(
      "node scripts/release/run-release-pipeline.mjs --dry-run",
    );
    expect(packageJson.scripts?.["release:verify-published"]).toBe(
      "node scripts/release/verify-published-release.mjs",
    );
    expect(packageJson.scripts?.["changelog:pm:install"]).toBe(
      "node dist/cli.js install npm:pm-changelog --project",
    );
    expect(packageJson.scripts?.["changelog:pm"]).toContain(
      "changelog:pm:install",
    );
    expect(packageJson.scripts?.["changelog:pm"]).toContain(
      "changelog generate",
    );
    expect(packageJson.scripts?.["changelog:pm"]).toContain("CHANGELOG.md");
    expect(packageJson.scripts?.["changelog:pm"]).toContain("--mode replace");
    expect(packageJson.scripts?.["changelog:pm"]).toContain(
      "--all-release-tags",
    );
    expect(packageJson.scripts?.["changelog:pm"]).toContain("--item-url-base");
    expect(packageJson.scripts?.["changelog:pm:check"]).toContain(
      "changelog:pm:install",
    );
    expect(packageJson.scripts?.["changelog:pm:check"]).toContain("--check");

    const runGatesSource = await readFile(
      path.join(repoRoot, "scripts/release/run-gates.mjs"),
      "utf8",
    );
    expect(runGatesSource).toMatch(
      /runCheckedStep\(\s*["']static-quality-gate["']\s*,\s*pnpm\s*,\s*\[\s*["']quality:static["']\s*\]\s*\)/,
    );
    expect(runGatesSource).not.toMatch(
      /runCheckedStep\(\s*["']static-quality-gate["']\s*,\s*process\.execPath/,
    );
  });

  it("keeps unused underscore conventions aligned across TypeScript and Node script lint surfaces", async () => {
    const eslintConfig = await readFile(
      path.join(repoRoot, "eslint.config.mjs"),
      "utf8",
    );
    expect(eslintConfig).toContain(
      [
        '    files: ["**/*.{js,mjs,cjs}"],',
        "    rules: {",
        '      "no-unused-vars": ["error", UNUSED_VARS_OPTIONS],',
        '      "@typescript-eslint/no-unused-vars": "off",',
        "    },",
      ].join("\n"),
    );
    expect(eslintConfig).toContain('files: ["**/*.ts"]');
    expect(eslintConfig).toContain(
      '"@typescript-eslint/no-unused-vars": ["error", UNUSED_VARS_OPTIONS]',
    );
    expect(eslintConfig).toContain('argsIgnorePattern: "^_"');
    expect(eslintConfig).toContain('varsIgnorePattern: "^_"');
    expect(eslintConfig).toContain('caughtErrorsIgnorePattern: "^_"');
  });

  it("keeps CommonJS-only globals out of the ESM lint surface", async () => {
    const eslintConfig = await readFile(
      path.join(repoRoot, "eslint.config.mjs"),
      "utf8",
    );
    const nodeGlobals = eslintConfig.match(
      /const NODE_GLOBALS = \{(?<body>[\s\S]*?)\n\};/,
    );
    const commonjsGlobals = eslintConfig.match(
      /const COMMONJS_GLOBALS = \{(?<body>[\s\S]*?)\n\};/,
    );
    expect(nodeGlobals?.groups?.body).toBeDefined();
    expect(commonjsGlobals?.groups?.body).toBeDefined();
    expect(eslintConfig).toContain('files: ["**/*.cjs"]');
    for (const commonjsGlobal of [
      "__dirname",
      "__filename",
      "require",
      "module",
      "exports",
    ]) {
      expect(nodeGlobals?.groups?.body).not.toContain(`${commonjsGlobal}:`);
      expect(commonjsGlobals?.groups?.body).toContain(`${commonjsGlobal}:`);
    }
  });

  it("keeps the ESLint suppressions budget pinned to the current baseline", async () => {
    const staticQualityGate = await readFile(
      path.join(repoRoot, "scripts/release/static-quality-gate.mts"),
      "utf8",
    );
    const suppressionsRaw = await readFile(
      path.join(repoRoot, "eslint-suppressions.json"),
      "utf8",
    );
    const suppressions = JSON.parse(suppressionsRaw) as Record<
      string,
      Record<string, { count?: unknown }>
    >;
    let total = 0;
    for (const rules of Object.values(suppressions)) {
      for (const entry of Object.values(rules)) {
        expect(typeof entry.count).toBe("number");
        total += entry.count as number;
      }
    }
    expect(staticQualityGate).toContain(
      `export const MAX_ESLINT_SUPPRESSIONS = ${total};`,
    );
  });

  it("keeps bundle rebuilds safe for concurrent local pm invocations", async () => {
    const bundleScript = await readFile(
      path.join(repoRoot, "scripts/bundle-cli.mjs"),
      "utf8",
    );
    expect(bundleScript).not.toContain("rm(outputDir");
    expect(bundleScript).toContain(
      "Do not delete the live bundle before rebuilding",
    );
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
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/auto-release.yml"),
      "utf8",
    );
    expect(workflow).toContain("pnpm build");
    const buildIndex = workflow.indexOf("pnpm build");
    const pipelineIndex = workflow.indexOf(
      "scripts/release/run-release-pipeline.mjs",
    );
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(pipelineIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeLessThan(pipelineIndex);
  });

  it("allows the external Sentry gate to be disabled in unauthenticated automation", () => {
    const env = { ...process.env };
    delete env.SENTRY_AUTH_TOKEN;
    delete env.SENTRY_ORG_TOKEN;
    delete env.SENTRY_PERSONAL_ADMIN_TOKEN;

    const result = runNodeScript(
      [
        "scripts/release/sentry-telemetry-gate.mjs",
        "--json",
        "--telemetry-mode",
        "off",
      ],
      env,
    );

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
    const gateSource = await readFile(
      path.join(repoRoot, "scripts/release/sentry-telemetry-gate.mjs"),
      "utf8",
    );
    expect(gateSource).toContain('commandFor("sentry")');
    expect(gateSource).toContain("function isExpectedHandledCliIssue");
    expect(gateSource).toContain("issue?.isUnhandled === true");
    expect(gateSource).toContain(
      "const combinedText = issueTextValue(issue).toLowerCase();",
    );
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
    expect(gateSource).toContain(
      "KNOWN_EXPECTED_HANDLED_ENVIRONMENT_ISSUE_PATTERNS",
    );
    expect(gateSource).toContain('"enospc: no space left on device"');
    expect(gateSource).toContain("ignored_expected_handled_total");
    expect(gateSource).toContain("function buildTelemetryCommandInvocation");
    expect(gateSource).toContain("function resolveTelemetrySummary");
    expect(gateSource).toContain('commandPath.endsWith(".sh")');
    expect(gateSource).toContain("telemetryInvocation.command");
    expect(gateSource).toContain(
      'params.telemetryMode === "required" && !params.telemetryCommandPath',
    );
    expect(gateSource).toContain("telemetry_query_command_missing");
    expect(gateSource).not.toContain(
      'runCommand(\n          "bash",\n          [telemetryCommandPath',
    );
  });

  it("bounds the Sentry gate query to a configurable recent-activity window (pm-nb08)", async () => {
    const gateSource = await readFile(
      path.join(repoRoot, "scripts/release/sentry-telemetry-gate.mjs"),
      "utf8",
    );
    // A stale benign unresolved issue must not block every scheduled release: the
    // query is bounded to a `lastSeen` window unless the window is explicitly 0.
    expect(gateSource).toContain("function buildSentryGateQuery(windowDays)");
    expect(gateSource).toMatch(/lastSeen:-\$\{windowDays\}d/);
    expect(gateSource).toContain('"sentry-window-days"');
    expect(gateSource).toContain("buildSentryGateQuery(sentryWindowDays)");
    expect(gateSource).toContain("window_days: params.sentryWindowDays");

    // The release + auto-release surfaces invoke the gate with an explicit window.
    const releaseWorkflow = await readFile(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8",
    );
    expect(releaseWorkflow).toContain("--sentry-window-days 14");
    const gatesSource = await readFile(
      path.join(repoRoot, "scripts/release/run-gates.mjs"),
      "utf8",
    );
    expect(gatesSource).toContain('"--sentry-window-days"');
  });

  it("keeps tracker-only changes outside release relevance", async () => {
    const pipelineModule = (await import(
      pathToFileURL(
        path.join(repoRoot, "scripts/release/release-relevance.mjs"),
      ).href
    )) as {
      isReleaseRelevantPath(filePath: string): boolean;
    };

    expect(
      pipelineModule.isReleaseRelevantPath(".agents/pm/tasks/pm-example.md"),
    ).toBe(false);
    expect(
      pipelineModule.isReleaseRelevantPath(".agents\\pm\\tasks\\pm-example.md"),
    ).toBe(false);
    expect(pipelineModule.isReleaseRelevantPath("src/cli/main.ts")).toBe(true);
  });

  it("keeps release pipeline and gate scripts discoverable through help output", () => {
    const pipelineHelp = runNodeScript([
      "scripts/release/run-release-pipeline.mjs",
      "--help",
    ]);
    expect(pipelineHelp.status).toBe(0);
    expect(pipelineHelp.stdout).toContain("--allow-same-day-release");
    expect(pipelineHelp.stdout).toContain("--dry-run");
    expect(pipelineHelp.stdout).toContain("--push");
    expect(pipelineHelp.stdout).toContain("--telemetry-mode");
    expect(pipelineHelp.stdout).toContain(".agents/pm tracker state");

    const gatesHelp = runNodeScript([
      "scripts/release/run-gates.mjs",
      "--help",
    ]);
    expect(gatesHelp.status).toBe(0);
    expect(gatesHelp.stdout).toContain("--skip-compatibility");
    expect(gatesHelp.stdout).toContain("--skip-telemetry-sentry");

    const docsSkillsHelp = runNodeScript([
      "scripts/release/docs-skills-gate.mjs",
      "--help",
    ]);
    expect(docsSkillsHelp.status).toBe(0);
    expect(docsSkillsHelp.stdout).toContain(
      "docs and .agents/skills freshness",
    );

    const verifyPublishedHelp = runNodeScript([
      "scripts/release/verify-published-release.mjs",
      "--help",
    ]);
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
    expect(pipelineSource).toContain(
      "ensureGeneratedReleaseSectionHasContent(params.targetVersion, generatedChangelogPath)",
    );
    expect(pipelineSource).toContain(
      "empty_generated_changelog_section_for_target_version",
    );
    expect(pipelineSource).toContain(
      'git([\n    "add",\n    "package.json",\n    "CHANGELOG.md",',
    );
    expect(pipelineSource).not.toContain("CHANGELOG.pm.md");
  });

  it("keeps release workflow pm-changelog verification step present", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8",
    );
    expect(workflow).toContain("pnpm changelog:pm:check");
  });

  it("keeps CI changelog checks on a tag-aware checkout", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/ci.yml"),
      "utf8",
    );
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("pnpm changelog:pm:check");
  });

  it("keeps release-note tracker evidence bounded by existing release tags", async () => {
    const releaseNotesSource = await readFile(
      path.join(repoRoot, "scripts/generate-release-notes.mjs"),
      "utf8",
    );
    expect(releaseNotesSource).toContain(
      "const currentDate = resolveTagDate(currentTag)",
    );
    expect(releaseNotesSource).toContain(
      "formatPmSummary(items, previousDate, currentDate)",
    );
    expect(releaseNotesSource).toContain(
      "item.closed_at ?? item.updated_at ?? item.created_at",
    );
    expect(releaseNotesSource).toContain('status === "closed"');
    expect(releaseNotesSource).toContain(
      "timestamp > since && timestamp <= until",
    );
  });

  it("keeps release workflow public verification delegated to the local script", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8",
    );
    expect(workflow).toContain(
      'node scripts/release/verify-published-release.mjs --tag "${RELEASE_TAG}" --skip-github-release --json',
    );
    expect(workflow).toContain(
      'node scripts/release/verify-published-release.mjs --tag "${RELEASE_TAG}" --skip-package --json',
    );
    expect(workflow).toContain("--max-critical 0 --max-high 0");
  });
});
