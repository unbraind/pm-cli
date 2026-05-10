import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pluginRoot = path.join(repoRoot, "plugins", "pm-cli-claude");

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

describe("Claude Code plugin contract", () => {
  it("has required plugin structure files", async () => {
    const required = [
      ".claude-plugin/plugin.json",
      ".mcp.json",
      "README.md",
      "scripts/pm-mcp-server.mjs",
      "hooks/hooks.json",
      "hooks/session-start.mjs",
    ];
    for (const rel of required) {
      const exists = await fileExists(path.join(pluginRoot, rel));
      expect(exists, `Missing plugin file: ${rel}`).toBe(true);
    }
  });

  it("has all required skills", async () => {
    const requiredSkills = [
      "pm-workflow",
      "pm-developer",
      "pm-release",
      "pm-audit",
      "pm-planner",
    ];
    for (const skill of requiredSkills) {
      const skillPath = path.join(pluginRoot, "skills", skill, "SKILL.md");
      const exists = await fileExists(skillPath);
      expect(exists, `Missing skill: ${skill}`).toBe(true);

      const content = await readFile(skillPath, "utf8");
      expect(content, `Skill ${skill} missing frontmatter name`).toContain(`name: ${skill}`);
      expect(content, `Skill ${skill} missing description`).toContain("description:");
    }
  });

  it("has all required slash commands", async () => {
    const requiredCommands = [
      "pm-status",
      "pm-start-task",
      "pm-close-task",
      "pm-triage",
      "pm-audit",
      "pm-search",
      "pm-new",
      "pm-list",
      "pm-calendar",
      "pm-developer",
      "pm-planner",
      "pm-release",
      "pm-workflow",
      "pm-init",
    ];
    for (const cmd of requiredCommands) {
      const cmdPath = path.join(pluginRoot, "commands", `${cmd}.md`);
      const exists = await fileExists(cmdPath);
      expect(exists, `Missing command: ${cmd}`).toBe(true);

      const content = await readFile(cmdPath, "utf8");
      expect(content, `Command ${cmd} missing description`).toContain("description:");
    }
  });

  it("has all required agents including new subagents", async () => {
    const requiredAgents = [
      "pm-coordinator",
      "pm-triage-agent",
      "pm-verification-agent",
      "pm-delivery-chain",
    ];
    for (const agent of requiredAgents) {
      const agentPath = path.join(pluginRoot, "agents", `${agent}.md`);
      const exists = await fileExists(agentPath);
      expect(exists, `Missing agent: ${agent}`).toBe(true);

      const content = await readFile(agentPath, "utf8");
      expect(content, `Agent ${agent} missing name frontmatter`).toContain(`name: ${agent}`);
      expect(content, `Agent ${agent} missing description frontmatter`).toContain("description:");
    }
  });

  it("has valid plugin.json with correct version and metadata", async () => {
    const pluginJson = (await readJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"))) as Record<string, unknown>;
    expect(pluginJson.name).toBe("pm-cli");
    expect(typeof pluginJson.version).toBe("string");
    expect(pluginJson.version).toMatch(/^\d+\.\d+\.\d+$/);
    const [major, minor] = (pluginJson.version as string).split(".").map(Number);
    expect(major).toBeGreaterThanOrEqual(1);
    expect(minor).toBeGreaterThanOrEqual(3);
    expect(pluginJson.license).toBe("MIT");
    expect(pluginJson.homepage).toContain("github.com");
    expect(pluginJson.repository).toContain("github.com");
    expect(Array.isArray(pluginJson.keywords)).toBe(true);
    expect(pluginJson.keywords).toContain("pm-cli");
    expect(pluginJson.keywords).toContain("mcp");
  });

  it("has valid marketplace.json with pm as canonical name", async () => {
    const marketplaceJson = (await readJson(path.join(repoRoot, "marketplace.json"))) as Record<string, unknown>;
    expect(marketplaceJson.name).toBe("pm");

    const plugins = marketplaceJson.plugins as Array<Record<string, unknown>>;
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins.length).toBeGreaterThan(0);

    const pmCliPlugin = plugins.find((p) => p.name === "pm-cli");
    expect(pmCliPlugin, "marketplace.json must contain pm-cli plugin").toBeTruthy();
    expect(pmCliPlugin?.source).toBe("./plugins/pm-cli-claude");
  });

  it("has valid MCP server .mcp.json with pm-cli-native server", async () => {
    const mcpJson = (await readJson(path.join(pluginRoot, ".mcp.json"))) as Record<string, unknown>;
    const servers = mcpJson.mcpServers as Record<string, unknown>;
    expect(servers).toBeDefined();
    expect(servers["pm-cli-native"]).toBeDefined();

    const server = servers["pm-cli-native"] as Record<string, unknown>;
    expect(server.command).toBe("node");
    expect(Array.isArray(server.args)).toBe(true);
    const args = server.args as string[];
    expect(args.some((a) => a.includes("pm-mcp-server.mjs"))).toBe(true);
  });

  it("has valid hooks.json with SessionStart hook", async () => {
    const hooksJson = (await readJson(path.join(pluginRoot, "hooks", "hooks.json"))) as Record<string, unknown>;
    const hooks = hooksJson.hooks as Record<string, unknown>;
    expect(hooks).toBeDefined();
    expect(hooks["SessionStart"]).toBeDefined();

    const sessionStart = hooks["SessionStart"] as Array<Record<string, unknown>>;
    expect(Array.isArray(sessionStart)).toBe(true);
    expect(sessionStart.length).toBeGreaterThan(0);
  });

  it("MCP server launcher resolves dist/mcp/server.js when present", async () => {
    const serverPath = path.join(repoRoot, "dist", "mcp", "server.js");
    const exists = await fileExists(serverPath);
    expect(exists, "dist/mcp/server.js must be built before testing").toBe(true);
  });

  it("session-start hook uses native module resolution, not shell pm command", async () => {
    const hookContent = await readFile(path.join(pluginRoot, "hooks", "session-start.mjs"), "utf8");
    // Must find and import native module (path.join components)
    expect(hookContent).toContain("native.js");
    expect(hookContent).toContain("runNativePmAction");
    // Must have npx fallback
    expect(hookContent).toContain("npx");
    // Must NOT invoke pm CLI directly via execSync with bare 'pm' command
    expect(hookContent).not.toContain('"pm context"');
    expect(hookContent).not.toContain("'pm context'");
    expect(hookContent).not.toContain('execSync("pm ');
    expect(hookContent).not.toContain("execSync('pm ");
  });

  it("agent files use native MCP tools, not shell pm commands", async () => {
    const PM_NATIVE_TOOLS = [
      "pm_context", "pm_search", "pm_list", "pm_get", "pm_create",
      "pm_update", "pm_claim", "pm_release", "pm_close", "pm_comments",
      "pm_files", "pm_docs", "pm_test", "pm_validate", "pm_health",
      "pm_contracts", "pm_guide", "pm_run",
    ];
    const agents = ["pm-coordinator", "pm-triage-agent", "pm-verification-agent", "pm-delivery-chain"];
    for (const agent of agents) {
      const content = await readFile(path.join(pluginRoot, "agents", `${agent}.md`), "utf8");
      // Each agent must reference at least one native MCP tool
      const referencesNativeTools = PM_NATIVE_TOOLS.some((tool) => content.includes(tool));
      expect(referencesNativeTools, `Agent ${agent} should reference native MCP tools`).toBe(true);
    }
  });
});
