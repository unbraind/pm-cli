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
  return results.sort((a, b) => a.localeCompare(b));
}

async function listMarkdownFilesRelativeToRepo(relativeDir: string): Promise<string[]> {
  const absoluteDir = path.resolve(repoRoot, relativeDir);
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  const results: string[] = [];
  for (const entry of entries) {
    const childRelativePath = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listMarkdownFilesRelativeToRepo(childRelativePath);
      results.push(...nested);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(childRelativePath);
    }
  }

  return results.sort((a, b) => a.localeCompare(b));
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

function extractSection(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`Missing section start marker: ${startMarker}`);
  }

  const tail = source.slice(start + startMarker.length);
  const end = tail.indexOf(endMarker);
  if (end < 0) {
    throw new Error(`Missing section end marker: ${endMarker}`);
  }

  return tail.slice(0, end);
}

function extractBacktickPmCommands(section: string): string[] {
  const commands = [...section.matchAll(/`pm ([a-z-]+)/g)].map((match) => match[1]);
  return [...new Set(commands)];
}

function extractDocumentedExtensionSubcommands(section: string, command: "beads" | "todos"): string[] {
  const pattern = new RegExp("`pm " + escapeRegExp(command) + " ([a-z-]+)(?:\\s[^`]*)?`", "g");
  const subcommands = [...section.matchAll(pattern)].map((match) => match[1]);
  return [...new Set(subcommands)];
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

function expectHelpOmitsCommands(helpOutput: string, commands: string[]): void {
  for (const command of commands) {
    const commandRegex = new RegExp(String.raw`\n\s+${escapeRegExp(command)}(?:\s|\[|<)`);
    expect(helpOutput).not.toMatch(commandRegex);
  }
}

function extractBacktickCommands(section: string): string[] {
  const commands = [...section.matchAll(/`([a-z-]+)`/g)].map((match) => match[1]);
  return [...new Set(commands)];
}

function extractBacktickFlags(section: string): string[] {
  const flags = [...section.matchAll(/`(--[a-z-]+)/g)].map((match) => match[1]);
  return [...new Set(flags)];
}

function expectSectionContainsTokens(section: string, tokens: string[]): void {
  for (const token of tokens) {
    expect(section).toContain(token);
  }
}

function expectTopLevelKeyOrder(value: unknown, expectedKeys: string[]): void {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Object.keys(value as Record<string, unknown>)).toEqual(expectedKeys);
}

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
const REQUIRED_TEST_FLAGS = [
  "--add",
  "--remove",
  "--run",
  "--timeout",
  "--author",
  "--message",
  "--force",
];
const REQUIRED_COMMENTS_FLAGS = ["--add", "--limit", "--author", "--message", "--force"];

const REQUIRED_CLAIM_RELEASE_FLAGS = ["--author", "--message", "--force"];
const REQUIRED_RESTORE_FLAGS = ["--author", "--message", "--force"];
const REQUIRED_CLOSE_FLAGS = ["--author", "--message", "--force"];
const REQUIRED_DELETE_FLAGS = ["--author", "--message", "--force"];
const REQUIRED_APPEND_FLAGS = ["--body", "--author", "--message", "--force"];
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
const ISSUE_METADATA_UPDATE_FLAG_TOKENS = [
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
const REQUIRED_PI_CREATE_EXAMPLE_KEYS = [
  "action",
  "title",
  "description",
  "type",
  "status",
  "priority",
  "tags",
  "body",
  "deadline",
  "estimate",
  "acceptanceCriteria",
  "author",
  "message",
  "assignee",
  "parent",
  "reviewer",
  "risk",
  "confidence",
  "sprint",
  "release",
  "blockedBy",
  "blockedReason",
  "unblockNote",
  "reporter",
  "severity",
  "environment",
  "reproSteps",
  "resolution",
  "expectedResult",
  "actualResult",
  "affectedVersion",
  "fixedVersion",
  "component",
  "regression",
  "customerImpact",
  "definitionOfReady",
  "order",
  "goal",
  "objective",
  "value",
  "impact",
  "outcome",
  "whyNow",
  "dep",
  "comment",
  "note",
  "learning",
  "linkedFile",
  "linkedTest",
  "doc",
];
const README_QUICKSTART_REQUIRED_SEED_TOKENS = [
  "--deadline +1d",
  '--dep "none"',
  '--comment "author=steve,created_at=now,text=Seed restore workflow"',
  '--note "author=steve,created_at=now,text=Implement replay and hash verification"',
  '--learning "none"',
  '--file "path=src/core/history/store.ts,scope=project,note=restore logic target"',
  '--test "command=node scripts/run-tests.mjs test,scope=project,timeout_seconds=240,note=sandbox-safe regression"',
  '--doc "path=PRD.md,scope=project,note=authoritative contract"',
];
const README_QUICKSTART_DISALLOWED_PLACEHOLDERS = [
  "--deadline <DEADLINE>",
  "--dep <DEP>",
  "--comment <COMMENT>",
  "--note <NOTE>",
  "--learning <LEARNINGS>",
  "--file <FILES>",
  "--test <TESTS>",
  "--doc <DOCS>",
];
const CLOSED_STATUS_UPDATE_DISALLOWED_TOKENS = ["pm update pm-a1b2 --status closed", "pm update <ID> --status closed"];
const LEGACY_PROMPT_DOCS_DIR = "docs/prompts";
const LEGACY_PROMPT_DISALLOWED_TOKENS = [
  "pm create --title|-t <T> [--tags ...] [--status|-s ...] [--body|-b ...]",
  "pm update <ID> [--title|-t ...] [--tags ...] [--status|-s ...] [--body|-b ...]",
  "pm activity [--limit|-l ...] [--follow]",
  "--depends-on / --blocks / --parent / --child / --related / --discovered-from",
];
const PLANNED_NOT_YET_CANONICAL_FLAGS = [
  "--evidence",
  "--decision",
  "--verified-by",
  "--verified-at",
  "--relates-to",
  "--duplicates",
  "--caused-by",
  "--split-from",
  "--child-of",
  "--implements",
  "--fixes",
  "--regressed-by",
];

describe("release readiness baseline contract", () => {
  it("keeps PRD core and roadmap command lists aligned with CLI help", async () => {
    const prd = await readRepoText("PRD.md");
    const coreSection = extractSection(
      prd,
      "### 11.3 Core commands (required for v0.1 release-ready scope)",
      "Roadmap commands (post-v0.1, tracked but not release blockers):",
    );
    const roadmapSection = extractSection(
      prd,
      "Roadmap commands (post-v0.1, tracked but not release blockers):",
      "### 11.4 Extended flags (minimum)",
    );

    const documentedCoreCommands = extractBacktickPmCommands(coreSection);
    const documentedRoadmapCommands = extractBacktickPmCommands(roadmapSection);

    expect(documentedCoreCommands.length).toBeGreaterThan(0);

    await withTempPmPath(async (context) => {
      const help = context.runCli(["--help"]);
      expect(help.code).toBe(0);
      expectHelpContainsCommands(help.stdout, documentedCoreCommands);
      expectHelpOmitsCommands(help.stdout, documentedRoadmapCommands);
    });
  });

  it("keeps README core and roadmap command lists aligned with CLI help", async () => {
    const readme = await readRepoText("README.md");
    const coreSection = extractSection(
      readme,
      "### Core (implemented in v0.1)",
      "### Roadmap (post-v0.1 / partial areas)",
    );
    const roadmapSection = extractSection(
      readme,
      "### Roadmap (post-v0.1 / partial areas)",
      "### Global flags",
    );

    const documentedCoreCommands = extractBacktickPmCommands(coreSection);
    const documentedRoadmapCommands = extractBacktickPmCommands(roadmapSection);

    expect(documentedCoreCommands.length).toBeGreaterThan(0);

    await withTempPmPath(async (context) => {
      const help = context.runCli(["--help"]);
      expect(help.code).toBe(0);
      expectHelpContainsCommands(help.stdout, documentedCoreCommands);
      expectHelpOmitsCommands(help.stdout, documentedRoadmapCommands);
    });
  });

  it("keeps documented extension subcommands aligned across docs and CLI subcommand help", async () => {
    const prd = await readRepoText("PRD.md");
    const readme = await readRepoText("README.md");
    const prdCoreSection = extractSection(
      prd,
      "### 11.3 Core commands (required for v0.1 release-ready scope)",
      "Roadmap commands (post-v0.1, tracked but not release blockers):",
    );
    const readmeCoreSection = extractSection(
      readme,
      "### Core (implemented in v0.1)",
      "### Roadmap (post-v0.1 / partial areas)",
    );

    const prdBeadsSubcommands = extractDocumentedExtensionSubcommands(prdCoreSection, "beads").sort((a, b) =>
      a.localeCompare(b),
    );
    const prdTodosSubcommands = extractDocumentedExtensionSubcommands(prdCoreSection, "todos").sort((a, b) =>
      a.localeCompare(b),
    );
    const readmeBeadsSubcommands = extractDocumentedExtensionSubcommands(readmeCoreSection, "beads").sort((a, b) =>
      a.localeCompare(b),
    );
    const readmeTodosSubcommands = extractDocumentedExtensionSubcommands(readmeCoreSection, "todos").sort((a, b) =>
      a.localeCompare(b),
    );

    expect(prdBeadsSubcommands).toEqual(["import"]);
    expect(prdTodosSubcommands).toEqual(["export", "import"]);
    expect(readmeBeadsSubcommands).toEqual(["import"]);
    expect(readmeTodosSubcommands).toEqual(["export", "import"]);
    expect(prdBeadsSubcommands).toEqual(readmeBeadsSubcommands);
    expect(prdTodosSubcommands).toEqual(readmeTodosSubcommands);

    await withTempPmPath(async (context) => {
      const beadsHelp = context.runCli(["beads", "--help"]);
      expect(beadsHelp.code).toBe(0);
      expectHelpContainsCommands(beadsHelp.stdout, prdBeadsSubcommands);

      const todosHelp = context.runCli(["todos", "--help"]);
      expect(todosHelp.code).toBe(0);
      expectHelpContainsCommands(todosHelp.stdout, prdTodosSubcommands);
    });
  });

  it("keeps AGENTS required dogfood command subset aligned with CLI help", async () => {
    const agents = await readRepoText("AGENTS.md");
    const requiredSubsetSection = extractSection(
      agents,
      "Until full command coverage exists, prioritize implementing the minimal missing subset needed for logging:",
      "### All-Flags Create Template (copy/paste)",
    );

    const requiredCommands = extractBacktickCommands(requiredSubsetSection);
    expect(requiredCommands.length).toBeGreaterThan(0);

    await withTempPmPath(async (context) => {
      const help = context.runCli(["--help"]);
      expect(help.code).toBe(0);
      expectHelpContainsCommands(help.stdout, requiredCommands);
    });
  });

  it("keeps AGENTS session bootstrap guidance aligned with repo-local dogfooding rules", async () => {
    const agents = await readRepoText("AGENTS.md");
    const bootstrapSection = extractSection(
      agents,
      "### 1.1) Session Bootstrap (Required)",
      "## 2) Canonical Agent Workflow",
    );

    expectSectionContainsTokens(bootstrapSection, [
      'PM_CMD="pm"',
      'PM_CMD="node dist/cli.js"',
      "PM_AUTHOR",
      "npm install -g .",
      "pm --version",
      "PM_PATH",
      "PM_GLOBAL_PATH",
      "node scripts/run-tests.mjs",
    ]);
  });

  it("keeps CONTRIBUTING maintainer bootstrap guidance aligned with global-install dogfooding rules", async () => {
    const contributing = await readRepoText("CONTRIBUTING.md");
    const bootstrapSection = extractSection(contributing, "## Maintainer Bootstrap (Dogfooding Runs)", "## Development Workflow");

    expectSectionContainsTokens(bootstrapSection, [
      "PM_AUTHOR",
      "npm install -g .",
      "pm --version",
      'PM_CMD="pm"',
      'PM_CMD="node dist/cli.js"',
      "PM_PATH",
      "PM_GLOBAL_PATH",
      "node scripts/run-tests.mjs",
    ]);
  });

  it("keeps README maintainer bootstrap guidance aligned with AGENTS dogfooding rules", async () => {
    const readme = await readRepoText("README.md");
    const bootstrapSection = extractSection(readme, "## Maintainer Bootstrap (Dogfooding Runs)", "## Quickstart");

    expectSectionContainsTokens(bootstrapSection, [
      "PM_AUTHOR",
      "npm install -g .",
      "pm --version",
      'PM_CMD="pm"',
      'PM_CMD="node dist/cli.js"',
      "PM_PATH",
      "PM_GLOBAL_PATH",
      "node scripts/run-tests.mjs",
    ]);
  });

  it("keeps PRD and README global flags aligned with CLI help", async () => {
    const prd = await readRepoText("PRD.md");
    const readme = await readRepoText("README.md");
    const prdFlagsSection = extractSection(prd, "### 11.1 Global flags (all commands)", "### 11.2 Exit codes");
    const readmeFlagsSection = extractSection(readme, "### Global flags", "### `pm create` explicit-field contract");

    const prdFlags = extractBacktickFlags(prdFlagsSection).sort((a, b) => a.localeCompare(b));
    const readmeFlags = extractBacktickFlags(readmeFlagsSection).sort((a, b) => a.localeCompare(b));

    expect(prdFlags.length).toBeGreaterThan(0);
    expect(readmeFlags.length).toBeGreaterThan(0);
    expect(prdFlags).toEqual(readmeFlags);

    await withTempPmPath(async (context) => {
      const help = context.runCli(["--help"]);
      expect(help.code).toBe(0);
      for (const flag of prdFlags) {
        expect(help.stdout).toContain(flag);
      }
    });
  });

  it("keeps --version output aligned with package metadata", async () => {
    const packageJson = JSON.parse(await readRepoText("package.json")) as {
      version?: string;
    };
    const expectedVersion = packageJson.version;

    expect(expectedVersion).toBeTypeOf("string");
    expect(expectedVersion).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

    await withTempPmPath(async (context) => {
      const versionResult = context.runCli(["--version"]);
      expect(versionResult.code).toBe(0);
      expect(versionResult.stdout.trim()).toBe(expectedVersion);
      expect(versionResult.stderr.trim()).toBe("");
    });
  });

  it("keeps --quiet runtime behavior aligned with PRD and README semantics", async () => {
    const prd = await readRepoText("PRD.md");
    const readme = await readRepoText("README.md");

    expect(prd).toContain("- `--quiet` suppress stdout");
    expect(prd).toContain("- `--quiet` prints nothing to stdout but still uses exit codes.");
    expect(readme).toContain("- `--quiet` suppress stdout (errors still on stderr)");

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

  it("keeps AGENTS all-fields create template aligned with required explicit flags", async () => {
    const agents = await readRepoText("AGENTS.md");
    const allFlagsTemplateSection = extractSection(
      agents,
      "### All-Flags Create Template (copy/paste)",
      "### Epic Template With Comment + Note",
    );

    expectSectionContainsTokens(allFlagsTemplateSection, ["pm create", ...REQUIRED_CREATE_FLAGS, "--confidence"]);
  });

  it("keeps README quickstart create example aligned with explicit seed-field contract", async () => {
    const readme = await readRepoText("README.md");
    const quickstartSection = extractSection(readme, "## Quickstart", "## Storage Layout");

    expectSectionContainsTokens(quickstartSection, [
      "pm create",
      ...REQUIRED_CREATE_FLAGS,
      ...README_QUICKSTART_REQUIRED_SEED_TOKENS,
    ]);
    for (const placeholderToken of README_QUICKSTART_DISALLOWED_PLACEHOLDERS) {
      expect(quickstartSection).not.toContain(placeholderToken);
    }
  });

  it("keeps AGENTS Pi wrapper create example aligned with explicit create payload shape", async () => {
    const agents = await readRepoText("AGENTS.md");
    const piCreateExampleSection = extractSection(agents, "### Example: create item", "### Example: append body update");
    const jsonBlockMatch = piCreateExampleSection.match(/```json\s*([\s\S]*?)```/);

    expect(jsonBlockMatch).not.toBeNull();
    const payload = JSON.parse((jsonBlockMatch?.[1] ?? "").trim()) as Record<string, unknown>;

    for (const key of REQUIRED_PI_CREATE_EXAMPLE_KEYS) {
      expect(payload).toHaveProperty(key);
    }

    expect(payload.action).toBe("create");
    expect(typeof payload.tags).toBe("string");

    const requiredRepeatableKeys = ["dep", "comment", "note", "learning", "linkedFile", "linkedTest", "doc"] as const;
    for (const key of requiredRepeatableKeys) {
      const value = payload[key];
      expect(Array.isArray(value)).toBe(true);
      expect((value as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it("keeps legacy prompt docs aligned with explicit create and close workflow contracts when present", async () => {
    const legacyPromptDocPaths = await listMarkdownFilesRelativeToRepo(LEGACY_PROMPT_DOCS_DIR);
    if (legacyPromptDocPaths.length === 0) {
      return;
    }

    for (const relativePath of legacyPromptDocPaths) {
      const promptDoc = await readRepoText(relativePath);
      expectSectionContainsTokens(promptDoc, REQUIRED_CREATE_FLAGS);
      expect(promptDoc).toContain("pm close <ID> <TEXT>");
      for (const forbiddenToken of LEGACY_PROMPT_DISALLOWED_TOKENS) {
        expect(promptDoc).not.toContain(forbiddenToken);
      }
    }
  });

  it("keeps imported hierarchical ID preservation explicit in PRD and README todos docs", async () => {
    const prd = await readRepoText("PRD.md");
    const readme = await readRepoText("README.md");
    const prdTodosSection = extractSection(prd, "### B) todos.ts import/export", "## 16) Security and Data Integrity");

    expect(prdTodosSection).toContain("hierarchical suffixes such as `pm-legacy.1.2`");
    expect(prdTodosSection).toContain("preserved verbatim");
    expect(readme).toContain("preserves explicit imported IDs verbatim including hierarchical suffixes such as `pm-legacy.1.2`");
  });

  it("keeps Pi wrapper packaging polish documented as implemented", async () => {
    const prd = await readRepoText("PRD.md");
    const readme = await readRepoText("README.md");
    const agents = await readRepoText("AGENTS.md");

    expect(prd).toContain("packaged CLI fallback, and distribution packaging polish implemented");
    expect(prd).toContain("`completion`");
    expect(prd).not.toContain("distribution packaging polish is post-v0.1 roadmap");
    expect(readme).toContain("For packaging resilience (implemented), the wrapper attempts `pm` first");
    expect(readme).toContain("action=completion");
    expect(agents).toContain("action: \"completion\"");
  });

  it("keeps pm install pi command contract aligned across docs and CLI help", async () => {
    const prd = await readRepoText("PRD.md");
    const readme = await readRepoText("README.md");
    const agents = await readRepoText("AGENTS.md");

    expect(prd).toContain("`pm install pi [--project|--global]`");
    expect(readme).toContain("`pm install pi [--project|--global]`");
    expect(agents).toContain("pm install pi --project");

    await withTempPmPath(async (context) => {
      const help = context.runCli(["install", "--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("Install target: pi");
      expect(help.stdout).toContain("--project");
      expect(help.stdout).toContain("--global");
    });
  });

  it("keeps pm create help aligned with required explicit create flags", async () => {
    const prd = await readRepoText("PRD.md");
    const readme = await readRepoText("README.md");
    const prdCreateSection = extractSection(
      prd,
      "Mutating `create` (all schema fields MUST be passable explicitly):",
      "Mutating `update` (v0.1 baseline):",
    );
    const readmeCreateSection = extractSection(
      readme,
      "### `pm create` explicit-field contract",
      "### `pm update` explicit-field contract",
    );
    expect(prdCreateSection).toContain("--estimated_minutes");
    expect(prdCreateSection).toContain("--acceptance_criteria");
    expect(prdCreateSection).toContain("--definition-of-ready");
    expect(prdCreateSection).toContain("--definition_of_ready");
    expect(prdCreateSection).toContain("--order");
    expect(prdCreateSection).toContain("--rank");
    expect(prdCreateSection).toContain("--goal");
    expect(prdCreateSection).toContain("--objective");
    expect(prdCreateSection).toContain("--value");
    expect(prdCreateSection).toContain("--impact");
    expect(prdCreateSection).toContain("--outcome");
    expect(prdCreateSection).toContain("--why-now");
    expect(prdCreateSection).toContain("--why_now");
    expect(prdCreateSection).toContain("--unblock-note");
    expect(prdCreateSection).toContain("--unblock_note");
    expect(prdCreateSection).toContain("low|med|medium|high|critical");
    expect(prdCreateSection).toContain("--confidence");
    expect(readmeCreateSection).toContain("--estimated_minutes");
    expect(readmeCreateSection).toContain("--acceptance_criteria");
    expect(readmeCreateSection).toContain("--definition-of-ready");
    expect(readmeCreateSection).toContain("--definition_of_ready");
    expect(readmeCreateSection).toContain("--order");
    expect(readmeCreateSection).toContain("--rank");
    expect(readmeCreateSection).toContain("--goal");
    expect(readmeCreateSection).toContain("--objective");
    expect(readmeCreateSection).toContain("--value");
    expect(readmeCreateSection).toContain("--impact");
    expect(readmeCreateSection).toContain("--outcome");
    expect(readmeCreateSection).toContain("--why-now");
    expect(readmeCreateSection).toContain("--why_now");
    expect(readmeCreateSection).toContain("--unblock-note");
    expect(readmeCreateSection).toContain("--unblock_note");
    expect(readmeCreateSection).toContain("low|med|medium|high|critical");
    expect(readmeCreateSection).toContain("--confidence");
    expectSectionContainsTokens(prdCreateSection, ISSUE_METADATA_CREATE_FLAG_TOKENS);
    expectSectionContainsTokens(readmeCreateSection, ISSUE_METADATA_CREATE_FLAG_TOKENS);

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

  it("keeps pm test help aligned without synthetic default-array text", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["test", "--help"]);
      expect(help.code).toBe(0);
      for (const flag of REQUIRED_TEST_FLAGS) {
        expect(help.stdout).toContain(flag);
      }
      expect(help.stdout).not.toContain("Add linked test entry (default: [])");
      expect(help.stdout).not.toContain("Remove linked test entry by command/path (default: [])");
    });
  });

  it("keeps pm files and pm docs help aligned without synthetic default-array text", async () => {
    await withTempPmPath(async (context) => {
      const filesHelp = context.runCli(["files", "--help"]);
      expect(filesHelp.code).toBe(0);
      expect(filesHelp.stdout).toContain("--add");
      expect(filesHelp.stdout).toContain("--remove");
      expect(filesHelp.stdout).not.toContain("Add linked file entry (default: [])");
      expect(filesHelp.stdout).not.toContain("Remove linked file by path (default: [])");

      const docsHelp = context.runCli(["docs", "--help"]);
      expect(docsHelp.code).toBe(0);
      expect(docsHelp.stdout).toContain("--add");
      expect(docsHelp.stdout).toContain("--remove");
      expect(docsHelp.stdout).not.toContain("Add linked doc entry (default: [])");
      expect(docsHelp.stdout).not.toContain("Remove linked doc by path (default: [])");
    });
  });

  it("keeps pm comments help aligned without synthetic default-array text", async () => {
    await withTempPmPath(async (context) => {
      const commentsHelp = context.runCli(["comments", "--help"]);
      expect(commentsHelp.code).toBe(0);
      for (const flag of REQUIRED_COMMENTS_FLAGS) {
        expect(commentsHelp.stdout).toContain(flag);
      }
      expect(commentsHelp.stdout).not.toContain("Add one comment entry (default: [])");
    });
  });

  it("keeps PRD and README update mutation contracts aligned with pm update --help", async () => {
    const prd = await readRepoText("PRD.md");
    const readme = await readRepoText("README.md");
    const prdUpdateSection = extractSection(prd, "Mutating `update` (v0.1 baseline):", "`pm update` status semantics:");
    const readmeUpdateSection = extractSection(readme, "### `pm update` explicit-field contract", "### Exit codes");

    expectSectionContainsTokens(prdUpdateSection, REQUIRED_UPDATE_FLAGS.filter((flag) => flag !== "--force"));
    expectSectionContainsTokens(readmeUpdateSection, REQUIRED_UPDATE_FLAGS);
    expect(prdUpdateSection).toContain("--estimated_minutes");
    expect(prdUpdateSection).toContain("--acceptance_criteria");
    expect(prdUpdateSection).toContain("--definition-of-ready");
    expect(prdUpdateSection).toContain("--definition_of_ready");
    expect(prdUpdateSection).toContain("--order");
    expect(prdUpdateSection).toContain("--rank");
    expect(prdUpdateSection).toContain("--goal");
    expect(prdUpdateSection).toContain("--objective");
    expect(prdUpdateSection).toContain("--value");
    expect(prdUpdateSection).toContain("--impact");
    expect(prdUpdateSection).toContain("--outcome");
    expect(prdUpdateSection).toContain("--why-now");
    expect(prdUpdateSection).toContain("--why_now");
    expect(prdUpdateSection).toContain("--unblock-note");
    expect(prdUpdateSection).toContain("--unblock_note");
    expect(prdUpdateSection).toContain("low|med|medium|high|critical");
    expect(prdUpdateSection).toContain("--confidence");
    expect(readmeUpdateSection).toContain("--estimated_minutes");
    expect(readmeUpdateSection).toContain("--acceptance_criteria");
    expect(readmeUpdateSection).toContain("--definition-of-ready");
    expect(readmeUpdateSection).toContain("--definition_of_ready");
    expect(readmeUpdateSection).toContain("--order");
    expect(readmeUpdateSection).toContain("--rank");
    expect(readmeUpdateSection).toContain("--goal");
    expect(readmeUpdateSection).toContain("--objective");
    expect(readmeUpdateSection).toContain("--value");
    expect(readmeUpdateSection).toContain("--impact");
    expect(readmeUpdateSection).toContain("--outcome");
    expect(readmeUpdateSection).toContain("--why-now");
    expect(readmeUpdateSection).toContain("--why_now");
    expect(readmeUpdateSection).toContain("--unblock-note");
    expect(readmeUpdateSection).toContain("--unblock_note");
    expect(readmeUpdateSection).toContain("low|med|medium|high|critical");
    expect(readmeUpdateSection).toContain("--confidence");
    expectSectionContainsTokens(prdUpdateSection, ISSUE_METADATA_UPDATE_FLAG_TOKENS);
    expectSectionContainsTokens(readmeUpdateSection, ISSUE_METADATA_UPDATE_FLAG_TOKENS);
    expect(readmeUpdateSection).toContain("pm close <ID> <TEXT>");

    await withTempPmPath(async (context) => {
      const updateHelp = context.runCli(["update", "--help"]);
      expect(updateHelp.code).toBe(0);
      for (const flag of REQUIRED_UPDATE_FLAGS) {
        expect(updateHelp.stdout).toContain(flag);
      }
      expect(updateHelp.stdout).toContain("--estimated-minutes");
      expect(updateHelp.stdout).toContain("--estimated_minutes");
      expect(updateHelp.stdout).toContain("--acceptance_criteria");
      expect(updateHelp.stdout).toContain("--definition-of-ready");
      expect(updateHelp.stdout).toContain("--definition_of_ready");
      expect(updateHelp.stdout).toContain("--order");
      expect(updateHelp.stdout).toContain("--rank");
      expect(updateHelp.stdout).toContain("--goal");
      expect(updateHelp.stdout).toContain("--objective");
      expect(updateHelp.stdout).toContain("--value");
      expect(updateHelp.stdout).toContain("--impact");
      expect(updateHelp.stdout).toContain("--outcome");
      expect(updateHelp.stdout).toContain("--why-now");
      expect(updateHelp.stdout).toContain("--why_now");
      expect(updateHelp.stdout).toContain("--unblock-note");
      expect(updateHelp.stdout).toContain("--unblock_note");
      expect(updateHelp.stdout).toContain("low|med|medium|high|critical");
      expect(updateHelp.stdout).toContain("--confidence");
      for (const flag of ISSUE_METADATA_UPDATE_FLAG_TOKENS) {
        expect(updateHelp.stdout).toContain(flag);
      }
    });
  });

  it("keeps planned/not-yet-canonical flags out of active create contracts and help output", async () => {
    const prd = await readRepoText("PRD.md");
    const readme = await readRepoText("README.md");
    const agents = await readRepoText("AGENTS.md");

    const prdCreateSection = extractSection(
      prd,
      "Mutating `create` (all schema fields MUST be passable explicitly):",
      "Mutating `update` (v0.1 baseline):",
    );
    const readmeCreateSection = extractSection(
      readme,
      "### `pm create` explicit-field contract",
      "### `pm update` explicit-field contract",
    );
    const agentsCreateTemplateSection = extractSection(
      agents,
      "### All-Flags Create Template (copy/paste)",
      "### Epic Template With Comment + Note",
    );

    for (const flag of PLANNED_NOT_YET_CANONICAL_FLAGS) {
      expect(prdCreateSection).not.toContain(flag);
      expect(readmeCreateSection).not.toContain(flag);
      expect(agentsCreateTemplateSection).not.toContain(flag);
    }

    await withTempPmPath(async (context) => {
      const createHelp = context.runCli(["create", "--help"]);
      expect(createHelp.code).toBe(0);
      for (const flag of PLANNED_NOT_YET_CANONICAL_FLAGS) {
        expect(createHelp.stdout).not.toContain(flag);
      }
    });
  });

  it("keeps claim and release mutation metadata contract aligned across PRD and CLI help", async () => {
    const prd = await readRepoText("PRD.md");
    expect(prd).toContain("| `pm claim <ID>` | id, optional `--author`/`--message`/`--force` |");
    expect(prd).toContain("| `pm release <ID>` | id, optional `--author`/`--message`/`--force` |");

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

  it("keeps close mutation metadata contract aligned across PRD and CLI help", async () => {
    const prd = await readRepoText("PRD.md");
    expect(prd).toContain("| `pm close <ID> <TEXT>` | id + close reason text + optional `--author/--message/--force` |");

    await withTempPmPath(async (context) => {
      const closeHelp = context.runCli(["close", "--help"]);
      expect(closeHelp.code).toBe(0);
      expect(closeHelp.stdout).toContain("Usage: pm close [options] <id> <text>");
      expect(closeHelp.stdout).toContain("Close an item with required reason text.");
      for (const flag of REQUIRED_CLOSE_FLAGS) {
        expect(closeHelp.stdout).toContain(flag);
      }
    });
  });

  it("keeps delete mutation metadata contract aligned across PRD and CLI help", async () => {
    const prd = await readRepoText("PRD.md");
    expect(prd).toContain("| `pm delete <ID>` | id + optional `--author`/`--message`/`--force` |");

    await withTempPmPath(async (context) => {
      const deleteHelp = context.runCli(["delete", "--help"]);
      expect(deleteHelp.code).toBe(0);
      expect(deleteHelp.stdout).toContain("Usage: pm delete [options] <id>");
      expect(deleteHelp.stdout).toContain("Delete an item and append a delete history entry.");
      for (const flag of REQUIRED_DELETE_FLAGS) {
        expect(deleteHelp.stdout).toContain(flag);
      }
    });
  });

  it("keeps append mutation metadata contract aligned across PRD and CLI help", async () => {
    const prd = await readRepoText("PRD.md");
    expect(prd).toContain("| `pm append <ID> --body` | id + appended markdown | `{ item, appended, changed_fields }` |");

    await withTempPmPath(async (context) => {
      const appendHelp = context.runCli(["append", "--help"]);
      expect(appendHelp.code).toBe(0);
      expect(appendHelp.stdout).toContain("Usage: pm append [options] <id>");
      expect(appendHelp.stdout).toContain("Append text to an item body.");
      for (const flag of REQUIRED_APPEND_FLAGS) {
        expect(appendHelp.stdout).toContain(flag);
      }
    });
  });

  it("keeps restore mutation metadata contract aligned across PRD and CLI help", async () => {
    const prd = await readRepoText("PRD.md");
    expect(prd).toContain(
      "| `pm restore <ID> <TIMESTAMP\\|VERSION>` | id + restore target + optional `--author/--message/--force` |",
    );

    await withTempPmPath(async (context) => {
      const restoreHelp = context.runCli(["restore", "--help"]);
      expect(restoreHelp.code).toBe(0);
      expect(restoreHelp.stdout).toContain("Usage: pm restore [options] <id> <target>");
      expect(restoreHelp.stdout).toContain("Restore an item to a previous timestamp or version.");
      for (const flag of REQUIRED_RESTORE_FLAGS) {
        expect(restoreHelp.stdout).toContain(flag);
      }
    });
  });

  it("keeps runtime JSON output object key ordering aligned with PRD output contracts", async () => {
    const prd = await readRepoText("PRD.md");
    const requiredOutputContractTokens = [
      "{ items, count, filters, now }",
      "{ query, mode, items, count, filters, now }",
      "{ item, body, linked: { files, tests, docs } }",
      "{ ok, path, settings, created_dirs, warnings }",
      "{ item, changed_fields, warnings }",
      "{ item, appended, changed_fields }",
      "{ item, claimed_by, previous_assignee, forced }",
      "{ item, released_by, previous_assignee, forced }",
      "{ id, comments, count }",
      "{ id, files, changed, count }",
      "{ id, docs, changed, count }",
      "{ ok, mode, total_items, artifacts, warnings, generated_at }",
      "{ id, history, count, limit }",
      "{ activity, count, limit }",
      "{ id, tests, run_results, changed, count }",
      "{ item, restored_from, changed_fields, warnings }",
      "{ totals, failed, passed, skipped, results }",
      "{ totals, by_type, by_status, generated_at }",
      "{ ok, checks, warnings, generated_at }",
      "{ ok, removed, retained, warnings, generated_at }",
    ];
    for (const token of requiredOutputContractTokens) {
      expect(prd).toContain(token);
    }

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
      expect(createdId).toBeTruthy();

      const updateResult = context.runCli(
        ["update", createdId, "--status", "in_progress", "--author", "test-author", "--message", "update", "--json"],
        { expectJson: true },
      );
      expect(updateResult.code).toBe(0);
      expectTopLevelKeyOrder(updateResult.json, ["item", "changed_fields", "warnings"]);

      const claimResult = context.runCli(
        ["claim", createdId, "--author", "test-author", "--message", "claim", "--json"],
        {
          expectJson: true,
        },
      );
      expect(claimResult.code).toBe(0);
      expectTopLevelKeyOrder(claimResult.json, ["item", "claimed_by", "previous_assignee", "forced"]);

      const releaseResult = context.runCli(
        ["release", createdId, "--author", "test-author", "--message", "release", "--json"],
        { expectJson: true },
      );
      expect(releaseResult.code).toBe(0);
      expectTopLevelKeyOrder(releaseResult.json, ["item", "released_by", "previous_assignee", "forced"]);

      const appendResult = context.runCli(
        ["append", createdId, "--body", "contract payload", "--author", "test-author", "--message", "append", "--json"],
        { expectJson: true },
      );
      expect(appendResult.code).toBe(0);
      expectTopLevelKeyOrder(appendResult.json, ["item", "appended", "changed_fields"]);

      const commentsResult = context.runCli(["comments", createdId, "--add", "contract comment", "--json"], {
        expectJson: true,
      });
      expect(commentsResult.code).toBe(0);
      expectTopLevelKeyOrder(commentsResult.json, ["id", "comments", "count"]);

      const filesResult = context.runCli(
        ["files", createdId, "--add", "path=src/cli.ts,scope=project,note=contract file", "--json"],
        {
          expectJson: true,
        },
      );
      expect(filesResult.code).toBe(0);
      expectTopLevelKeyOrder(filesResult.json, ["id", "files", "changed", "count"]);

      const docsResult = context.runCli(
        ["docs", createdId, "--add", "path=README.md,scope=project,note=contract doc", "--json"],
        {
          expectJson: true,
        },
      );
      expect(docsResult.code).toBe(0);
      expectTopLevelKeyOrder(docsResult.json, ["id", "docs", "changed", "count"]);

      const testResult = context.runCli(["test", createdId, "--json"], { expectJson: true });
      expect(testResult.code).toBe(0);
      expectTopLevelKeyOrder(testResult.json, ["id", "tests", "run_results", "changed", "count"]);

      const listResult = context.runCli(["list-open", "--limit", "20", "--json"], { expectJson: true });
      expect(listResult.code).toBe(0);
      expectTopLevelKeyOrder(listResult.json, ["items", "count", "filters", "now"]);

      const searchResult = context.runCli(["search", "--mode", "keyword", "--limit", "20", "contract", "--json"], {
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
        {
          expectJson: true,
        },
      );
      expect(closeResult.code).toBe(0);
      expectTopLevelKeyOrder(closeResult.json, ["item", "changed_fields", "warnings"]);

      const deleteResult = context.runCli(
        ["delete", createdId, "--author", "test-author", "--message", "delete", "--json"],
        {
          expectJson: true,
        },
      );
      expect(deleteResult.code).toBe(0);
      expectTopLevelKeyOrder(deleteResult.json, ["item", "changed_fields", "warnings"]);
    });
  });

  it("keeps runtime exit-code mapping aligned with PRD contract table", async () => {
    const prd = await readRepoText("PRD.md");
    const requiredExitCodeTokens = [
      "- `0` success",
      "- `1` generic failure",
      "- `2` usage / invalid args",
      "- `3` not found",
      "- `4` conflict (claim/lock/ownership)",
      "- `5` dependency failed (for orchestration/test-all failures)",
    ];
    for (const token of requiredExitCodeTokens) {
      expect(prd).toContain(token);
    }

    await withTempPmPath(async (context) => {
      const createSeedItem = (options: {
        title: string;
        assignee?: string;
        testEntry?: string;
        message: string;
      }) =>
        context.runCli(
          [
            "create",
            "--title",
            options.title,
            "--description",
            "Seed item for exit-code contract coverage.",
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
            "Exit-code contract remains deterministic.",
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

  it("keeps update-close workflow contract aligned with PRD semantics", async () => {
    const prd = await readRepoText("PRD.md");
    const readme = await readRepoText("README.md");
    const agents = await readRepoText("AGENTS.md");
    expect(prd).toContain("- `pm update <ID> --status closed` is invalid usage and returns exit code `2`.");
    expect(prd).toContain("- `--status closed` is not supported; callers must use `pm close <ID> <TEXT>`");

    const readmeQuickstartSection = extractSection(readme, "## Quickstart", "## Storage Layout");
    expect(readmeQuickstartSection).toContain("pm close pm-a1b2");
    for (const token of CLOSED_STATUS_UPDATE_DISALLOWED_TOKENS) {
      expect(readmeQuickstartSection).not.toContain(token);
    }

    const agentsValidationSection = extractSection(agents, "### Step F - Validate and close", "### Step G - Release claim");
    expect(agentsValidationSection).toContain('pm close <ID> "<reason>"');
    for (const token of CLOSED_STATUS_UPDATE_DISALLOWED_TOKENS) {
      expect(agentsValidationSection).not.toContain(token);
    }

    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--title",
          "Update close workflow contract seed",
          "--description",
          "Seed item for update/close workflow contract validation.",
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
          "seed close workflow contract",
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

  it("keeps sandbox-safe linked test command guidance aligned across authoritative docs", async () => {
    const prd = await readRepoText("PRD.md");
    const readme = await readRepoText("README.md");
    const agents = await readRepoText("AGENTS.md");

    const requiredSafetyTokens = ["node scripts/run-tests.mjs", "PM_PATH", "PM_GLOBAL_PATH", "pm test-all", "sandbox-unsafe"];
    for (const token of requiredSafetyTokens) {
      expect(prd).toContain(token);
      expect(readme).toContain(token);
      expect(agents).toContain(token);
    }
  });

  it("keeps AGENTS validation sweep guidance aligned with in-progress and closed test-all loops", async () => {
    const agents = await readRepoText("AGENTS.md");
    const validateAndCloseSection = extractSection(agents, "### Step F - Validate and close", "### Step G - Release claim");

    expectSectionContainsTokens(validateAndCloseSection, [
      "`pm test-all --status in_progress`",
      "`pm test-all --status closed`",
    ]);
  });

  it("keeps npm packaging allowlist and prepublish guard aligned", async () => {
    const packageJson = JSON.parse(await readRepoText("package.json")) as {
      files?: string[];
      scripts?: Record<string, string | undefined>;
    };

    const requiredPublishFiles = [
      "dist/**",
      "README.md",
      "LICENSE",
      "AGENTS.md",
      "PRD.md",
      ".pi/extensions/pm-cli/index.ts",
      "scripts/install.sh",
      "scripts/install.ps1",
    ];

    expect(packageJson.files).toBeDefined();
    for (const requiredPath of requiredPublishFiles) {
      expect(packageJson.files).toContain(requiredPath);
    }

    expect(packageJson.scripts?.prepublishOnly).toBe("pnpm build");
  });

  it("keeps 100% coverage gate wiring aligned in config and scripts", async () => {
    const vitestConfig = await readRepoText("vitest.config.ts");
    const packageJson = JSON.parse(await readRepoText("package.json")) as {
      scripts?: Record<string, string | undefined>;
    };

    const requiredThresholdTokens = ["lines: 100", "branches: 100", "functions: 100", "statements: 100"];
    for (const token of requiredThresholdTokens) {
      expect(vitestConfig).toContain(token);
    }

    expect(packageJson.scripts?.["test:coverage"]).toBeDefined();
    expect(packageJson.scripts?.["test:coverage"]).toContain("vitest run --coverage");
  });

  it("keeps vitest coverage include list aligned with src ts modules", async () => {
    const vitestConfig = await readRepoText("vitest.config.ts");
    const includePatterns = extractCoverageIncludePatterns(vitestConfig);
    const sourceFiles = await listTsFilesRelativeToRepo("src");
    const uncoveredFiles = sourceFiles.filter((filePath) => !matchesAnyPattern(filePath, includePatterns));

    expect(uncoveredFiles.sort((a, b) => a.localeCompare(b))).toEqual(["src/cli.ts", "src/cli/main.ts"]);
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

    const readme = await readRepoText("README.md");
    expect(readme).toContain("`pm --version`");

    const prd = await readRepoText("PRD.md");
    expect(prd).toContain("post-install `pm --version` availability verification");

    const installSh = await readRepoText("scripts/install.sh");
    expect(installSh).toContain("PM_BIN");
    expect(installSh).toContain("$PM_BIN --version");
    expect(installSh).toContain("Installed pm version:");

    const installPs1 = await readRepoText("scripts/install.ps1");
    expect(installPs1).toContain("$pmExecutable --version");
    expect(installPs1).toContain("Installed pm version:");
  });
});
