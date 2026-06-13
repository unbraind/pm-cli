import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  renderGuideMarkdown,
  resolveGuideOutputFormat,
  runGuide,
  type GuideResult,
} from "../../src/cli/commands/guide.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import type { GlobalOptions } from "../../src/core/shared/command-types.js";

const GLOBAL_OPTIONS: GlobalOptions = {
  json: false,
  quiet: false,
  noExtensions: false,
  profile: false,
};

describe("guide command runtime", () => {
  it("returns an index payload by default", async () => {
    const result = await runGuide({}, GLOBAL_OPTIONS);
    expect(result.mode).toBe("index");
    expect(result.output_default).toBe("toon");
    expect(result.topics.some((topic) => topic.id === "quickstart")).toBe(true);
  });

  it("returns topic payload with docs metadata", async () => {
    const result = await runGuide({ topic: "commands", depth: "standard" }, GLOBAL_OPTIONS);
    expect(result.mode).toBe("topic");
    expect(result.topic.id).toBe("commands");
    expect(result.docs.length).toBeGreaterThan(0);
    expect(result.docs.every((doc) => typeof doc.exists === "boolean")).toBe(true);
  });

  it("throws usage error for unknown topic", async () => {
    await expect(runGuide({ topic: "definitely-not-a-topic" }, GLOBAL_OPTIONS)).rejects.toMatchObject<PmCliError>({
      exitCode: EXIT_CODE.USAGE,
    });
  });

  it("rejects conflicting --json and --format markdown", () => {
    expect(() => resolveGuideOutputFormat({ format: "markdown" }, { ...GLOBAL_OPTIONS, json: true })).toThrow(PmCliError);
  });

  it("resolves explicit output formats and rejects unknown formats", () => {
    expect(resolveGuideOutputFormat({ format: " JSON " }, GLOBAL_OPTIONS)).toBe("json");
    expect(resolveGuideOutputFormat({ format: "markdown" }, GLOBAL_OPTIONS)).toBe("markdown");
    expect(resolveGuideOutputFormat({}, { ...GLOBAL_OPTIONS, json: true })).toBe("json");
    expect(() => resolveGuideOutputFormat({ format: "html" }, GLOBAL_OPTIONS)).toThrow(PmCliError);
  });

  it("honors list mode and validates depth values", async () => {
    const result = await runGuide({ topic: "quickstart", list: true, depth: "standard" }, GLOBAL_OPTIONS);
    expect(result.mode).toBe("index");
    expect(result.depth).toBe("standard");
    expect(renderGuideMarkdown(result)).toContain("  - intent:");

    await expect(runGuide({ depth: "encyclopedic" }, GLOBAL_OPTIONS)).rejects.toMatchObject<PmCliError>({
      exitCode: EXIT_CODE.USAGE,
      message: "Guide depth must be one of brief|standard|deep",
    });
  });

  it("renders markdown for index and topic payloads", async () => {
    const index = await runGuide({}, GLOBAL_OPTIONS);
    const indexMarkdown = renderGuideMarkdown(index);
    expect(indexMarkdown).toContain("# pm guide");
    expect(indexMarkdown).toContain("## Topics");

    const topic = await runGuide({ topic: "quickstart", depth: "brief" }, GLOBAL_OPTIONS);
    const topicMarkdown = renderGuideMarkdown(topic as GuideResult);
    expect(topicMarkdown).toContain("# pm guide quickstart");
    expect(topicMarkdown).toContain("## Key commands");
  });
});

