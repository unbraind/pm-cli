import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
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

/** Prepend a native temporary binary directory to the PATH seen inside Bash. */
function prependFakeBinForBash(script: string): string {
  return [
    'if command -v cygpath >/dev/null 2>&1; then fake_bin="$(cygpath -u "$FAKE_BIN")"; else fake_bin="$FAKE_BIN"; fi',
    'export PATH="${fake_bin}:${PATH}"',
    script,
  ].join("\n");
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
      "pnpm build && pnpm exec tsx scripts/release/static-quality-gate.mts --max-eslint-suppressions 114 --max-coverage-ignore-pragmas 477 --min-docstring-coverage 100 --min-exported-docstring-coverage 100 --min-member-docstring-coverage 100 && node scripts/release/audit-package-boundary.mjs && node scripts/release/package-sdk-contract-parity.mjs && node scripts/release/surface-replication-gate.mjs && node scripts/release/absence-tolerance-gate.mjs && node scripts/release/token-budget-gate.mjs && node scripts/release/context-intent-calibration-gate.mjs && node scripts/release/tracker-measurement-gate.mjs && node scripts/release/gate-registry.mjs && node scripts/sdk-surface-snapshot.mjs --check && node scripts/bench/sdk-entrypoint-costs.mjs --check && node scripts/bench/cli-transport-floor.mjs --check && node dist/cli.js assurance run graph-composition --trigger ci --dry-run --json && node dist/cli.js assurance run record-integrity --trigger ci --dry-run --json",
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

    const gateRegistry = JSON.parse(
      await readFile(
        path.join(repoRoot, "scripts/release/gate-registry.json"),
        "utf8",
      ),
    ) as {
      local_preflight: {
        steps: Array<{
          id: string;
          executable: { command: string; args: string[] };
        }>;
      };
    };
    const staticStep = gateRegistry.local_preflight.steps.find(
      (step) => step.id === "static-quality-gate",
    );
    expect(staticStep?.executable).toEqual({
      command: "pnpm",
      args: ["quality:static"],
    });
    const runGatesSource = await readFile(
      path.join(repoRoot, "scripts/release/run-gates.mjs"),
      "utf8",
    );
    expect(runGatesSource).toContain("for (const step of steps)");
    expect(runGatesSource).toContain("executable.args.map(substitute)");
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
    expect(bundleScript).toContain("if (!lockStats)");
    expect(bundleScript).toContain("await removeStaleBundleFiles(outputs)");
    expect(bundleScript).toContain("await writeBundleManifest(outputs)");
    expect(bundleScript).toContain(
      "must not leak into repeated-build package artifacts",
    );
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

  it("scopes protected-main credentials to release policy analysis", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/auto-release.yml"),
      "utf8",
    );
    const pipeline = await readFile(
      path.join(repoRoot, "scripts/release/run-release-pipeline.mjs"),
      "utf8",
    );
    const gates = await readFile(
      path.join(repoRoot, "scripts/release/run-gates.mjs"),
      "utf8",
    );
    const gateRegistry = await readFile(
      path.join(repoRoot, "scripts/release/gate-registry.json"),
      "utf8",
    );
    expect(workflow).toContain(
      "RELEASE_POLICY_TOKEN: ${{ secrets.RELEASE_PAT }}",
    );
    expect(workflow).toContain("GH_TOKEN: ${{ github.token }}");
    expect(workflow).not.toContain("GH_TOKEN: ${{ secrets.RELEASE_PAT");
    expect(pipeline).toContain("delete process.env.RELEASE_POLICY_TOKEN");
    expect(gates).toContain("delete process.env.RELEASE_POLICY_TOKEN");
    expect(gateRegistry).toContain('"GH_TOKEN": "{{release_policy_token}}"');
    expect(gates).toContain("release_policy_token: releasePolicyToken");
    expect(gates).toContain(".filter(([, value]) => value.length > 0)");
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

  it("keeps Sentry classification SDK-bound and telemetry command execution portable", async () => {
    const gateSource = await readFile(
      path.join(repoRoot, "scripts/release/sentry-telemetry-gate.mjs"),
      "utf8",
    );
    expect(gateSource).toContain('commandFor("sentry")');
    expect(gateSource).toContain("function isExpectedHandledCliIssue");
    expect(gateSource).toContain("issue?.isUnhandled === true");
    expect(gateSource).toContain("PM_ERROR_CODE_CATALOG");
    expect(gateSource).toContain("resolveCanonicalPmErrorCodeContract");
    expect(gateSource).toMatch(
      /new Set\(\[\s*"usage",\s*"not_found",\s*"conflict",?\s*\]\)/u,
    );
    expect(gateSource).toContain(
      'readIssueContractValue(issue, "error_code", "pm.error_code")',
    );
    expect(gateSource).toContain(
      'readIssueContractValue(issue, "exit_code", "pm.exit_code")',
    );
    expect(gateSource).toContain("contract.exit_code === exitCode");
    expect(gateSource).toContain("enrichSentryIssuesWithLatestEvents");
    expect(gateSource).toContain("enrichSentryIssuesViaCli");
    expect(gateSource).not.toContain(
      "KNOWN_EXPECTED_HANDLED_CLI_ISSUE_PATTERNS",
    );
    expect(gateSource).not.toContain(
      "KNOWN_EXPECTED_HANDLED_ENVIRONMENT_ISSUE_PATTERNS",
    );
    expect(gateSource).not.toContain("issueTextValue");
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
    const gateRegistry = await readFile(
      path.join(repoRoot, "scripts/release/gate-registry.json"),
      "utf8",
    );
    expect(gateRegistry).toContain('"--sentry-window-days"');
    expect(gateRegistry).toContain('"{{sentry_window_days}}"');
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
    expect(pipelineModule.isReleaseRelevantPath("CHANGELOG.md")).toBe(false);
    expect(pipelineModule.isReleaseRelevantPath("src/cli/main.ts")).toBe(true);
  });

  it("keeps release pipeline and gate scripts discoverable through help output", () => {
    const pipelineHelp = runNodeScript([
      "scripts/release/run-release-pipeline.mjs",
      "--help",
    ]);
    expect(pipelineHelp.status).toBe(0);
    expect(pipelineHelp.stdout).not.toContain("--allow-same-day-release");
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
    expect(pipelineSource).toMatch(
      /"--status",\s*"closed",\s*"--exclude-tag",\s*"changelog-exclude",\s*"--item-url-base"/u,
    );
    expect(pipelineSource).toContain(
      "ensureGeneratedReleaseSectionHasContent(params.targetVersion, generatedChangelogPath)",
    );
    expect(pipelineSource).toContain(
      "empty_generated_changelog_section_for_target_version",
    );
    expect(pipelineSource).not.toContain("bumpSameDayOrdinal");
    expect(pipelineSource).not.toContain("maybeBumpSameDayTargetVersion");
    expect(pipelineSource).not.toContain(
      '"scripts/release-version.mjs", "next"',
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
    expect(workflow).toContain(
      '[ "${GITHUB_EVENT_NAME}" = "workflow_dispatch" ] && [ "${RECOVERY_SOURCE_MODE}" = "tag" ]',
    );
    expect(workflow).toContain("pnpm changelog:pm");
    expect(workflow).toContain("pnpm changelog:pm:check");
    expect(workflow).toContain("Exact-tag changelog recovery changed unexpected tracked paths");
    expect(workflow).toContain("':(exclude)CHANGELOG.md'");
    expect(workflow).toContain(
      "':(exclude).agents/pm/extensions/.managed-extensions.json'",
    );
  });

  it("executes exact-tag changelog recovery with a tracked-path mutation guard", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8",
    );
    const changelogStep = workflow.match(
      / {6}- name: Verify generated pm changelog\n {8}run: \|\n([\s\S]*?)(?=\n {6}- name:)/u,
    )?.[1];
    expect(changelogStep).toBeDefined();
    const changelogScript = changelogStep
      ?.split("\n")
      .map((line) => line.slice(10))
      .join("\n");
    expect(changelogScript).toBeDefined();

    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-release-changelog-recovery-"),
    );
    try {
      const invocationLog = path.join(tempRoot, "invocations.log");
      await writeFile(
        path.join(tempRoot, "pnpm"),
        `#!/usr/bin/env bash
printf 'pnpm %s\\n' "$*" >> "\${INVOCATION_LOG}"
`,
        "utf8",
      );
      await writeFile(
        path.join(tempRoot, "git"),
        `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >> "\${INVOCATION_LOG}"
printf '%s' "\${UNEXPECTED_PATHS}"
`,
        "utf8",
      );
      await chmod(path.join(tempRoot, "pnpm"), 0o755);
      await chmod(path.join(tempRoot, "git"), 0o755);

      const runScenario = (overrides: NodeJS.ProcessEnv) =>
        spawnSync(
          "bash",
          ["-c", prependFakeBinForBash(changelogScript ?? "")],
          {
            cwd: repoRoot,
            encoding: "utf8",
            env: {
              ...process.env,
              FAKE_BIN: tempRoot,
              INVOCATION_LOG: invocationLog,
              UNEXPECTED_PATHS: "",
              GITHUB_EVENT_NAME: "workflow_dispatch",
              RECOVERY_SOURCE_MODE: "tag",
              ...overrides,
            },
          },
        );

      await writeFile(invocationLog, "", "utf8");
      const recovery = runScenario({});
      expect(recovery.status).toBe(0);
      expect(await readFile(invocationLog, "utf8")).toContain(
        "pnpm changelog:pm",
      );
      expect(recovery.stdout).toContain(
        "regenerated the package changelog with the tagged checkout's canonical policy",
      );

      await writeFile(invocationLog, "", "utf8");
      const unexpectedMutation = runScenario({
        UNEXPECTED_PATHS: "package.json\n",
      });
      expect(unexpectedMutation.status).toBe(1);
      expect(unexpectedMutation.stderr).toContain(
        "changed unexpected tracked paths",
      );
      expect(unexpectedMutation.stderr).toContain("package.json");

      await writeFile(invocationLog, "", "utf8");
      const ordinaryTagPush = runScenario({
        GITHUB_EVENT_NAME: "push",
        RECOVERY_SOURCE_MODE: "tag",
      });
      expect(ordinaryTagPush.status).toBe(0);
      expect(await readFile(invocationLog, "utf8")).toBe(
        "pnpm changelog:pm:check\n",
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
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
    expect(workflow).toContain(
      'node scripts/release/verify-installed-agent-session.mjs --version "${RELEASE_TAG#v}" --manager both --json',
    );
    expect(workflow).toContain(
      'NPM_PACKAGE="$(node -p \'require("./package.json").name\')"',
    );
    expect(workflow).toContain("export NPM_PACKAGE");
    expect(workflow).toContain('npm access set status=public "${NPM_PACKAGE}"');
    expect(workflow).toContain(
      "attempting access recovery before immutable publication",
    );
    expect(workflow).toContain("refusing immutable publication");
    expect(workflow).toContain(
      "grep -Eq 'E404|404 Not Found|Package not found'",
    );
    expect(workflow).toContain(
      'elif anonymous_npm_view "${NPM_PACKAGE}" name; then',
    );
    expect(workflow).not.toContain(
      "Exact-tag recovery is restoring public package access before anonymous probes.",
    );
    const exactVersionProbeIndex = workflow.indexOf(
      'if anonymous_npm_view "${NPM_PACKAGE}@${VERSION}" version; then',
    );
    const packageProbeIndex = workflow.indexOf(
      'elif anonymous_npm_view "${NPM_PACKAGE}" name; then',
    );
    const accessRecoveryIndex = workflow.indexOf(
      "${NPM_PACKAGE} is not public; attempting access recovery before immutable publication.",
    );
    expect(exactVersionProbeIndex).toBeGreaterThanOrEqual(0);
    expect(packageProbeIndex).toBeGreaterThanOrEqual(0);
    expect(accessRecoveryIndex).toBeGreaterThanOrEqual(0);
    expect(exactVersionProbeIndex).toBeLessThan(packageProbeIndex);
    expect(packageProbeIndex).toBeLessThan(accessRecoveryIndex);
    expect(workflow).not.toContain("@unbrained/pm-cli");
    expect(workflow).toContain("env -u NODE_AUTH_TOKEN -u NPM_TOKEN");
    expect(workflow).toContain('npm_config_userconfig="${PUBLIC_NPMRC}"');
    expect(workflow).toContain('npm_config_cache="${PUBLIC_NPM_CACHE}"');
    expect(workflow).toContain("--max-critical 0 --max-high 0");
    expect(workflow).toContain(
      "DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}",
    );
    expect(workflow).toContain("github.sha || github.ref");
    expect(workflow).toContain("name: Select exact-tag recovery source");
    expect(workflow).toContain(
      'npm view "${NPM_PACKAGE}@${VERSION}" version --json',
    );
    expect(workflow).toContain(
      'git rev-parse --verify "refs/tags/${RELEASE_TAG}^{commit}"',
    );
    expect(workflow).toContain('git checkout --detach "${tag_commit}"');
    expect(workflow).toContain(
      'echo "RECOVERY_SOURCE_MODE=tag" >> "${GITHUB_ENV}"',
    );
    expect(workflow.indexOf("pnpm changelog:pm:check")).toBeLessThan(
      workflow.indexOf("pnpm quality:static"),
    );
    expect(workflow).toContain(
      "run: node dist/cli.js merge install --no-extensions",
    );
    expect(workflow).toContain(
      'if [ "${GITHUB_REF_NAME}" != "${DEFAULT_BRANCH}" ]; then',
    );
    expect(workflow).toMatch(
      /if \[ "\$\{GITHUB_EVENT_NAME\}" = "workflow_dispatch" \] && \[ "\$\{RECOVERY_SOURCE_MODE\}" = "main" \]; then[\s\S]*?else\s+node scripts\/release-version\.mjs check --tag "\$\{RELEASE_TAG\}"\s+fi/u,
    );
  });

  it("executes exact-tag recovery source selection fail closed", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8",
    );
    const sourceSelectionStep = workflow.match(
      / {6}- name: Select exact-tag recovery source[\s\S]*? {8}run: \|\n([\s\S]*?)(?=\n {6}- name:)/u,
    )?.[1];
    expect(sourceSelectionStep).toBeDefined();
    const sourceSelectionScript = sourceSelectionStep
      ?.split("\n")
      .map((line) => line.slice(10))
      .join("\n");
    expect(sourceSelectionScript).toBeDefined();

    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-release-source-selection-"),
    );
    try {
      const npmLog = path.join(tempRoot, "npm.log");
      const gitLog = path.join(tempRoot, "git.log");
      const githubEnv = path.join(tempRoot, "github.env");
      await writeFile(
        path.join(tempRoot, "npm"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${NPM_FAKE_LOG}"
printf '%s\\n' "\${PROBE_OUTPUT}"
exit "\${PROBE_STATUS}"
`,
        "utf8",
      );
      await writeFile(
        path.join(tempRoot, "git"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${GIT_FAKE_LOG}"
case "$1" in
  rev-parse) printf '%s\\n' "0449d15f0d34d15f0d34d15f0d34d15f0d34d15" ;;
  checkout) ;;
  *) exit 97 ;;
esac
`,
        "utf8",
      );
      await chmod(path.join(tempRoot, "npm"), 0o755);
      await chmod(path.join(tempRoot, "git"), 0o755);

      const runScenario = (overrides: NodeJS.ProcessEnv) =>
        spawnSync(
          "bash",
          ["-c", prependFakeBinForBash(sourceSelectionScript ?? "")],
          {
            cwd: repoRoot,
            encoding: "utf8",
            env: {
              ...process.env,
              FAKE_BIN: tempRoot,
              RELEASE_TAG: "v2026.8.5",
              DEFAULT_BRANCH: "main",
              GITHUB_ENV: githubEnv,
              NPM_FAKE_LOG: npmLog,
              GIT_FAKE_LOG: gitLog,
              PROBE_STATUS: "0",
              PROBE_OUTPUT: '"2026.8.5"',
              ...overrides,
            },
          },
        );

      await writeFile(npmLog, "", "utf8");
      await writeFile(gitLog, "", "utf8");
      await writeFile(githubEnv, "", "utf8");
      const existingVersion = runScenario({});
      expect(existingVersion.status).toBe(0);
      expect(await readFile(githubEnv, "utf8")).toBe(
        "RECOVERY_SOURCE_MODE=main\n",
      );
      expect(await readFile(gitLog, "utf8")).toBe("");

      await writeFile(gitLog, "", "utf8");
      await writeFile(githubEnv, "", "utf8");
      const missingVersion = runScenario({
        PROBE_STATUS: "1",
        PROBE_OUTPUT: "npm error code ETARGET",
      });
      expect(missingVersion.status).toBe(0);
      expect(await readFile(githubEnv, "utf8")).toBe(
        "RECOVERY_SOURCE_MODE=tag\n",
      );
      expect(await readFile(gitLog, "utf8")).toContain(
        "checkout --detach 0449d15f0d34d15f0d34d15f0d34d15f0d34d15",
      );
      await writeFile(npmLog, "", "utf8");
      await writeFile(gitLog, "", "utf8");
      await writeFile(githubEnv, "", "utf8");
      const invalidTag = runScenario({ RELEASE_TAG: "main" });
      expect(invalidTag.status).toBe(1);
      expect(await readFile(npmLog, "utf8")).toBe("");
      expect(await readFile(gitLog, "utf8")).toBe("");

      await writeFile(gitLog, "", "utf8");
      await writeFile(githubEnv, "", "utf8");
      const registryFailure = runScenario({
        PROBE_STATUS: "37",
        PROBE_OUTPUT: "npm error code E403 secret-diagnostic",
      });
      expect(registryFailure.status).toBe(37);
      expect(registryFailure.stderr).toContain(
        "failed without a definitive missing-version response (status 37)",
      );
      expect(registryFailure.stderr).not.toContain("secret-diagnostic");
      expect(await readFile(gitLog, "utf8")).toBe("");
      expect(await readFile(githubEnv, "utf8")).toBe("");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("executes the npm publication guard and stabilizes exact-tag recovery", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8",
    );
    const publishStep = workflow.match(
      / {6}- name: Publish to npm[\s\S]*? {8}run: \|\n([\s\S]*?)(?=\n {6}- name:)/u,
    )?.[1];
    expect(publishStep).toBeDefined();
    const publishScript = publishStep
      ?.split("\n")
      .map((line) => line.slice(10))
      .join("\n");
    expect(publishScript).toBeDefined();

    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-release-publish-guard-"),
    );
    try {
      const fakeNpm = path.join(tempRoot, "npm");
      const npmLog = path.join(tempRoot, "npm.log");
      const accessMarker = path.join(tempRoot, "access-attempted");
      await writeFile(
        fakeNpm,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${NPM_FAKE_LOG}"
case "$*" in
  "view \${NPM_PACKAGE}@\${RELEASE_VERSION} version --json")
    if [[ -f "\${ACCESS_MARKER}" ]]; then
      exit "\${POST_RECOVERY_TARGET_STATUS}"
    fi
    exit "\${TARGET_VERSION_STATUS}"
    ;;
  "view \${NPM_PACKAGE} name --json")
    if [[ -f "\${ACCESS_MARKER}" ]]; then
      exit "\${POST_RECOVERY_PACKAGE_STATUS}"
    fi
    exit "\${PACKAGE_STATUS}"
    ;;
  "access set status=public \${NPM_PACKAGE}")
    : > "\${ACCESS_MARKER}"
    printf '%s\\n' "\${ACCESS_OUTPUT}"
    exit "\${ACCESS_STATUS}"
    ;;
  "publish --access public --provenance --tag latest")
    exit 0
    ;;
  *)
    printf 'Unexpected npm invocation: %s\\n' "$*" >&2
    exit 97
    ;;
