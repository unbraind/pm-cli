import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkDirectoryLoad, collectTypeScriptFiles, relativeToRepo } from "../../scripts/release/static-quality-gate.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Per-directory `.ts` file cap enforced by `scripts/release/static-quality-gate.mjs`
 * (`--max-files-per-dir`, default 120) and run via the `quality:static` CI gate.
 * Kept in sync with the gate source by the contract test below so the magic
 * number cannot silently drift between the gate and this guardrail.
 */
const MAX_FILES_PER_DIRECTORY = 120;

const PUBLISH_OR_RELEASE_PATTERNS = [
  "npm publish",
  "pnpm publish",
  "semantic-release",
  "changeset publish",
  "gh release",
  "npx changeset publish",
];
const SHA_PATTERN = "[0-9a-f]{40}";
const PINNED_PNPM_VERSION = "version: 11.10.0";
const PINNED_ACTIONS = {
  checkout: new RegExp(`uses: actions/checkout@${SHA_PATTERN}`),
  pnpmSetup: new RegExp(`uses: pnpm/action-setup@${SHA_PATTERN}`),
  setupNode: new RegExp(`uses: actions/setup-node@${SHA_PATTERN}`),
  actionsCache: new RegExp(`uses: actions/cache@${SHA_PATTERN}`),
  downloadArtifact: new RegExp(`uses: actions/download-artifact@${SHA_PATTERN}`),
  setupBun: new RegExp(`uses: oven-sh/setup-bun@${SHA_PATTERN}`),
  uploadArtifact: new RegExp(`uses: actions/upload-artifact@${SHA_PATTERN}`),
};

