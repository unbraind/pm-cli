import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSettings, writeSettings } from "../../src/core/store/settings.js";
import { writeTestExtension } from "../helpers/extensions.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

interface SourceCliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  json?: unknown;
}

function runSourceCli(context: TempPmContext, args: string[], options: { expectJson?: boolean } = {}): SourceCliResult {
  const tsxCliPath = path.resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const completed = spawnSync(process.execPath, [tsxCliPath, path.resolve(process.cwd(), "src", "cli.ts"), ...args], {
    cwd: process.cwd(),
    env: context.env,
    encoding: "utf8",
  });
  const result: SourceCliResult = {
    code: completed.status,
    stdout: completed.stdout ?? "",
    stderr: completed.stderr ?? "",
  };
  if (options.expectJson && result.stdout.trim().length > 0) {
    result.json = JSON.parse(result.stdout);
  }
  return result;
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

describe("extension startup activation", () => {
  it("skips command-scoped extension imports for unrelated core commands and activates contributed commands", async () => {
    await withTempPmPath(async (context) => {
      const logPath = path.join(context.tempRoot, "scoped-extension.log");
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "scoped-command-ext",
        manifest: {
          name: "scoped-command-ext",
          version: "1.0.0",
          entry: "index.mjs",
          capabilities: ["commands", "schema"],
          activation: {
            commands: ["slow command"],
          },
        },
        entryFilename: "index.mjs",
        entrySource: [
          'import { appendFileSync } from "node:fs";',
          `appendFileSync(${JSON.stringify(logPath)}, "import\\n", "utf8");`,
          "export function activate(api) {",
          `  appendFileSync(${JSON.stringify(logPath)}, "activate\\n", "utf8");`,
          "  api.registerCommand({",
          '    name: "slow command",',
          '    description: "Slow test command.",',
          '    run: async (context) => ({ ok: true, source: "scoped-command-ext", command: context.command }),',
          "  });",
          "}",
          "export default { activate };",
          "",
        ].join("\n"),
      });

      const list = runSourceCli(context, ["list-open", "--json"], { expectJson: true });
      expect(list.code).toBe(0);
      expect(await readOptionalFile(logPath)).toBe("");

      const dynamic = runSourceCli(context, ["slow", "command", "--json"], { expectJson: true });
      expect(dynamic.code).toBe(0);
      expect(dynamic.json).toMatchObject({
        ok: true,
        source: "scoped-command-ext",
        command: "slow command",
      });
      expect(await readOptionalFile(logPath)).toBe("import\nactivate\n");
    });
  });

  it("dispatches a search+commands extension's own command, both with and without declared activation.commands (pm-nacb)", async () => {
    await withTempPmPath(async (context) => {
      // Mirrors `pm package init --capability search`: capabilities pair `search`
      // with `commands`, the command path's first token is not a built-in search
      // word, and `activation.commands` enumerates the registered command exactly.
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "kanban-board",
        manifest: {
          name: "kanban-board",
          version: "1.0.0",
          entry: "index.mjs",
          capabilities: ["commands", "search"],
          activation: {
            commands: ["kanban board ping"],
          },
        },
        entryFilename: "index.mjs",
        entrySource: [
          "export function activate(api) {",
          "  api.registerCommand({",
          '    name: "kanban board ping",',
          '    description: "Kanban starter command.",',
          '    run: async (context) => ({ ok: true, source: "kanban-board", command: context.command }),',
          "  });",
          "  api.registerSearchProvider({",
          '    name: "kanban-board-search",',
          "    query: async () => ({ hits: [] }),",
          "    embed: async () => [1],",
          "  });",
          "}",
          "export default { activate };",
          "",
        ].join("\n"),
      });
      // Hand-authored variant that omits `activation.commands`: dispatch must still
      // work through the capability heuristic (search must not shadow the
      // conservative `commands` activation).
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "atlas-grid",
        manifest: {
          name: "atlas-grid",
          version: "1.0.0",
          entry: "index.mjs",
          capabilities: ["commands", "search"],
        },
        entryFilename: "index.mjs",
        entrySource: [
          "export function activate(api) {",
          "  api.registerCommand({",
          '    name: "atlas grid ping",',
          '    description: "Atlas starter command.",',
          '    run: async (context) => ({ ok: true, source: "atlas-grid", command: context.command }),',
          "  });",
          "  api.registerSearchProvider({",
          '    name: "atlas-grid-search",',
          "    query: async () => ({ hits: [] }),",
          "    embed: async () => [1],",
          "  });",
          "}",
          "export default { activate };",
          "",
        ].join("\n"),
      });

      const declared = runSourceCli(context, ["kanban", "board", "ping", "--json"], { expectJson: true });
      expect(declared.code).toBe(0);
      expect(declared.json).toMatchObject({ ok: true, source: "kanban-board", command: "kanban board ping" });

      const heuristic = runSourceCli(context, ["atlas", "grid", "ping", "--json"], { expectJson: true });
      expect(heuristic.code).toBe(0);
      expect(heuristic.json).toMatchObject({ ok: true, source: "atlas-grid", command: "atlas grid ping" });
    });
  });

  it("keeps renderer and hook overrides active even when activation metadata does not match the command", async () => {
    await withTempPmPath(async (context) => {
      const hookLogPath = path.join(context.tempRoot, "hook-extension.log");
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "renderer-ext",
        manifest: {
          name: "renderer-ext",
          version: "1.0.0",
          entry: "index.mjs",
          capabilities: ["renderers"],
          activation: {
            commands: ["unrelated command"],
          },
        },
        entryFilename: "index.mjs",
        entrySource: [
          "export function activate(api) {",
          "  api.registerRenderer('json', (context) => JSON.stringify({",
          "    rendered_by: 'renderer-ext',",
          "    command: context.command,",
          "  }));",
          "}",
          "export default { activate };",
          "",
        ].join("\n"),
      });
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "hook-ext",
        manifest: {
          name: "hook-ext",
          version: "1.0.0",
          entry: "index.mjs",
          capabilities: ["hooks"],
          activation: {
            commands: ["unrelated command"],
          },
        },
        entryFilename: "index.mjs",
        entrySource: [
          'import { appendFileSync } from "node:fs";',
          `const HOOK_LOG_PATH = ${JSON.stringify(hookLogPath)};`,
          "export function activate(api) {",
          '  appendFileSync(HOOK_LOG_PATH, "activate\\n", "utf8");',
          '  api.hooks.beforeCommand(() => appendFileSync(HOOK_LOG_PATH, "before\\n", "utf8"));',
          '  api.hooks.afterCommand((context) => appendFileSync(HOOK_LOG_PATH, "after:" + String(context.ok) + "\\n", "utf8"));',
          "}",
          "export default { activate };",
          "",
        ].join("\n"),
      });

      const rendered = runSourceCli(context, ["list-open", "--json"], { expectJson: true });
      expect(rendered.code).toBe(0);
      expect(rendered.json).toEqual({
        rendered_by: "renderer-ext",
        command: "list-open",
      });
      expect(await readOptionalFile(hookLogPath)).toBe("activate\nbefore\nafter:true\n");
    });
  });

  it("keeps legacy broad command manifests active for core command overrides", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "legacy-command-ext",
        manifest: {
          name: "legacy-command-ext",
          version: "1.0.0",
          entry: "index.mjs",
          capabilities: ["commands"],
        },
        entryFilename: "index.mjs",
        entrySource: [
          "export function activate(api) {",
          "  api.registerCommand('list-open', (context) => ({",
          "    ...(context.result ?? {}),",
          "    legacy_override: true,",
          "  }));",
          "}",
          "export default { activate };",
          "",
        ].join("\n"),
      });

      const result = runSourceCli(context, ["list-open", "--json"], { expectJson: true });
      expect(result.code).toBe(0);
      expect(result.json).toMatchObject({
        legacy_override: true,
      });
    });
  });

  it("loads template command extensions only when create uses --template", async () => {
    await withTempPmPath(async (context) => {
      const logPath = path.join(context.tempRoot, "template-extension.log");
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "template-command-ext",
        manifest: {
          name: "template-command-ext",
          version: "1.0.0",
          entry: "index.mjs",
          capabilities: ["commands", "schema"],
          activation: {
            commands: ["templates", "templates show"],
          },
        },
        entryFilename: "index.mjs",
        entrySource: [
          'import { appendFileSync } from "node:fs";',
          `appendFileSync(${JSON.stringify(logPath)}, "import\\n", "utf8");`,
          "export function activate(api) {",
          `  appendFileSync(${JSON.stringify(logPath)}, "activate\\n", "utf8");`,
          "  api.registerCommand({",
          '    name: "templates show",',
          '    action: "templates-show",',
          "    run: async () => ({",
          '      name: "checkout-defaults",',
          "      options: {",
          '        type: "Task",',
          '        priority: "1",',
          '        tags: "template-startup",',
          '        body: "Template body from startup integration test",',
          "      },",
          "    }),",
          "  });",
          "}",
          "export default { activate };",
          "",
        ].join("\n"),
      });

      const list = runSourceCli(context, ["list-open", "--json"], { expectJson: true });
      expect(list.code).toBe(0);
      expect(await readOptionalFile(logPath)).toBe("");

      const created = runSourceCli(
        context,
        [
          "create",
          "--template",
          "checkout-defaults",
          "--title",
          "Templated startup item",
          "--description",
          "Created via lazy-loaded templates extension.",
          "--json",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      expect(created.json).toMatchObject({
        item: {
          title: "Templated startup item",
          type: "Task",
          priority: 1,
          tags: ["template-startup"],
        },
      });
      expect(await readOptionalFile(logPath)).toBe("import\nactivate\n");
    });
  });

  it("activates command-scoped search extensions for semantic search probes", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Scoped search provider item",
          "--description",
          "Created for lazy search provider activation.",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--body",
          "Scoped search provider body",
          "--acceptance-criteria",
          "Semantic search activates the scoped search provider.",
          "--author",
          "unit-test",
          "--message",
          "Create scoped search activation item",
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
      expect(created.code).toBe(0);

      const logPath = path.join(context.tempRoot, "scoped-search-extension.log");
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "scoped-search-ext",
        manifest: {
          name: "scoped-search-ext",
          version: "1.0.0",
          entry: "index.mjs",
          capabilities: ["commands", "search"],
          activation: {
            commands: ["provider doctor"],
          },
        },
        entryFilename: "index.mjs",
        entrySource: [
          'import { appendFileSync } from "node:fs";',
          `appendFileSync(${JSON.stringify(logPath)}, "import\\n", "utf8");`,
          "export function activate(api) {",
          `  appendFileSync(${JSON.stringify(logPath)}, "activate\\n", "utf8");`,
          "  api.registerSearchProvider({",
          '    name: "scoped-provider",',
          "    embedBatch: ({ inputs }) => inputs.map((_value, index) => [index + 0.1, index + 0.2]),",
          "  });",
          "  api.registerCommand({",
          '    name: "provider doctor",',
          '    run: async () => ({ ok: true }),',
          "  });",
          "}",
          "export default { activate };",
          "",
        ].join("\n"),
      });

      const settings = await readSettings(context.pmPath);
      settings.search.provider = "scoped-provider";
      settings.vector_store.lancedb.path = path.join(context.tempRoot, "scoped-search-vectors");
      await writeSettings(context.pmPath, settings);

      const list = runSourceCli(context, ["list-open", "--json"], { expectJson: true });
      expect(list.code).toBe(0);
      expect(await readOptionalFile(logPath)).toBe("");

      const search = runSourceCli(context, ["search", "Scoped", "--mode", "semantic", "--json"], { expectJson: true });
      expect(search.code).toBe(0);
      expect(search.json).toMatchObject({
        query: "Scoped",
      });
      expect(await readOptionalFile(logPath)).toBe("import\nactivate\n");
    });
  });
});
