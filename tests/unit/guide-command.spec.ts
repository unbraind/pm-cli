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
});