function normalizeWorkflow(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

function expectContainsAll(content: string, requiredSnippets: Array<string | RegExp>): void {
  for (const snippet of requiredSnippets) {
    if (snippet instanceof RegExp) {
      expect(content).toMatch(snippet);
    } else {
      expect(content).toContain(snippet);
    }
  }
}

function expectContainsNone(content: string, blockedSnippets: string[]): void {
  for (const snippet of blockedSnippets) {
    expect(content).not.toContain(snippet);
  }
}

function extractWorkflowJob(content: string, jobName: string): string {
  const match = content.match(new RegExp(`\\n  ${jobName}:\\n[\\s\\S]*?(?=\\n  [a-zA-Z0-9_-]+:\\n|\\n?$)`));
  if (!match) {
    throw new Error(`Expected workflow job ${jobName} to exist`);
  }
  return match[0];
}

describe("GitHub workflow contract", () => {
  it("keeps the README Codecov badge pinned to the default branch", async () => {
    const readmePath = path.resolve(repoRoot, "README.md");
    const readme = normalizeWorkflow(await readFile(readmePath, "utf8"));

    expect(readme).toContain(
      "[![codecov](https://codecov.io/gh/unbraind/pm-cli/branch/main/graph/badge.svg)]",
    );
  });

  it("keeps CI matrix and quality-gate steps aligned with release requirements", async () => {
    const ciPath = path.resolve(repoRoot, ".github/workflows/ci.yml");
    const ciWorkflow = normalizeWorkflow(await readFile(ciPath, "utf8"));
    const runtimeSmokeJob = extractWorkflowJob(ciWorkflow, "build-test");
    const coverageShardsJob = extractWorkflowJob(ciWorkflow, "coverage-shards");
    const coverageJob = extractWorkflowJob(ciWorkflow, "coverage");
    const windowsRegressionJob = extractWorkflowJob(ciWorkflow, "windows-regression");

    expectContainsAll(ciWorkflow, [
      "on:",
      "push:",
      "pull_request:",
      "paths:",
      '- "**"',
      '- "!docs/**"',
      '- "!**/*.md"',
      '- "!.github/ISSUE_TEMPLATE/**"',
      '- "plugins/**"',
      "permissions:",
      "contents: read",
      "FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: \"true\"",
      "concurrency:",
      "cancel-in-progress: true",
      "build-foundation:",
      "build-test:",
      "gates:",
      "coverage-shards:",
      "coverage:",
      "windows-regression:",
      "name: Build foundation (Ubuntu, Node 24)",
      "name: Runtime smoke (${{ matrix.os }}, Node ${{ matrix.node }})",
      "name: Gates (${{ matrix.gate }})",
      "name: Coverage shard ${{ matrix.shard }}/4",
      "name: Gates (coverage)",
      "name: Windows regression (Node 24)",
      "needs: build-foundation",
      "gate:",
      "- typecheck",
      "- static",
      "- compat",
      "- smokes",
      "if: matrix.gate == 'typecheck'",
      "if: matrix.gate == 'static'",
      "if: matrix.gate == 'compat'",
      "if: matrix.gate == 'smokes'",
      PINNED_ACTIONS.checkout,
      PINNED_ACTIONS.pnpmSetup,
      PINNED_PNPM_VERSION,
      PINNED_ACTIONS.setupNode,
      "name: Restore TypeScript and Vitest caches",
      PINNED_ACTIONS.actionsCache,
      ".cache/tsbuildinfo",
      ".cache/vitest",
      "key: pm-cli-validation-cache-${{ runner.os }}-node24-${{ hashFiles('pnpm-lock.yaml', 'tsconfig*.json', 'vitest.config.ts', 'src/**/*.ts', 'tests/**/*.ts', 'packages/**/*.ts') }}",
      "pm-cli-validation-cache-${{ runner.os }}-",
      "name: Restore LanceDB cache",
      ".agents/pm/search/lancedb",
      "key: pm-cli-observability-cache-${{ runner.os }}-node24-${{ hashFiles('pnpm-lock.yaml', '.agents/pm/settings.json', '.agents/pm/**/*.toon', '.agents/pm/**/*.md', 'src/**/*.ts', 'scripts/**/*.mjs', 'tests/**/*.ts') }}",
      "pm-cli-observability-cache-${{ runner.os }}-",
      "name: Upload dist artifact",
      "name: dist-node24-ubuntu",
      "path: dist",
      "if-no-files-found: error",
      PINNED_ACTIONS.downloadArtifact,
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
      "name: Download dist artifact",
      "name: Dist artifact version smoke",
      "run: node dist/cli.js --version",
      "name: Node 22 TypeScript extension loading smoke",
      "if: matrix.os == 'ubuntu-latest' && matrix.node == 22",
      "PM_CLI_PACKAGE_ROOT=\"${temp_root}\"",
      "runtime-loader.ts",
      "node22-ts-runtime",
      "node --input-type=module -e",
      "run: pnpm build",
      "pnpm version:check",
      "pnpm security:scan",
      "pnpm lint",
      "run: pnpm typecheck",
      "pnpm test:coverage --",
      "run: node scripts/release/compatibility-check.mjs --json",
      "npm pack --dry-run",
      "pnpm smoke:npx",
      "pnpm dogfood:package-first",
      PINNED_ACTIONS.uploadArtifact,
      "if: always()",
      "name: coverage-node24-ubuntu-latest",
      "path: coverage",
      "if-no-files-found: ignore",
      "uses: codecov/codecov-action@fb8b3582c8e4def4969c97caa2f19720cb33a72f # v7.0.0",
      "token: ${{ secrets.CODECOV_TOKEN }}",
      "files: ./coverage/lcov.info",
      "name: pm-cli-coverage",
      "override_branch: ${{ github.event_name == 'pull_request' && github.head_ref || github.ref_name }}",
      "override_commit: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
      "report_type: test_results",
      "files: ./coverage/junit.xml",
      "name: pm-cli-test-results",
    ]);
    expectContainsAll(coverageShardsJob, [
      "needs: build-foundation",
      "persist-credentials: false",
      "shard: [1, 2, 3, 4]",
      "--shard=${{ matrix.shard }}/4",
      "--reporter=blob",
      "--outputFile.blob=.vitest-reports/blob-${{ matrix.shard }}.json",
      "--coverage.thresholds.lines=0",
      "--coverage.thresholds.branches=0",
      "--coverage.thresholds.functions=0",
      "--coverage.thresholds.statements=0",
      "name: coverage-blob-${{ matrix.shard }}",
      "if-no-files-found: error",
    ]);
    expectContainsAll(coverageJob, [
      "name: Gates (coverage)",
      "needs: coverage-shards",
      "persist-credentials: false",
      "pattern: coverage-blob-*",
      "merge-multiple: true",
      "path: .vitest-reports",
      "pnpm exec vitest --merge-reports=.vitest-reports --coverage",
      "name: coverage-node24-ubuntu-latest",
      "files: ./coverage/lcov.info",
      "files: ./coverage/junit.xml",
    ]);
    expectContainsAll(runtimeSmokeJob, [
      "name: Runtime smoke (${{ matrix.os }}, Node ${{ matrix.node }})",
      "needs: build-foundation",
      "runs-on: ${{ matrix.os }}",
      "node-version: ${{ matrix.node }}",
      PINNED_ACTIONS.checkout,
      PINNED_ACTIONS.setupNode,
      PINNED_ACTIONS.downloadArtifact,
      "name: Dist artifact version smoke",
      "run: node dist/cli.js --version",
      "name: Node 22 TypeScript extension loading smoke",
      "if: matrix.os == 'ubuntu-latest' && matrix.node == 22",
      "PM_CLI_PACKAGE_ROOT=\"${temp_root}\"",
      "runtime-loader.ts",
      "node22-ts-runtime",
      "node --input-type=module -e",
    ]);
    expect(runtimeSmokeJob).toMatch(
      /matrix:\n\s+include:\n\s+- os: ubuntu-latest\n\s+node: 22\n\s+- os: macos-latest\n\s+node: 24\n\s+- os: ubuntu-latest\n\s+node: 24/,
    );
    expectContainsNone(runtimeSmokeJob, [
      "pnpm/action-setup",
      "cache: pnpm",
      "actions/cache",
      "pnpm install",
      "pnpm test",
      "pnpm dogfood:package-first",
    ]);
    expectContainsAll(windowsRegressionJob, [
      "name: Windows regression (Node 24)",
      "needs: build-foundation",
      "runs-on: windows-latest",
      "node-version: 24",
      PINNED_ACTIONS.checkout,
      PINNED_ACTIONS.pnpmSetup,
      PINNED_PNPM_VERSION,
      PINNED_ACTIONS.setupNode,
      PINNED_ACTIONS.actionsCache,
      "run: pnpm install --frozen-lockfile",
      "run: pnpm build",
      "PM_RUN_TESTS_SKIP_BUILD: \"1\"",
      "run: node scripts/run-tests.mjs test -- tests/unit/cli/cli-main-errors.spec.ts tests/unit/cli/argv-utils.spec.ts tests/unit/core/schema/runtime-schema-path-win32-guard.spec.ts tests/unit/helpers/scriptModule.spec.ts tests/unit/scripts/ tests/unit/packages/runtime-loaders.spec.ts tests/unit/packages/package-manifest.spec.ts tests/unit/core/telemetry/telemetry-runtime.spec.ts tests/unit/commands/init-command.spec.ts tests/integration/init-path-guard.integration.spec.ts tests/unit/commands/test-runs-command.spec.ts tests/unit/core/item/core-item-lock-coverage.spec.ts",
      "run: node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts -t \"installs runtime dependencies for packed npm package extensions\"",
    ]);
    expect(ciWorkflow.match(/PM_RUN_TESTS_SKIP_BUILD: "1"/g)?.length).toBe(3);
    expect(ciWorkflow).not.toMatch(/^\s*run: pnpm test\s*$/m);
    expect(ciWorkflow).not.toContain("Sandboxed PM regression");

    expectContainsNone(ciWorkflow, PUBLISH_OR_RELEASE_PATTERNS);
  });

  it("keeps docs workflow setup pinned and aligned with docs gates", async () => {
    const docsPath = path.resolve(repoRoot, ".github/workflows/docs.yml");
    const docsWorkflow = normalizeWorkflow(await readFile(docsPath, "utf8"));

    expectContainsAll(docsWorkflow, [
      "name: Docs and Skills",
      "permissions:",
      "contents: read",
      "FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: \"true\"",
      "concurrency:",
      "cancel-in-progress: true",
      PINNED_ACTIONS.checkout,
      PINNED_ACTIONS.pnpmSetup,
      PINNED_PNPM_VERSION,
      PINNED_ACTIONS.setupNode,
      "node-version: 24",
      "cache: pnpm",
      "run: pnpm install --frozen-lockfile",
      "run: pnpm build",
      "run: pnpm quality:docs-skills",
      "run: pnpm quality:docs-links",
    ]);

    expectContainsNone(docsWorkflow, PUBLISH_OR_RELEASE_PATTERNS);
  });

  it("keeps nightly regression workflow sandbox-safe and non-publishing", async () => {
    const nightlyPath = path.resolve(repoRoot, ".github/workflows/nightly.yml");
    const nightlyWorkflow = normalizeWorkflow(await readFile(nightlyPath, "utf8"));

    expectContainsAll(nightlyWorkflow, [
      "schedule:",
      "workflow_dispatch:",
      "permissions:",
      "contents: read",
      "issues: write",
      "concurrency:",
      "cancel-in-progress: true",
      "matrix:",
      "{ os: ubuntu-latest, node: 22 }",
      "{ os: ubuntu-latest, node: 24 }",
      "{ os: ubuntu-latest, node: 25 }",
      "{ os: macos-latest, node: 24 }",
      "{ os: windows-latest, node: 24 }",
      PINNED_ACTIONS.checkout,
      PINNED_ACTIONS.pnpmSetup,
      PINNED_PNPM_VERSION,
      PINNED_ACTIONS.setupNode,
      "name: Restore TypeScript and Vitest caches",
      PINNED_ACTIONS.actionsCache,
      ".cache/tsbuildinfo",
      ".cache/vitest",
      "key: pm-cli-validation-cache-${{ runner.os }}-node${{ matrix.node }}-${{ hashFiles('pnpm-lock.yaml', 'tsconfig*.json', 'vitest.config.ts', 'src/**/*.ts', 'tests/**/*.ts', 'packages/**/*.ts') }}",
      "name: Restore LanceDB cache",
      ".agents/pm/search/lancedb",
      "key: pm-cli-observability-cache-${{ runner.os }}-node${{ matrix.node }}-${{ hashFiles('pnpm-lock.yaml', '.agents/pm/settings.json', '.agents/pm/**/*.toon', '.agents/pm/**/*.md', 'src/**/*.ts', 'scripts/**/*.mjs', 'tests/**/*.ts') }}",
      "run: pnpm build",
      "run: pnpm version:check",
      "run: pnpm security:scan",
      "run: pnpm typecheck",
      "if: matrix.os == 'ubuntu-latest' && matrix.node == 24",
      "run: pnpm test:coverage",
      "run: pnpm quality:static",
      "run: node scripts/release/compatibility-check.mjs --json",
      "if: matrix.os != 'ubuntu-latest' || matrix.node != 24",
      "run: pnpm test",
      "name: Alert on scheduled nightly failure",
      "if: failure() && github.event_name == 'schedule'",
      "GH_TOKEN: ${{ github.token }}",
      "NIGHTLY_SHA: ${{ github.sha }}",
      'gh issue list --state open --search "\\"${title}\\" in:title"',
      "gh issue create --title",
      "gh issue comment",
    ]);
    expect(nightlyWorkflow.match(/PM_RUN_TESTS_SKIP_BUILD: "1"/g)?.length).toBe(2);
    expect(nightlyWorkflow).not.toContain("Sandboxed PM regression");

    expectContainsNone(nightlyWorkflow, PUBLISH_OR_RELEASE_PATTERNS);
  });

  it("keeps release workflow aligned with tag-trigger npm publish contract", async () => {
    const releasePath = path.resolve(repoRoot, ".github/workflows/release.yml");
    const releaseWorkflow = normalizeWorkflow(await readFile(releasePath, "utf8"));

    expectContainsAll(releaseWorkflow, [
      "on:",
      "tags:",
      "v*.*.*",
      "workflow_dispatch:",
      "tag:",
      "permissions:",
      "contents: write",
      "concurrency:",
      "cancel-in-progress: false",
      "environment:",
      "name: release",
      "RELEASE_TAG:",
      PINNED_ACTIONS.checkout,
      "ref: ${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref }}",
      PINNED_ACTIONS.pnpmSetup,
      PINNED_PNPM_VERSION,
      PINNED_ACTIONS.setupNode,
      "node-version: 24",
      "name: Restore TypeScript and Vitest caches",
      PINNED_ACTIONS.actionsCache,
      ".cache/tsbuildinfo",
      ".cache/vitest",
      "key: pm-cli-validation-cache-${{ runner.os }}-node24-${{ hashFiles('pnpm-lock.yaml', 'tsconfig*.json', 'vitest.config.ts', 'src/**/*.ts', 'tests/**/*.ts', 'packages/**/*.ts') }}",
      "name: Restore LanceDB cache",
      ".agents/pm/search/lancedb",
      "key: pm-cli-observability-cache-${{ runner.os }}-node24-${{ hashFiles('pnpm-lock.yaml', '.agents/pm/settings.json', '.agents/pm/**/*.toon', '.agents/pm/**/*.md', 'src/**/*.ts', 'scripts/**/*.mjs', 'tests/**/*.ts') }}",
      "node scripts/release-version.mjs check --tag \"${RELEASE_TAG}\"",
      "run: pnpm security:scan",
      "run: pnpm build",
      "run: pnpm typecheck",
      "run: pnpm test:coverage",
      "run: pnpm quality:static",
      "run: pnpm changelog:pm:check",
      "run: node scripts/release/compatibility-check.mjs --json",
      "node scripts/release/sentry-telemetry-gate.mjs --json --telemetry-mode off --sentry-window-days 14 --max-critical 0 --max-high 0",
      "name: Upload Sentry sourcemaps",
      "SENTRY_AUTH_TOKEN",
      "SENTRY_PERSONAL_ADMIN_TOKEN",
      "SENTRY_PERSONAL_ADMIN_TOKEN is required",
      "SENTRY_AUTH_TOKEN is not configured",
      "pnpm sentry:inject",
      "pnpm sentry:upload",
      "run: npm pack --dry-run",
      "run: pnpm smoke:npx",
      "run: pnpm dogfood:package-first",
      "fetch-depth: 0",
      "run: node scripts/generate-release-notes.mjs --version \"${RELEASE_TAG#v}\" --output \"$RUNNER_TEMP/release-notes.md\"",
      "name: release-notes-${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}",
      "path: ${{ runner.temp }}/release-notes.md",
      "body_path: ${{ runner.temp }}/release-notes.md",
      PINNED_ACTIONS.setupBun,
      "NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}",
      "npm publish --access public --provenance",
      "is already published; skipping npm publish.",
      "node scripts/release/verify-published-release.mjs --tag \"${RELEASE_TAG}\" --skip-github-release --json",
      "node scripts/release/verify-published-release.mjs --tag \"${RELEASE_TAG}\" --skip-package --json",
      "uses: softprops/action-gh-release@718ea10b132b3b2eba29c1007bb80653f286566b",
      "tag_name: ${{ env.RELEASE_TAG }}",
      PINNED_ACTIONS.uploadArtifact,
      "path: coverage",
      "if-no-files-found: ignore",
    ]);
    expect(releaseWorkflow.match(/PM_RUN_TESTS_SKIP_BUILD: "1"/g)?.length).toBe(1);
    expect(releaseWorkflow).not.toContain("Sandboxed PM regression");
  });

  it("keeps auto-release workflow aligned with one-production-release-per-day policy", async () => {
    const autoReleasePath = path.resolve(repoRoot, ".github/workflows/auto-release.yml");
    const autoReleaseWorkflow = normalizeWorkflow(await readFile(autoReleasePath, "utf8"));

    expectContainsAll(autoReleaseWorkflow, [
      "schedule:",
      "issues:",
      "types:",
      "- closed",
      "workflow_dispatch:",
      "dry_run",
      "push:",
      "telemetry_mode",
      "permissions:",
      "actions: read",
      "contents: write",
      "issues: write",
      "concurrency:",
      "cancel-in-progress: false",
      'if: "${{ github.event_name != \'issues\' || (github.actor != \'github-actions[bot]\' && github.event.issue.title == \'Auto Release blocked: scheduled run failed\' && github.event.issue.user.login == \'github-actions[bot]\') }}"',
      PINNED_ACTIONS.checkout,
      "persist-credentials: false",
      PINNED_ACTIONS.pnpmSetup,
      PINNED_PNPM_VERSION,
      PINNED_ACTIONS.setupNode,
      "name: Restore TypeScript and Vitest caches",
      PINNED_ACTIONS.actionsCache,
      ".cache/tsbuildinfo",
      ".cache/vitest",
      "key: pm-cli-validation-cache-${{ runner.os }}-node24-${{ hashFiles('pnpm-lock.yaml', 'tsconfig*.json', 'vitest.config.ts', 'src/**/*.ts', 'tests/**/*.ts', 'packages/**/*.ts') }}",
      "name: Restore LanceDB cache",
      ".agents/pm/search/lancedb",
      "key: pm-cli-observability-cache-${{ runner.os }}-node24-${{ hashFiles('pnpm-lock.yaml', '.agents/pm/settings.json', '.agents/pm/**/*.toon', '.agents/pm/**/*.md', 'src/**/*.ts', 'scripts/**/*.mjs', 'tests/**/*.ts') }}",
      "run: pnpm install --frozen-lockfile",
      "--dry-run",
      "--push",
      "RELEASE_PAT_CONFIGURED: ${{ secrets.RELEASE_PAT != '' }}",
      "RELEASE_PUSH_TOKEN: ${{ secrets.RELEASE_PAT || github.token }}",
      '-z "${RELEASE_PUSH_TOKEN//[[:space:]]/}"',
      "RELEASE_PAT is required before Auto Release can push",
      "ISSUE_CREATED_AT: ${{ github.event.issue.created_at || '' }}",
      "ISSUE_NUMBER: ${{ github.event.issue.number || '' }}",
      'current_day="$(date -u +%F)"',
      "Auto Release retry skipped because blocker issue was not created on the current UTC day.",
      "retry_skip_reason=same_day_window_expired",
      "Auto Release retry refused because the blocker issue number was unavailable.",
      "retry_skip_reason=retry_issue_number_unavailable",
      "retry_marker=\"<!-- auto-release-retry-attempted:${current_day} -->\"",
      "trusted_issue_comments=\"$(gh issue view \"${ISSUE_NUMBER}\" --json comments --jq '.comments[] | select(.author.login? == \"github-actions[bot]\") | .body')\"",
      "Could not inspect Auto Release blocker issue #${ISSUE_NUMBER}; refusing untracked production retry.",
      "retry_skip_reason=retry_state_unavailable",
      "Auto Release retry refused because this blocker issue already recorded a current-day retry attempt.",
      "retry_skip_reason=retry_already_attempted",
      "Auto Release retry attempt recorded for ${current_day} UTC.",
      "This marker prevents repeated production retries for the same blocker issue",
      "Could not record Auto Release retry marker on blocker issue #${ISSUE_NUMBER}; refusing untracked production retry.",
      "node scripts/release/run-release-pipeline.mjs",
      "--telemetry-mode",
      "Waiting for tag-push Release workflow for ${NEW_TAG}.",
      "gh run list --workflow Release --event push --branch \"${NEW_TAG}\"",
      "gh run watch \"${RELEASE_RUN_ID}\" --compact --exit-status --interval 30",
      "retry_skip_reason=no_new_pushed_release_tag",
      "id: auto_release",
      "PUBLISHED_SHA=\"$(git rev-list -n 1 \"${NEW_TAG}\")\"",
      "echo \"published_tag=${NEW_TAG}\" >> \"${GITHUB_OUTPUT}\"",
      "echo \"published_sha=${PUBLISHED_SHA}\" >> \"${GITHUB_OUTPUT}\"",
      "name: Resolve blocked scheduled auto-release issue",
      "if: success() && github.event_name == 'schedule' && steps.auto_release.outputs.published_tag",
      "RELEASE_SHA: ${{ steps.auto_release.outputs.published_sha }}",
      "RELEASE_TAG: ${{ steps.auto_release.outputs.published_tag }}",
      "Could not query blocked auto-release issues after successful publish; leaving release status successful.",
      "No open blocked auto-release issue found.",
      "Scheduled Auto Release succeeded and published",
      "Could not close blocked auto-release issue #${existing_issue} after successful publish; leaving release status successful.",
      "gh issue close \"${existing_issue}\" --comment \"${body}\" --reason completed",
      "name: Record resolved-issue auto-release retry success",
      'if: "${{ success() && github.event_name == \'issues\' && steps.auto_release.outputs.published_tag }}"',
      "ISSUE_NUMBER: ${{ github.event.issue.number }}",
      "Auto Release retry after blocker resolution succeeded and published",
      "Could not comment on resolved Auto Release blocker issue #${ISSUE_NUMBER}; leaving retry status successful.",
      "name: Record resolved-issue auto-release retry skip",
      'if: "${{ success() && github.event_name == \'issues\' && !steps.auto_release.outputs.published_tag }}"',
      "RETRY_SKIP_REASON: ${{ steps.auto_release.outputs.retry_skip_reason || 'no_new_pushed_release_tag' }}",
      "Auto Release retry after blocker resolution completed without publishing a new tag.",
      "Retry skip reason: \\`${RETRY_SKIP_REASON}\\`",
      "The retry was skipped because the blocker issue was not created on the current UTC day.",
      "The retry was skipped because the blocker issue number was unavailable in the issue event payload.",
      "The retry was skipped because existing blocker comments could not be inspected safely.",
      "The retry was skipped because this blocker issue already recorded a current-day retry attempt.",
      "The retry completed but found no new pushed release tag",
      "name: Alert on blocked scheduled auto-release",
      'if: "${{ failure() && (github.event_name == \'schedule\' || github.event_name == \'issues\') }}"',
      "GH_TOKEN: ${{ github.token }}",
      "RELEASE_SHA: ${{ github.sha }}",
      "CLOSED_ISSUE_NUMBER: ${{ github.event.issue.number || '' }}",
      "SENTRY_PERSONAL_ADMIN_TOKEN_CONFIGURED: ${{ secrets.SENTRY_PERSONAL_ADMIN_TOKEN != '' }}",
      "Auto Release blocked: scheduled run failed",
      "gh issue view \"${existing_issue}\" --json createdAt --jq '.createdAt // \"\"'",
      "printf -v superseded_body '%s\\n\\nRun: %s\\nCommit: %s\\n\\n%s'",
      "Superseded by a new Auto Release blocker for the current UTC day.",
      "Closing this stale blocker so same-day retry detection uses the most recent scheduled failure date.",
      "gh issue close \"${existing_issue}\" --comment \"${superseded_body}\" || true",
      "The Auto Release retry after blocker resolution failed before publishing, so no release was cut.",
      "The scheduled daily Auto Release run failed before publishing, so no release was cut.",
      "release_path_description=\"the blocker-resolution retry\"",
      "release_path_description=\"the scheduled production release\"",
      "body=\"${failure_intro}",
      "Detected preflight state:",
      "release_pat_configured:",
      "sentry_personal_admin_token_configured:",
      "detected_cause:",
      "RELEASE_PAT is missing from the release environment; ${release_path_description} cannot push the checked version commit/tag to protected main.",
      "Trigger: \\`${GITHUB_EVENT_NAME}\\`",
      "Common causes:",
      'gh issue list --state open --search "\\"${title}\\" in:title"',
      "Could not comment on blocked Auto Release issue #${existing_issue}; continuing blocker state update.",
      "gh issue reopen \"${existing_issue}\"",
      "Could not reopen blocked Auto Release issue #${existing_issue} after retry failure.",
      "gh issue create --title",
      "gh issue comment",
    ]);
    expect(autoReleaseWorkflow).not.toContain("gh workflow run release.yml");
    expect(autoReleaseWorkflow).not.toContain("allow_same_day_release");
    expect(autoReleaseWorkflow).not.toContain("--allow-same-day-release");
    expect(autoReleaseWorkflow).not.toContain("token: ${{ secrets.RELEASE_PAT || github.token }}");
  });

  it("keeps security workflow downloads pinned and hash-verified", async () => {
    const securityPath = path.resolve(repoRoot, ".github/workflows/security.yml");
    const securityWorkflow = normalizeWorkflow(await readFile(securityPath, "utf8"));

    expectContainsAll(securityWorkflow, [
      "name: Security and Script Quality",
      "permissions:",
      "contents: read",
      PINNED_ACTIONS.checkout,
      "persist-credentials: false",
      "scanners: vuln,secret,misconfig",
      "trivyignores: .trivyignore",
      "skip-dirs: node_modules,dist,coverage,.pnpm-store",
      "shellcheck --version",
      "shellcheck --severity=style",
      "$moduleVersion = '1.24.0'",
      "$expectedSha256 = 'e86c97d44bb1bc8a1de35e753b85ea1d938f6f9f881639a181507e079bca4556'",
      "Invoke-WebRequest -Uri \"https://www.powershellgallery.com/api/v2/package/$moduleName/$moduleVersion\" -OutFile $packagePath",
      "Get-FileHash -Path $packagePath -Algorithm SHA256",
      "Expand-Archive -Path $packagePath -DestinationPath $modulePath -Force",
      "Import-Module (Join-Path $modulePath 'PSScriptAnalyzer.psd1') -Force",
      "Invoke-ScriptAnalyzer -Path $_ -Severity @('Error', 'Warning', 'Information')",
      "expected_sha=\"8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8\"",
      "sha256sum --check --strict",
      "./actionlint -color",
    ]);
    expectContainsNone(securityWorkflow, ["Install-Module PSScriptAnalyzer", "Set-PSRepository PSGallery"]);
  });

  it("keeps CodeQL actions SHA-pinned for supply-chain safety (pm-ji5c)", async () => {
    const codeqlPath = path.resolve(repoRoot, ".github/workflows/codeql.yml");
    const codeqlWorkflow = normalizeWorkflow(await readFile(codeqlPath, "utf8"));

    expectContainsAll(codeqlWorkflow, [
      PINNED_ACTIONS.checkout,
      new RegExp(`uses: github/codeql-action/init@${SHA_PATTERN}`),
      new RegExp(`uses: github/codeql-action/analyze@${SHA_PATTERN}`),
    ]);
    // No mutable tag refs (e.g. @v3) may remain — every `uses:` must be a 40-char SHA.
    const unpinnedUses = codeqlWorkflow
      .split("\n")
      .filter((line) => /uses:/.test(line) && !new RegExp(`@${SHA_PATTERN}(\\s|$)`).test(line));
    expect(unpinnedUses, `codeql.yml has unpinned actions: ${unpinnedUses.join(", ")}`).toEqual([]);
  });
});

describe("static-quality-gate directory-load contract (pm-wc0d)", () => {
  it("keeps the per-directory file cap pinned to the gate default", async () => {
    const gateSource = await readFile(path.resolve(repoRoot, "scripts/release/static-quality-gate.mjs"), "utf8");
    // The cap this guardrail asserts must match the gate's own default so the
    // two cannot drift out of sync (e.g. the gate raising it without updating us).
    expect(gateSource).toContain(`parseNumberFlag(flags, "max-files-per-dir", ${MAX_FILES_PER_DIRECTORY})`);
  });

  it("keeps every source/test/package directory at or below the 120-file cap", () => {
    const files = collectTypeScriptFiles();
    const violations = checkDirectoryLoad(files, MAX_FILES_PER_DIRECTORY) as Array<{
      directory: string;
      file_count: number;
    }>;
    expect(
      violations,
      `Directories over the ${MAX_FILES_PER_DIRECTORY}-file cap: ${violations
        .map((entry) => `${entry.directory} (${entry.file_count})`)
        .join(", ")}. Split the directory (e.g. tests/unit/<area>/) rather than adding more files.`,
    ).toEqual([]);

    // Sanity-check the tests/unit subdirectory split that keeps each area under
    // the cap: the historical flat tests/unit/ directory is fully partitioned.
    const counts = new Map<string, number>();
    for (const absolutePath of files) {
      const directory = relativeToRepo(path.dirname(absolutePath));
      counts.set(directory, (counts.get(directory) ?? 0) + 1);
    }
    expect(counts.get("tests/unit") ?? 0).toBe(0);
    expect([...counts.keys()].some((directory) => directory.startsWith("tests/unit/"))).toBe(true);
  });
});
