/**
 * @module cli/commands/guide
 *
 * Implements the pm guide command surface and its agent-facing runtime behavior.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveConfiguredPmPackageRoot } from "../../core/packages/root.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import {
  listGuideTopicIds,
  listGuideTopics,
  resolveGuideTopic,
  type GuideTopicDefinition,
} from "../guide-topics.js";

/** Supported values accepted by the guide output contract. */
export const GUIDE_OUTPUT_VALUES = ["markdown", "toon", "json"] as const;
/** Restricts guide output format values accepted by command, SDK, and storage contracts. */
export type GuideOutputFormat = (typeof GUIDE_OUTPUT_VALUES)[number];

/** Supported values accepted by the guide depth contract. */
export const GUIDE_DEPTH_VALUES = ["brief", "standard", "deep"] as const;
/** Restricts guide depth values accepted by command, SDK, and storage contracts. */
export type GuideDepth = (typeof GUIDE_DEPTH_VALUES)[number];

/** Documents the guide options payload exchanged by command, SDK, and package integrations. */
export interface GuideOptions {
  /** Value that configures or reports topic for this contract. */
  topic?: string;
  /** Value that configures or reports list for this contract. */
  list?: boolean;
  /** Value that configures or reports format for this contract. */
  format?: string;
  /** Value that configures or reports depth for this contract. */
  depth?: string;
  [key: string]: unknown;
}

/** Documents the guide doc render payload exchanged by command, SDK, and package integrations. */
export interface GuideDocRender {
  /** Filesystem path used for path resolution. */
  path: string;
  /** Value that configures or reports purpose for this contract. */
  purpose: string;
  /** Value that configures or reports optional for this contract. */
  optional: boolean;
  /** Value that configures or reports exists for this contract. */
  exists: boolean;
  /** Number of line entries represented by this result. */
  line_count: number | null;
  /** Strategy used to control content behavior. */
  content_mode: "none" | "excerpt" | "full";
  /** Value that configures or reports content for this contract. */
  content: string | null;
  /** Value that configures or reports truncated for this contract. */
  truncated: boolean;
}

/** Documents the guide index result payload exchanged by command, SDK, and package integrations. */
export interface GuideIndexResult {
  /** Value that configures or reports output default for this contract. */
  output_default: "toon";
  /** Value that configures or reports mode for this contract. */
  mode: "index";
  /** Value that configures or reports depth for this contract. */
  depth: GuideDepth;
  /** Value that configures or reports topics for this contract. */
  topics: Array<{
    id: string;
    aliases: string[];
    title: string;
    summary: string;
    intent: string;
    quick_commands: string[];
    docs: Array<{ path: string; purpose: string }>;
    related: string[];
  }>;
  /** Value that configures or reports suggested next steps for this contract. */
  suggested_next_steps: string[];
}

/** Documents the guide topic result payload exchanged by command, SDK, and package integrations. */
export interface GuideTopicResult {
  /** Value that configures or reports output default for this contract. */
  output_default: "toon";
  /** Value that configures or reports mode for this contract. */
  mode: "topic";
  /** Value that configures or reports depth for this contract. */
  depth: GuideDepth;
  /** Value that configures or reports requested topic for this contract. */
  requested_topic: string;
  /** Value that configures or reports topic for this contract. */
  topic: GuideTopicDefinition;
  /** Value that configures or reports docs for this contract. */
  docs: GuideDocRender[];
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
}

/** Restricts guide result values accepted by command, SDK, and storage contracts. */
export type GuideResult = GuideIndexResult | GuideTopicResult;

function parseGuideOutputFormat(
  raw: string | undefined,
): GuideOutputFormat | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (!GUIDE_OUTPUT_VALUES.includes(normalized as GuideOutputFormat)) {
    throw new PmCliError(
      "Guide format must be one of markdown|toon|json",
      EXIT_CODE.USAGE,
    );
  }
  return normalized as GuideOutputFormat;
}

/** Implements resolve guide output format for the public runtime surface of this module. */
export function resolveGuideOutputFormat(
  options: GuideOptions,
  global: GlobalOptions,
): GuideOutputFormat {
  const commandFormat = parseGuideOutputFormat(options.format);
  if (global.json && commandFormat && commandFormat !== "json") {
    throw new PmCliError(
      "Cannot combine --json with --format markdown|toon",
      EXIT_CODE.USAGE,
    );
  }
  if (global.json) {
    return "json";
  }
  return commandFormat ?? "toon";
}

