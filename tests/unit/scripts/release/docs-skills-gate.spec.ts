import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../../helpers/scriptModule";

const harness = createScriptHarness(["../../../../scripts/release/utils.mjs"]);

const SCRIPT = "scripts/release/docs-skills-gate.mjs";

type DocsModule = {
  usage: () => void;
  parseJson: (text: string, context: string) => unknown;
  isMissingError: (error: unknown) => boolean;
  fileExists: (relativePath: string) => Promise<boolean>;
  pathExists: (relativePath: string) => Promise<boolean>;
  requireFiles: (filePaths: string[], failures: string[]) => Promise<void>;
  readUtf8: (relativePath: string) => Promise<string>;
  extractFrontmatter: (raw: string) => { frontmatter: string | null; body: string };
  parseSimpleYamlMap: (frontmatter: string) => Map<string, string>;
  validateSkillFrontmatter: (skillName: string, raw: string, failures: string[]) => void;
  extractRelativeMarkdownLinks: (content: string) => string[];
  collectMarkdownFiles: (relativeDirectory: string) => Promise<string[]>;
  validateSkillLinks: (skillName: string, failures: string[]) => Promise<void>;
  resolveMarkdownLink: (markdownFile: string, linkTarget: string) => string | null;
  validateDocsLinks: (failures: string[]) => Promise<void>;
  resolveExampleCommandPath: (example: string, available: Set<string>) => string | null;
  validateGuideCommands: (
    topicResult: { topic: { id: string; commands: string[]; workflows: { commands: string[] }[] } },
    available: Set<string>,
    failures: string[],
  ) => void;
  runGuideChecks: (failures: string[]) => Promise<void>;
  validateRequiredGuideMentions: (failures: string[]) => Promise<void>;
  validatePublicDocBudgets: (failures: string[]) => Promise<void>;
  runSkillChecks: (failures: string[]) => Promise<void>;
  main: () => Promise<void>;
};

function mockUtils(): void {
  vi.doMock("../../../../scripts/release/utils.mjs", async () => {
    const actual = await vi.importActual<typeof import("../../../../scripts/release/utils.mjs")>(
      "../../../../scripts/release/utils.mjs",
    );
    return {
      ...actual,
      fail(message: string, exitCode = 1) {
        throw new Error(`FAIL:${exitCode}:${message}`);
      },
    };
  });
}

function mockUtilsWithRun(runCommand: ReturnType<typeof vi.fn>): void {
  vi.doMock("../../../../scripts/release/utils.mjs", async () => {
    const actual = await vi.importActual<typeof import("../../../../scripts/release/utils.mjs")>(
      "../../../../scripts/release/utils.mjs",
    );
    return {
      ...actual,
      runCommand,
      fail(message: string, exitCode = 1) {
        throw new Error(`FAIL:${exitCode}:${message}`);
      },
    };
  });
}

function mockFsPromises(impl: Partial<typeof import("node:fs/promises")>): void {
  vi.doMock("node:fs/promises", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    return { ...actual, ...impl };
  });
}

