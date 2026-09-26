import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../helpers/scriptModule";

interface GeneratorModule { main: () => Promise<void> }

const harness = createScriptHarness();
const root = process.cwd();
const sourceRoot = path.join(root, "templates", "agent-skills");
const skills = ["pm-audit", "pm-developer", "pm-planner", "pm-release", "pm-workflow"];
const aliases = ["pm-auditor", "pm-native"];
const files = ["SKILL.md", "agents/openai.yaml"];

/** Model only the filesystem boundary, leaving the real projection algorithm under test. */
function mockSkillTree({ emptySource = false, unexpected = false } = {}) {
  const contents = new Map<string, string>();
  const mkdir = vi.fn(async () => undefined);
  const writeFile = vi.fn(async (target: string, content: string) => {
    contents.set(String(target), content);
  });
  for (const skill of [...skills, ...aliases]) {
    for (const file of files) {
      const origin = aliases.includes(skill) ? path.join(sourceRoot, "codex-aliases") : sourceRoot;
      const value = `${skill}:${file}`;
      contents.set(path.join(origin, skill, file), value);
      for (const plugin of aliases.includes(skill) ? ["pm-codex"] : ["pm-claude", "pm-codex"]) {
        contents.set(path.join(root, "plugins", plugin, "skills", skill, file), value);
      }
    }
  }
  vi.doMock("node:fs/promises", () => ({
    mkdir,
    writeFile,
    readFile: vi.fn(async (target: string) => {
      const value = contents.get(String(target));
      if (value === undefined) throw new Error("missing file");
      return value;
    }),
    readdir: vi.fn(async (target: string) => {
      if (target === sourceRoot) return emptySource ? ["codex-aliases"] : [...skills, "codex-aliases"];
      if (target === path.join(sourceRoot, "codex-aliases")) return aliases;
      if (target === path.join(root, "plugins", "pm-codex", "skills")) {
        return unexpected ? [...skills, ...aliases, "unowned"] : [...skills, ...aliases];
      }
      return skills;
    }),
  }));
  return { contents, mkdir, writeFile };
}

describe("gen-agent-plugin-skills", () => {
  it("keeps both plugin skill bundles in sync and repairs only missing or stale files", async () => {
    const { contents, mkdir, writeFile } = mockSkillTree();
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", "/nonmatching/runner", "--check"];
    const generator = await harness.importModule<GeneratorModule>("scripts/gen-agent-plugin-skills.mjs");
    await expect(generator.main()).resolves.toBeUndefined();
    expect(writeFile).not.toHaveBeenCalled();

    const stale = path.join(root, "plugins", "pm-claude", "skills", "pm-audit", "SKILL.md");
    const missing = path.join(root, "plugins", "pm-codex", "skills", "pm-native", "agents/openai.yaml");
    contents.set(stale, "stale");
    contents.delete(missing);
    await expect(generator.main()).rejects.toThrow(new RegExp(`Agent plugin skills drifted[\\s\\S]*pm-audit[\\s\\S]*pm-native`));
    expect(writeFile).not.toHaveBeenCalled();

    process.argv = ["node", "/nonmatching/runner"];
    await expect(generator.main()).resolves.toBeUndefined();
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(mkdir).toHaveBeenCalledTimes(2);
    expect(contents.get(stale)).toBe("pm-audit:SKILL.md");
    expect(contents.get(missing)).toBe("pm-native:agents/openai.yaml");
    process.argv.push("--check");
    await expect(generator.main()).resolves.toBeUndefined();
  });

  it("rejects unowned published skill directories", async () => {
    mockSkillTree({ unexpected: true });
    process.argv = ["node", "/nonmatching/runner", "--check"];
    const generator = await harness.importModule<GeneratorModule>("scripts/gen-agent-plugin-skills.mjs");
    await expect(generator.main()).rejects.toThrow("pm-codex has unowned skill directories: unowned");
  });

  it("rejects an empty canonical source tree", async () => {
    mockSkillTree({ emptySource: true });
    process.argv = ["node", "/nonmatching/runner", "--check"];
    const generator = await harness.importModule<GeneratorModule>("scripts/gen-agent-plugin-skills.mjs");
    await expect(generator.main()).rejects.toThrow("Canonical Agent Skills tree is empty");
  });
});
