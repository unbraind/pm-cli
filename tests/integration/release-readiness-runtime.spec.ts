import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function readRepoText(relativePath: string): Promise<string> {
  return readFile(path.resolve(repoRoot, relativePath), "utf8");
}

async function listTsFilesRelativeToRepo(relativeDir: string): Promise<string[]> {
  const absoluteDir = path.resolve(repoRoot, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const childRelativePath = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listTsFilesRelativeToRepo(childRelativePath);
      results.push(...nested);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      results.push(childRelativePath);
    }
  }
  return results.sort((left, right) => left.localeCompare(right));
}

function extractCoverageIncludePatterns(vitestConfig: string): string[] {
  const includeSectionMatch = vitestConfig.match(/coverage:\s*\{[\s\S]*?include:\s*\[([\s\S]*?)\][\s\S]*?thresholds:/);
  if (!includeSectionMatch) {
    throw new Error("Missing coverage include section in vitest config.");
  }
  const includeSection = includeSectionMatch[1];
  const patterns = [...includeSection.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  return [...new Set(patterns)];
}

function globPatternToRegExp(glob: string): RegExp {
  const escaped = glob.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`);
  const withDoubleStarSentinel = escaped.replaceAll("**", "__DOUBLE_STAR__");
  const withSingleStar = withDoubleStarSentinel.replaceAll("*", "[^/]*");
  const withDoubleStar = withSingleStar.replaceAll("__DOUBLE_STAR__", ".*");
  return new RegExp(`^${withDoubleStar}$`);
}

function matchesAnyPattern(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globPatternToRegExp(pattern).test(value));
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function expectHelpContainsCommands(helpOutput: string, commands: string[]): void {
  for (const command of commands) {
    const commandRegex = new RegExp(String.raw`\n\s+${escapeRegExp(command)}(?:\s|\[|<)`);
    expect(helpOutput).toMatch(commandRegex);
  }
}

function expectTopLevelKeyOrder(value: unknown, expectedKeys: string[]): void {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Object.keys(value as Record<string, unknown>)).toEqual(expectedKeys);
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const CORE_COMMANDS = [
  "init",
  "config",
  "install",
  "create",
  "list",
  "list-all",
  "list-draft",
  "list-open",
  "list-in-progress",
  "list-blocked",
  "list-closed",
  "list-canceled",
  "search",
  "reindex",
  "get",
  "history",
  "activity",
  "restore",
  "update",
  "close",
  "delete",
  "append",
  "comments",
  "files",
  "docs",
  "test",
  "test-all",
  "stats",
  "health",
  "gc",
  "claim",
  "release",
  "completion",
];

const REQUIRED_CREATE_FLAGS = [
  "--title",
  "--description",
  "--type",
  "--status",
  "--priority",
  "--tags",
  "--body",
  "--deadline",
  "--estimate",
  "--acceptance-criteria",
  "--ac",
  "--author",
  "--message",
  "--assignee",
  "--dep",
  "--comment",
  "--note",
  "--learning",
  "--file",
  "--test",
  "--doc",
];

const REQUIRED_UPDATE_FLAGS = [
  "--title",
  "--description",
  "--status",
  "--priority",
  "--type",
  "--tags",
  "--deadline",
  "--estimate",
  "--acceptance-criteria",
  "--ac",
  "--assignee",
  "--author",
  "--message",
  "--force",
];

const ISSUE_METADATA_CREATE_FLAG_TOKENS = [
  "--reporter",
  "--severity",
  "--environment",
  "--repro-steps",
  "--repro_steps",
  "--resolution",
  "--expected-result",
  "--expected_result",
  "--actual-result",
  "--actual_result",
  "--affected-version",
  "--affected_version",
  "--fixed-version",
  "--fixed_version",
  "--component",
  "--regression",
  "--customer-impact",
  "--customer_impact",
];

const ISSUE_METADATA_UPDATE_FLAG_TOKENS = [...ISSUE_METADATA_CREATE_FLAG_TOKENS];
const REQUIRED_TEST_FLAGS = ["--add", "--remove", "--run", "--timeout", "--author", "--message", "--force"];
const REQUIRED_COMMENTS_FLAGS = ["--add", "--limit", "--author", "--message", "--force"];
const REQUIRED_CLAIM_RELEASE_FLAGS = ["--author", "--message", "--force"];
const REQUIRED_RESTORE_FLAGS = ["--author", "--message", "--force"];
const REQUIRED_CLOSE_FLAGS = ["--author", "--message", "--force"];
const REQUIRED_DELETE_FLAGS = ["--author", "--message", "--force"];
const REQUIRED_APPEND_FLAGS = ["--body", "--author", "--message", "--force"];

describe("release readiness runtime coverage", () => {
  it("shows the expected core commands in top-level help", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["--help"]);
      expect(help.code).toBe(0);
      expectHelpContainsCommands(help.stdout, CORE_COMMANDS);
    });
  });

  it("shows built-in extension subcommands in subcommand help", async () => {
    await withTempPmPath(async (context) => {
      const beadsHelp = context.runCli(["beads", "--help"]);
      expect(beadsHelp.code).toBe(0);
      expectHelpContainsCommands(beadsHelp.stdout, ["import"]);

      const todosHelp = context.runCli(["todos", "--help"]);
      expect(todosHelp.code).toBe(0);
      expectHelpContainsCommands(todosHelp.stdout, ["import", "export"]);
    });
  });

  it("keeps --version output aligned with package metadata", async () => {
    const packageJson = JSON.parse(await readRepoText("package.json")) as { version?: string };
    const expectedVersion = packageJson.version;

    expect(expectedVersion).toBeTypeOf("string");
    const versionPolicyMatch = (expectedVersion as string).match(/^([1-9]\d{3})\.([1-9]\d*)\.([1-9]\d*)(?:-([1-9]\d*))?$/);
    expect(versionPolicyMatch).not.toBeNull();
    if (!versionPolicyMatch) {
      throw new Error("unreachable");
    }

    const year = Number(versionPolicyMatch[1]);
    const month = Number(versionPolicyMatch[2]);
    const day = Number(versionPolicyMatch[3]);
    const releaseOrdinal = versionPolicyMatch[4] ? Number(versionPolicyMatch[4]) : null;
    expect(month).toBeGreaterThanOrEqual(1);
    expect(month).toBeLessThanOrEqual(12);
    expect(day).toBeGreaterThanOrEqual(1);
    expect(day).toBeLessThanOrEqual(31);
    expect(isValidCalendarDate(year, month, day)).toBe(true);
    if (releaseOrdinal !== null) {
      expect(releaseOrdinal).toBeGreaterThanOrEqual(2);
    }

    await withTempPmPath(async (context) => {
      const versionResult = context.runCli(["--version"]);
      expect(versionResult.code).toBe(0);
      expect(versionResult.stdout.trim()).toBe(expectedVersion);
      expect(versionResult.stderr.trim()).toBe("");
    });
  });

  it("keeps --quiet runtime behavior deterministic", async () => {
    await withTempPmPath(async (context) => {
      const successResult = context.runCli(["list-open", "--limit", "1", "--quiet", "--json"]);
      expect(successResult.code).toBe(0);
      expect(successResult.stdout.trim()).toBe("");
      expect(successResult.stderr.trim()).toBe("");

      const usageResult = context.runCli(["create", "--quiet", "--json"]);
      expect(usageResult.code).toBe(2);
      expect(usageResult.stdout.trim()).toBe("");
      expect(usageResult.stderr.trim().length).toBeGreaterThan(0);

      const notFoundResult = context.runCli(["get", "pm-does-not-exist", "--quiet", "--json"]);
      expect(notFoundResult.code).toBe(3);
      expect(notFoundResult.stdout.trim()).toBe("");
      expect(notFoundResult.stderr.toLowerCase()).toContain("not found");
    });
  });

  it("keeps install help aligned with supported install targets and flags", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["install", "--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("Install target: pi");
      expect(help.stdout).toContain("--project");
      expect(help.stdout).toContain("derived from --path");
      expect(help.stdout).toContain("--global");
    });
  });

  it("keeps create help aligned with required flags and aliases", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["create", "--help"]);
      expect(help.code).toBe(0);
      for (const flag of REQUIRED_CREATE_FLAGS) {
        expect(help.stdout).toContain(flag);
      }
      expect(help.stdout).toContain("--estimated-minutes");
      expect(help.stdout).toContain("--estimated_minutes");
      expect(help.stdout).toContain("--acceptance_criteria");
      expect(help.stdout).toContain("--definition-of-ready");
      expect(help.stdout).toContain("--definition_of_ready");
      expect(help.stdout).toContain("--order");
      expect(help.stdout).toContain("--rank");
      expect(help.stdout).toContain("--goal");
      expect(help.stdout).toContain("--objective");
      expect(help.stdout).toContain("--value");
      expect(help.stdout).toContain("--impact");
      expect(help.stdout).toContain("--outcome");
      expect(help.stdout).toContain("--why-now");
      expect(help.stdout).toContain("--why_now");
      expect(help.stdout).toContain("--unblock-note");
      expect(help.stdout).toContain("--unblock_note");
      expect(help.stdout).toContain("low|med|medium|high|critical");
      expect(help.stdout).toContain("--confidence");
      for (const flag of ISSUE_METADATA_CREATE_FLAG_TOKENS) {
        expect(help.stdout).toContain(flag);
      }
      expect(help.stdout).not.toContain("Seed dependency entry (required; use none for empty) (default: [])");
      expect(help.stdout).not.toContain("Seed comment entry (required; use none for empty) (default: [])");
      expect(help.stdout).not.toContain("Seed note entry (required; use none for empty) (default: [])");
      expect(help.stdout).not.toContain("Seed learning entry (required; use none for empty) (default: [])");
      expect(help.stdout).not.toContain("Seed linked file entry (required; use none for empty) (default: [])");
      expect(help.stdout).not.toContain("Seed linked test entry (required; use none for empty) (default: [])");
      expect(help.stdout).not.toContain("Seed linked doc entry (required; use none for empty) (default: [])");
    });
  });

  it("keeps update help aligned with required flags and aliases", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["update", "--help"]);
      expect(help.code).toBe(0);
      for (const flag of REQUIRED_UPDATE_FLAGS) {
        expect(help.stdout).toContain(flag);
      }
      expect(help.stdout).toContain("--estimated-minutes");
      expect(help.stdout).toContain("--estimated_minutes");
      expect(help.stdout).toContain("--acceptance_criteria");
      expect(help.stdout).toContain("--definition-of-ready");
      expect(help.stdout).toContain("--definition_of_ready");
      expect(help.stdout).toContain("--order");
      expect(help.stdout).toContain("--rank");
      expect(help.stdout).toContain("--goal");
      expect(help.stdout).toContain("--objective");
      expect(help.stdout).toContain("--value");
      expect(help.stdout).toContain("--impact");
      expect(help.stdout).toContain("--outcome");
      expect(help.stdout).toContain("--why-now");
      expect(help.stdout).toContain("--why_now");
      expect(help.stdout).toContain("--unblock-note");
      expect(help.stdout).toContain("--unblock_note");
      expect(help.stdout).toContain("low|med|medium|high|critical");
      expect(help.stdout).toContain("--confidence");
      for (const flag of ISSUE_METADATA_UPDATE_FLAG_TOKENS) {
        expect(help.stdout).toContain(flag);
      }
    });
  });

  it("keeps mutation help free of synthetic default-array text", async () => {
    await withTempPmPath(async (context) => {
      const testHelp = context.runCli(["test", "--help"]);
      expect(testHelp.code).toBe(0);
      for (const flag of REQUIRED_TEST_FLAGS) {
        expect(testHelp.stdout).toContain(flag);
      }
      expect(testHelp.stdout).not.toContain("Add linked test entry (default: [])");
      expect(testHelp.stdout).not.toContain("Remove linked test entry by command/path (default: [])");

      const filesHelp = context.runCli(["files", "--help"]);
      expect(filesHelp.code).toBe(0);
      expect(filesHelp.stdout).not.toContain("Add linked file entry (default: [])");
      expect(filesHelp.stdout).not.toContain("Remove linked file by path (default: [])");

      const docsHelp = context.runCli(["docs", "--help"]);
      expect(docsHelp.code).toBe(0);
      expect(docsHelp.stdout).not.toContain("Add linked doc entry (default: [])");
      expect(docsHelp.stdout).not.toContain("Remove linked doc by path (default: [])");

      const commentsHelp = context.runCli(["comments", "--help"]);
      expect(commentsHelp.code).toBe(0);
      for (const flag of REQUIRED_COMMENTS_FLAGS) {
        expect(commentsHelp.stdout).toContain(flag);
      }
      expect(commentsHelp.stdout).not.toContain("Add one comment entry (default: [])");
    });
  });

  it("keeps claim and release help aligned with mutation flags", async () => {
    await withTempPmPath(async (context) => {
      const claimHelp = context.runCli(["claim", "--help"]);
      expect(claimHelp.code).toBe(0);
      for (const flag of REQUIRED_CLAIM_RELEASE_FLAGS) {
        expect(claimHelp.stdout).toContain(flag);
      }

      const releaseHelp = context.runCli(["release", "--help"]);
      expect(releaseHelp.code).toBe(0);
      for (const flag of REQUIRED_CLAIM_RELEASE_FLAGS) {
        expect(releaseHelp.stdout).toContain(flag);
      }
    });
  });

  it("keeps close, delete, append, and restore help aligned with runtime behavior", async () => {
    await withTempPmPath(async (context) => {
      const closeHelp = context.runCli(["close", "--help"]);
      expect(closeHelp.code).toBe(0);
      expect(closeHelp.stdout).toContain("Usage: pm close [options] <id> <text>");
      expect(closeHelp.stdout).toContain("Close an item with a required reason.");
      for (const flag of REQUIRED_CLOSE_FLAGS) {
        expect(closeHelp.stdout).toContain(flag);
      }

      const deleteHelp = context.runCli(["delete", "--help"]);
      expect(deleteHelp.code).toBe(0);
      expect(deleteHelp.stdout).toContain("Usage: pm delete [options] <id>");
      expect(deleteHelp.stdout).toContain("Delete an item and record the change in history.");
      for (const flag of REQUIRED_DELETE_FLAGS) {
        expect(deleteHelp.stdout).toContain(flag);
      }

      const appendHelp = context.runCli(["append", "--help"]);
      expect(appendHelp.code).toBe(0);
      expect(appendHelp.stdout).toContain("Usage: pm append [options] <id>");
      expect(appendHelp.stdout).toContain("Append text to an item's body.");
      for (const flag of REQUIRED_APPEND_FLAGS) {
        expect(appendHelp.stdout).toContain(flag);
      }

      const restoreHelp = context.runCli(["restore", "--help"]);
      expect(restoreHelp.code).toBe(0);
      expect(restoreHelp.stdout).toContain("Usage: pm restore [options] <id> <target>");
      expect(restoreHelp.stdout).toContain("Restore an item to an earlier timestamp or version.");
      for (const flag of REQUIRED_RESTORE_FLAGS) {
        expect(restoreHelp.stdout).toContain(flag);
      }
    });
  });

  it("supports a basic sandboxed pm-data lifecycle", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Runtime lifecycle seed",
          "--description",
          "Validate a basic pm-data lifecycle without relying on prose docs.",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "integration,runtime",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "20",
          "--acceptance-criteria",
          "Lifecycle succeeds in sandboxed pm data.",
          "--author",
          "runtime-test",
          "--message",
          "Create runtime lifecycle seed",
          "--assignee",
          "none",
          "--dep",
          "none",
          "--comment",
          "none",
          "--note",
          "none",
          "--learning",
          "none",
          "--file",
          "none",
          "--test",
          "none",
          "--doc",
          "none",
        ],
        { expectJson: true },
      );
      expect(createResult.code).toBe(0);
      const id = (createResult.json as { item: { id: string } }).item.id;

      const claimResult = context.runCli(["claim", id, "--json", "--author", "runtime-test"], { expectJson: true });
      expect(claimResult.code).toBe(0);

      const updateResult = context.runCli(
        [
          "update",
          id,
          "--json",
          "--status",
          "in_progress",
          "--author",
          "runtime-test",
          "--message",
          "Start runtime lifecycle seed",
        ],
        { expectJson: true },
      );
      expect(updateResult.code).toBe(0);

      const fileResult = context.runCli(
        [
          "files",
          id,
          "--json",
          "--add",
          "path=src/cli/main.ts,scope=project,note=runtime file",
          "--author",
          "runtime-test",
          "--message",
          "Add runtime file link",
        ],
        { expectJson: true },
      );
      expect(fileResult.code).toBe(0);

      const docResult = context.runCli(
        [
          "docs",
          id,
          "--json",
          "--add",
          "path=docs/ARCHITECTURE.md,scope=project,note=reference doc",
          "--author",
          "runtime-test",
          "--message",
          "Add runtime doc link",
        ],
        { expectJson: true },
      );
      expect(docResult.code).toBe(0);

      const commentResult = context.runCli(
        [
          "comments",
          id,
          "--json",
          "--add",
          "runtime lifecycle evidence",
          "--author",
          "runtime-test",
          "--message",
          "Add runtime lifecycle evidence",
        ],
        {
          expectJson: true,
        },
      );
      expect(commentResult.code).toBe(0);

      const closeResult = context.runCli(
        ["close", id, "runtime lifecycle completed", "--json", "--author", "runtime-test", "--message", "Close seed"],
        { expectJson: true },
      );
      expect(closeResult.code).toBe(0);
    });
  });

  it("keeps runtime JSON output object key ordering deterministic", async () => {
    await withTempPmPath(async (context) => {
      const initResult = context.runCli(["init", "--json"], { expectJson: true });
      expect(initResult.code).toBe(0);
      expectTopLevelKeyOrder(initResult.json, ["ok", "path", "settings", "created_dirs", "warnings"]);

      const createResult = context.runCli(
        [
          "create",
          "--title",
          "Output contract sample",
          "--description",
          "Seed item for output-shape validation.",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "2",
          "--tags",
          "pm-cli,area:release,tests",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "0",
          "--acceptance-criteria",
          "JSON output key-order contract remains deterministic.",
          "--author",
          "test-author",
          "--message",
          "seed output contract item",
          "--assignee",
          "none",
          "--dep",
          "none",
          "--comment",
          "none",
          "--note",
          "none",
          "--learning",
          "none",
          "--file",
          "none",
          "--test",
          "none",
          "--doc",
          "none",
          "--json",
        ],
        { expectJson: true },
      );
      expect(createResult.code).toBe(0);
      expectTopLevelKeyOrder(createResult.json, ["item", "changed_fields", "warnings"]);

      const createdId = (createResult.json as { item: { id: string } }).item.id;

      const updateResult = context.runCli(
        ["update", createdId, "--status", "in_progress", "--author", "test-author", "--message", "update", "--json"],
        { expectJson: true },
      );
      expect(updateResult.code).toBe(0);
      expectTopLevelKeyOrder(updateResult.json, ["item", "changed_fields", "warnings"]);

      const claimResult = context.runCli(["claim", createdId, "--author", "test-author", "--message", "claim", "--json"], {
        expectJson: true,
      });
      expect(claimResult.code).toBe(0);
      expectTopLevelKeyOrder(claimResult.json, ["item", "claimed_by", "previous_assignee", "forced"]);

      const releaseResult = context.runCli(
        ["release", createdId, "--author", "test-author", "--message", "release", "--json"],
        { expectJson: true },
      );
      expect(releaseResult.code).toBe(0);
      expectTopLevelKeyOrder(releaseResult.json, ["item", "released_by", "previous_assignee", "forced"]);

      const appendResult = context.runCli(
        ["append", createdId, "--body", "runtime payload", "--author", "test-author", "--message", "append", "--json"],
        { expectJson: true },
      );
      expect(appendResult.code).toBe(0);
      expectTopLevelKeyOrder(appendResult.json, ["item", "appended", "changed_fields"]);

      const commentsResult = context.runCli(["comments", createdId, "--add", "runtime comment", "--json"], {
        expectJson: true,
      });
      expect(commentsResult.code).toBe(0);
      expectTopLevelKeyOrder(commentsResult.json, ["id", "comments", "count"]);

      const filesResult = context.runCli(
        ["files", createdId, "--add", "path=src/cli.ts,scope=project,note=runtime file", "--json"],
        { expectJson: true },
      );
      expect(filesResult.code).toBe(0);
      expectTopLevelKeyOrder(filesResult.json, ["id", "files", "changed", "count"]);

      const docsResult = context.runCli(
        ["docs", createdId, "--add", "path=docs/ARCHITECTURE.md,scope=project,note=reference doc", "--json"],
        { expectJson: true },
      );
      expect(docsResult.code).toBe(0);
      expectTopLevelKeyOrder(docsResult.json, ["id", "docs", "changed", "count"]);

      const testResult = context.runCli(["test", createdId, "--json"], { expectJson: true });
      expect(testResult.code).toBe(0);
      expectTopLevelKeyOrder(testResult.json, ["id", "tests", "run_results", "changed", "count"]);

      const listResult = context.runCli(["list-open", "--limit", "20", "--json"], { expectJson: true });
      expect(listResult.code).toBe(0);
      expectTopLevelKeyOrder(listResult.json, ["items", "count", "filters", "now"]);

      const searchResult = context.runCli(["search", "--mode", "keyword", "--limit", "20", "runtime", "--json"], {
        expectJson: true,
      });
      expect(searchResult.code).toBe(0);
      expectTopLevelKeyOrder(searchResult.json, ["query", "mode", "items", "count", "filters", "now"]);

      const getResult = context.runCli(["get", createdId, "--json"], { expectJson: true });
      expect(getResult.code).toBe(0);
      expectTopLevelKeyOrder(getResult.json, ["item", "body", "linked"]);

      const reindexResult = context.runCli(["reindex", "--mode", "keyword", "--json"], { expectJson: true });
      expect(reindexResult.code).toBe(0);
      expectTopLevelKeyOrder(reindexResult.json, ["ok", "mode", "total_items", "artifacts", "warnings", "generated_at"]);

      const historyResult = context.runCli(["history", createdId, "--limit", "20", "--json"], { expectJson: true });
      expect(historyResult.code).toBe(0);
      expectTopLevelKeyOrder(historyResult.json, ["id", "history", "count", "limit"]);

      const activityResult = context.runCli(["activity", "--limit", "20", "--json"], { expectJson: true });
      expect(activityResult.code).toBe(0);
      expectTopLevelKeyOrder(activityResult.json, ["activity", "count", "limit"]);

      const statsResult = context.runCli(["stats", "--json"], { expectJson: true });
      expect(statsResult.code).toBe(0);
      expectTopLevelKeyOrder(statsResult.json, ["totals", "by_type", "by_status", "generated_at"]);

      const healthResult = context.runCli(["health", "--json"], { expectJson: true });
      expect(healthResult.code).toBe(0);
      expectTopLevelKeyOrder(healthResult.json, ["ok", "checks", "warnings", "generated_at"]);

      const gcResult = context.runCli(["gc", "--json"], { expectJson: true });
      expect(gcResult.code).toBe(0);
      expectTopLevelKeyOrder(gcResult.json, ["ok", "removed", "retained", "warnings", "generated_at"]);

      const testAllResult = context.runCli(["test-all", "--status", "in_progress", "--timeout", "30", "--json"], {
        expectJson: true,
      });
      expect(testAllResult.code).toBe(0);
      expectTopLevelKeyOrder(testAllResult.json, ["totals", "failed", "passed", "skipped", "results"]);

      const restoreResult = context.runCli(
        ["restore", createdId, "1", "--author", "test-author", "--message", "restore", "--json"],
        { expectJson: true },
      );
      expect(restoreResult.code).toBe(0);
      expectTopLevelKeyOrder(restoreResult.json, ["item", "restored_from", "changed_fields", "warnings"]);

      const closeResult = context.runCli(
        ["close", createdId, "close reason", "--author", "test-author", "--message", "close", "--json"],
        { expectJson: true },
      );
      expect(closeResult.code).toBe(0);
      expectTopLevelKeyOrder(closeResult.json, ["item", "changed_fields", "warnings"]);

      const deleteResult = context.runCli(
        ["delete", createdId, "--author", "test-author", "--message", "delete", "--json"],
        { expectJson: true },
      );
      expect(deleteResult.code).toBe(0);
      expectTopLevelKeyOrder(deleteResult.json, ["item", "changed_fields", "warnings"]);
    });
  });

  it("keeps runtime exit-code mapping deterministic", async () => {
    await withTempPmPath(async (context) => {
      const createSeedItem = (options: { title: string; assignee?: string; testEntry?: string; message: string }) =>
        context.runCli(
          [
            "create",
            "--title",
            options.title,
            "--description",
            "Seed item for exit-code coverage.",
            "--type",
            "Task",
            "--status",
            "open",
            "--priority",
            "2",
            "--tags",
            "pm-cli,area:release,tests",
            "--body",
            "",
            "--deadline",
            "none",
            "--estimate",
            "0",
            "--acceptance-criteria",
            "Exit-code behavior remains deterministic.",
            "--author",
            "test-author",
            "--message",
            options.message,
            "--assignee",
            options.assignee ?? "none",
            "--dep",
            "none",
            "--comment",
            "none",
            "--note",
            "none",
            "--learning",
            "none",
            "--file",
            "none",
            "--test",
            options.testEntry ?? "none",
            "--doc",
            "none",
            "--json",
          ],
          { expectJson: true },
        );

      const successResult = context.runCli(["list-open", "--limit", "1", "--json"], { expectJson: true });
      expect(successResult.code).toBe(0);

      const genericFailureResult = context.runCli([
        "beads",
        "import",
        "--file",
        path.join(context.tempRoot, "missing-beads.jsonl"),
      ]);
      expect(genericFailureResult.code).toBe(1);

      const usageResult = context.runCli(["create", "--json"]);
      expect(usageResult.code).toBe(2);

      const notFoundResult = context.runCli(["get", "pm-does-not-exist", "--json"]);
      expect(notFoundResult.code).toBe(3);

      const conflictSeed = createSeedItem({
        title: "Exit code conflict seed",
        assignee: "other-author",
        message: "seed conflict code path",
      });
      expect(conflictSeed.code).toBe(0);
      const conflictSeedId = (conflictSeed.json as { item: { id: string } }).item.id;
      const conflictResult = context.runCli(["update", conflictSeedId, "--status", "in_progress", "--json"]);
      expect(conflictResult.code).toBe(4);

      const dependencySeed = createSeedItem({
        title: "Exit code dependency failure seed",
        message: "seed dependency-failed code path",
        testEntry: 'command=node -e "process.exit(1)",scope=project,timeout_seconds=5,note=exit-code-fail-signal',
      });
      expect(dependencySeed.code).toBe(0);
      const dependencyFailedResult = context.runCli(["test-all", "--status", "open", "--timeout", "5", "--json"]);
      expect(dependencyFailedResult.code).toBe(5);
    });
  });

  it("keeps update-close workflow behavior deterministic", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--title",
          "Update close workflow seed",
          "--description",
          "Seed item for update/close workflow validation.",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "2",
          "--tags",
          "pm-cli,area:release,tests",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "0",
          "--acceptance-criteria",
          "close workflow remains deterministic.",
          "--author",
          "test-author",
          "--message",
          "seed close workflow runtime",
          "--assignee",
          "none",
          "--dep",
          "none",
          "--comment",
          "none",
          "--note",
          "none",
          "--learning",
          "none",
          "--file",
          "none",
          "--test",
          "none",
          "--doc",
          "none",
          "--json",
        ],
        { expectJson: true },
      );
      expect(createResult.code).toBe(0);
      const createdId = (createResult.json as { item: { id: string } }).item.id;

      const invalidUpdateCloseResult = context.runCli(["update", createdId, "--status", "closed", "--json"]);
      expect(invalidUpdateCloseResult.code).toBe(2);
      expect(invalidUpdateCloseResult.stderr).toContain('Use "pm close <ID> <TEXT>"');

      const closeResult = context.runCli(
        ["close", createdId, "close workflow reason", "--author", "test-author", "--message", "close workflow", "--json"],
        { expectJson: true },
      );
      expect(closeResult.code).toBe(0);
    });
  });

  it("keeps npm packaging allowlist and prepublish guard aligned", async () => {
    const packageJson = JSON.parse(await readRepoText("package.json")) as {
      name?: string;
      files?: string[];
      scripts?: Record<string, string | undefined>;
      repository?: { type?: string; url?: string };
      bugs?: { url?: string };
      homepage?: string;
      author?: string;
      publishConfig?: { access?: string };
    };

    const requiredPublishFiles = [
      "dist/**",
      "README.md",
      "LICENSE",
      "docs/**",
      ".pi/extensions/pm-cli/index.ts",
      "scripts/install.sh",
      "scripts/install.ps1",
    ];

    expect(packageJson.files).toBeDefined();
    for (const requiredPath of requiredPublishFiles) {
      expect(packageJson.files).toContain(requiredPath);
    }

    expect(packageJson.scripts?.prepublishOnly).toBe("pnpm build");
    expect(packageJson.scripts?.["version:check"]).toBe("node scripts/release-version.mjs check");
    expect(packageJson.scripts?.["version:next"]).toBe("node scripts/release-version.mjs next");
    expect(packageJson.scripts?.["security:scan"]).toBe("node scripts/check-secrets.mjs");
    expect(packageJson.scripts?.["smoke:npx"]).toBe("node scripts/smoke-npx-from-pack.mjs");
    expect(packageJson.name).toBe("@unbrained/pm-cli");
    expect(packageJson.publishConfig?.access).toBe("public");
    expect(packageJson.repository?.type).toBe("git");
    expect(packageJson.repository?.url).toContain("github.com");
    expect(packageJson.bugs?.url).toContain("github.com");
    expect(typeof packageJson.homepage).toBe("string");
    expect(typeof packageJson.author).toBe("string");
  });

  it("keeps 100% coverage gate wiring aligned in config and scripts", async () => {
    const vitestConfig = await readRepoText("vitest.config.ts");
    const packageJson = JSON.parse(await readRepoText("package.json")) as {
      scripts?: Record<string, string | undefined>;
    };

    for (const token of ["lines: 100", "branches: 100", "functions: 100", "statements: 100"]) {
      expect(vitestConfig).toContain(token);
    }
    expect(packageJson.scripts?.["test:coverage"]).toContain("vitest run --coverage");
  });

  it("keeps vitest coverage include list aligned with src ts modules", async () => {
    const vitestConfig = await readRepoText("vitest.config.ts");
    const includePatterns = extractCoverageIncludePatterns(vitestConfig);
    const sourceFiles = await listTsFilesRelativeToRepo("src");
    const uncoveredFiles = sourceFiles.filter((filePath) => !matchesAnyPattern(filePath, includePatterns));
    expect(uncoveredFiles.sort((left, right) => left.localeCompare(right))).toEqual(["src/cli.ts", "src/cli/main.ts"]);
  });

  it("keeps release governance docs present with expected baseline markers", async () => {
    const requiredDocs = [
      { path: "LICENSE", marker: "MIT License" },
      { path: "CHANGELOG.md", marker: "## [Unreleased]" },
      { path: "CONTRIBUTING.md", marker: "node scripts/run-tests.mjs coverage" },
      { path: "SECURITY.md", marker: "## Reporting a Vulnerability" },
      { path: "CODE_OF_CONDUCT.md", marker: "## Our Standards" },
    ];

    for (const doc of requiredDocs) {
      const absolutePath = path.resolve(repoRoot, doc.path);
      await access(absolutePath);
      const content = await readFile(absolutePath, "utf8");
      expect(content.trim().length).toBeGreaterThan(0);
      expect(content).toContain(doc.marker);
    }
  });

  it("keeps release-hardening scaffolding paths present", async () => {
    const requiredPaths = [
      "src/cli/main.ts",
      "src/core/store/index.ts",
      "src/types/index.ts",
      "tests/helpers/withTempPmPath.ts",
      "scripts/run-tests.mjs",
      "scripts/install.sh",
      "scripts/install.ps1",
      "scripts/release-version.mjs",
      "scripts/check-secrets.mjs",
      "scripts/smoke-npx-from-pack.mjs",
    ];

    for (const requiredPath of requiredPaths) {
      await access(path.resolve(repoRoot, requiredPath));
    }

    const testHarness = await readRepoText("tests/helpers/withTempPmPath.ts");
    expect(testHarness).toContain("PM_PATH");
    expect(testHarness).toContain("PM_GLOBAL_PATH");
    expect(testHarness).toContain("PM_AUTHOR");

    const sandboxRunner = await readRepoText("scripts/run-tests.mjs");
    expect(sandboxRunner).toContain("mkdtemp");
    expect(sandboxRunner).toContain("PM_PATH");
    expect(sandboxRunner).toContain("PM_GLOBAL_PATH");

    const installSh = await readRepoText("scripts/install.sh");
    expect(installSh).toContain("PM_BIN");
    expect(installSh).toContain("$PM_BIN --version");
    expect(installSh).toContain("Installed pm version:");
    expect(installSh).toContain("@unbrained/pm-cli");
    expect(installSh).toContain("--force");

    const installPs1 = await readRepoText("scripts/install.ps1");
    expect(installPs1).toContain("$pmExecutable --version");
    expect(installPs1).toContain("Installed pm version:");
    expect(installPs1).toContain('@unbrained/pm-cli');
    expect(installPs1).toContain('"--force"');

    const releaseVersionScript = await readRepoText("scripts/release-version.mjs");
    expect(releaseVersionScript).toContain("YYYY.M.D");
    expect(releaseVersionScript).toContain("verify-next");

    const securityScanScript = await readRepoText("scripts/check-secrets.mjs");
    expect(securityScanScript).toContain("No credential-like secrets detected");

    const npxSmokeScript = await readRepoText("scripts/smoke-npx-from-pack.mjs");
    expect(npxSmokeScript).toContain("npx");
    expect(npxSmokeScript).toContain("npm pack");
  });
});