describe("guide doc resolution", () => {
  let tempRoot = "";
  let previousPackageRoot = "";

  afterEach(async () => {
    if (previousPackageRoot.length > 0) {
      process.env.PM_CLI_PACKAGE_ROOT = previousPackageRoot;
    } else {
      delete process.env.PM_CLI_PACKAGE_ROOT;
    }
    if (tempRoot.length > 0) {
      await rm(tempRoot, { recursive: true, force: true });
    }
    tempRoot = "";
    previousPackageRoot = "";
  });

  it("reports warnings when required topic docs are missing", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-guide-topic-"));
    await mkdir(path.join(tempRoot, "docs"), { recursive: true });
    await writeFile(path.join(tempRoot, "README.md"), "# temp\n", "utf8");

    previousPackageRoot = process.env.PM_CLI_PACKAGE_ROOT ?? "";
    process.env.PM_CLI_PACKAGE_ROOT = tempRoot;

    const result = await runGuide({ topic: "quickstart", depth: "standard" }, GLOBAL_OPTIONS);
    expect(result.mode).toBe("topic");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => warning.includes("docs/QUICKSTART.md"))).toBe(true);
  });

  it("renders standard excerpts, truncation markers, related topics, and warnings", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-guide-standard-"));
    await mkdir(path.join(tempRoot, "docs"), { recursive: true });
    await writeFile(path.join(tempRoot, "README.md"), "# temp\n", "utf8");
    await writeFile(
      path.join(tempRoot, "docs", "QUICKSTART.md"),
      Array.from({ length: 130 }, (_, index) => `line ${index + 1}`).join("\n"),
      "utf8",
    );

    previousPackageRoot = process.env.PM_CLI_PACKAGE_ROOT ?? "";
    process.env.PM_CLI_PACKAGE_ROOT = tempRoot;

    const result = await runGuide({ topic: "quickstart", depth: "standard" }, GLOBAL_OPTIONS);
    expect(result.docs.find((doc) => doc.path === "docs/QUICKSTART.md")).toMatchObject({
      exists: true,
      content_mode: "excerpt",
      truncated: true,
      line_count: 130,
    });
    expect(result.warnings).toContain("Missing required guide document: docs/COMMANDS.md");

    const markdown = renderGuideMarkdown(result);
    expect(markdown).toContain("_truncated for context efficiency_");
    expect(markdown).toContain("## Related topics");
    expect(markdown).toContain("## Warnings");
  });

  it("renders deep full document content with escaped code fences", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-guide-deep-"));
    await mkdir(path.join(tempRoot, "docs"), { recursive: true });
    await writeFile(path.join(tempRoot, "README.md"), "# temp\r\n```ts\r\nconsole.log('x')\r\n```\r\n", "utf8");
    await writeFile(path.join(tempRoot, "docs", "QUICKSTART.md"), "", "utf8");
    await writeFile(path.join(tempRoot, "docs", "COMMANDS.md"), "# commands\n", "utf8");

    previousPackageRoot = process.env.PM_CLI_PACKAGE_ROOT ?? "";
    process.env.PM_CLI_PACKAGE_ROOT = tempRoot;

    const result = await runGuide({ topic: "quickstart", depth: "deep" }, GLOBAL_OPTIONS);
    expect(result.docs[0]).toMatchObject({
      path: "README.md",
      exists: true,
      line_count: 4,
      content_mode: "full",
      truncated: false,
    });
    expect(result.docs.find((doc) => doc.path === "docs/QUICKSTART.md")).toMatchObject({
      line_count: 0,
      content: "",
    });

    const markdown = renderGuideMarkdown(result);
    expect(markdown).toContain("``\\`ts");
  });

  it("wraps non-missing document read failures", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-guide-read-error-"));
    await mkdir(path.join(tempRoot, "docs", "COMMANDS.md"), { recursive: true });

    previousPackageRoot = process.env.PM_CLI_PACKAGE_ROOT ?? "";
    process.env.PM_CLI_PACKAGE_ROOT = tempRoot;

    await expect(runGuide({ topic: "commands", depth: "standard" }, GLOBAL_OPTIONS)).rejects.toMatchObject<PmCliError>({
      exitCode: EXIT_CODE.GENERIC_FAILURE,
      message: 'Failed to read guide document "docs/COMMANDS.md".',
    });
  });
});
