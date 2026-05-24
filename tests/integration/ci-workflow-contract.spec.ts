import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const PUBLISH_OR_RELEASE_PATTERNS = [
  "npm publish",
  "pnpm publish",
  "semantic-release",
  "changeset publish",
  "gh release",
  "npx changeset publish",
];
const SHA_PATTERN = "[0-9a-f]{40}";
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
  it("keeps CI matrix and quality-gate steps aligned with release requirements", async () => {
    const ciPath = path.resolve(repoRoot, ".github/workflows/ci.yml");
    const ciWorkflow = normalizeWorkflow(await readFile(ciPath, "utf8"));
    const runtimeSmokeJob = extractWorkflowJob(ciWorkflow, "build-test");

    expectContainsAll(ciWorkflow, [
      "on:",
      "push:",
      "pull_request:",
      "paths-ignore:",
      '"docs/**"',
      '"**/*.md"',
      '"CHANGELOG.md"',
      '"CONTRIBUTING.md"',
      '".github/ISSUE_TEMPLATE/**"',
      "permissions:",
      "contents: read",
      "FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: \"true\"",
      "concurrency:",
      "cancel-in-progress: true",
      "build-foundation:",
      "build-test:",
      "gates:",
      "name: Build foundation (Ubuntu, Node 20)",
      "name: Runtime smoke (${{ matrix.os }}, Node ${{ matrix.node }})",
      "name: Gates (${{ matrix.gate }})",
      "needs: build-foundation",
      "gate:",
      "- coverage",
      "- typecheck",
      "- static",
      "- compat",
      "- smokes",
      "if: matrix.gate == 'coverage'",
      "if: matrix.gate == 'typecheck'",
      "if: matrix.gate == 'static'",
      "if: matrix.gate == 'compat'",
      "if: matrix.gate == 'smokes'",
      PINNED_ACTIONS.checkout,
      PINNED_ACTIONS.pnpmSetup,
      PINNED_ACTIONS.setupNode,
      "name: Restore TypeScript and Vitest caches",
      PINNED_ACTIONS.actionsCache,
      ".cache/tsbuildinfo",
      ".cache/vitest",
      "key: pm-cli-validation-cache-${{ runner.os }}-node20-${{ hashFiles('pnpm-lock.yaml', 'tsconfig*.json', 'vitest.config.ts', 'src/**/*.ts', 'tests/**/*.ts', 'packages/**/*.ts') }}",
      "pm-cli-validation-cache-${{ runner.os }}-",
      "name: Restore LanceDB and Sentry caches",
      ".agents/pm/search/lancedb",
      "~/.cache/sentry-cli",
      "key: pm-cli-observability-cache-${{ runner.os }}-node20-${{ hashFiles('pnpm-lock.yaml', '.agents/pm/settings.json', '.agents/pm/**/*.toon', '.agents/pm/**/*.md', 'src/**/*.ts', 'scripts/**/*.mjs', 'tests/**/*.ts') }}",
      "pm-cli-observability-cache-${{ runner.os }}-",
      "name: Upload dist artifact",
      "name: dist-node20-ubuntu",
      "path: dist",
      "if-no-files-found: error",
      PINNED_ACTIONS.downloadArtifact,
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
      "name: Download dist artifact",
      "name: Dist artifact version smoke",
      "run: node dist/cli.js --version",
      "run: pnpm build",
      "pnpm version:check",
      "pnpm security:scan",
      "run: pnpm typecheck",
      "run: pnpm test:coverage",
      "pnpm quality:static",
      "run: node scripts/release/compatibility-check.mjs --json",
      "npm pack --dry-run",
      "pnpm smoke:npx",
      "pnpm dogfood:package-first",
      PINNED_ACTIONS.uploadArtifact,
      "if: always()",
      "name: coverage-node20-ubuntu-latest",
      "path: coverage",
      "if-no-files-found: ignore",
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
    ]);
    expect(runtimeSmokeJob).toMatch(
      /matrix:\n\s+include:\n\s+- os: ubuntu-latest\n\s+node: 20\n\s+- os: macos-latest\n\s+node: 20\n\s+- os: ubuntu-latest\n\s+node: 22\n\s+- os: ubuntu-latest\n\s+node: 24/,
    );
    expectContainsNone(runtimeSmokeJob, [
      "pnpm/action-setup",
      "cache: pnpm",
      "actions/cache",
      "pnpm install",
      "pnpm test",
    ]);
    expect(ciWorkflow.match(/PM_RUN_TESTS_SKIP_BUILD: "1"/g)?.length).toBe(1);
    expect(ciWorkflow).not.toMatch(/^\s*run: pnpm test\s*$/m);
    expect(ciWorkflow).not.toContain("Sandboxed PM regression");

    expectContainsNone(ciWorkflow, PUBLISH_OR_RELEASE_PATTERNS);
  });

  it("keeps nightly regression workflow sandbox-safe and non-publishing", async () => {
    const nightlyPath = path.resolve(repoRoot, ".github/workflows/nightly.yml");
    const nightlyWorkflow = normalizeWorkflow(await readFile(nightlyPath, "utf8"));

    expectContainsAll(nightlyWorkflow, [
      "schedule:",
      "workflow_dispatch:",
      "permissions:",
      "contents: read",
      "concurrency:",
      "cancel-in-progress: true",
      "matrix:",
      "{ os: ubuntu-latest, node: 20 }",
      "{ os: ubuntu-latest, node: 22 }",
      "{ os: ubuntu-latest, node: 24 }",
      "{ os: ubuntu-latest, node: 25 }",
      "{ os: macos-latest, node: 20 }",
      "{ os: windows-latest, node: 20 }",
      PINNED_ACTIONS.checkout,
      PINNED_ACTIONS.pnpmSetup,
      PINNED_ACTIONS.setupNode,
      "name: Restore TypeScript and Vitest caches",
      PINNED_ACTIONS.actionsCache,
      ".cache/tsbuildinfo",
      ".cache/vitest",
      "key: pm-cli-validation-cache-${{ runner.os }}-node${{ matrix.node }}-${{ hashFiles('pnpm-lock.yaml', 'tsconfig*.json', 'vitest.config.ts', 'src/**/*.ts', 'tests/**/*.ts', 'packages/**/*.ts') }}",
      "name: Restore LanceDB and Sentry caches",
      ".agents/pm/search/lancedb",
      "~/.cache/sentry-cli",
      "key: pm-cli-observability-cache-${{ runner.os }}-node${{ matrix.node }}-${{ hashFiles('pnpm-lock.yaml', '.agents/pm/settings.json', '.agents/pm/**/*.toon', '.agents/pm/**/*.md', 'src/**/*.ts', 'scripts/**/*.mjs', 'tests/**/*.ts') }}",
      "run: pnpm build",
      "run: pnpm version:check",
      "run: pnpm security:scan",
      "run: pnpm typecheck",
      "if: matrix.os == 'ubuntu-latest' && matrix.node == 20",
      "run: pnpm test:coverage",
      "run: pnpm quality:static",
      "run: node scripts/release/compatibility-check.mjs --json",
      "if: matrix.os != 'ubuntu-latest' || matrix.node != 20",
      "run: pnpm test",
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
      PINNED_ACTIONS.setupNode,
      "name: Restore TypeScript and Vitest caches",
      PINNED_ACTIONS.actionsCache,
      ".cache/tsbuildinfo",
      ".cache/vitest",
      "key: pm-cli-validation-cache-${{ runner.os }}-node20-${{ hashFiles('pnpm-lock.yaml', 'tsconfig*.json', 'vitest.config.ts', 'src/**/*.ts', 'tests/**/*.ts', 'packages/**/*.ts') }}",
      "name: Restore LanceDB and Sentry caches",
      ".agents/pm/search/lancedb",
      "~/.cache/sentry-cli",
      "key: pm-cli-observability-cache-${{ runner.os }}-node20-${{ hashFiles('pnpm-lock.yaml', '.agents/pm/settings.json', '.agents/pm/**/*.toon', '.agents/pm/**/*.md', 'src/**/*.ts', 'scripts/**/*.mjs', 'tests/**/*.ts') }}",
      "node scripts/release-version.mjs check --tag \"${RELEASE_TAG}\"",
      "run: pnpm security:scan",
      "run: pnpm build",
      "run: pnpm typecheck",
      "run: pnpm test:coverage",
      "run: pnpm quality:static",
      "run: pnpm changelog:pm:check",
      "run: node scripts/release/compatibility-check.mjs --json",
      "node scripts/release/sentry-telemetry-gate.mjs --json --telemetry-mode off --max-critical 10 --max-high 20",
      "name: Upload Sentry sourcemaps",
      "SENTRY_AUTH_TOKEN",
      "SENTRY_PERSONAL_ADMIN_TOKEN",
      "SENTRY_PERSONAL_ADMIN_TOKEN is not configured",
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
      "npm publish --access public --provenance",
      "is already published; skipping npm publish.",
      "NPM_TOKEN",
      "node scripts/release/verify-published-release.mjs --tag \"${RELEASE_TAG}\" --skip-github-release --json",
      "node scripts/release/verify-published-release.mjs --tag \"${RELEASE_TAG}\" --skip-package --json",
      "uses: softprops/action-gh-release@218a0cad87d638dff9a0383acf010108077227f3",
      "tag_name: ${{ env.RELEASE_TAG }}",
      PINNED_ACTIONS.uploadArtifact,
      "path: coverage",
      "if-no-files-found: ignore",
    ]);
    expect(releaseWorkflow.match(/PM_RUN_TESTS_SKIP_BUILD: "1"/g)?.length).toBe(1);
    expect(releaseWorkflow).not.toContain("Sandboxed PM regression");
  });

  it("keeps auto-release workflow aligned with one-per-day and manual override policy", async () => {
    const autoReleasePath = path.resolve(repoRoot, ".github/workflows/auto-release.yml");
    const autoReleaseWorkflow = normalizeWorkflow(await readFile(autoReleasePath, "utf8"));

    expectContainsAll(autoReleaseWorkflow, [
      "schedule:",
      "workflow_dispatch:",
      "allow_same_day_release",
      "dry_run",
      "push:",
      "telemetry_mode",
      "permissions:",
      "actions: write",
      "contents: write",
      "concurrency:",
      "cancel-in-progress: false",
      PINNED_ACTIONS.checkout,
      PINNED_ACTIONS.pnpmSetup,
      PINNED_ACTIONS.setupNode,
      "name: Restore TypeScript and Vitest caches",
      PINNED_ACTIONS.actionsCache,
      ".cache/tsbuildinfo",
      ".cache/vitest",
      "key: pm-cli-validation-cache-${{ runner.os }}-node20-${{ hashFiles('pnpm-lock.yaml', 'tsconfig*.json', 'vitest.config.ts', 'src/**/*.ts', 'tests/**/*.ts', 'packages/**/*.ts') }}",
      "name: Restore LanceDB and Sentry caches",
      ".agents/pm/search/lancedb",
      "~/.cache/sentry-cli",
      "key: pm-cli-observability-cache-${{ runner.os }}-node20-${{ hashFiles('pnpm-lock.yaml', '.agents/pm/settings.json', '.agents/pm/**/*.toon', '.agents/pm/**/*.md', 'src/**/*.ts', 'scripts/**/*.mjs', 'tests/**/*.ts') }}",
      "run: pnpm install --frozen-lockfile",
      "--allow-same-day-release",
      "--dry-run",
      "--push",
      "node scripts/release/run-release-pipeline.mjs",
      "--telemetry-mode",
      "gh workflow run release.yml --ref main -f tag=\"${NEW_TAG}\"",
      "gh run watch \"${RELEASE_RUN_ID}\" --compact --exit-status --interval 30",
    ]);
  });
});
