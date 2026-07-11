import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pluginRoot = path.join(repoRoot, "plugins", "pm-claude");

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
    expect(pluginJson.name).toBe("pm-claude");
    expect(typeof pluginJson.version).toBe("string");
    // Date-based version policy (YYYY.M.D[-N]), kept in lockstep with the root
    // package by scripts/sync-versions.mjs — pm-cli artifacts do not use semver.
    expect(pluginJson.version).toMatch(/^[1-9]\d{3}\.[1-9]\d*\.[1-9]\d*(-[2-9]\d*)?$/);
    const rootPackageJson = (await readJson(path.join(repoRoot, "package.json"))) as Record<string, unknown>;
    expect(pluginJson.version).toBe(rootPackageJson.version);
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

    const pmClaudePlugin = plugins.find((p) => p.name === "pm-claude");
    expect(pmClaudePlugin, "marketplace.json must contain pm-claude plugin").toBeTruthy();
    expect(pmClaudePlugin?.source).toBe("./plugins/pm-claude");

    // Reconciled manifest fields (see pm-rjgh): root marketplace.json carries the
    // same metadata/category surface as .claude-plugin/marketplace.json.
    const metadata = marketplaceJson.metadata as Record<string, unknown>;
    expect(metadata, "marketplace.json must carry a metadata block").toBeTruthy();
    expect(typeof metadata.description).toBe("string");
    expect(metadata.version).toBe(pmClaudePlugin?.version);
    expect(pmClaudePlugin?.category).toBe("productivity");
  });

  it("keeps root and .claude-plugin marketplace manifests in sync (no drift)", async () => {
    const rootMarketplace = await readJson(path.join(repoRoot, "marketplace.json"));
    const claudePluginMarketplace = await readJson(path.join(repoRoot, ".claude-plugin", "marketplace.json"));
    expect(
      rootMarketplace,
      "marketplace.json and .claude-plugin/marketplace.json must stay reconciled",
    ).toEqual(claudePluginMarketplace);
  });

  it("keeps .agents/plugins pm-local marketplace in sync with local plugin manifests", async () => {
    const localMarketplace = (await readJson(path.join(repoRoot, ".agents", "plugins", "marketplace.json"))) as Record<
      string,
      unknown
    >;
    expect(localMarketplace.name).toBe("pm-local");

    const localPlugins = localMarketplace.plugins as Array<Record<string, unknown>>;
    expect(Array.isArray(localPlugins)).toBe(true);

    const codexManifest = (await readJson(
      path.join(repoRoot, "plugins", "pm-codex", ".codex-plugin", "plugin.json"),
    )) as Record<string, unknown>;
    const claudeManifest = (await readJson(
      path.join(repoRoot, "plugins", "pm-claude", ".claude-plugin", "plugin.json"),
    )) as Record<string, unknown>;

    const expectedPlugins = [
      { name: codexManifest.name, version: codexManifest.version, sourcePath: "./plugins/pm-codex" },
      { name: claudeManifest.name, version: claudeManifest.version, sourcePath: "./plugins/pm-claude" },
    ];

    const localPluginNames = localPlugins.map((plugin) => plugin.name).sort();
    const expectedNames = expectedPlugins.map((plugin) => plugin.name).sort();
    expect(localPluginNames, "pm-local marketplace plugin set drifted from local manifests").toEqual(expectedNames);

    for (const expected of expectedPlugins) {
      const localEntry = localPlugins.find((plugin) => plugin.name === expected.name);
      expect(localEntry, `pm-local marketplace missing ${expected.name}`).toBeTruthy();
      expect(localEntry?.version).toBe(expected.version);
      const source = localEntry?.source as Record<string, unknown> | undefined;
      expect(source?.source).toBe("local");
      expect(source?.path).toBe(expected.sourcePath);
    }
  });

  it("has valid MCP server .mcp.json with pm-mcp server", async () => {
    const mcpJson = (await readJson(path.join(pluginRoot, ".mcp.json"))) as Record<string, unknown>;
    const servers = mcpJson.mcpServers as Record<string, unknown>;
    expect(servers).toBeDefined();
    expect(servers["pm-mcp"]).toBeDefined();

    const server = servers["pm-mcp"] as Record<string, unknown>;
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

  it("session-start hook avoids direct agent runtime imports", async () => {
    const hookContent = await readFile(path.join(pluginRoot, "hooks", "session-start.mjs"), "utf8");
    expect(hookContent).not.toContain("native.js");
    expect(hookContent).not.toContain("runNativePmAction");
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
      "pm_files", "pm_docs", "pm_notes", "pm_learnings", "pm_deps",
      "pm_test", "pm_validate", "pm_health",
      "pm_contracts", "pm_plan", "pm_run",
    ];
    const agents = ["pm-coordinator", "pm-triage-agent", "pm-verification-agent", "pm-delivery-chain"];
    for (const agent of agents) {
      const content = await readFile(path.join(pluginRoot, "agents", `${agent}.md`), "utf8");
      // Each agent must reference at least one native MCP tool
      const referencesNativeTools = PM_NATIVE_TOOLS.some((tool) => content.includes(tool));
      expect(referencesNativeTools, `Agent ${agent} should reference native MCP tools`).toBe(true);
      expect(content, `Agent ${agent} should not reference removed pm_guide tool`).not.toContain("pm_guide");
    }
  });
});
