import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandFor, fail, flagBool, parseFlags, runCommand } from "./utils.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

const REQUIRED_DOC_FILES = [
  "README.md",
  "docs/README.md",
  "docs/COMMANDS.md",
  "docs/AGENT_GUIDE.md",
  "docs/SDK.md",
  "docs/EXTENSIONS.md",
  "docs/QUICKSTART.md",
  "docs/RELEASING.md",
];

const REQUIRED_PM_GUIDE_DOCS = ["README.md", "docs/README.md", "docs/COMMANDS.md", "docs/AGENT_GUIDE.md"];

const REQUIRED_SKILLS = ["pm-developer", "pm-user", "pm-extensions", "pm-sdk"];
const SKILLS_ROOT = ".agents/skills";
const REQUIRED_HARNESS_DOC = ".agents/skills/HARNESS_COMPATIBILITY.md";

function usage() {
  console.log(`Usage:
  node scripts/release/docs-skills-gate.mjs [--json]

Validates docs and .agents/skills freshness gates:
- required docs and skills existence
- agentskills frontmatter validity for required skills
- pm guide topic/doc routing integrity
- guide command examples match runtime command contracts
`);
}

function parseJson(text, context) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Failed to parse JSON for ${context}: ${message}`);
  }
}

function isMissingError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function fileExists(relativePath) {
  const absolutePath = path.resolve(REPO_ROOT, relativePath);
  try {
    const stats = await stat(absolutePath);
    return stats.isFile();
  } catch (error) {
    if (isMissingError(error)) {
      return false;
    }
    throw error;
  }
}

async function requireFiles(filePaths, failures) {
  for (const filePath of filePaths) {
    if (!(await fileExists(filePath))) {
      failures.push(`Missing required file: ${filePath}`);
    }
  }
}

async function readUtf8(relativePath) {
  const absolutePath = path.resolve(REPO_ROOT, relativePath);
  return readFile(absolutePath, "utf8");
}

export function extractFrontmatter(rawContent) {
  if (!rawContent.startsWith("---\n")) {
    return { frontmatter: null, body: rawContent };
  }
  const closingIndex = rawContent.indexOf("\n---\n", 4);
  if (closingIndex === -1) {
    return { frontmatter: null, body: rawContent };
  }
  const frontmatter = rawContent.slice(4, closingIndex);
  const body = rawContent.slice(closingIndex + 5);
  return { frontmatter, body };
}

export function parseSimpleYamlMap(frontmatter) {
  const values = new Map();
  const lines = frontmatter.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

export function validateSkillFrontmatter(skillName, rawContent, failures) {
  const { frontmatter, body } = extractFrontmatter(rawContent);
  if (!frontmatter) {
    failures.push(`Skill ${skillName}: missing YAML frontmatter in SKILL.md`);
    return;
  }
  const map = parseSimpleYamlMap(frontmatter);
  const declaredName = map.get("name");
  const description = map.get("description");
  if (!declaredName) {
    failures.push(`Skill ${skillName}: missing required frontmatter field "name"`);
  } else if (declaredName !== skillName) {
    failures.push(`Skill ${skillName}: frontmatter name "${declaredName}" must match directory name`);
  }
  if (!description) {
    failures.push(`Skill ${skillName}: missing required frontmatter field "description"`);
  } else if (!description.toLowerCase().includes("use when")) {
    failures.push(`Skill ${skillName}: description should include explicit "Use when" routing guidance`);
  }
  const lineCount = rawContent.split(/\r?\n/).length;
  if (lineCount > 500) {
    failures.push(`Skill ${skillName}: SKILL.md should stay under 500 lines (found ${lineCount})`);
  }
  if (!body.includes("pm guide")) {
    failures.push(`Skill ${skillName}: body must include pm guide routing to avoid stale deep links`);
  }
}

function extractRelativeMarkdownLinks(content) {
  const links = [];
  const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const match of content.matchAll(linkPattern)) {
    const target = match[1]?.trim();
    if (!target) {
      continue;
    }
    if (
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("mailto:") ||
      target.startsWith("#")
    ) {
      continue;
    }
    links.push(target);
  }
  return links;
}

async function collectMarkdownFiles(relativeDirectory) {
  const absoluteDirectory = path.resolve(REPO_ROOT, relativeDirectory);
  const files = [];

  async function walk(currentAbsolute, currentRelative) {
    const entries = await readdir(currentAbsolute, { withFileTypes: true });
    for (const entry of entries) {
      const nextAbsolute = path.join(currentAbsolute, entry.name);
      const nextRelative = path.posix.join(currentRelative, entry.name);
      if (entry.isDirectory()) {
        await walk(nextAbsolute, nextRelative);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(nextRelative);
      }
    }
  }

  await walk(absoluteDirectory, relativeDirectory.replaceAll("\\", "/"));
  return files;
}

async function validateSkillLinks(skillName, failures) {
  const skillRoot = `${SKILLS_ROOT}/${skillName}`;
  const markdownFiles = await collectMarkdownFiles(skillRoot);
  for (const markdownFile of markdownFiles) {
    const content = await readUtf8(markdownFile);
    const links = extractRelativeMarkdownLinks(content);
    for (const link of links) {
      const [pathWithoutAnchor] = link.split("#");
      const targetRelative = path.posix.normalize(path.posix.join(path.posix.dirname(markdownFile), pathWithoutAnchor));
      if (!(await fileExists(targetRelative))) {
        failures.push(`Skill ${skillName}: broken relative link "${link}" in ${markdownFile}`);
      }
    }
  }
}

export function resolveExampleCommandPath(example, availableCommands) {
  const normalized = example.trim();
  if (!normalized.startsWith("pm ")) {
    return null;
  }
  const tokens = normalized.split(/\s+/).slice(1);
  if (tokens.length === 0) {
    return null;
  }

  const commandTokens = [];
  for (const token of tokens) {
    if (
      token.startsWith("--") ||
      token.includes("<") ||
      token.includes(">") ||
      token.startsWith("[") ||
      token.startsWith("\"") ||
      token.startsWith("'")
    ) {
      break;
    }
    commandTokens.push(token);
  }

  if (commandTokens.length === 0) {
    return null;
  }

  for (let index = commandTokens.length; index >= 1; index -= 1) {
    const candidate = commandTokens.slice(0, index).join(" ");
    if (availableCommands.has(candidate)) {
      return candidate;
    }
  }
  return "";
}

function validateGuideCommands(topicResult, availableCommands, failures) {
  const commandSamples = [
    ...topicResult.topic.commands,
    ...topicResult.topic.workflows.flatMap((workflow) => workflow.commands),
  ];
  for (const sample of commandSamples) {
    const resolved = resolveExampleCommandPath(sample, availableCommands);
    if (resolved === "") {
      failures.push(`Guide topic "${topicResult.topic.id}" has unknown command example: ${sample}`);
    }
  }
}

async function runGuideChecks(failures) {
  const contractsResult = runCommand(process.execPath, ["dist/cli.js", "contracts", "--json"], {
    cwd: REPO_ROOT,
    capture: true,
  });
  const contractsPayload = parseJson(contractsResult.stdout, "pm contracts --json");
  const availableCommands = new Set(Array.isArray(contractsPayload.commands) ? contractsPayload.commands : []);

  const guideIndexResult = runCommand(process.execPath, ["dist/cli.js", "guide", "--json"], {
    cwd: REPO_ROOT,
    capture: true,
  });
  const guideIndex = parseJson(guideIndexResult.stdout, "pm guide --json");
  if (!guideIndex || guideIndex.mode !== "index" || !Array.isArray(guideIndex.topics)) {
    failures.push("pm guide --json did not return an index payload");
    return;
  }

  for (const topic of guideIndex.topics) {
    const topicId = typeof topic?.id === "string" ? topic.id : null;
    if (!topicId) {
      failures.push("pm guide index includes a topic without an id");
      continue;
    }
    const topicResultRaw = runCommand(
      process.execPath,
      ["dist/cli.js", "guide", topicId, "--depth", "standard", "--json"],
      {
        cwd: REPO_ROOT,
        capture: true,
      },
    );
    const topicResult = parseJson(topicResultRaw.stdout, `pm guide ${topicId} --json`);
    if (!topicResult || topicResult.mode !== "topic" || !topicResult.topic) {
      failures.push(`pm guide ${topicId} did not return a topic payload`);
      continue;
    }
    if (Array.isArray(topicResult.warnings) && topicResult.warnings.length > 0) {
      for (const warning of topicResult.warnings) {
        failures.push(`Guide topic "${topicId}" warning: ${warning}`);
      }
    }
    if (!Array.isArray(topicResult.docs)) {
      failures.push(`Guide topic "${topicId}" is missing docs metadata`);
      continue;
    }
    for (const doc of topicResult.docs) {
      if (doc && doc.exists === false && doc.optional !== true) {
        failures.push(`Guide topic "${topicId}" missing required document: ${doc.path}`);
      }
    }
    validateGuideCommands(topicResult, availableCommands, failures);
  }
}

async function validateRequiredGuideMentions(failures) {
  for (const filePath of REQUIRED_PM_GUIDE_DOCS) {
    const content = await readUtf8(filePath);
    if (!content.includes("pm guide")) {
      failures.push(`Required docs routing marker missing in ${filePath}: expected "pm guide" reference`);
    }
  }
}

async function runSkillChecks(failures) {
  if (!(await fileExists(REQUIRED_HARNESS_DOC))) {
    failures.push(`Missing required harness compatibility guide: ${REQUIRED_HARNESS_DOC}`);
  }
  for (const skillName of REQUIRED_SKILLS) {
    const skillPath = `${SKILLS_ROOT}/${skillName}/SKILL.md`;
    if (!(await fileExists(skillPath))) {
      failures.push(`Missing required skill: ${skillPath}`);
      continue;
    }
    const skillContent = await readUtf8(skillPath);
    validateSkillFrontmatter(skillName, skillContent, failures);
    await validateSkillLinks(skillName, failures);
  }
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.get("help") || flags.get("h")) {
    usage();
    return;
  }
  const outputJson = flagBool(flags, "json", false);
  const failures = [];

  await requireFiles(REQUIRED_DOC_FILES, failures);
  await validateRequiredGuideMentions(failures);
  await runSkillChecks(failures);
  await runGuideChecks(failures);

  const payload = {
    ok: failures.length === 0,
    checks: {
      required_docs: REQUIRED_DOC_FILES.length,
      required_skills: REQUIRED_SKILLS.length,
      required_harness_doc: REQUIRED_HARNESS_DOC,
    },
    failures,
  };

  if (outputJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (payload.ok) {
    console.log("Docs/skills gate passed.");
  } else {
    console.error("Docs/skills gate failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
  }

  if (!payload.ok) {
    fail("Docs/skills gate failed.", 1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Docs/skills gate crashed: ${message}`, 1);
  });
}