esac
`,
        "utf8",
      );
      await chmod(fakeNpm, 0o755);

      const runScenario = (overrides: NodeJS.ProcessEnv) =>
        spawnSync("bash", ["-c", prependFakeBinForBash(publishScript ?? "")], {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            FAKE_BIN: tempRoot,
            RELEASE_TAG: "v2026.7.27",
            RELEASE_VERSION: "2026.7.27",
            RUNNER_TEMP: tempRoot,
            GITHUB_EVENT_NAME: "push",
            RECOVERY_SOURCE_MODE: "tag",
            NPM_PACKAGE: "@unbrained/pm-cli",
            NPM_FAKE_LOG: npmLog,
            ACCESS_MARKER: accessMarker,
            TARGET_VERSION_STATUS: "1",
            PACKAGE_STATUS: "0",
            POST_RECOVERY_TARGET_STATUS: "1",
            POST_RECOVERY_PACKAGE_STATUS: "1",
            ACCESS_STATUS: "99",
            ACCESS_OUTPUT: "access should not run",
            ...overrides,
          },
        });

      const publicPackage = runScenario({});
      expect(publicPackage.status).toBe(0);
      expect(publicPackage.stdout).toContain(
        "@unbrained/pm-cli is publicly available but 2026.7.27 is not; publishing.",
      );
      let invocations = await readFile(npmLog, "utf8");
      expect(invocations).toContain(
        "view @unbrained/pm-cli@2026.7.27 version --json",
      );
      expect(invocations).toContain("view @unbrained/pm-cli name --json");
      expect(invocations).toContain(
        "publish --access public --provenance --tag latest",
      );
      expect(invocations).not.toContain("access set status=public");

      await writeFile(npmLog, "", "utf8");
      const existingVersion = runScenario({ TARGET_VERSION_STATUS: "0" });
      expect(existingVersion.status).toBe(0);
      expect(existingVersion.stdout).toContain(
        "@unbrained/pm-cli@2026.7.27 is publicly available; skipping npm publish.",
      );
      invocations = await readFile(npmLog, "utf8");
      expect(invocations).not.toContain("publish --access public");
      expect(invocations).not.toContain("access set status=public");

      await writeFile(npmLog, "", "utf8");
      await rm(accessMarker, { force: true });
      const exactTagRecovery = runScenario({
        GITHUB_EVENT_NAME: "workflow_dispatch",
        TARGET_VERSION_STATUS: "0",
        ACCESS_STATUS: "0",
        ACCESS_OUTPUT: "access restored",
        POST_RECOVERY_TARGET_STATUS: "0",
      });
      expect(exactTagRecovery.status).toBe(0);
      expect(exactTagRecovery.stdout).toContain(
        "@unbrained/pm-cli@2026.7.27 is publicly available; skipping npm publish.",
      );
      invocations = await readFile(npmLog, "utf8");
      expect(invocations).toContain(
        "view @unbrained/pm-cli@2026.7.27 version --json",
      );
      expect(invocations).not.toContain(
        "access set status=public @unbrained/pm-cli",
      );
      expect(invocations).not.toContain("publish --access public");

      await writeFile(npmLog, "", "utf8");
      await rm(accessMarker, { force: true });
      const missingExactTagRecovery = runScenario({
        GITHUB_EVENT_NAME: "workflow_dispatch",
        RECOVERY_SOURCE_MODE: "main",
        ACCESS_STATUS: "0",
        ACCESS_OUTPUT: "access restored",
        POST_RECOVERY_PACKAGE_STATUS: "0",
      });
      expect(missingExactTagRecovery.status).not.toBe(0);
      expect(missingExactTagRecovery.stderr).toContain(
        "refusing to publish different source under an immutable tag",
      );
      invocations = await readFile(npmLog, "utf8");
      expect(invocations).not.toContain("publish --access public");

      await writeFile(npmLog, "", "utf8");
      await rm(accessMarker, { force: true });
      const unpublishedTaggedSourceRecovery = runScenario({
        GITHUB_EVENT_NAME: "workflow_dispatch",
        RECOVERY_SOURCE_MODE: "tag",
        ACCESS_STATUS: "0",
        ACCESS_OUTPUT: "access restored",
        POST_RECOVERY_PACKAGE_STATUS: "0",
      });
      expect(unpublishedTaggedSourceRecovery.status).toBe(0);
      expect(unpublishedTaggedSourceRecovery.stdout).toContain(
        "@unbrained/pm-cli is publicly available but 2026.7.27 is not; publishing.",
      );
      invocations = await readFile(npmLog, "utf8");
      expect(invocations).toContain(
        "publish --access public --provenance --tag latest",
      );
      expect(invocations).not.toContain(
        "access set status=public @unbrained/pm-cli",
      );

      await writeFile(npmLog, "", "utf8");
      await rm(accessMarker, { force: true });
      const recoveredExistingVersion = runScenario({
        PACKAGE_STATUS: "1",
        ACCESS_STATUS: "0",
        ACCESS_OUTPUT: "access restored",
        POST_RECOVERY_TARGET_STATUS: "0",
      });
      expect(recoveredExistingVersion.status).toBe(0);
      expect(recoveredExistingVersion.stdout).toContain(
        "@unbrained/pm-cli@2026.7.27 became publicly available; skipping npm publish.",
      );
      invocations = await readFile(npmLog, "utf8");
      expect(invocations).toContain(
        "access set status=public @unbrained/pm-cli",
      );
      expect(invocations).not.toContain("publish --access public");

      await writeFile(npmLog, "", "utf8");
      await rm(accessMarker, { force: true });
      const recoveredMissingVersion = runScenario({
        PACKAGE_STATUS: "1",
        ACCESS_STATUS: "0",
        ACCESS_OUTPUT: "access restored",
        POST_RECOVERY_PACKAGE_STATUS: "0",
      });
      expect(recoveredMissingVersion.status).toBe(0);
      expect(recoveredMissingVersion.stdout).toContain(
        "@unbrained/pm-cli is public after access recovery but 2026.7.27 is not; publishing.",
      );
      invocations = await readFile(npmLog, "utf8");
      expect(invocations).toContain(
        "access set status=public @unbrained/pm-cli",
      );
      expect(invocations).toContain(
        "publish --access public --provenance --tag latest",
      );

      await writeFile(npmLog, "", "utf8");
      await rm(accessMarker, { force: true });
      const firstPublication = runScenario({
        PACKAGE_STATUS: "1",
        ACCESS_STATUS: "1",
        ACCESS_OUTPUT: "npm error code E404",
      });
      expect(firstPublication.status).toBe(0);
      expect(firstPublication.stdout).toContain(
        "@unbrained/pm-cli does not exist for this credential; publishing 2026.7.27.",
      );
      invocations = await readFile(npmLog, "utf8");
      expect(invocations).toContain(
        "access set status=public @unbrained/pm-cli",
      );
      expect(invocations).toContain(
        "publish --access public --provenance --tag latest",
      );

      await writeFile(npmLog, "", "utf8");
      await rm(accessMarker, { force: true });
      const deniedRecovery = runScenario({
        PACKAGE_STATUS: "1",
        ACCESS_STATUS: "1",
        ACCESS_OUTPUT: "npm error code E403",
      });
      expect(deniedRecovery.status).not.toBe(0);
      expect(deniedRecovery.stderr).toContain(
        "Public-access recovery failed without a definitive package-not-found response",
      );
      invocations = await readFile(npmLog, "utf8");
      expect(invocations).toContain(
        "access set status=public @unbrained/pm-cli",
      );
      expect(invocations).not.toContain("publish --access public");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
