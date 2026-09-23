import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../helpers/scriptModule";

interface GeneratorModule { main: () => Promise<void> }
const harness = createScriptHarness();
const root = process.cwd();
const sourceFiles = new Map(await Promise.all([
  "templates/agent-plugins/pm-mcp-server.mjs",
  "templates/agent-plugins/plugin-runtime.mjs",
].map(async (file) => [path.join(root, file), await readFile(path.join(root, file), "utf8")] as const)));

describe("gen-plugin-mcp-wrappers", () => {
  it("copies both complete sources into each plugin and detects drift", async () => {
    const generated = new Map<string, string>();
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn(async (target: string) => generated.get(String(target)) ?? sourceFiles.get(String(target)) ?? ""),
      writeFile: vi.fn(async (target: string, content: string) => { generated.set(String(target), content); }),
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", "/nonmatching/runner"];
    const writer = await harness.importModule<GeneratorModule>("scripts/gen-plugin-mcp-wrappers.mjs");
    await writer.main();
    expect(generated.size).toBe(4);
    for (const plugin of ["pm-claude", "pm-codex"]) {
      expect(generated.get(path.join(root, "plugins", plugin, "scripts/pm-mcp-server.mjs"))).toBe(sourceFiles.get(path.join(root, "templates/agent-plugins/pm-mcp-server.mjs")));
      expect(generated.get(path.join(root, "plugins", plugin, "scripts/plugin-runtime.mjs"))).toBe(sourceFiles.get(path.join(root, "templates/agent-plugins/plugin-runtime.mjs")));
    }
    process.argv.push("--check");
    const checker = await harness.importModule<GeneratorModule>("scripts/gen-plugin-mcp-wrappers.mjs");
    await expect(checker.main()).resolves.toBeUndefined();
    generated.set(path.join(root, "plugins/pm-codex/scripts/plugin-runtime.mjs"), "stale");
    const exit = harness.mockProcessExit();
    await expect(checker.main()).rejects.toThrow("EXIT:1");
    exit.mockRestore();
  });

  it("reports missing plugin targets as drift", async () => {
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn(async (target: string) => {
        const source = sourceFiles.get(String(target));
        if (source !== undefined) return source;
        throw new Error("missing target");
      }),
      writeFile: vi.fn(),
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv = ["node", "/nonmatching/runner", "--check"];
    const exit = harness.mockProcessExit();
    const checker = await harness.importModule<GeneratorModule>("scripts/gen-plugin-mcp-wrappers.mjs");
    await expect(checker.main()).rejects.toThrow("EXIT:1");
    exit.mockRestore();
  });
});