function parseGuideDepth(raw: string | undefined): GuideDepth {
  if (!raw) {
    return "brief";
  }
  const normalized = raw.trim().toLowerCase();
  if (!GUIDE_DEPTH_VALUES.includes(normalized as GuideDepth)) {
    throw new PmCliError(
      "Guide depth must be one of brief|standard|deep",
      EXIT_CODE.USAGE,
    );
  }
  return normalized as GuideDepth;
}

function resolvePackageRoot(): string {
  return resolveConfiguredPmPackageRoot(
    process.env,
    "PM_CLI_PACKAGE_ROOT",
    import.meta.url,
    ["..", "..", ".."],
  );
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

function toExcerpt(
  content: string,
  maxLines: number,
  maxCharacters: number,
): { excerpt: string; truncated: boolean; lineCount: number } {
  const normalized = normalizeLineEndings(content);
  const lines = normalized.split("\n");
  const lineSlice = lines.slice(0, maxLines);
  let excerpt = lineSlice.join("\n");
  let truncated = lines.length > maxLines;
  if (excerpt.length > maxCharacters) {
    excerpt = excerpt.slice(0, maxCharacters);
    truncated = true;
  }
  return {
    excerpt: excerpt.trimEnd(),
    truncated,
    lineCount: lines.length,
  };
}

async function renderGuideDocs(
  topic: GuideTopicDefinition,
  depth: GuideDepth,
  packageRoot: string,
): Promise<GuideDocRender[]> {
  const includeContent = depth !== "brief";
  const contentMode: GuideDocRender["content_mode"] = includeContent
    ? depth === "deep"
      ? "full"
      : "excerpt"
    : "none";
  const docs: GuideDocRender[] = [];
  for (const doc of topic.docs) {
    const absolutePath = path.resolve(packageRoot, doc.path);
    if (!includeContent) {
      docs.push({
        path: doc.path,
        purpose: doc.purpose,
        optional: doc.optional === true,
        exists: true,
        line_count: null,
        content_mode: "none",
        content: null,
        truncated: false,
      });
      continue;
    }
    try {
      const rawContent = await readFile(absolutePath, "utf8");
      if (depth === "deep") {
        const normalized = normalizeLineEndings(rawContent).trimEnd();
        docs.push({
          path: doc.path,
          purpose: doc.purpose,
          optional: doc.optional === true,
          exists: true,
          line_count:
            normalized.length === 0 ? 0 : normalized.split("\n").length,
          content_mode: "full",
          content: normalized,
          truncated: false,
        });
      } else {
        const excerpt = toExcerpt(rawContent, 120, 12_000);
        docs.push({
          path: doc.path,
          purpose: doc.purpose,
          optional: doc.optional === true,
          exists: true,
          line_count: excerpt.lineCount,
          content_mode: contentMode,
          content: excerpt.excerpt,
          truncated: excerpt.truncated,
        });
      }
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      const missing = code === "ENOENT";
      docs.push({
        path: doc.path,
        purpose: doc.purpose,
        optional: doc.optional === true,
        exists: false,
        line_count: null,
        content_mode: "none",
        content: null,
        truncated: false,
      });
      if (!missing) {
        throw new PmCliError(
          `Failed to read guide document "${doc.path}".`,
          EXIT_CODE.GENERIC_FAILURE,
        );
      }
    }
  }
  return docs;
}

function buildGuideIndex(depth: GuideDepth): GuideIndexResult {
  const topics = listGuideTopics().map((topic) => ({
    id: topic.id,
    aliases: topic.aliases,
    title: topic.title,
    summary: topic.summary,
    intent: topic.intent,
    quick_commands:
      depth === "brief"
        ? topic.commands.slice(0, 3)
        : topic.commands.slice(0, 6),
    docs: topic.docs.map((doc) => ({ path: doc.path, purpose: doc.purpose })),
    related: topic.related,
  }));
  return {
    output_default: "toon",
    mode: "index",
    depth,
    topics,
    suggested_next_steps: [
      "pm guide <topic>",
      "pm guide <topic> --depth standard",
      "pm guide <topic> --depth deep --format markdown",
      "pm guide <topic> --json",
    ],
  };
}

function ensureGuideTopic(topic: string): GuideTopicDefinition {
  const resolved = resolveGuideTopic(topic);
  if (resolved) {
    return resolved;
  }
  const available = listGuideTopicIds().join(", ");
  throw new PmCliError(
    `Unknown guide topic "${topic}". Available topics: ${available}. Use "pm guide --list" to browse.`,
    EXIT_CODE.USAGE,
  );
}

/** Implements run guide for the public runtime surface of this module. */
export async function runGuide(
  options: GuideOptions,
  global: GlobalOptions,
): Promise<GuideResult> {
  const depth = parseGuideDepth(
    typeof options.depth === "string" ? options.depth : undefined,
  );
  const listRequested = options.list === true;
  const topicRaw =
    typeof options.topic === "string" ? options.topic : undefined;
  if (listRequested || !topicRaw) {
    return buildGuideIndex(depth);
  }

  const topic = ensureGuideTopic(topicRaw);
  const packageRoot = resolvePackageRoot();
  const docs = await renderGuideDocs(topic, depth, packageRoot);
  const warnings = docs
    .filter((doc) => !doc.exists && !doc.optional)
    .map((doc) => `Missing required guide document: ${doc.path}`);

  return {
    output_default: "toon",
    mode: "topic",
    depth,
    requested_topic: topicRaw,
    topic,
    docs,
    warnings,
  };
}

/** Public contract for test only guide, shared by SDK and presentation-layer consumers. */
export const _testOnlyGuide = {
  ensureGuideTopic,
};

function markdownCodeFence(content: string): string {
  return content.replaceAll("```", "``\\`");
}

/** Implements render guide markdown for the public runtime surface of this module. */
export function renderGuideMarkdown(result: GuideResult): string {
  if (result.mode === "index") {
    const lines: string[] = [
      "# pm guide",
      "",
      "Token-efficient local documentation index for agent and maintainer workflows.",
      "",
      "## Topics",
    ];
    for (const topic of result.topics) {
      lines.push(`- \`${topic.id}\` - ${topic.summary}`);
      if (result.depth !== "brief") {
        lines.push(`  - intent: ${topic.intent}`);
        lines.push(
          `  - docs: ${topic.docs.map((doc) => `\`${doc.path}\``).join(", ")}`,
        );
      }
    }
    lines.push("", "## Next steps");
    for (const step of result.suggested_next_steps) {
      lines.push(`- \`${step}\``);
    }
    return lines.join("\n");
  }

  const lines: string[] = [
    `# pm guide ${result.topic.id}`,
    "",
    result.topic.summary,
    "",
    "## Intent",
    result.topic.intent,
    "",
    "## Key commands",
    ...result.topic.commands.map((command) => `- \`${command}\``),
    "",
    "## Workflow prompts",
  ];
  for (const workflow of result.topic.workflows) {
    lines.push(`### ${workflow.name}`);
    lines.push(`goal: ${workflow.goal}`);
    lines.push(`prompt: ${workflow.prompt}`);
    lines.push("commands:");
    lines.push(...workflow.commands.map((command) => `- \`${command}\``));
    lines.push("");
  }
  lines.push("## Documents");
  for (const doc of result.docs) {
    const status = doc.exists
      ? "available"
      : doc.optional
        ? "missing (optional)"
        : "missing (required)";
    lines.push(`- \`${doc.path}\` - ${doc.purpose} (${status})`);
    if (doc.exists && doc.content_mode !== "none" && doc.content) {
      lines.push("");
      lines.push(`### Excerpt: \`${doc.path}\``);
      if (doc.truncated) {
        lines.push("_truncated for context efficiency_");
      }
      lines.push("```markdown");
      lines.push(markdownCodeFence(doc.content));
      lines.push("```");
    }
  }
  if (result.topic.related.length > 0) {
    lines.push("", "## Related topics");
    lines.push(...result.topic.related.map((topic) => `- \`${topic}\``));
  }
  if (result.warnings.length > 0) {
    lines.push("", "## Warnings");
    lines.push(...result.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join("\n");
}