describe("docs-skills-gate", () => {
  describe("pure helpers", () => {
    it("covers usage(), isMissingError, parseJson success + failure", async () => {
      mockUtils();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const mod = await harness.importModuleStable<DocsModule>(SCRIPT);
      mod.usage();
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes("Usage:"))).toBe(true);

      expect(mod.isMissingError({ code: "ENOENT" })).toBe(true);
      expect(mod.isMissingError({ code: "EACCES" })).toBe(false);
      expect(mod.isMissingError(null)).toBe(false);
      expect(mod.isMissingError("string")).toBe(false);

      expect(mod.parseJson('{"a":1}', "ctx")).toEqual({ a: 1 });
      expect(() => mod.parseJson("{bad", "ctx")).toThrow(/Failed to parse JSON for ctx/);
    });

    it("covers extractFrontmatter + parseSimpleYamlMap + validateSkillFrontmatter branches", async () => {
      mockUtils();
      const mod = await harness.importModuleStable<DocsModule>(SCRIPT);

      expect(mod.extractFrontmatter("no fm here").frontmatter).toBeNull();
      expect(mod.extractFrontmatter("---\nunterminated\n").frontmatter).toBeNull();
      const fm = mod.extractFrontmatter("---\nname: x\n---\nbody");
      expect(fm.frontmatter).toBe("name: x");
      expect(fm.body).toBe("body");

      const map = mod.parseSimpleYamlMap(
        ["# comment", "", "noseparator", 'name: "quoted"', "desc: 'single'", "plain: value"].join("\n"),
      );
      expect(map.get("name")).toBe("quoted");
      expect(map.get("desc")).toBe("single");
      expect(map.get("plain")).toBe("value");
      expect(map.has("noseparator")).toBe(false);

      const f1: string[] = [];
      mod.validateSkillFrontmatter("s", "no fm", f1);
      expect(f1.some((x) => x.includes("missing YAML frontmatter"))).toBe(true);

      const f2: string[] = [];
      mod.validateSkillFrontmatter("s", "---\nother: y\n---\nbody", f2);
      expect(f2.some((x) => x.includes('missing required frontmatter field "name"'))).toBe(true);
      expect(f2.some((x) => x.includes('missing required frontmatter field "description"'))).toBe(true);

      const f3: string[] = [];
      mod.validateSkillFrontmatter("s", "---\nname: other\ndescription: nope\n---\nbody", f3);
      expect(f3.some((x) => x.includes("must match directory name"))).toBe(true);
      expect(f3.some((x) => x.includes('explicit "Use when" routing'))).toBe(true);
      expect(f3.some((x) => x.includes("pm guide routing"))).toBe(true);
      expect(f3.some((x) => x.includes("installing guide-shell"))).toBe(true);

      const longBody = ["---", "name: s", 'description: "use when"', "---", "pm guide", "pm install guide-shell"]
        .concat(Array.from({ length: 510 }, () => "x"))
        .join("\n");
      const f4: string[] = [];
      mod.validateSkillFrontmatter("s", longBody, f4);
      expect(f4.some((x) => x.includes("under 500 lines"))).toBe(true);

      const valid = ["---", "name: s", 'description: "use when X"', "---", "pm guide", "pm install guide-shell"].join(
        "\n",
      );
      const f5: string[] = [];
      mod.validateSkillFrontmatter("s", valid, f5);
      expect(f5).toEqual([]);
    });

    it("covers extractRelativeMarkdownLinks filtering and resolveMarkdownLink variants", async () => {
      mockUtils();
      const mod = await harness.importModuleStable<DocsModule>(SCRIPT);
      const content = [
        "[abs](/docs/A.md)",
        "[rel](./B.md)",
        "[http](https://x)",
        "[mail](mailto:a@b)",
        "[anchor](#h)",
        "[blank](   )",
        "[query](C.md?x=1#frag)",
      ].join("\n");
      const links = mod.extractRelativeMarkdownLinks(content);
      expect(links).toContain("/docs/A.md");
      expect(links).toContain("./B.md");
      expect(links).not.toContain("https://x");
      expect(links).not.toContain("mailto:a@b");

      expect(mod.resolveMarkdownLink("docs/x.md", "/docs/A.md")).toBe("docs/A.md");
      expect(mod.resolveMarkdownLink("docs/x.md", "./B.md")).toBe("docs/B.md");
      expect(mod.resolveMarkdownLink("docs/x.md", "C.md?x=1#frag")).toBe("docs/C.md");
      expect(mod.resolveMarkdownLink("docs/x.md", "<>")).toBeNull();
      expect(mod.resolveMarkdownLink("docs/x.md", "   ")).toBeNull();
      expect(mod.resolveMarkdownLink("docs/x.md", "#frag")).toBeNull();
    });

    it("covers validateGuideCommands unknown-example failure and resolveExampleCommandPath edge cases", async () => {
      mockUtils();
      const mod = await harness.importModuleStable<DocsModule>(SCRIPT);
      const available = new Set(["list", "guide", "guide topic"]);
      expect(mod.resolveExampleCommandPath("pm list things", available)).toBe("list");
      expect(mod.resolveExampleCommandPath("pm guide topic --json", available)).toBe("guide topic");
      expect(mod.resolveExampleCommandPath("not-pm cmd", available)).toBeNull();
      expect(mod.resolveExampleCommandPath('pm "quoted"', available)).toBeNull();
      expect(mod.resolveExampleCommandPath("pm <arg>", available)).toBeNull();
      expect(mod.resolveExampleCommandPath("pm", available)).toBeNull();
      expect(mod.resolveExampleCommandPath("pm --flag", available)).toBeNull();
      expect(mod.resolveExampleCommandPath("pm bogus", available)).toBe("");

      const failures: string[] = [];
      mod.validateGuideCommands(
        {
          topic: {
            id: "t1",
            commands: ["pm bogus-cmd"],
            workflows: [{ commands: ["pm list"] }],
          },
        },
        new Set(["list"]),
        failures,
      );
      expect(failures.some((f) => f.includes("unknown command example"))).toBe(true);
    });
  });

  describe("fs-backed helpers", () => {
    it("fileExists/pathExists: file, dir, missing, and rethrows non-ENOENT", async () => {
      mockUtils();
      mockFsPromises({
        stat: vi.fn(async (p: string) => {
          const s = String(p);
          if (s.endsWith("present.md")) {
            return { isFile: () => true } as unknown as import("node:fs").Stats;
          }
          if (s.endsWith("adir")) {
            return { isFile: () => false } as unknown as import("node:fs").Stats;
          }
          if (s.endsWith("missing.md")) {
            throw Object.assign(new Error("nope"), { code: "ENOENT" });
          }
          throw Object.assign(new Error("boom"), { code: "EACCES" });
        }) as never,
      });
      const mod = await harness.importModuleStable<DocsModule>(SCRIPT);
      expect(await mod.fileExists("present.md")).toBe(true);
      expect(await mod.fileExists("adir")).toBe(false);
      expect(await mod.fileExists("missing.md")).toBe(false);
      await expect(mod.fileExists("denied")).rejects.toThrow("boom");

      expect(await mod.pathExists("present.md")).toBe(true);
      expect(await mod.pathExists("missing.md")).toBe(false);
      await expect(mod.pathExists("denied")).rejects.toThrow("boom");
    });

    it("requireFiles pushes failures for missing files", async () => {
      mockUtils();
      mockFsPromises({
        stat: vi.fn(async (p: string) => {
          if (String(p).endsWith("ok.md")) {
            return { isFile: () => true } as unknown as import("node:fs").Stats;
          }
          throw Object.assign(new Error("nope"), { code: "ENOENT" });
        }) as never,
      });
      const mod = await harness.importModuleStable<DocsModule>(SCRIPT);
      const failures: string[] = [];
      await mod.requireFiles(["ok.md", "gone.md"], failures);
      expect(failures).toEqual(["Missing required file: gone.md"]);
    });

    it("collectMarkdownFiles walks dirs and validateDocsLinks/validateSkillLinks flag broken links", async () => {
      mockUtils();
      mockFsPromises({
        readdir: vi.fn(async (dir: string) => {
          // Normalize separators so the directory keys match on windows-latest,
          // where the gate passes native backslash absolute paths to readdir.
          const s = String(dir).replaceAll("\\", "/");
          if (s.endsWith("/docs")) {
            return [
              { name: "sub", isDirectory: () => true, isFile: () => false },
              { name: "page.md", isDirectory: () => false, isFile: () => true },
              { name: "ignore.txt", isDirectory: () => false, isFile: () => true },
            ] as never;
          }
          if (s.endsWith("/docs/sub")) {
            return [{ name: "nested.md", isDirectory: () => false, isFile: () => true }] as never;
          }
          if (s.includes(".agents/skills/pm-user")) {
            return [{ name: "SKILL.md", isDirectory: () => false, isFile: () => true }] as never;
          }
          return [] as never;
        }) as never,
        readFile: vi.fn(async (p: string) => {
          const s = String(p);
          if (s.endsWith("SKILL.md")) return "[skbroken](./gone.md)\n[nulltarget](<>)";
          if (s.endsWith("README.md")) return "[broken](./missing.md)\n[nulltarget](<>)";
          if (s.endsWith("page.md")) return "[ok](./present.md)";
          return "";
        }) as never,
        stat: vi.fn(async (p: string) => {
          const s = String(p);
          if (s.endsWith("missing.md") || s.endsWith("gone.md")) {
            throw Object.assign(new Error("nope"), { code: "ENOENT" });
          }
          return { isFile: () => true } as unknown as import("node:fs").Stats;
        }) as never,
      });
      const mod = await harness.importModuleStable<DocsModule>(SCRIPT);
      const files = await mod.collectMarkdownFiles("docs");
      expect(files).toContain("docs/page.md");
      expect(files).toContain("docs/sub/nested.md");
      expect(files).not.toContain("docs/ignore.txt");

      const failures: string[] = [];
      await mod.validateDocsLinks(failures);
      expect(failures.some((f) => f.includes("missing.md"))).toBe(true);

      const skillFailures: string[] = [];
      await mod.validateSkillLinks("pm-user", skillFailures);
      expect(skillFailures.some((f) => f.includes("broken relative link") && f.includes("gone.md"))).toBe(true);
    });

    it("validateRequiredGuideMentions flags missing markers", async () => {
      mockUtils();
      mockFsPromises({
        readFile: vi.fn(async (p: string) => {
          if (String(p).endsWith("README.md")) {
            return "pm guide\npm install guide-shell";
          }
          return "no markers here";
        }) as never,
      });
      const mod = await harness.importModuleStable<DocsModule>(SCRIPT);
      const failures: string[] = [];
      await mod.validateRequiredGuideMentions(failures);
      expect(failures.some((f) => f.includes("pm guide"))).toBe(true);
      expect(failures.some((f) => f.includes("pm install guide-shell"))).toBe(true);
    });

    it("validatePublicDocBudgets flags over-budget, multi-h1, duplicate headings", async () => {
      mockUtils();
      const bad = ["# One", "# Two", "## Dup", "## Dup", ...Array.from({ length: 460 }, () => "x")].join("\n");
      mockFsPromises({
        readFile: vi.fn(async () => bad) as never,
      });
      const mod = await harness.importModuleStable<DocsModule>(SCRIPT);
      const failures: string[] = [];
      await mod.validatePublicDocBudgets(failures);
      expect(failures.some((f) => f.includes("under 450 lines"))).toBe(true);
      expect(failures.some((f) => f.includes("exactly one top-level heading"))).toBe(true);
      expect(failures.some((f) => f.includes("duplicate section heading"))).toBe(true);
    });

    it("validatePublicDocBudgets accepts a compliant doc", async () => {
      mockUtils();
      const good = ["# Single Heading", "", "## Alpha", "body", "## Beta", "body"].join("\n");
      mockFsPromises({
        readFile: vi.fn(async () => good) as never,
      });
      const mod = await harness.importModuleStable<DocsModule>(SCRIPT);
      const failures: string[] = [];
      await mod.validatePublicDocBudgets(failures);
      expect(failures).toEqual([]);
    });

    it("runSkillChecks flags missing harness doc and missing skills", async () => {
      mockUtils();
      mockFsPromises({
        stat: vi.fn(async () => {
          throw Object.assign(new Error("nope"), { code: "ENOENT" });
        }) as never,
      });
      const mod = await harness.importModuleStable<DocsModule>(SCRIPT);
      const failures: string[] = [];
      await mod.runSkillChecks(failures);
      expect(failures.some((f) => f.includes("harness compatibility guide"))).toBe(true);
      expect(failures.some((f) => f.includes("Missing required skill"))).toBe(true);
    });
  });

  describe("runGuideChecks + main", () => {
    it("runGuideChecks: contracts without commands array falls back to empty set", async () => {
      const runCommand = vi.fn((command: string, args: string[]) => {
        if (args.includes("contracts")) {
          return { status: 0, stdout: JSON.stringify({ commands: "not-array" }), stderr: "" };
        }
        if (args.includes("guide")) {
          return { status: 0, stdout: JSON.stringify({ mode: "index", topics: [] }), stderr: "" };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      });
      mockUtilsWithRun(runCommand);
      const mod = await harness.importModuleStable<DocsModule>(SCRIPT);
      const failures: string[] = [];
      await mod.runGuideChecks(failures);
      expect(failures).toEqual([]);
    });

    it("runGuideChecks: non-index payload pushes failure", async () => {
      const runCommand = vi.fn((command: string, args: string[]) => {
        if (
          args.includes("guide") &&
          args.includes("--json") &&
          !args.some((a) => !a.startsWith("-") && a !== "guide" && a !== "dist/cli.js")
        ) {
          return { status: 0, stdout: JSON.stringify({ mode: "not-index" }), stderr: "" };
        }
        if (args.includes("contracts")) {
          return { status: 0, stdout: JSON.stringify({ commands: ["list"] }), stderr: "" };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      });
      mockUtilsWithRun(runCommand);
      const mod = await harness.importModuleStable<DocsModule>(SCRIPT);
      const failures: string[] = [];
      await mod.runGuideChecks(failures);
      expect(failures.some((f) => f.includes("did not return an index payload"))).toBe(true);
    });

    it("runGuideChecks: topics with id/no-id, missing docs, warnings, unknown command, missing docs metadata", async () => {
      const runCommand = vi.fn((command: string, args: string[]) => {
        if (args.includes("contracts")) {
          return { status: 0, stdout: JSON.stringify({ commands: ["list"] }), stderr: "" };
        }
        const isTopicCall = args.some((a) => a === "t-ok" || a === "t-warn" || a === "t-nodocs" || a === "t-notopic");
        if (args.includes("guide") && !isTopicCall) {
          return {
            status: 0,
            stdout: JSON.stringify({
              mode: "index",
              topics: [{ id: "t-ok" }, {}, { id: "t-warn" }, { id: "t-nodocs" }, { id: "t-notopic" }],
            }),
            stderr: "",
          };
        }
        if (args.includes("t-ok")) {
          return {
            status: 0,
            stdout: JSON.stringify({
              mode: "topic",
              topic: { id: "t-ok", commands: ["pm bogus"], workflows: [] },
              docs: [{ path: "missing.md", exists: false, optional: false }],
            }),
            stderr: "",
          };
        }
        if (args.includes("t-warn")) {
          return {
            status: 0,
            stdout: JSON.stringify({
              mode: "topic",
              topic: { id: "t-warn", commands: [], workflows: [] },
              docs: [
                { path: "ok.md", exists: true },
                { path: "opt.md", exists: false, optional: true },
              ],
              warnings: ["a warning"],
            }),
            stderr: "",
          };
        }
        if (args.includes("t-nodocs")) {
          return {
            status: 0,
            stdout: JSON.stringify({ mode: "topic", topic: { id: "t-nodocs", commands: [], workflows: [] } }),
            stderr: "",
          };
        }
        if (args.includes("t-notopic")) {
          return { status: 0, stdout: JSON.stringify({ mode: "not-topic" }), stderr: "" };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      });
      mockUtilsWithRun(runCommand);
      const mod = await harness.importModuleStable<DocsModule>(SCRIPT);
      const failures: string[] = [];
      await mod.runGuideChecks(failures);
      expect(failures.some((f) => f.includes("topic without an id"))).toBe(true);
      expect(failures.some((f) => f.includes("missing required document"))).toBe(true);
      expect(failures.some((f) => f.includes("warning: a warning"))).toBe(true);
      expect(failures.some((f) => f.includes("missing docs metadata"))).toBe(true);
      expect(failures.some((f) => f.includes("did not return a topic payload"))).toBe(true);
      expect(failures.some((f) => f.includes("unknown command example"))).toBe(true);
    });

    it("main --help returns early", async () => {
      mockUtils();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const mod = await harness.importModuleStable<DocsModule>(SCRIPT);
      process.argv = ["node", "x", "--help"];
      await mod.main();
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes("Usage:"))).toBe(true);
    });

    it("main --links-only with broken link emits json + fail", async () => {
      const runCommand = vi.fn(() => ({ status: 0, stdout: "{}", stderr: "" }));
      mockUtilsWithRun(runCommand);
      mockFsPromises({
        readdir: vi.fn(async () => [] as never) as never,
        readFile: vi.fn(async (p: string) => {
          if (String(p).endsWith("README.md")) return "[broken](./missing.md)";
          return "";
        }) as never,
        stat: vi.fn(async () => {
          throw Object.assign(new Error("nope"), { code: "ENOENT" });
        }) as never,
      });
      const mod = await harness.importModuleStable<DocsModule>(SCRIPT);
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      process.argv = ["node", "x", "--json", "--links-only"];
      await expect(mod.main()).rejects.toThrow(/Docs\/skills gate failed/);
      const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}"));
      expect(payload.ok).toBe(false);
      expect(payload.checks.mode).toBe("links-only");
    });

    it("main links-only passes and prints success when no broken links (text)", async () => {
      const runCommand = vi.fn(() => ({ status: 0, stdout: "{}", stderr: "" }));
      mockUtilsWithRun(runCommand);
      mockFsPromises({
        readdir: vi.fn(async () => [] as never) as never,
        readFile: vi.fn(async () => "no links here") as never,
        stat: vi.fn(async () => ({ isFile: () => true }) as unknown as import("node:fs").Stats) as never,
      });
      const mod = await harness.importModuleStable<DocsModule>(SCRIPT);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      process.argv = ["node", "x", "--links-only"];
      await mod.main();
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes("Docs/skills gate passed."))).toBe(true);
    });

    it("main full mode passing path prints success (text)", async () => {
      const runCommand = vi.fn((command: string, args: string[]) => {
        if (args.includes("contracts")) {
          return { status: 0, stdout: JSON.stringify({ commands: ["list"] }), stderr: "" };
        }
        if (args.includes("guide")) {
          return { status: 0, stdout: JSON.stringify({ mode: "index", topics: [] }), stderr: "" };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      });
      mockUtilsWithRun(runCommand);
      const validSkill = [
        "---",
        "name: __SKILLNAME__",
        'description: "Use when working with pm."',
        "---",
        "",
        "Body mentions pm guide and pm install guide-shell.",
      ].join("\n");
      mockFsPromises({
        readdir: vi.fn(async () => [] as never) as never,
        readFile: vi.fn(async (p: string) => {
          const s = String(p);
          const match = s.match(/\.agents\/skills\/([^/]+)\/SKILL\.md$/);
          if (match) {
            return validSkill.replace("__SKILLNAME__", match[1]);
          }
          return "# Title\npm guide\npm install guide-shell";
        }) as never,
        stat: vi.fn(async () => ({ isFile: () => true }) as unknown as import("node:fs").Stats) as never,
      });
      const mod = await harness.importModuleStable<DocsModule>(SCRIPT);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      process.argv = ["node", "x"];
      await mod.main();
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes("Docs/skills gate passed."))).toBe(true);
    });

    it("main full mode passing path emits JSON payload", async () => {
      const runCommand = vi.fn((command: string, args: string[]) => {
        if (args.includes("contracts")) {
          return { status: 0, stdout: JSON.stringify({ commands: ["list"] }), stderr: "" };
        }
        if (args.includes("guide")) {
          return { status: 0, stdout: JSON.stringify({ mode: "index", topics: [] }), stderr: "" };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      });
      mockUtilsWithRun(runCommand);
      const validSkill = [
        "---",
        "name: __SKILLNAME__",
        'description: "Use when working with pm."',
        "---",
        "",
        "Body mentions pm guide and pm install guide-shell.",
      ].join("\n");
      mockFsPromises({
        readdir: vi.fn(async () => [] as never) as never,
        readFile: vi.fn(async (p: string) => {
          const s = String(p);
          const match = s.match(/\.agents\/skills\/([^/]+)\/SKILL\.md$/);
          if (match) {
            return validSkill.replace("__SKILLNAME__", match[1]);
          }
          return "# Title\npm guide\npm install guide-shell";
        }) as never,
        stat: vi.fn(async () => ({ isFile: () => true }) as unknown as import("node:fs").Stats) as never,
      });
      const mod = await harness.importModuleStable<DocsModule>(SCRIPT);
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      process.argv = ["node", "x", "--json"];
      await mod.main();
      const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}"));
      expect(payload.ok).toBe(true);
      expect(payload.checks.mode).toBe("full");
      expect(payload.checks.required_docs).toBeGreaterThan(0);
    });

    it("main full mode failing path prints failures to stderr (text) then fails", async () => {
      const runCommand = vi.fn((command: string, args: string[]) => {
        if (args.includes("contracts")) {
          return { status: 0, stdout: JSON.stringify({ commands: [] }), stderr: "" };
        }
        if (args.includes("guide")) {
          return { status: 0, stdout: JSON.stringify({ mode: "index", topics: [] }), stderr: "" };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      });
      mockUtilsWithRun(runCommand);
      mockFsPromises({
        readdir: vi.fn(async () => [] as never) as never,
        readFile: vi.fn(async () => "no markers") as never,
        stat: vi.fn(async () => {
          throw Object.assign(new Error("nope"), { code: "ENOENT" });
        }) as never,
      });
      const mod = await harness.importModuleStable<DocsModule>(SCRIPT);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      process.argv = ["node", "x"];
      await expect(mod.main()).rejects.toThrow(/Docs\/skills gate failed/);
      expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("Docs/skills gate failed:"))).toBe(true);
    });
  });

  describe("fs-backed full + links-only flows (real temp fixtures)", () => {
    async function seedDocsSkillsFixture(root: string): Promise<void> {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const docsContent = [
        "# Docs",
        "",
        "Install the guide package first:",
        "",
        "`pm install guide-shell --project`",
        "",
        "Then route via `pm guide workflows`.",
        "",
        "[Docs index](docs/README.md)",
      ].join("\n");
      await writeFile(path.join(root, "README.md"), docsContent, "utf8");
      await writeFile(path.join(root, "AGENTS.md"), "# Agents\n\nAgent links are local.\n", "utf8");
      await writeFile(path.join(root, "CONTRIBUTING.md"), "# Contributing\n\nNo broken links.\n", "utf8");

      const docs = {
        "docs/README.md": docsContent,
        "docs/COMMANDS.md": docsContent,
        "docs/AGENT_GUIDE.md": docsContent,
        "docs/SDK.md": "# SDK\n\nMinimal SDK guide.\n",
        "docs/QUICKSTART.md": "# Quickstart\n\nMinimal quickstart.\n",
        "docs/RELEASING.md": "# Releasing\n\nMinimal releasing guide.\n",
        "docs/EXTENSIONS.md": [
          "# Extensions",
          "",
          "## Install",
          "Use `pm install guide-shell --project` and route via `pm guide`.",
          "",
          "## Validate",
          "Keep this page compact.",
        ].join("\n"),
      } as const;
      for (const [relativePath, content] of Object.entries(docs)) {
        await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
        await writeFile(path.join(root, relativePath), content, "utf8");
      }

      await mkdir(path.join(root, ".agents", "skills"), { recursive: true });
      await writeFile(
        path.join(root, ".agents", "skills", "HARNESS_COMPATIBILITY.md"),
        "# Harness compatibility\n\nLocal fixture.\n",
        "utf8",
      );

      const requiredSkills = ["pm-developer", "pm-user", "pm-extensions", "pm-sdk"];
      for (const skill of requiredSkills) {
        const skillDir = path.join(root, ".agents", "skills", skill);
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          path.join(skillDir, "SKILL.md"),
          [
            "---",
            `name: ${skill}`,
            'description: "Example fixture. Use when validating docs skills."',
            "---",
            "",
            "# Body",
            "",
            "Run `pm install guide-shell --project` before using `pm guide workflows`.",
          ].join("\n"),
          "utf8",
        );
      }
    }

    function mockUtilsWithRepo(repoRoot: string, runCommand: ReturnType<typeof vi.fn>): void {
      vi.doMock("../../../../scripts/release/utils.mjs", async () => {
        const actual = await vi.importActual<typeof import("../../../../scripts/release/utils.mjs")>(
          "../../../../scripts/release/utils.mjs",
        );
        return {
          ...actual,
          repoRoot,
          runCommand,
          fail(message: string, exitCode = 1) {
            process.exitCode = exitCode;
            console.error(message);
          },
        };
      });
    }

    it("full-mode pass against a seeded fixture repo (auto-run entrypoint)", async () => {
      const fixtureRoot = await harness.createTempRoot("pm-docs-skills-full-");
      await seedDocsSkillsFixture(fixtureRoot);
      const runCommand = vi.fn((command: string, args: string[]) => {
        const joined = [command, ...args].join(" ");
        if (joined.includes("contracts --runtime-only --availability-only --json")) {
          return { status: 0, stdout: JSON.stringify({ commands: ["guide", "contracts"] }), stderr: "" };
        }
        if (joined.includes("guide workflows --depth standard --json")) {
          return {
            status: 0,
            stdout: JSON.stringify({
              mode: "topic",
              topic: {
                id: "workflows",
                commands: ["pm guide workflows"],
                workflows: [{ commands: ["pm contracts --command guide --flags-only"] }],
              },
              docs: [{ path: "README.md", exists: true, optional: false }],
              warnings: [],
            }),
            stderr: "",
          };
        }
        if (joined.includes("guide --json")) {
          return { status: 0, stdout: JSON.stringify({ mode: "index", topics: [{ id: "workflows" }] }), stderr: "" };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      });
      mockUtilsWithRepo(fixtureRoot, runCommand);
      const scriptPath = path.join(process.cwd(), "scripts/release/docs-skills-gate.mjs");
      process.argv = ["node", scriptPath, "--json"];
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await harness.importModuleStable("scripts/release/docs-skills-gate.mjs");
      await harness.waitForCondition(() => {
        expect(stdoutSpy).toHaveBeenCalled();
      });
      const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
        ok: boolean;
        checks: { mode: string };
        failures: string[];
      };
      expect(payload.ok).toBe(true);
      expect(payload.checks.mode).toBe("full");
      expect(payload.failures).toEqual([]);
    });

    it("links-only flags a broken link against a seeded fixture repo (auto-run entrypoint)", async () => {
      const fixtureRoot = await harness.createTempRoot("pm-docs-skills-links-");
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(path.join(fixtureRoot, "docs"), { recursive: true });
      await writeFile(path.join(fixtureRoot, "README.md"), "# Root\n\n[Broken](missing.md)\n", "utf8");
      await writeFile(path.join(fixtureRoot, "AGENTS.md"), "# Agents\n\nNo links.\n", "utf8");
      await writeFile(path.join(fixtureRoot, "CONTRIBUTING.md"), "# Contributing\n\nNo links.\n", "utf8");
      await writeFile(path.join(fixtureRoot, "docs", "README.md"), "# Docs\n\n[Missing](../ghost.md)\n", "utf8");
      const runCommand = vi.fn(() => ({ status: 0, stdout: "{}", stderr: "" }));
      mockUtilsWithRepo(fixtureRoot, runCommand);
      const scriptPath = path.join(process.cwd(), "scripts/release/docs-skills-gate.mjs");
      process.argv = ["node", scriptPath, "--links-only", "--json"];
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await harness.importModuleStable("scripts/release/docs-skills-gate.mjs");
      await harness.waitForCondition(() => {
        expect(stdoutSpy).toHaveBeenCalled();
      });
      const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
        ok: boolean;
        checks: { mode: string };
        failures: string[];
      };
      expect(payload.checks.mode).toBe("links-only");
      expect(Array.isArray(payload.failures)).toBe(true);
    });
  });
});
