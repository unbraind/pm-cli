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

function normalizeWorkflow(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

function expectContainsAll(content: string, requiredSnippets: string[]): void {
  for (const snippet of requiredSnippets) {
    expect(content).toContain(snippet);
  }
}

function expectContainsNone(content: string, blockedSnippets: string[]): void {
  for (const snippet of blockedSnippets) {
    expect(content).not.toContain(snippet);
  }
}

describe("GitHub workflow contract", () => {
  it("keeps CI matrix and quality-gate steps aligned with release requirements", async () => {
    const ciPath = path.resolve(repoRoot, ".github/workflows/ci.yml");
    const ciWorkflow = normalizeWorkflow(await readFile(ciPath, "utf8"));

    expectContainsAll(ciWorkflow, [
      "on:",
      "push:",
      "pull_request:",
      "permissions:",
      "contents: read",
      "concurrency:",
      "cancel-in-progress: true",
      "matrix:",
      "include:",
      "- os: ubuntu-latest",
      "- os: macos-latest",
      "- os: windows-latest",
      "node: 20",
      "node: 22",
      "node: 24",
      "run: pnpm build",
      "run: pnpm typecheck",
      "run: pnpm test",
      "if: matrix.os == 'ubuntu-latest' && matrix.node == 20",
      "run: pnpm test:coverage",
      "run: node scripts/run-tests.mjs coverage",
      "run: npm pack --dry-run",
      "uses: actions/upload-artifact@v4",
      "if: always() && matrix.os == 'ubuntu-latest' && matrix.node == 20",
      "name: coverage-node${{ matrix.node }}-${{ matrix.os }}",
      "path: coverage",
      "if-no-files-found: ignore",
    ]);

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
      "- 20",
      "- 22",
      "- 24",
      "- 25",
      "run: pnpm build",
      "run: pnpm typecheck",
      "if: matrix.node == 20",
      "run: pnpm test:coverage",
      "run: node scripts/run-tests.mjs coverage",
      "if: matrix.node != 20",
      "run: pnpm test",
    ]);

    expectContainsNone(nightlyWorkflow, PUBLISH_OR_RELEASE_PATTERNS);
  });

  it("keeps release workflow aligned with tag-trigger npm publish contract", async () => {
    const releasePath = path.resolve(repoRoot, ".github/workflows/release.yml");
    const releaseWorkflow = normalizeWorkflow(await readFile(releasePath, "utf8"));

    expectContainsAll(releaseWorkflow, [
      "on:",
      "tags:",
      "v*.*.*",
      "permissions:",
      "contents: read",
      "concurrency:",
      "cancel-in-progress: false",
      "run: pnpm build",
      "run: pnpm typecheck",
      "run: pnpm test:coverage",
      "run: node scripts/run-tests.mjs coverage",
      "run: npm pack --dry-run",
      "run: npm publish",
      "NPM_TOKEN",
      "uses: actions/upload-artifact@v4",
      "path: coverage",
      "if-no-files-found: ignore",
    ]);
  });
});
